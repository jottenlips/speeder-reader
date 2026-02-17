/**
 * Web-specific HomeScreen — supports PDF, EPUB, HTML, Markdown, plain text.
 * PDF/EPUB parsed in a hidden <iframe> via PARSER_HTML (PDF.js + JSZip on CDN).
 * TXT/MD/HTML parsed directly in JS (no network dependency).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import Logo from '../components/Logo';
import { buildWordList, firstIndexOfPage, PARSER_HTML, WordEntry } from '../utils/pdfParser';
import { detectFileType, FileType, parseTextContent } from '../utils/textParser';
import { loadProgress, clearProgress, makeFileKey, SavedProgress } from '../utils/progress';
import type { RootStackParamList } from '../../App';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;
type ParseState = 'idle' | 'loading' | 'parsing' | 'ready' | 'error';
type InputMode = 'file' | 'url';

const SERIF = Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia' });
const MAX_WPM = 750;

const FORMAT_LABEL: Record<FileType, string> = {
  pdf: 'PDF', epub: 'EPUB', html: 'HTML', md: 'Markdown', txt: 'Plain text',
};

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file, 'utf-8');
  });
}

export default function HomeScreen({ navigation }: Props) {
  const [wpm, setWpm] = useState(250);
  const [parseState, setParseState] = useState<ParseState>('idle');
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileType, setFileType] = useState<FileType>('pdf');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [words, setWords] = useState<WordEntry[]>([]);
  const [numPages, setNumPages] = useState(0);
  const [inputMode, setInputMode] = useState<InputMode>('file');
  const [pdfUrl, setPdfUrl] = useState('');

  // Progress / starting page state
  const [fileKey, setFileKey] = useState('');
  const [savedProgress, setSavedProgress] = useState<SavedProgress | null>(null);
  const [startPage, setStartPage] = useState(1);
  const [startPageText, setStartPageText] = useState('1');
  const [startWordIndex, setStartWordIndex] = useState(0);

  // Refs so the focus listener always reads the latest values without re-registering
  const fileKeyRef = useRef<string>('');
  const parseStateRef = useRef<ParseState>('idle');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const iframeReady = useRef(false);
  const pendingMsg = useRef<object | null>(null);

  const [iframeSrc] = useState(() => {
    const blob = new Blob([PARSER_HTML], { type: 'text/html' });
    return URL.createObjectURL(blob);
  });
  useEffect(() => () => URL.revokeObjectURL(iframeSrc), [iframeSrc]);

  const sendToIframe = useCallback((msg: object) => {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify(msg), '*');
  }, []);

  const dispatch = useCallback((msg: object) => {
    if (iframeReady.current) sendToIframe(msg);
    else pendingMsg.current = msg;
  }, [sendToIframe]);

  // Messages from iframe
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (!event.data) return;
      try {
        const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        switch (msg.type) {
          case 'READY':
            iframeReady.current = true;
            if (pendingMsg.current) { sendToIframe(pendingMsg.current); pendingMsg.current = null; }
            break;
          case 'PROGRESS':
            setProgress({ current: msg.current, total: msg.total });
            break;
          case 'DONE': {
            const parsed = buildWordList(msg.pages as string[]);
            setWords(parsed);
            setNumPages(msg.numPages as number);
            setParseState('ready');
            break;
          }
          case 'ERROR':
            alert('Parse error: ' + (msg.error ?? 'unknown'));
            setParseState('error');
            break;
        }
      } catch (_) {}
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [sendToIframe]);

  // Mount hidden file input + iframe
  useEffect(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.epub,.txt,.md,.markdown,.html,.htm';
    input.style.display = 'none';
    document.body.appendChild(input);
    fileInputRef.current = input;

    const iframe = document.createElement('iframe');
    iframe.src = iframeSrc;
    iframe.style.cssText = 'display:none;width:0;height:0;border:none;';
    document.body.appendChild(iframe);
    iframeRef.current = iframe;

    return () => {
      document.body.removeChild(input);
      document.body.removeChild(iframe);
    };
  }, [iframeSrc]);

  // Keep refs current so the focus listener always has fresh values
  fileKeyRef.current = fileKey;
  parseStateRef.current = parseState;

  const applyProgress = useCallback((saved: SavedProgress | null) => {
    setSavedProgress(saved);
    const page = saved?.page ?? 1;
    const wordIdx = saved?.wordIndex ?? 0;
    setStartPage(page);
    setStartPageText(String(page));
    setStartWordIndex(wordIdx);
  }, []);

  // Load saved progress whenever parsing first finishes
  useEffect(() => {
    if (parseState !== 'ready' || !fileKey) return;
    loadProgress(fileKey).then(applyProgress);
  }, [parseState, fileKey, applyProgress]);

  // Re-load saved progress whenever the screen comes back into focus (e.g. returning from Reader)
  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      if (!fileKeyRef.current || parseStateRef.current !== 'ready') return;
      loadProgress(fileKeyRef.current).then(applyProgress);
    });
    return unsubscribe;
  }, [navigation, applyProgress]);

  // ── File upload ───────────────────────────────────────────────────────────
  const pickFile = useCallback(() => {
    const input = fileInputRef.current;
    if (!input) return;
    const handleChange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      input.removeEventListener('change', handleChange);

      const name = file.name;
      const type = detectFileType(name);
      const key = makeFileKey(name);

      setFileName(name);
      setFileType(type);
      setFileKey(key);
      setSavedProgress(null);
      setStartPage(1);
      setStartPageText('1');
      setStartWordIndex(0);
      setParseState('loading');
      setWords([]);
      setProgress({ current: 0, total: 0 });

      try {
        if (type === 'txt' || type === 'md' || type === 'html') {
          const raw = await readFileAsText(file);
          const { words: parsed, numPages: np } = parseTextContent(raw, type);
          setWords(parsed);
          setNumPages(np);
          setParseState('ready');
        } else {
          const base64 = await readFileAsBase64(file);
          const msgType = type === 'epub' ? 'PARSE_EPUB' : 'PARSE_PDF';
          setParseState('parsing');
          dispatch({ type: msgType, base64 });
        }
      } catch (err) {
        alert('Failed to read file: ' + (err instanceof Error ? err.message : String(err)));
        setParseState('error');
      }
      input.value = '';
    };
    input.addEventListener('change', handleChange);
    input.click();
  }, [dispatch]);

  // ── URL load ──────────────────────────────────────────────────────────────
  const loadFromUrl = useCallback(async () => {
    const url = pdfUrl.trim();
    if (!url) return;

    const name = url.split('/').pop()?.split('?')[0] ?? 'document';
    const type = detectFileType(name);
    const key = makeFileKey(url);

    setFileName(name);
    setFileType(type);
    setFileKey(key);
    setSavedProgress(null);
    setStartPage(1);
    setStartPageText('1');
    setStartWordIndex(0);
    setParseState('loading');
    setWords([]);
    setProgress({ current: 0, total: 0 });

    try {
      if (type === 'txt' || type === 'md' || type === 'html') {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.text();
        const { words: parsed, numPages: np } = parseTextContent(raw, type);
        setWords(parsed);
        setNumPages(np);
        setParseState('ready');
      } else if (type === 'pdf') {
        setParseState('parsing');
        dispatch({ type: 'PARSE_PDF_URL', url });
      } else {
        // EPUB: fetch as binary, convert to base64
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const base64 = btoa(bin);
        setParseState('parsing');
        dispatch({ type: 'PARSE_EPUB', base64 });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      alert('Failed to load from URL: ' + msg + (msg.includes('fetch') ? '\n\nThe server may not allow cross-origin requests (CORS).' : ''));
      setParseState('error');
    }
  }, [pdfUrl, dispatch]);

  const startReading = useCallback(() => {
    navigation.navigate('Reader', { words, wpm, numPages, startIndex: startWordIndex, fileKey });
  }, [navigation, words, wpm, numPages, startWordIndex, fileKey]);

  const adjustWpm = (delta: number) =>
    setWpm((prev) => Math.min(MAX_WPM, Math.max(50, prev + delta)));

  const adjustStartPage = (delta: number) => {
    setStartPage((prev) => {
      const next = Math.min(numPages, Math.max(1, prev + delta));
      setStartPageText(String(next));
      setStartWordIndex(firstIndexOfPage(words, next));
      return next;
    });
  };

  const handleStartPageText = (t: string) => {
    setStartPageText(t);
    const n = parseInt(t, 10);
    if (!isNaN(n) && n >= 1 && n <= numPages) {
      setStartPage(n);
      setStartWordIndex(firstIndexOfPage(words, n));
    }
  };

  const isBusy = parseState === 'loading' || parseState === 'parsing';
  const fillPct = ((wpm - 50) / (MAX_WPM - 50)) * 100;

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">

        <View style={styles.header}>
          <Logo size={56} color="#382110" />
          <Text style={styles.title}>SpeederReader</Text>
        </View>

        {/* WPM */}
        <View style={styles.section}>
          <Text style={styles.label}>Reading speed</Text>
          <View style={styles.wpmRow}>
            <TouchableOpacity style={styles.wpmBtn} onPress={() => adjustWpm(-25)}>
              <Text style={styles.wpmBtnText}>−</Text>
            </TouchableOpacity>
            <Text style={styles.wpmValue}>{wpm} wpm</Text>
            <TouchableOpacity style={styles.wpmBtn} onPress={() => adjustWpm(25)}>
              <Text style={styles.wpmBtnText}>+</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.trackWrap}>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${fillPct}%` as any }]} />
            </View>
            <View style={styles.trackLabels}>
              <Text style={styles.trackLabel}>50</Text>
              <Text style={styles.trackLabel}>{MAX_WPM}</Text>
            </View>
          </View>
        </View>

        <View style={styles.divider} />

        {/* Mode toggle */}
        <View style={styles.modeToggle}>
          <TouchableOpacity
            style={[styles.modeBtn, inputMode === 'file' && styles.modeBtnActive]}
            onPress={() => setInputMode('file')}
          >
            <Text style={[styles.modeBtnText, inputMode === 'file' && styles.modeBtnActiveText]}>Upload file</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeBtn, inputMode === 'url' && styles.modeBtnActive]}
            onPress={() => setInputMode('url')}
          >
            <Text style={[styles.modeBtnText, inputMode === 'url' && styles.modeBtnActiveText]}>From URL</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.formatsNote}>PDF · EPUB · HTML · Markdown · Plain text</Text>

        {inputMode === 'file' && (
          <TouchableOpacity style={[styles.uploadBtn, isBusy && styles.dimmed]} onPress={pickFile} disabled={isBusy}>
            <Text style={styles.uploadBtnText}>
              {isBusy
                ? parseState === 'loading' ? 'Reading…' : 'Parsing…'
                : parseState === 'ready' ? 'Choose another' : 'Choose file'}
            </Text>
          </TouchableOpacity>
        )}

        {inputMode === 'url' && (
          <View style={styles.urlRow}>
            <TextInput
              style={styles.urlInput}
              value={pdfUrl}
              onChangeText={setPdfUrl}
              placeholder="https://example.com/book.epub"
              placeholderTextColor="#B8AFA8"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={loadFromUrl}
              editable={!isBusy}
            />
            <TouchableOpacity
              style={[styles.urlBtn, (isBusy || !pdfUrl.trim()) && styles.dimmed]}
              onPress={loadFromUrl}
              disabled={isBusy || !pdfUrl.trim()}
            >
              <Text style={styles.urlBtnText}>{isBusy ? '…' : 'Load'}</Text>
            </TouchableOpacity>
          </View>
        )}

        {isBusy && (
          <View style={styles.progressRow}>
            <ActivityIndicator color="#C8A951" size="small" />
            <Text style={styles.progressText}>
              {parseState === 'loading'
                ? 'Fetching…'
                : `${FORMAT_LABEL[fileType]} · page ${progress.current}${progress.total ? ` of ${progress.total}` : ''}…`}
            </Text>
          </View>
        )}

        {parseState === 'ready' && fileName && (
          <View style={styles.fileInfo}>
            <Text style={styles.fileInfoName} numberOfLines={1}>✓  {fileName}</Text>
            <Text style={styles.fileInfoMeta}>
              {FORMAT_LABEL[fileType]} · {numPages} {numPages === 1 ? 'page' : 'pages'} · {words.length.toLocaleString()} words
            </Text>
          </View>
        )}

        {parseState === 'ready' && (
          <>
            {/* Saved progress banner */}
            {savedProgress && (
              <View style={styles.savedBanner}>
                <Text style={styles.savedText}>
                  Saved progress: page {savedProgress.page}
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    clearProgress(fileKey);
                    setSavedProgress(null);
                    setStartPage(1);
                    setStartPageText('1');
                  }}
                >
                  <Text style={styles.savedClear}>Clear</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Start page picker */}
            <View style={styles.startPageRow}>
              <Text style={styles.startPageLabel}>Start from page</Text>
              <View style={styles.startPageControls}>
                <TouchableOpacity style={styles.startPageBtn} onPress={() => adjustStartPage(-1)}>
                  <Text style={styles.startPageBtnText}>−</Text>
                </TouchableOpacity>
                <TextInput
                  style={styles.startPageInput}
                  value={startPageText}
                  onChangeText={handleStartPageText}
                  keyboardType="number-pad"
                  selectTextOnFocus
                />
                <TouchableOpacity style={styles.startPageBtn} onPress={() => adjustStartPage(1)}>
                  <Text style={styles.startPageBtnText}>+</Text>
                </TouchableOpacity>
              </View>
            </View>

            <TouchableOpacity style={styles.startBtn} onPress={startReading}>
              <Text style={styles.startBtnText}>Start reading</Text>
            </TouchableOpacity>
          </>
        )}

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F4F1EA' },
  scroll: { paddingHorizontal: 28, paddingVertical: 40, maxWidth: 520, alignSelf: 'center' as any, width: '100%' },

  header: { alignItems: 'center', marginBottom: 40, gap: 14 },
  title: { fontSize: 28, fontFamily: SERIF, fontWeight: '700', color: '#382110', letterSpacing: 0.3 },

  section: { marginBottom: 8 },
  label: { fontSize: 11, fontFamily: SERIF, color: '#908787', textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 16 },

  wpmRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  wpmBtn: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: '#D4C9BC', alignItems: 'center', justifyContent: 'center' },
  wpmBtnText: { fontSize: 20, color: '#382110', lineHeight: 22 },
  wpmValue: { fontSize: 26, fontFamily: SERIF, fontWeight: '700', color: '#382110' },

  trackWrap: { marginBottom: 4 },
  track: { height: 3, backgroundColor: '#E8E2D9', borderRadius: 2, overflow: 'hidden', marginBottom: 6 },
  fill: { height: 3, backgroundColor: '#C8A951', borderRadius: 2 },
  trackLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  trackLabel: { fontSize: 11, color: '#C0B8B0', fontFamily: SERIF },

  divider: { height: 1, backgroundColor: '#E8E2D9', marginVertical: 28 },

  modeToggle: { flexDirection: 'row', marginBottom: 10, borderWidth: 1, borderColor: '#D4C9BC', borderRadius: 8, overflow: 'hidden' },
  modeBtn: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  modeBtnActive: { backgroundColor: '#382110' },
  modeBtnText: { fontFamily: SERIF, fontSize: 14, color: '#908787' },
  modeBtnActiveText: { color: '#F4F1EA' },

  formatsNote: { fontFamily: SERIF, fontSize: 11, color: '#C0B8B0', textAlign: 'center', marginBottom: 18 },

  uploadBtn: { borderWidth: 1, borderColor: '#D4C9BC', borderRadius: 8, borderStyle: 'dashed', paddingVertical: 20, alignItems: 'center', marginBottom: 16 },
  dimmed: { opacity: 0.45 },
  uploadBtnText: { fontFamily: SERIF, fontSize: 16, color: '#382110' },

  urlRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  urlInput: { flex: 1, backgroundColor: '#FDFAF5', borderRadius: 8, borderWidth: 1, borderColor: '#D4C9BC', fontFamily: SERIF, fontSize: 14, color: '#382110', paddingHorizontal: 12, paddingVertical: 11 },
  urlBtn: { backgroundColor: '#382110', borderRadius: 8, paddingHorizontal: 18, justifyContent: 'center' },
  urlBtnText: { color: '#F4F1EA', fontFamily: SERIF, fontSize: 15, fontWeight: '600' },

  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 },
  progressText: { fontFamily: SERIF, fontSize: 14, color: '#908787' },

  fileInfo: { backgroundColor: '#FDFAF5', borderRadius: 8, borderWidth: 1, borderColor: '#D4C9BC', padding: 14, marginBottom: 16 },
  fileInfoName: { fontFamily: SERIF, fontSize: 14, color: '#382110', fontWeight: '600' },
  fileInfoMeta: { fontFamily: SERIF, fontSize: 12, color: '#908787', marginTop: 3 },

  // Saved progress banner
  savedBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FDF6E3', borderRadius: 8, borderWidth: 1, borderColor: '#E8D8A0', paddingHorizontal: 14, paddingVertical: 10, marginBottom: 14 },
  savedText: { fontFamily: SERIF, fontSize: 13, color: '#6B5B2E' },
  savedClear: { fontFamily: SERIF, fontSize: 12, color: '#A89040', textDecorationLine: 'underline' },

  // Start page picker
  startPageRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 },
  startPageLabel: { fontFamily: SERIF, fontSize: 14, color: '#6B5B4E' },
  startPageControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  startPageBtn: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, borderColor: '#D4C9BC', alignItems: 'center', justifyContent: 'center' },
  startPageBtnText: { fontSize: 18, color: '#382110', lineHeight: 20 },
  startPageInput: { width: 58, backgroundColor: '#FDFAF5', borderRadius: 6, borderWidth: 1, borderColor: '#D4C9BC', fontFamily: SERIF, fontSize: 15, color: '#382110', textAlign: 'center', paddingVertical: 5 },

  startBtn: { backgroundColor: '#382110', borderRadius: 8, paddingVertical: 16, alignItems: 'center' },
  startBtnText: { fontFamily: SERIF, fontSize: 18, fontWeight: '700', color: '#F4F1EA', letterSpacing: 0.3 },
});
