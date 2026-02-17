import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../App';
import { firstIndexOfPage, WordEntry } from '../utils/pdfParser';
import { saveProgress, clearProgress } from '../utils/progress';

type Props = NativeStackScreenProps<RootStackParamList, 'Reader'>;

const SERIF = Platform.select({
  ios: 'Georgia',
  android: 'serif',
  default: 'Georgia',
});

const CONTEXT_BEFORE = 14;
const CONTEXT_AFTER = 14;

function midIndex(word: string): number {
  return Math.floor(word.length / 2);
}

function WordDisplay({ word }: { word: string }) {
  if (!word) return null;
  const mid = midIndex(word);
  return (
    <Text style={styles.word} allowFontScaling={false}>
      <Text style={styles.wordNormal}>{word.slice(0, mid)}</Text>
      <Text style={styles.wordHighlight}>{word.slice(mid, mid + 1)}</Text>
      <Text style={styles.wordNormal}>{word.slice(mid + 1)}</Text>
    </Text>
  );
}

function ContextDisplay({ words, currentIndex }: { words: WordEntry[]; currentIndex: number }) {
  const start = Math.max(0, currentIndex - CONTEXT_BEFORE);
  const end = Math.min(words.length, currentIndex + CONTEXT_AFTER + 1);
  const slice = words.slice(start, end);
  const hiOffset = currentIndex - start;

  return (
    <Text style={styles.context} numberOfLines={3}>
      {slice.map((w, i) => (
        <Text
          key={start + i}
          style={i === hiOffset ? styles.contextCurrent : styles.contextWord}
        >
          {i > 0 ? ' ' : ''}{w.word}
        </Text>
      ))}
    </Text>
  );
}

export default function ReaderScreen({ route, navigation }: Props) {
  const { words, wpm: initialWpm, numPages, startIndex, fileKey } = route.params;

  const [currentIndex, setCurrentIndex] = useState(startIndex);
  const [isPlaying, setIsPlaying] = useState(true);
  const [wpm, setWpm] = useState(initialWpm);
  const [showJumper, setShowJumper] = useState(false);
  const [pageInput, setPageInput] = useState('');
  const [showControls, setShowControls] = useState(false);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const indexRef = useRef(currentIndex);

  useEffect(() => { indexRef.current = currentIndex; }, [currentIndex]);

  const interval = useMemo(() => Math.round(60000 / wpm), [wpm]);

  const advance = useCallback(() => {
    const next = indexRef.current + 1;
    if (next >= words.length) { setIsPlaying(false); return; }
    setCurrentIndex(next);
  }, [words.length]);

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (isPlaying) intervalRef.current = setInterval(advance, interval);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [isPlaying, interval, advance]);

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

  // Clear saved progress when finished
  const isFinished = currentIndex >= words.length;
  useEffect(() => {
    if (isFinished) clearProgress(fileKey);
  }, [isFinished, fileKey]);

  const handleTap = useCallback(() => {
    setIsPlaying((p) => {
      const next = !p;
      if (!next) {
        // Pausing — save exact position immediately
        saveProgress(fileKey, { wordIndex: indexRef.current, page: words[indexRef.current]?.page ?? 1 });
      }
      return next;
    });
  }, [fileKey, words]);
  const handleLongPress = useCallback(() => setShowControls((v) => !v), []);

  const adjustWpm = (delta: number) =>
    setWpm((prev) => Math.min(750, Math.max(50, prev + delta)));

  const jumpToPage = useCallback(() => {
    const page = parseInt(pageInput, 10);
    if (isNaN(page) || page < 1 || page > numPages) {
      Alert.alert('Invalid page', `Enter a number between 1 and ${numPages}.`);
      return;
    }
    setCurrentIndex(firstIndexOfPage(words, page));
    setShowJumper(false);
    setPageInput('');
  }, [pageInput, numPages, words]);

  const handleBack = useCallback(async () => {
    setIsPlaying(false);
    const idx = indexRef.current;
    await saveProgress(fileKey, { wordIndex: idx, page: words[idx]?.page ?? 1 });
    navigation.goBack();
  }, [fileKey, words, navigation]);

  const progress = words.length > 0 ? currentIndex / words.length : 0;

  if (isFinished) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.doneContainer}>
          <Text style={styles.doneIcon}>◎</Text>
          <Text style={styles.doneTitle}>Finished</Text>
          <Text style={styles.doneSub}>
            {words.length.toLocaleString()} words · {wpm} wpm
          </Text>
          <TouchableOpacity style={styles.doneBtn} onPress={() => navigation.goBack()}>
            <Text style={styles.doneBtnText}>← Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Progress bar */}
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${progress * 100}%` as any }]} />
      </View>

      {/* Context paragraph */}
      <View style={styles.contextContainer}>
        <ContextDisplay words={words} currentIndex={currentIndex} />
      </View>

      {/* Reading area */}
      <TouchableWithoutFeedback onPress={handleTap} onLongPress={handleLongPress}>
        <View style={styles.wordArea}>
          <WordDisplay word={currentWord?.word ?? ''} />

          {!isPlaying && (
            <View style={styles.pausedHint}>
              <Text style={styles.pausedHintText}>tap to resume</Text>
            </View>
          )}
        </View>
      </TouchableWithoutFeedback>

      {/* Speed overlay (long-press) */}
      {showControls && (
        <View style={styles.speedBar}>
          <TouchableOpacity onPress={() => adjustWpm(-25)} style={styles.speedBtn}>
            <Text style={styles.speedBtnText}>−25</Text>
          </TouchableOpacity>
          <Text style={styles.speedValue}>{wpm} wpm</Text>
          <TouchableOpacity onPress={() => adjustWpm(25)} style={styles.speedBtn}>
            <Text style={styles.speedBtnText}>+25</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Bottom bar */}
      <View style={styles.bottomBar}>
        <TouchableOpacity onPress={handleBack} style={styles.backBtn}>
          <Text style={styles.backBtnText}>← back</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.pageBtn}
          onPress={() => { setIsPlaying(false); setShowJumper(true); }}
        >
          <Text style={styles.pageBtnText}>
            {currentPage} / {numPages}
          </Text>
        </TouchableOpacity>

        <Text style={styles.wpmLabel}>{wpm}</Text>
      </View>

      {/* Page jump modal */}
      <Modal visible={showJumper} transparent animationType="fade" onRequestClose={() => setShowJumper(false)}>
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Jump to page</Text>
            <Text style={styles.modalSub}>1 – {numPages}</Text>
            <TextInput
              style={styles.modalInput}
              value={pageInput}
              onChangeText={setPageInput}
              keyboardType="number-pad"
              placeholder={String(currentPage)}
              placeholderTextColor="#6a5a4a"
              autoFocus
              returnKeyType="go"
              onSubmitEditing={jumpToPage}
            />
            <View style={styles.modalBtns}>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => { setShowJumper(false); setPageInput(''); }}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalConfirm} onPress={jumpToPage}>
                <Text style={styles.modalConfirmText}>Jump</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#18100A',
  },

  progressTrack: {
    height: 2,
    backgroundColor: '#2C1D12',
  },
  progressFill: {
    height: 2,
    backgroundColor: '#C8A951',
  },

  // ── Context paragraph ─────────────────────────────────────────────────────
  contextContainer: {
    paddingHorizontal: 24,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#221508',
  },
  context: {
    fontFamily: SERIF,
    fontSize: 13,
    lineHeight: 20,
    color: '#4A3828',
    textAlign: 'center',
  },
  contextWord: {
    color: '#4A3828',
    fontFamily: SERIF,
    fontSize: 13,
  },
  contextCurrent: {
    color: '#9A8060',
    fontFamily: SERIF,
    fontSize: 13,
    fontWeight: '600',
  },

  // ── Word area ─────────────────────────────────────────────────────────────
  wordArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  word: {
    fontSize: 54,
    lineHeight: 64,
    textAlign: 'center',
    fontFamily: SERIF,
  },
  wordNormal: {
    color: '#F4ECD8',
    fontFamily: SERIF,
    fontSize: 54,
  },
  wordHighlight: {
    color: '#C8A951',
    fontFamily: SERIF,
    fontSize: 54,
    fontWeight: '700',
  },
  pausedHint: {
    position: 'absolute',
    bottom: 60,
  },
  pausedHintText: {
    color: '#6A5A4A',
    fontSize: 13,
    fontFamily: SERIF,
    letterSpacing: 0.5,
  },

  // ── Speed overlay ─────────────────────────────────────────────────────────
  speedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    backgroundColor: '#211509',
    gap: 24,
    borderTopWidth: 1,
    borderTopColor: '#2C1D12',
  },
  speedBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#4A3020',
    borderRadius: 6,
  },
  speedBtnText: {
    color: '#C8A951',
    fontSize: 14,
    fontFamily: SERIF,
  },
  speedValue: {
    color: '#F4ECD8',
    fontSize: 18,
    fontFamily: SERIF,
    minWidth: 90,
    textAlign: 'center',
  },

  // ── Bottom bar ────────────────────────────────────────────────────────────
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 16,
    backgroundColor: '#120C06',
    borderTopWidth: 1,
    borderTopColor: '#2C1D12',
  },
  backBtn: { minWidth: 60 },
  backBtnText: {
    color: '#6A5A4A',
    fontSize: 13,
    fontFamily: SERIF,
  },
  pageBtn: { alignItems: 'center' },
  pageBtnText: {
    color: '#C8A951',
    fontSize: 16,
    fontFamily: SERIF,
    fontWeight: '600',
  },
  wpmLabel: {
    color: '#6A5A4A',
    fontSize: 13,
    fontFamily: SERIF,
    minWidth: 60,
    textAlign: 'right',
  },

  // ── Done screen ───────────────────────────────────────────────────────────
  doneContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  doneIcon: {
    fontSize: 48,
    color: '#C8A951',
    marginBottom: 20,
  },
  doneTitle: {
    color: '#F4ECD8',
    fontSize: 32,
    fontFamily: SERIF,
    fontWeight: '700',
    marginBottom: 8,
  },
  doneSub: {
    color: '#6A5A4A',
    fontSize: 15,
    fontFamily: SERIF,
    marginBottom: 40,
  },
  doneBtn: {
    borderWidth: 1,
    borderColor: '#C8A951',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 32,
  },
  doneBtnText: {
    color: '#C8A951',
    fontSize: 16,
    fontFamily: SERIF,
  },

  // ── Page jump modal ───────────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCard: {
    width: '78%',
    backgroundColor: '#211509',
    borderRadius: 12,
    padding: 28,
    borderWidth: 1,
    borderColor: '#3A2515',
    alignItems: 'center',
  },
  modalTitle: {
    color: '#F4ECD8',
    fontSize: 20,
    fontFamily: SERIF,
    fontWeight: '700',
    marginBottom: 4,
  },
  modalSub: {
    color: '#6A5A4A',
    fontSize: 13,
    fontFamily: SERIF,
    marginBottom: 18,
  },
  modalInput: {
    width: '100%',
    backgroundColor: '#180E06',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#3A2515',
    color: '#F4ECD8',
    fontSize: 28,
    fontFamily: SERIF,
    textAlign: 'center',
    paddingVertical: 10,
    marginBottom: 20,
  },
  modalBtns: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  modalCancel: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#3A2515',
  },
  modalCancelText: {
    color: '#6A5A4A',
    fontFamily: SERIF,
    fontSize: 15,
  },
  modalConfirm: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: '#C8A951',
  },
  modalConfirmText: {
    color: '#18100A',
    fontFamily: SERIF,
    fontSize: 15,
    fontWeight: '700',
  },
});
