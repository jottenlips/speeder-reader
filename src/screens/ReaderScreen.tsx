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
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../App";
import { firstIndexOfPage, WordEntry } from "../utils/pdfParser";
import { saveProgress, clearProgress } from "../utils/progress";
import { archiveItem } from "../utils/library";
import { t } from "../utils/i18n";
import { useLanguage } from "../contexts/LanguageContext";
import { useTheme } from "../contexts/ThemeContext";
import { getTheme, ThemeColors } from "../utils/theme";

// WebView is only used on native for the dictionary modal; web uses window.open instead
const WebView =
  Platform.OS !== "web" ? require("react-native-webview").default : null;

type Props = NativeStackScreenProps<RootStackParamList, "Reader">;

const SERIF = Platform.select({
  ios: "Georgia",
  android: "serif",
  default: "Georgia",
});

const CONTEXT_LINES = 5;
const WORDS_PER_LINE_EST = 8; // rough estimate for advance threshold
const CONTEXT_WINDOW = WORDS_PER_LINE_EST * CONTEXT_LINES; // ~40 words fills 5 lines

// ORP: middle letter for odd-length words; left-of-center for even-length words
function midIndex(word: string): number {
  return Math.ceil(word.length / 2) - 1;
}

function WordDisplay({ word, c }: { word: string; c: ThemeColors }) {
  if (!word) return null;
  const mid = midIndex(word);
  const before = word.slice(0, mid);
  const highlight = word.slice(mid, mid + 1);
  const after = word.slice(mid + 1);
  return (
    // flex-row: left half right-aligns up to center, highlight sits at center,
    // right half left-aligns from center — ORP always at screen midpoint
    <View style={wordRowStyle}>
      <View style={wordLeftStyle}>
        <Text
          style={{ color: c.readerText, fontFamily: SERIF, fontSize: 38 }}
          allowFontScaling={false}
        >
          {before}
        </Text>
      </View>
      <Text
        style={{
          color: c.accent,
          fontFamily: SERIF,
          fontSize: 38,
          fontWeight: "700",
        }}
        allowFontScaling={false}
      >
        {highlight}
      </Text>
      <View style={wordRightStyle}>
        <Text
          style={{ color: c.readerText, fontFamily: SERIF, fontSize: 38 }}
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
  onLastVisibleIndex,
}: {
  words: WordEntry[];
  windowStart: number;
  currentIndex: number;
  c: ThemeColors;
  onLastVisibleIndex: (idx: number) => void;
}) {
  // Show words from windowStart; render extra so numberOfLines/overflow clips cleanly
  const displayEnd = Math.min(words.length, windowStart + CONTEXT_WINDOW + 40);
  const slice = words.slice(windowStart, displayEnd);
  const hiOffset = currentIndex - windowStart;

  const containerRef = useRef<any>(null);
  const measuredWindowRef = useRef<number>(-1);

  // Native: use onTextLayout lines data
  const handleTextLayout = useCallback(
    (e: any) => {
      const lines: Array<{ text: string }> | undefined = e.nativeEvent?.lines;
      if (!lines || lines.length === 0) return;
      // Reset when window changes
      if (measuredWindowRef.current !== windowStart) {
        measuredWindowRef.current = windowStart;
      }
      const combined = lines.map((l) => l.text).join("");
      const visibleWordCount = combined
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
      const lastIdx = Math.min(
        words.length - 1,
        windowStart + visibleWordCount - 1,
      );
      onLastVisibleIndex(Math.max(windowStart, lastIdx));
    },
    [words.length, windowStart, onLastVisibleIndex],
  );

  // Web: DOM-based measurement — count child spans within the visible container bounds
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = containerRef.current;
    if (!el) return;
    // Small delay to allow layout to settle
    const timer = setTimeout(() => {
      const node =
        el instanceof HTMLElement ? el : ((el as any)?._nativeTag ?? null);
      if (!node || !(node instanceof HTMLElement)) return;
      const containerRect = node.getBoundingClientRect();
      const containerBottom = containerRect.bottom;
      const spans = node.querySelectorAll("span");
      let lastVisible = windowStart;
      let wordIdx = 0;
      for (let i = 0; i < spans.length; i++) {
        const span = spans[i];
        // Skip wrapper spans that contain children (only count leaf text spans)
        if (span.children.length > 0) continue;
        const rect = span.getBoundingClientRect();
        if (rect.top < containerBottom && rect.height > 0) {
          lastVisible = windowStart + wordIdx;
        }
        wordIdx++;
      }
      onLastVisibleIndex(Math.max(windowStart, lastVisible));
    }, 20);
    return () => clearTimeout(timer);
  }, [windowStart, currentIndex, words.length, onLastVisibleIndex]);

  const containerHeight = CONTEXT_LINES * 20 + 2; // lineHeight = 20, +2 for sub-pixel tolerance

  return (
    <Text
      ref={containerRef}
      style={{
        fontFamily: SERIF,
        fontSize: 13,
        lineHeight: 20,
        color: c.readerContextWord,
        textAlign: "left",
        maxHeight: containerHeight,
        overflow: "hidden",
      }}
      numberOfLines={Platform.OS !== "web" ? CONTEXT_LINES : undefined}
      ellipsizeMode={Platform.OS !== "web" ? "clip" : undefined}
      onTextLayout={handleTextLayout}
    >
      {slice.map((w, i) => (
        <Text
          key={windowStart + i}
          style={
            i === hiOffset
              ? {
                  color: c.readerContextCurrent,
                  fontFamily: SERIF,
                  fontSize: 13,
                }
              : { color: c.readerContextWord, fontFamily: SERIF, fontSize: 13 }
          }
        >
          {i > 0 ? " " : ""}
          {w.word}
        </Text>
      ))}
    </Text>
  );
}

export default function ReaderScreen({ route, navigation }: Props) {
  const { lang } = useLanguage();
  const { scheme, toggleTheme } = useTheme();
  const c = getTheme(scheme);
  const styles = useMemo(() => makeStyles(c), [scheme]);

  const {
    words,
    wpm: initialWpm,
    numPages,
    startIndex,
    fileKey,
    isLibraryItem,
  } = route.params;

  const [currentIndex, setCurrentIndex] = useState(startIndex);
  const [windowStart, setWindowStart] = useState(() => Math.max(0, startIndex));
  const windowStartRef = useRef(Math.max(0, startIndex));
  // Tracks the actual last visible word index measured from onTextLayout
  const lastVisibleIndexRef = useRef(startIndex + CONTEXT_WINDOW - 1);
  const [isPlaying, setIsPlaying] = useState(true);
  const [wpm, setWpm] = useState(initialWpm);
  const [showJumper, setShowJumper] = useState(false);
  const [pageInput, setPageInput] = useState("");

  const [flowReading, setFlowReading] = useState(true);

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

  // Called by ContextDisplay after each text layout measurement
  const handleLastVisibleIndex = useCallback((idx: number) => {
    lastVisibleIndexRef.current = idx;
  }, []);

  // Advance context window only when the highlighted word reaches the last visible word
  // (measured by onTextLayout), not on a word-count estimate.
  // Overlap ensures words near the boundary appear in both old and new windows,
  // preventing skipped words when bold reflow causes slight measurement variance.
  const WINDOW_OVERLAP = 3;
  useEffect(() => {
    const ws = windowStartRef.current;
    if (currentIndex < ws) {
      // Stepped backwards past window start — pull window back
      const next = Math.max(0, currentIndex);
      windowStartRef.current = next;
      lastVisibleIndexRef.current = next + CONTEXT_WINDOW - 1; // reset estimate; layout will correct it
      setWindowStart(next);
    } else if (currentIndex > lastVisibleIndexRef.current) {
      // Highlighted word has passed the last visible word — advance with overlap
      const next = Math.max(0, currentIndex - WINDOW_OVERLAP);
      windowStartRef.current = next;
      lastVisibleIndexRef.current = next + CONTEXT_WINDOW - 1; // reset estimate; layout will correct it
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

  // Clear saved progress when finished; auto-archive library items
  const isFinished = currentIndex >= words.length;
  useEffect(() => {
    if (isFinished) {
      clearProgress(fileKey);
      if (isLibraryItem) archiveItem(fileKey);
    }
  }, [isFinished, fileKey, isLibraryItem]);

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
      const jump = Math.max(1, lastVisibleIndexRef.current - windowStartRef.current);
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
    setWpm((prev) => Math.min(750, Math.max(50, prev + delta)));

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
          onLastVisibleIndex={handleLastVisibleIndex}
        />
      </View>

      {/* Reading area */}
      <TouchableWithoutFeedback onPress={handleTap}>
        <View style={styles.wordArea}>
          <WordDisplay word={currentWord?.word ?? ""} c={c} />

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
              {scheme === "dark" ? "☀" : "☾"}
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

function makeStyles(c: ThemeColors) {
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
