import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import {
  activateKeepAwakeAsync,
  deactivateKeepAwake,
} from "expo-keep-awake";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../App";
import { firstIndexOfPage, WordEntry } from "../utils/pdfParser";
import { saveProgress, clearProgress, saveCurrentBook, clearCurrentBook, saveWpm } from "../utils/progress";
import { t } from "../utils/i18n";
import { useLanguage } from "../contexts/LanguageContext";
import { useTheme } from "../contexts/ThemeContext";
import { useFont } from "../contexts/FontContext";
import { getTheme, ThemeColors } from "../utils/theme";

// WebView is only used on native for the dictionary modal; web uses window.open instead
const WebView =
  Platform.OS !== "web" ? require("react-native-webview").default : null;

type Props = NativeStackScreenProps<RootStackParamList, "Reader">;

const READER_KEEP_AWAKE_TAG = "reader-screen";

const CONTEXT_LINES = 5;
const WORDS_PER_LINE_EST = 8; // rough estimate for advance threshold
const CONTEXT_WINDOW = WORDS_PER_LINE_EST * CONTEXT_LINES; // ~40 words fills 5 lines

// ORP: middle letter for odd-length words; left-of-center for even-length words
function midIndex(word: string): number {
  return Math.ceil(word.length / 2) - 1;
}

function WordDisplay({ word, c, serif, serifBold, isDyslexic }: { word: string; c: ThemeColors; serif: string; serifBold: string; isDyslexic: boolean }) {
  if (!word) return null;
  const mid = midIndex(word);
  const before = word.slice(0, mid);
  const highlight = word.slice(mid, mid + 1);
  const after = word.slice(mid + 1);
  const sz = isDyslexic ? 28 : 38;
  return (
    <View style={wordRowStyle}>
      <View style={wordLeftStyle}>
        <Text
          style={{ color: c.readerText, fontFamily: serif, fontSize: sz }}
          allowFontScaling={false}
        >
          {before}
        </Text>
      </View>
      <Text
        style={{
          color: c.accent,
          fontFamily: serifBold,
          fontSize: sz,
          fontWeight: "700",
        }}
        allowFontScaling={false}
      >
        {highlight}
      </Text>
      <View style={wordRightStyle}>
        <Text
          style={{ color: c.readerText, fontFamily: serif, fontSize: sz }}
          allowFontScaling={false}
        >
          {after}
        </Text>
      </View>
    </View>
  );
}

// Static layout styles that don't change with theme
const wordRowStyle: any = {
  flexDirection: "row",
  alignItems: "center",
  alignSelf: "stretch",
};
const wordLeftStyle: any = { flex: 1, alignItems: "flex-end" };
const wordRightStyle: any = { flex: 1, alignItems: "flex-start" };


function ContextDisplay({
  words,
  windowStart,
  currentIndex,
  c,
  onAdvance,
  serif,
  isDyslexic,
}: {
  words: WordEntry[];
  windowStart: number;
  currentIndex: number;
  c: ThemeColors;
  onAdvance: () => void;
  serif: string;
  isDyslexic: boolean;
}) {
  const ctxSize = isDyslexic ? 11 : 13;
  const ctxLine = isDyslexic ? 18 : 20;
  const containerH = CONTEXT_LINES * ctxLine + 4;

  // Render enough words to fill well past the visible area
  const displayEnd = Math.min(words.length, windowStart + CONTEXT_WINDOW + 40);
  const slice = words.slice(windowStart, displayEnd);
  const hiOffset = currentIndex - windowStart;
  const advanceRef = useRef(onAdvance);
  advanceRef.current = onAdvance;
  const containerHRef = useRef(containerH);
  containerHRef.current = containerH;

  // When the highlighted word's onLayout reports it's past the container bottom, advance
  const handleHighlightLayout = useCallback((e: any) => {
    const { y, height } = e.nativeEvent.layout;
    if (y + height > containerHRef.current) {
      advanceRef.current();
    }
  }, []);

  return (
    <View style={{ height: containerH, overflow: "hidden" as any }}>
      <View style={contextFlowStyle}>
        {slice.map((w, i) => (
          <Text
            key={i === hiOffset ? `hl-${currentIndex}` : windowStart + i}
            onLayout={i === hiOffset ? handleHighlightLayout : undefined}
            style={
              i === hiOffset
                ? { color: c.readerContextCurrent, fontFamily: serif, fontSize: ctxSize, lineHeight: ctxLine }
                : { color: c.readerContextWord, fontFamily: serif, fontSize: ctxSize, lineHeight: ctxLine }
            }
          >
            {w.word}{" "}
          </Text>
        ))}
      </View>
    </View>
  );
}

const contextFlowStyle: any = {
  flexDirection: "row",
  flexWrap: "wrap",
};

export default function ReaderScreen({ route, navigation }: Props) {
  const { lang } = useLanguage();
  const { scheme, toggleTheme } = useTheme();
  const { serif, serifBold, font, toggleFont, isDyslexic } = useFont();
  const c = getTheme(scheme);
  const styles = useMemo(() => makeStyles(c, serif), [scheme, serif]);

  const {
    words,
    wpm: initialWpm,
    numPages,
    startIndex,
    fileKey,
    fileName,
  } = route.params;

  // Persist the current book so HomeScreen can offer "Continue Reading"
  useEffect(() => {
    saveCurrentBook({ words, numPages, fileKey, fileName, wpm: initialWpm });
  }, []); // only on mount

  const [currentIndex, setCurrentIndex] = useState(startIndex);
  const [windowStart, setWindowStart] = useState(() => Math.max(0, startIndex));
  const windowStartRef = useRef(Math.max(0, startIndex));
  const [isPlaying, setIsPlaying] = useState(true);
  const [wpm, setWpm] = useState(initialWpm);
  const [showJumper, setShowJumper] = useState(false);
  const [pageInput, setPageInput] = useState("");

  const [flowReading, setFlowReading] = useState(true);
  const [keepScreenAwake, setKeepScreenAwake] = useState(false);

  const indexRef = useRef(currentIndex);
  const wpmRef = useRef(wpm);
  const flowReadingRef = useRef(flowReading);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRef = useRef<() => void>(() => {});

  useEffect(() => {
    indexRef.current = currentIndex;
  }, [currentIndex]);
  useEffect(() => {
    wpmRef.current = wpm;
  }, [wpm]);
  useEffect(() => {
    flowReadingRef.current = flowReading;
  }, [flowReading]);

  useEffect(() => {
    if (!keepScreenAwake) {
      void deactivateKeepAwake(READER_KEEP_AWAKE_TAG);
      return;
    }
    void activateKeepAwakeAsync(READER_KEEP_AWAKE_TAG);
    return () => {
      void deactivateKeepAwake(READER_KEEP_AWAKE_TAG);
    };
  }, [keepScreenAwake]);

  // Called by ContextDisplay when the highlighted word's onLayout reports it's past
  // the visible container. Advances the window so the current word is near the top.
  const WINDOW_OVERLAP = 3;
  const handleAdvance = useCallback(() => {
    const next = Math.max(0, indexRef.current - WINDOW_OVERLAP);
    if (next !== windowStartRef.current) {
      windowStartRef.current = next;
      setWindowStart(next);
    }
  }, []);

  // Handle backward navigation past the window start
  useEffect(() => {
    if (currentIndex < windowStartRef.current) {
      const next = Math.max(0, currentIndex);
      windowStartRef.current = next;
      setWindowStart(next);
    }
  }, [currentIndex]);

  // Inline so it always closes over latest `words`; assigned to scheduleRef each render
  // so recursive timeout callbacks always call the current version.
  const scheduleNext = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    const word = words[indexRef.current]?.word ?? "";
    const baseDelay = Math.round(60000 / wpmRef.current);
    let delay = baseDelay;
    if (flowReadingRef.current) {
      const hasPunct = /[.,!?;:\-—–]/.test(word);
      const lengthBonus = Math.max(0, word.length - 8) * 0.1;
      const multiplier = Math.min(
        2.5,
        Math.max(hasPunct ? 2 : 1, 1 + lengthBonus),
      );
      delay = Math.round(baseDelay * multiplier);
    }
    timeoutRef.current = setTimeout(() => {
      const next = indexRef.current + 1;
      if (next >= words.length) {
        setIsPlaying(false);
        return;
      }
      indexRef.current = next;
      setCurrentIndex(next);
      scheduleRef.current();
    }, delay);
  };
  scheduleRef.current = scheduleNext;

  useEffect(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (isPlaying) scheduleRef.current();
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [isPlaying, wpm, flowReading]);

  const currentWord = words[currentIndex];
  const currentPage = currentWord?.page ?? 1;

  // Save progress whenever the page changes (not on every word)
  const lastSavedPage = useRef(-1);
  useEffect(() => {
    if (currentPage !== lastSavedPage.current) {
      lastSavedPage.current = currentPage;
      saveProgress(fileKey, { wordIndex: currentIndex, page: currentPage });
    }
  }, [currentPage, fileKey, currentIndex]);

  // Clear saved progress and book when finished
  const isFinished = currentIndex >= words.length;
  useEffect(() => {
    if (isFinished) {
      clearProgress(fileKey);
      clearCurrentBook();
    }
  }, [isFinished, fileKey]);

  const handleTap = useCallback(() => {
    setIsPlaying((p) => {
      const next = !p;
      if (!next) {
        // Pausing — save exact position immediately
        saveProgress(fileKey, {
          wordIndex: indexRef.current,
          page: words[indexRef.current]?.page ?? 1,
        });
      }
      return next;
    });
  }, [fileKey, words]);

  const [dictUrl, setDictUrl] = useState<string | null>(null);

  const lookUpWord = useCallback(() => {
    const clean = (currentWord?.word ?? "")
      .replace(/[^a-zA-Z'-]/g, "")
      .toLowerCase();
    if (!clean) return;
    const url = `https://www.dictionary.com/browse/${clean}`;
    if (Platform.OS === "web") {
      // Open in a new browser tab on web
      (window as any).open(url, "_blank");
    } else {
      setDictUrl(url);
    }
  }, [currentWord]);

  const stepWord = useCallback(
    (delta: number) => {
      const next = Math.min(
        words.length - 1,
        Math.max(0, indexRef.current + delta),
      );
      indexRef.current = next;
      setCurrentIndex(next);
    },
    [words.length],
  );

  const stepWindow = useCallback(
    (direction: 1 | -1) => {
      const jump = CONTEXT_WINDOW - WINDOW_OVERLAP;
      const next = Math.min(
        words.length - 1,
        Math.max(0, indexRef.current + direction * jump),
      );
      indexRef.current = next;
      setCurrentIndex(next);
    },
    [words.length],
  );

  const adjustWpm = (delta: number) =>
    setWpm((prev) => {
      const next = Math.min(750, Math.max(50, prev + delta));
      saveWpm(next);
      return next;
    });

  const jumpToPage = useCallback(() => {
    const page = parseInt(pageInput, 10);
    if (isNaN(page) || page < 1 || page > numPages) {
      Alert.alert(
        t(lang, "invalidPage"),
        t(lang, "invalidPageMsg", { max: numPages }),
      );
      return;
    }
    const idx = firstIndexOfPage(words, page);
    indexRef.current = idx; // sync immediately — don't wait for effect
    setCurrentIndex(idx);
    saveProgress(fileKey, { wordIndex: idx, page }); // persist to storage
    setShowJumper(false);
    setPageInput("");
    setIsPlaying(true); // auto-resume after jump
  }, [pageInput, numPages, words, fileKey]);

  const handleBack = useCallback(async () => {
    setIsPlaying(false);
    const idx = indexRef.current;
    await saveProgress(fileKey, {
      wordIndex: idx,
      page: words[idx]?.page ?? 1,
    });
    navigation.goBack();
  }, [fileKey, words, navigation]);

  const progress = words.length > 0 ? currentIndex / words.length : 0;

  // Compute estimated time to next page, accounting for flow-reading delays
  const minsToNextPage = useMemo(() => {
    if (currentIndex >= words.length - 1) return 0;
    const curPage = words[currentIndex]?.page ?? 1;
    const baseDelay = 60000 / wpm; // ms per word
    let totalMs = 0;
    for (let i = currentIndex + 1; i < words.length; i++) {
      if (words[i].page !== curPage) break;
      if (flowReading) {
        const w = words[i].word;
        const hasPunct = /[.,!?;:\-—–]/.test(w);
        const lengthBonus = Math.max(0, w.length - 8) * 0.1;
        const multiplier = Math.min(2.5, Math.max(hasPunct ? 2 : 1, 1 + lengthBonus));
        totalMs += baseDelay * multiplier;
      } else {
        totalMs += baseDelay;
      }
    }
    return totalMs / 60000;
  }, [currentIndex, words, wpm, flowReading]);

  if (isFinished) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.doneContainer}>
          <Text style={styles.doneIcon}>◎</Text>
          <Text style={styles.doneTitle}>{t(lang, "finished")}</Text>
          <Text style={styles.doneSub}>
            {t(lang, "finishedSub", {
              count: words.length.toLocaleString(),
              wpm,
            })}
          </Text>
          <TouchableOpacity
            style={styles.doneBtn}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.doneBtnText}>{t(lang, "backBtn")}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Progress bar */}
      <View style={styles.progressTrack}>
        <View
          style={[styles.progressFill, { width: `${progress * 100}%` as any }]}
        />
      </View>

      {/* Context paragraph */}
      <View style={styles.contextContainer}>
        <ContextDisplay
          words={words}
          windowStart={windowStart}
          currentIndex={currentIndex}
          c={c}
          onAdvance={handleAdvance}
          serif={serif}
          isDyslexic={isDyslexic}
        />
      </View>

      {/* Reading area */}
      <TouchableWithoutFeedback onPress={handleTap}>
        <View style={styles.wordArea}>
          <WordDisplay word={currentWord?.word ?? ""} c={c} serif={serif} serifBold={serifBold} isDyslexic={isDyslexic} />

          {/* Navigation arrows — absolutely positioned when paused */}
          {!isPlaying && (
            <>
              {/* Window-skip (chunk) arrows */}
              <TouchableOpacity
                style={[
                  styles.stepBtn,
                  styles.chunkBtnLeft,
                  currentIndex <= 0 && styles.stepBtnDisabled,
                ]}
                onPress={() => stepWindow(-1)}
                disabled={currentIndex <= 0}
              >
                <Text style={styles.stepBtnText}>⇐</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.stepBtn,
                  styles.chunkBtnRight,
                  currentIndex >= words.length - 1 && styles.stepBtnDisabled,
                ]}
                onPress={() => stepWindow(1)}
                disabled={currentIndex >= words.length - 1}
              >
                <Text style={styles.stepBtnText}>⇒</Text>
              </TouchableOpacity>

              {/* Word-step arrows */}
              <TouchableOpacity
                style={[
                  styles.stepBtn,
                  styles.stepBtnLeft,
                  currentIndex <= 0 && styles.stepBtnDisabled,
                ]}
                onPress={() => stepWord(-1)}
                disabled={currentIndex <= 0}
              >
                <Text style={styles.stepBtnText}>←</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.stepBtn,
                  styles.stepBtnRight,
                  currentIndex >= words.length - 1 && styles.stepBtnDisabled,
                ]}
                onPress={() => stepWord(1)}
                disabled={currentIndex >= words.length - 1}
              >
                <Text style={styles.stepBtnText}>→</Text>
              </TouchableOpacity>
            </>
          )}

          <View style={styles.pausedHint}>
            {isPlaying ? (
              <Text style={styles.pausedHintText}>{t(lang, "tapToPause")}</Text>
            ) : (
              <>
                <Text style={styles.pageTimeText}>
                  {minsToNextPage < 1
                    ? `${Math.ceil(minsToNextPage * 60)}s to next page`
                    : `${minsToNextPage.toFixed(1)} min to next page`}
                </Text>
                <Text style={styles.pausedHintText}>
                  {t(lang, "tapToResume")}
                </Text>
                <TouchableOpacity style={styles.lookupBtn} onPress={lookUpWord}>
                  <Text style={styles.lookupBtnText}>
                    {t(lang, "lookUpWord")}
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </TouchableWithoutFeedback>

      {/* Speed controls */}
      <View style={styles.speedBar}>
        <View style={styles.speedRow}>
          <TouchableOpacity
            onPress={() => adjustWpm(-25)}
            style={styles.speedBtn}
          >
            <Text style={styles.speedBtnText}>−25</Text>
          </TouchableOpacity>
          <Text style={styles.speedValue}>
            {wpm} {t(lang, "wpm")}
          </Text>
          <TouchableOpacity
            onPress={() => adjustWpm(25)}
            style={styles.speedBtn}
          >
            <Text style={styles.speedBtnText}>+25</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.speedToggles}>
          <TouchableOpacity
            style={[styles.flowBtn, flowReading && styles.flowBtnActive]}
            onPress={() => setFlowReading((v) => !v)}
          >
            <Text
              style={[
                styles.flowBtnText,
                flowReading && styles.flowBtnTextActive,
              ]}
            >
              {flowReading ? t(lang, "flowOn") : t(lang, "flowOff")}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.themeBtn} onPress={toggleTheme}>
            <Text style={styles.themeBtnText}>
              {scheme === "dark" ? "Light" : "Dark"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.flowBtn, font === "opendyslexic" && styles.flowBtnActive]}
            onPress={toggleFont}
          >
            <Text style={[styles.flowBtnText, font === "opendyslexic" && styles.flowBtnTextActive]}>
              {font === "opendyslexic" ? "OpenDyslexic" : "Dyslexic"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.flowBtn, keepScreenAwake && styles.flowBtnActive]}
            onPress={() => setKeepScreenAwake((v) => !v)}
          >
            <Text
              style={[
                styles.flowBtnText,
                keepScreenAwake && styles.flowBtnTextActive,
              ]}
            >
              {keepScreenAwake ? t(lang, "keepAwakeOn") : t(lang, "keepAwakeOff")}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Bottom bar */}
      <View style={styles.bottomBar}>
        <TouchableOpacity onPress={handleBack} style={styles.backBtn}>
          <Text style={styles.backBtnText}>{t(lang, "back")}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.pageBtn}
          onPress={() => {
            setIsPlaying(false);
            setShowJumper(true);
          }}
        >
          <Text style={styles.pageBtnText}>
            {currentPage} / {numPages}
          </Text>
        </TouchableOpacity>

        <Text style={styles.wpmLabel}>{wpm}</Text>
      </View>

      {/* Page jump modal */}
      <Modal
        visible={showJumper}
        transparent
        animationType="fade"
        onRequestClose={() => setShowJumper(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t(lang, "jumpToPage")}</Text>
            <Text style={styles.modalSub}>1 – {numPages}</Text>
            <TextInput
              style={styles.modalInput}
              value={pageInput}
              onChangeText={setPageInput}
              keyboardType="number-pad"
              placeholder={String(currentPage)}
              placeholderTextColor={c.readerModalPlaceholder}
              autoFocus
              returnKeyType="go"
              onSubmitEditing={jumpToPage}
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => {
                  setShowJumper(false);
                  setPageInput("");
                }}
              >
                <Text style={styles.modalCancelText}>{t(lang, "cancel")}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalConfirm}
                onPress={jumpToPage}
              >
                <Text style={styles.modalConfirmText}>{t(lang, "jump")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Dictionary WebView modal (native only — web uses window.open) */}
      {dictUrl && (
        <Modal
          visible
          animationType="slide"
          onRequestClose={() => setDictUrl(null)}
        >
          <SafeAreaView style={styles.dictModal}>
            <View style={styles.dictHeader}>
              <Text style={styles.dictTitle}>{t(lang, "dictionaryCom")}</Text>
              <TouchableOpacity
                onPress={() => setDictUrl(null)}
                style={styles.dictClose}
              >
                <Text style={styles.dictCloseText}>✕</Text>
              </TouchableOpacity>
            </View>
            <WebView
              source={{ uri: dictUrl }}
              style={{ flex: 1 }}
              javaScriptEnabled
              domStorageEnabled
            />
          </SafeAreaView>
        </Modal>
      )}
    </SafeAreaView>
  );
}

function makeStyles(c: ThemeColors, SERIF: string = 'Georgia') {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.readerBg,
    },

    progressTrack: {
      height: 2,
      backgroundColor: c.readerBorder,
    },
    progressFill: {
      height: 2,
      backgroundColor: c.accent,
    },

    // ── Context paragraph ─────────────────────────────────────────────────────
    contextContainer: {
      paddingHorizontal: 24,
      paddingTop: 14,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: c.readerBorderSubtle,
    },

    // ── Step arrows ───────────────────────────────────────────────────────────
    stepBtnLeft: {
      position: "absolute",
      left: 24,
      top: "60%",
      transform: [{ translateY: -22 }],
    },
    stepBtnRight: {
      position: "absolute",
      right: 24,
      top: "60%",
      transform: [{ translateY: -22 }],
    },
    chunkBtnLeft: {
      position: "absolute",
      left: 24,
      top: "40%",
      transform: [{ translateY: -22 }],
    },
    chunkBtnRight: {
      position: "absolute",
      right: 24,
      top: "40%",
      transform: [{ translateY: -22 }],
    },
    stepRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 24,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.readerBorderSubtle,
    },
    stepBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: c.readerBorder,
      alignItems: "center",
      justifyContent: "center",
    },
    stepBtnDisabled: {
      opacity: 0.2,
    },
    stepBtnText: {
      color: c.accent,
      fontSize: 20,
      fontFamily: SERIF,
    },

    // ── Word area ─────────────────────────────────────────────────────────────
    wordArea: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 32,
    },
    pausedHint: {
      position: "absolute",
      bottom: 60,
      alignItems: "center",
      gap: 12,
    },
    pausedHintText: {
      color: c.readerTextMuted,
      fontSize: 13,
      fontFamily: SERIF,
      letterSpacing: 0.5,
    },
    pageTimeText: {
      color: c.accent,
      fontSize: 14,
      fontFamily: SERIF,
      letterSpacing: 0.3,
      marginBottom: 4,
    },
    lookupBtn: {
      paddingHorizontal: 16,
      paddingVertical: 7,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: c.readerBorder,
    },
    lookupBtnText: {
      color: c.accent,
      fontSize: 12,
      fontFamily: SERIF,
      letterSpacing: 0.5,
    },

    // ── Dictionary modal ───────────────────────────────────────────────────────
    dictModal: {
      flex: 1,
      backgroundColor: c.readerBg,
    },
    dictHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 20,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: c.readerBorder,
    },
    dictTitle: {
      color: c.accent,
      fontFamily: SERIF,
      fontSize: 15,
      fontWeight: "600",
    },
    dictClose: {
      padding: 6,
    },
    dictCloseText: {
      color: c.readerTextMuted,
      fontSize: 16,
    },

    // ── Speed overlay ─────────────────────────────────────────────────────────
    speedBar: {
      alignItems: "center",
      paddingVertical: 12,
      paddingBottom: 14,
      backgroundColor: c.readerBarBg,
      gap: 10,
      borderTopWidth: 1,
      borderTopColor: c.readerBorder,
    },
    speedRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 24,
    },
    speedBtn: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: c.readerBorder,
      borderRadius: 6,
    },
    speedBtnText: {
      color: c.accent,
      fontSize: 14,
      fontFamily: SERIF,
    },
    speedValue: {
      color: c.readerText,
      fontSize: 18,
      fontFamily: SERIF,
      minWidth: 90,
      textAlign: "center",
    },
    speedToggles: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "center",
      alignItems: "center",
      gap: 10,
    },
    flowBtn: {
      paddingHorizontal: 18,
      paddingVertical: 6,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: c.readerBorder,
    },
    flowBtnActive: {
      borderColor: c.accent,
      backgroundColor: "rgba(200,169,81,0.1)",
    },
    flowBtnText: {
      color: c.readerTextMuted,
      fontSize: 12,
      fontFamily: SERIF,
      letterSpacing: 0.5,
    },
    flowBtnTextActive: {
      color: c.accent,
    },
    themeBtn: {
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: c.readerBorder,
    },
    themeBtnText: {
      color: c.readerTextMuted,
      fontSize: 14,
    },

    // ── Bottom bar ────────────────────────────────────────────────────────────
    bottomBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 24,
      paddingVertical: 16,
      backgroundColor: c.readerBottomBg,
      borderTopWidth: 1,
      borderTopColor: c.readerBorder,
    },
    backBtn: { minWidth: 60 },
    backBtnText: {
      color: c.readerTextMuted,
      fontSize: 13,
      fontFamily: SERIF,
    },
    pageBtn: { alignItems: "center" },
    pageBtnText: {
      color: c.accent,
      fontSize: 16,
      fontFamily: SERIF,
      fontWeight: "600",
    },
    wpmLabel: {
      color: c.readerTextMuted,
      fontSize: 13,
      fontFamily: SERIF,
      minWidth: 60,
      textAlign: "right",
    },

    // ── Done screen ───────────────────────────────────────────────────────────
    doneContainer: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 40,
    },
    doneIcon: {
      fontSize: 48,
      color: c.accent,
      marginBottom: 20,
    },
    doneTitle: {
      color: c.readerText,
      fontSize: 32,
      fontFamily: SERIF,
      fontWeight: "700",
      marginBottom: 8,
    },
    doneSub: {
      color: c.readerTextMuted,
      fontSize: 15,
      fontFamily: SERIF,
      marginBottom: 40,
    },
    doneBtn: {
      borderWidth: 1,
      borderColor: c.accent,
      borderRadius: 8,
      paddingVertical: 12,
      paddingHorizontal: 32,
    },
    doneBtnText: {
      color: c.accent,
      fontSize: 16,
      fontFamily: SERIF,
    },

    // ── Page jump modal ───────────────────────────────────────────────────────
    modalOverlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.7)",
      alignItems: "center",
      justifyContent: "center",
    },
    modalCard: {
      width: "78%",
      backgroundColor: c.readerModalBg,
      borderRadius: 12,
      padding: 28,
      borderWidth: 1,
      borderColor: c.readerModalBorder,
      alignItems: "center",
      maxWidth: 400,
    },
    modalTitle: {
      color: c.readerModalText,
      fontSize: 20,
      fontFamily: SERIF,
      fontWeight: "700",
      marginBottom: 4,
    },
    modalSub: {
      color: c.readerTextMuted,
      fontSize: 13,
      fontFamily: SERIF,
      marginBottom: 18,
    },
    modalInput: {
      width: "100%",
      backgroundColor: c.readerModalInputBg,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.readerModalBorder,
      color: c.readerModalText,
      fontSize: 28,
      fontFamily: SERIF,
      textAlign: "center",
      paddingVertical: 10,
      marginBottom: 20,
    },
    modalBtns: {
      flexDirection: "row",
      gap: 12,
      width: "100%",
    },
    modalCancel: {
      flex: 1,
      paddingVertical: 12,
      alignItems: "center",
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.readerModalBorder,
    },
    modalCancelText: {
      color: c.readerTextMuted,
      fontFamily: SERIF,
      fontSize: 15,
    },
    modalConfirm: {
      flex: 1,
      paddingVertical: 12,
      alignItems: "center",
      borderRadius: 8,
      backgroundColor: c.accent,
    },
    modalConfirmText: {
      color: "#18100A",
      fontFamily: SERIF,
      fontSize: 15,
      fontWeight: "700",
    },
  });
}
