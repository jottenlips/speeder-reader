/**
 * Web HomeScreen — Article library (Matter/Pocket-style).
 *
 * Primary flow  : Save URL → article appears in Inbox → tap to read →
 *                 auto-archived when finished.
 * Secondary flow: Upload file (PDF/EPUB/etc.) or browse Project Gutenberg →
 *                 navigates directly to reader without going through library.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Linking,
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
import {
  buildWordList,
  firstIndexOfPage,
  PARSER_HTML,
  WordEntry,
} from '../utils/pdfParser';
import {
  detectFileType,
  FileType,
  parseTextContent,
} from '../utils/textParser';
import { loadProgress, clearProgress, makeFileKey, SavedProgress } from '../utils/progress';
import {
  GutenbergBook,
  GutenbergFormat,
  bestGutenbergFormat,
  fetchGutenbergSearch,
} from '../utils/gutenberg';
import { t, formatTimeLeft } from '../utils/i18n';
import { useLanguage } from '../contexts/LanguageContext';
import { useTheme } from '../contexts/ThemeContext';
import { getTheme, ThemeColors } from '../utils/theme';
import type { RootStackParamList } from '../../App';
import {
  LibraryItem,
  getLibrary,
  addToLibrary,
  updateLibraryItem,
  archiveItem as archiveLibraryItem,
  unarchiveItem,
  removeFromLibrary,
} from '../utils/library';
import { fetchArticle } from '../utils/articleFetcher';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;
type ParseState = 'idle' | 'loading' | 'parsing' | 'ready' | 'error';
type LibraryTab = 'inbox' | 'archive';

const SERIF = Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia' });
const MAX_WPM = 750;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatSavedDate(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  const hrs = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsText(file, 'utf-8');
  });
}

// ─── ArticleCard ──────────────────────────────────────────────────────────────

function ArticleCard({
  item,
  isLoading,
  wpm,
  onRead,
  onArchive,
  onUnarchive,
  onDelete,
  c,
  styles,
}: {
  item: LibraryItem;
  isLoading: boolean;
  wpm: number;
  onRead: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onDelete: () => void;
  c: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
}) {
  const readMins =
    item.totalWords > 0
      ? Math.max(1, Math.ceil(item.totalWords / wpm))
      : null;

  return (
    <TouchableOpacity
      style={styles.articleCard}
      onPress={onRead}
      disabled={isLoading}
      activeOpacity={0.75}
    >
      <View style={styles.articleCardBody}>
        <Text style={styles.articleTitle} numberOfLines={2}>
          {item.title}
        </Text>
        <View style={styles.articleMetaRow}>
          <Text style={styles.articleSite}>{item.siteName}</Text>
          {readMins != null && (
            <Text style={styles.articleReadTime}> · {readMins} min read</Text>
          )}
        </View>
        {item.description ? (
          <Text style={styles.articleDesc} numberOfLines={2}>
            {item.description}
          </Text>
        ) : null}
        <Text style={styles.articleDate}>{formatSavedDate(item.savedAt)}</Text>
      </View>

      <View style={styles.articleCardActions}>
        {isLoading ? (
          <ActivityIndicator size="small" color={c.accent} />
        ) : (
          <>
            {onArchive && (
              <TouchableOpacity style={styles.cardAction} onPress={onArchive}>
                <Text style={styles.cardActionText}>Archive</Text>
              </TouchableOpacity>
            )}
            {onUnarchive && (
              <TouchableOpacity style={styles.cardAction} onPress={onUnarchive}>
                <Text style={styles.cardActionText}>Unarchive</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.cardAction} onPress={onDelete}>
              <Text style={[styles.cardActionText, styles.cardDeleteText]}>
                Delete
              </Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ─── EmptyState ───────────────────────────────────────────────────────────────

function EmptyState({ tab, styles }: { tab: LibraryTab; styles: ReturnType<typeof makeStyles> }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyIcon}>{tab === 'inbox' ? '◎' : '✓'}</Text>
      <Text style={styles.emptyTitle}>
        {tab === 'inbox' ? 'Your inbox is empty' : 'Nothing archived yet'}
      </Text>
      <Text style={styles.emptySub}>
        {tab === 'inbox'
          ? 'Paste an article URL above to save it for later.'
          : 'Articles move here automatically once you finish reading.'}
      </Text>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function HomeScreen({ navigation }: Props) {
  const { lang, toggleLang } = useLanguage();
  const { scheme, toggleTheme } = useTheme();
  const c = getTheme(scheme);
  const styles = useMemo(() => makeStyles(c), [scheme]);

  // ── WPM ───────────────────────────────────────────────────────────────────
  const [wpm, setWpm] = useState(250);
  const adjustWpm = (d: number) =>
    setWpm((p) => Math.min(MAX_WPM, Math.max(50, p + d)));
  const fillPct = ((wpm - 50) / (MAX_WPM - 50)) * 100;

  // ── Library state ─────────────────────────────────────────────────────────
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [activeTab, setActiveTab] = useState<LibraryTab>('inbox');
  const [urlInput, setUrlInput] = useState('');
  const [savingUrl, setSavingUrl] = useState(false);
  const [loadingItemId, setLoadingItemId] = useState<string | null>(null);

  const refreshLibrary = useCallback(async () => {
    const items = await getLibrary();
    setLibraryItems(items);
  }, []);

  // Load on mount
  useEffect(() => { refreshLibrary(); }, [refreshLibrary]);

  // Reload when returning from reader
  useEffect(() => {
    const unsub = navigation.addListener('focus', refreshLibrary);
    return unsub;
  }, [navigation, refreshLibrary]);

  // ── Direct file reading state (bypasses library) ──────────────────────────
  const [parseState, setParseState] = useState<ParseState>('idle');
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileType, setFileType] = useState<FileType>('pdf');
  const [fileProgress, setFileProgress] = useState({ current: 0, total: 0 });
  const [words, setWords] = useState<WordEntry[]>([]);
  const [numPages, setNumPages] = useState(0);
  const [fileKey, setFileKey] = useState('');
  const [savedFileProgress, setSavedFileProgress] = useState<SavedProgress | null>(null);
  const [startPage, setStartPage] = useState(1);
  const [startPageText, setStartPageText] = useState('1');
  const [startWordIndex, setStartWordIndex] = useState(0);

  const fileKeyRef = useRef('');
  const parseStateRef = useRef<ParseState>('idle');
  fileKeyRef.current = fileKey;
  parseStateRef.current = parseState;

  // ── Gutenberg state ───────────────────────────────────────────────────────
  const [showGutenberg, setShowGutenberg] = useState(false);
  const [gutenbergQuery, setGutenbergQuery] = useState('');
  const [gutenbergResults, setGutenbergResults] = useState<GutenbergBook[]>([]);
  const [gutenbergSearching, setGutenbergSearching] = useState(false);

  // ── Hidden iframe + file input ────────────────────────────────────────────
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

  const dispatch = useCallback(
    (msg: object) => {
      if (iframeReady.current) sendToIframe(msg);
      else pendingMsg.current = msg;
    },
    [sendToIframe],
  );

  // Iframe messages
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
            setFileProgress({ current: msg.current, total: msg.total });
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

  // Load file progress when parse finishes
  const applyFileProgress = useCallback((saved: SavedProgress | null) => {
    setSavedFileProgress(saved);
    const page = saved?.page ?? 1;
    const wordIdx = saved?.wordIndex ?? 0;
    setStartPage(page);
    setStartPageText(String(page));
    setStartWordIndex(wordIdx);
  }, []);

  useEffect(() => {
    if (parseState !== 'ready' || !fileKey) return;
    loadProgress(fileKey).then(applyFileProgress);
  }, [parseState, fileKey, applyFileProgress]);

  // ── Library handlers ──────────────────────────────────────────────────────

  const handleSaveUrl = useCallback(async () => {
    let url = urlInput.trim();
    if (!url || savingUrl) return;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    setSavingUrl(true);

    const id = `article_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    let domain = url;
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch {}

    const newItem: LibraryItem = {
      id,
      url,
      title: domain,
      description: '',
      siteName: domain,
      estimatedMinutes: 0,
      savedAt: Date.now(),
      status: 'unread',
      wordIndex: 0,
      totalWords: 0,
    };

    await addToLibrary(newItem);
    setLibraryItems((prev) => [newItem, ...prev.filter((i) => i.url !== url)]);
    setUrlInput('');
    setActiveTab('inbox');
    setSavingUrl(false);

    // Fetch metadata in background
    fetchArticle(url)
      .then((meta) => {
        const updates: Partial<LibraryItem> = {
          title: meta.title || domain,
          description: meta.description,
          siteName: meta.siteName || domain,
          totalWords: meta.wordCount,
          estimatedMinutes: Math.max(1, Math.ceil(meta.wordCount / 250)),
        };
        if (meta.thumbnail) updates.thumbnail = meta.thumbnail;
        updateLibraryItem(id, updates);
        setLibraryItems((prev) =>
          prev.map((i) => (i.id === id ? { ...i, ...updates } : i)),
        );
      })
      .catch(() => {/* keep the basic domain-named item */});
  }, [urlInput, savingUrl]);

  const readLibraryItem = useCallback(
    async (item: LibraryItem) => {
      if (loadingItemId) return;
      setLoadingItemId(item.id);
      try {
        const saved = await loadProgress(item.id);
        const startIndex = saved?.wordIndex ?? 0;

        const { text } = await fetchArticle(item.url);
        const { words: parsed, numPages: np } = parseTextContent(text, 'txt');

        navigation.navigate('Reader', {
          words: parsed,
          wpm,
          numPages: np,
          startIndex,
          fileKey: item.id,
          isLibraryItem: true,
        });
      } catch {
        alert(
          'Could not load article. Check your connection and try again.',
        );
      } finally {
        setLoadingItemId(null);
      }
    },
    [loadingItemId, wpm, navigation],
  );

  const handleArchive = useCallback(async (id: string) => {
    await archiveLibraryItem(id);
    setLibraryItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, status: 'archived' } : i)),
    );
  }, []);

  const handleUnarchive = useCallback(async (id: string) => {
    await unarchiveItem(id);
    setLibraryItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, status: 'unread' } : i)),
    );
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    await removeFromLibrary(id);
    await clearProgress(id);
    setLibraryItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  // ── File upload (direct reader, bypasses library) ─────────────────────────

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
      setSavedFileProgress(null);
      setStartPage(1);
      setStartPageText('1');
      setStartWordIndex(0);
      setParseState('loading');
      setWords([]);
      setFileProgress({ current: 0, total: 0 });

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

  const startDirectReading = useCallback(() => {
    navigation.navigate('Reader', {
      words,
      wpm,
      numPages,
      startIndex: startWordIndex,
      fileKey,
    });
  }, [navigation, words, wpm, numPages, startWordIndex, fileKey]);

  const adjustStartPage = (delta: number) => {
    setStartPage((prev) => {
      const next = Math.min(numPages, Math.max(1, prev + delta));
      setStartPageText(String(next));
      setStartWordIndex(firstIndexOfPage(words, next));
      return next;
    });
  };

  const handleStartPageText = (val: string) => {
    setStartPageText(val);
    const n = parseInt(val, 10);
    if (!isNaN(n) && n >= 1 && n <= numPages) {
      setStartPage(n);
      setStartWordIndex(firstIndexOfPage(words, n));
    }
  };

  // ── Gutenberg ─────────────────────────────────────────────────────────────

  const searchGutenberg = useCallback(async () => {
    const q = gutenbergQuery.trim();
    if (!q) return;
    setGutenbergSearching(true);
    setGutenbergResults([]);
    try {
      setGutenbergResults(await fetchGutenbergSearch(q));
    } catch {
      alert('Search failed: Could not reach Project Gutenberg catalog. Check your connection.');
    } finally {
      setGutenbergSearching(false);
    }
  }, [gutenbergQuery]);

  const loadGutenbergBook = useCallback(
    (book: GutenbergBook, fmt: GutenbergFormat) => {
      if (fmt.type === 'txt') {
        const open = window.confirm(t(lang, 'txtOnlyMsg', { title: book.title }));
        if (open) window.open(fmt.url, '_blank');
        return;
      }
      window.open(fmt.url, '_blank');
      setShowGutenberg(false);
    },
    [lang],
  );

  // ── Derived ───────────────────────────────────────────────────────────────

  const inboxItems = libraryItems.filter((i) => i.status === 'unread');
  const archiveItems = libraryItems.filter((i) => i.status === 'archived');
  const displayItems = activeTab === 'inbox' ? inboxItems : archiveItems;
  const isBusy = parseState === 'loading' || parseState === 'parsing';

  const FORMAT_LABEL: Record<FileType, string> = {
    pdf: 'PDF',
    epub: 'EPUB',
    html: 'HTML',
    md: 'Markdown',
    txt: t(lang, 'plainText'),
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0" />
      <meta property="og:title" content="SpeederReader: Speed Reading for Everyone, Read More Books!" />
      <meta property="og:description" content="Read faster and save time with SpeederReader, the free speed reading app for PDFs, EPUBs, and more. Boost your reading speed and comprehension today!" />
      <meta property="og:image" content="https://raw.githubusercontent.com/jottenlips/speeder-reader/refs/heads/main/social-image.png" />

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Header ─────────────────────────────────────────────────── */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Logo size={40} color={c.textPrimary} />
            <Text style={styles.title}>SpeederReader</Text>
          </View>
          <View style={styles.headerBtns}>
            <TouchableOpacity onPress={toggleLang} style={styles.headerBtn}>
              <Text style={styles.headerBtnText}>{lang === 'en' ? 'ES' : 'EN'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={toggleTheme} style={styles.headerBtn}>
              <Text style={styles.headerBtnText}>{scheme === 'dark' ? '☀' : '☾'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ── URL save bar ────────────────────────────────────────────── */}
        <View style={styles.saveBar}>
          <TextInput
            style={styles.saveInput}
            value={urlInput}
            onChangeText={setUrlInput}
            placeholder="Paste article URL to save…"
            placeholderTextColor={c.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            onSubmitEditing={handleSaveUrl}
            editable={!savingUrl}
          />
          <TouchableOpacity
            style={[styles.saveBtn, (!urlInput.trim() || savingUrl) && styles.dimmed]}
            onPress={handleSaveUrl}
            disabled={!urlInput.trim() || savingUrl}
          >
            {savingUrl
              ? <ActivityIndicator size="small" color={c.primaryBtnText} />
              : <Text style={styles.saveBtnText}>Save</Text>}
          </TouchableOpacity>
        </View>

        {/* ── Library tabs ────────────────────────────────────────────── */}
        <View style={styles.tabs}>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'inbox' && styles.tabActive]}
            onPress={() => setActiveTab('inbox')}
          >
            <Text style={[styles.tabText, activeTab === 'inbox' && styles.tabTextActive]}>
              Inbox{inboxItems.length > 0 ? ` (${inboxItems.length})` : ''}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'archive' && styles.tabActive]}
            onPress={() => setActiveTab('archive')}
          >
            <Text style={[styles.tabText, activeTab === 'archive' && styles.tabTextActive]}>
              Archive{archiveItems.length > 0 ? ` (${archiveItems.length})` : ''}
            </Text>
          </TouchableOpacity>
        </View>

        {/* ── Article list ────────────────────────────────────────────── */}
        {displayItems.length === 0 ? (
          <EmptyState tab={activeTab} styles={styles} />
        ) : (
          displayItems.map((item) => (
            <ArticleCard
              key={item.id}
              item={item}
              isLoading={loadingItemId === item.id}
              wpm={wpm}
              onRead={() => readLibraryItem(item)}
              onArchive={activeTab === 'inbox' ? () => handleArchive(item.id) : undefined}
              onUnarchive={activeTab === 'archive' ? () => handleUnarchive(item.id) : undefined}
              onDelete={() => handleDelete(item.id)}
              c={c}
              styles={styles}
            />
          ))
        )}

        {/* ── Reading speed ───────────────────────────────────────────── */}
        <View style={styles.wpmSection}>
          <Text style={styles.wpmLabel}>{t(lang, 'readingSpeed')}</Text>
          <View style={styles.wpmRow}>
            <TouchableOpacity style={styles.wpmBtn} onPress={() => adjustWpm(-25)}>
              <Text style={styles.wpmBtnText}>−</Text>
            </TouchableOpacity>
            <Text style={styles.wpmValue}>{wpm} {t(lang, 'wpm')}</Text>
            <TouchableOpacity style={styles.wpmBtn} onPress={() => adjustWpm(25)}>
              <Text style={styles.wpmBtnText}>+</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${fillPct}%` as any }]} />
          </View>
        </View>

        {/* ── Divider: secondary sources ──────────────────────────────── */}
        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerLabel}>Also open directly</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* ── File upload ─────────────────────────────────────────────── */}
        <TouchableOpacity
          style={[styles.secondaryBtn, isBusy && styles.dimmed]}
          onPress={pickFile}
          disabled={isBusy}
        >
          <Text style={styles.secondaryBtnText}>
            {isBusy
              ? parseState === 'loading'
                ? t(lang, 'readingFile')
                : t(lang, 'parsing')
              : parseState === 'ready'
              ? `✓ ${fileName ?? ''} — ${t(lang, 'chooseAnother')}`
              : `${t(lang, 'upload')} (PDF, EPUB, HTML, MD, TXT)`}
          </Text>
        </TouchableOpacity>

        {isBusy && (
          <View style={styles.progressRow}>
            <ActivityIndicator color={c.accent} size="small" />
            <Text style={styles.progressText}>
              {parseState === 'loading'
                ? t(lang, 'fetching')
                : `${FORMAT_LABEL[fileType]} · ${
                    fileProgress.total
                      ? t(lang, 'pageOf', { current: fileProgress.current, total: fileProgress.total })
                      : t(lang, 'pageNum', { current: fileProgress.current })
                  }`}
            </Text>
          </View>
        )}

        {parseState === 'ready' && words.length > 0 && (
          <View style={styles.fileReady}>
            <Text style={styles.fileReadyMeta}>
              {FORMAT_LABEL[fileType]} · {numPages}{' '}
              {numPages === 1 ? t(lang, 'page') : t(lang, 'pages')} ·{' '}
              {words.length.toLocaleString()} {t(lang, 'words')}
            </Text>
            <Text style={styles.fileReadyTime}>
              {formatTimeLeft(lang, words.length - startWordIndex, wpm)}
            </Text>

            {savedFileProgress && (
              <View style={styles.savedBanner}>
                <Text style={styles.savedText}>
                  {t(lang, 'savedProgress', { page: savedFileProgress.page })}
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    clearProgress(fileKey);
                    setSavedFileProgress(null);
                    setStartPage(1);
                    setStartPageText('1');
                  }}
                >
                  <Text style={styles.savedClear}>{t(lang, 'clear')}</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.startPageRow}>
              <Text style={styles.startPageLabel}>{t(lang, 'startFromPage')}</Text>
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

            <TouchableOpacity style={styles.startBtn} onPress={startDirectReading}>
              <Text style={styles.startBtnText}>{t(lang, 'startReading')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Gutenberg ───────────────────────────────────────────────── */}
        <TouchableOpacity
          style={styles.secondaryBtn}
          onPress={() => setShowGutenberg((v) => !v)}
        >
          <Text style={styles.secondaryBtnText}>
            {showGutenberg ? '▲ ' : '▼ '}{t(lang, 'browse')} Project Gutenberg
          </Text>
        </TouchableOpacity>

        {showGutenberg && (
          <View style={styles.gutenbergSection}>
            <View style={styles.urlRow}>
              <TextInput
                style={styles.urlInput}
                value={gutenbergQuery}
                onChangeText={setGutenbergQuery}
                placeholder={t(lang, 'searchPlaceholder')}
                placeholderTextColor={c.placeholder}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                onSubmitEditing={searchGutenberg}
                editable={!gutenbergSearching}
              />
              <TouchableOpacity
                style={[styles.urlBtn, (gutenbergSearching || !gutenbergQuery.trim()) && styles.dimmed]}
                onPress={searchGutenberg}
                disabled={gutenbergSearching || !gutenbergQuery.trim()}
              >
                <Text style={styles.urlBtnText}>{gutenbergSearching ? '…' : t(lang, 'search')}</Text>
              </TouchableOpacity>
            </View>

            {gutenbergSearching && (
              <View style={styles.progressRow}>
                <ActivityIndicator color={c.accent} size="small" />
                <Text style={styles.progressText}>{t(lang, 'searchingGutenberg')}</Text>
              </View>
            )}

            {gutenbergResults.map((book) => {
              const fmt = bestGutenbergFormat(book.formats);
              const authors = book.authors.map((a) => a.name).join(', ');
              return (
                <TouchableOpacity
                  key={book.id}
                  style={[styles.bookResult, (!fmt || isBusy) && styles.dimmed]}
                  onPress={() => fmt && loadGutenbergBook(book, fmt)}
                  disabled={!fmt || isBusy}
                >
                  <Text style={styles.bookTitle} numberOfLines={2}>{book.title}</Text>
                  <Text style={styles.bookAuthor} numberOfLines={1}>{authors}</Text>
                  <Text style={styles.bookMeta}>
                    {book.download_count.toLocaleString()} {t(lang, 'downloads')} ·{' '}
                    {fmt ? fmt.type.toUpperCase() : t(lang, 'unavailable')}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        <TouchableOpacity
          style={styles.siteLink}
          onPress={() => Linking.openURL('https://speederreader.org/FEATURES/')}
        >
          <Text style={styles.siteLinkText}>{t(lang, 'featureDocumentation')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bg },
    scroll: {
      paddingHorizontal: 20,
      paddingTop: 32,
      paddingBottom: 48,
      maxWidth: 560,
      alignSelf: 'center' as any,
      width: '100%',
    },

    // Header
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 24,
    },
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    title: {
      fontSize: 22,
      fontFamily: SERIF,
      fontWeight: '700',
      color: c.textPrimary,
      letterSpacing: 0.2,
    },
    headerBtns: { flexDirection: 'row', gap: 8 },
    headerBtn: {
      paddingHorizontal: 12,
      paddingVertical: 5,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: c.border,
    },
    headerBtnText: {
      fontFamily: SERIF,
      fontSize: 12,
      color: c.textSecondary,
      letterSpacing: 1,
    },

    // URL save bar
    saveBar: {
      flexDirection: 'row',
      gap: 10,
      marginBottom: 20,
    },
    saveInput: {
      flex: 1,
      backgroundColor: c.card,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.border,
      fontFamily: SERIF,
      fontSize: 14,
      color: c.textPrimary,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    saveBtn: {
      backgroundColor: c.primaryBtn,
      borderRadius: 10,
      paddingHorizontal: 20,
      justifyContent: 'center',
      minWidth: 64,
      alignItems: 'center',
    },
    saveBtnText: {
      color: c.primaryBtnText,
      fontFamily: SERIF,
      fontSize: 15,
      fontWeight: '700',
    },

    // Tabs
    tabs: {
      flexDirection: 'row',
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      overflow: 'hidden',
      marginBottom: 16,
    },
    tab: { flex: 1, paddingVertical: 10, alignItems: 'center' },
    tabActive: { backgroundColor: c.activeTabBg },
    tabText: { fontFamily: SERIF, fontSize: 14, color: c.textSecondary },
    tabTextActive: { color: c.activeTabText, fontWeight: '600' },

    // Article card
    articleCard: {
      backgroundColor: c.card,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.border,
      marginBottom: 10,
      overflow: 'hidden',
    },
    articleCardBody: { padding: 14 },
    articleTitle: {
      fontFamily: SERIF,
      fontSize: 16,
      fontWeight: '700',
      color: c.textPrimary,
      marginBottom: 4,
      lineHeight: 22,
    },
    articleMetaRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
    articleSite: {
      fontFamily: SERIF,
      fontSize: 12,
      color: c.accent,
    },
    articleReadTime: {
      fontFamily: SERIF,
      fontSize: 12,
      color: c.textSecondary,
    },
    articleDesc: {
      fontFamily: SERIF,
      fontSize: 13,
      color: c.textMuted,
      lineHeight: 18,
      marginBottom: 6,
    },
    articleDate: {
      fontFamily: SERIF,
      fontSize: 11,
      color: c.textTertiary,
    },
    articleCardActions: {
      flexDirection: 'row',
      borderTopWidth: 1,
      borderTopColor: c.border,
      paddingHorizontal: 14,
      paddingVertical: 8,
      gap: 16,
    },
    cardAction: { paddingVertical: 4 },
    cardActionText: {
      fontFamily: SERIF,
      fontSize: 13,
      color: c.textSecondary,
    },
    cardDeleteText: { color: '#c0392b' },

    // Empty state
    emptyState: {
      alignItems: 'center',
      paddingVertical: 48,
      paddingHorizontal: 24,
    },
    emptyIcon: { fontSize: 36, color: c.accent, marginBottom: 14 },
    emptyTitle: {
      fontFamily: SERIF,
      fontSize: 18,
      fontWeight: '700',
      color: c.textPrimary,
      marginBottom: 8,
    },
    emptySub: {
      fontFamily: SERIF,
      fontSize: 14,
      color: c.textMuted,
      textAlign: 'center',
      lineHeight: 20,
    },

    // WPM section
    wpmSection: {
      marginTop: 8,
      marginBottom: 20,
      paddingTop: 20,
      borderTopWidth: 1,
      borderTopColor: c.divider,
    },
    wpmLabel: {
      fontSize: 11,
      fontFamily: SERIF,
      color: c.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 1.2,
      marginBottom: 12,
    },
    wpmRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 12,
    },
    wpmBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    wpmBtnText: { fontSize: 20, color: c.textPrimary, lineHeight: 22 },
    wpmValue: {
      fontSize: 22,
      fontFamily: SERIF,
      fontWeight: '700',
      color: c.textPrimary,
    },
    track: {
      height: 3,
      backgroundColor: c.divider,
      borderRadius: 2,
      overflow: 'hidden',
    },
    fill: { height: 3, backgroundColor: c.accent, borderRadius: 2 },

    // Divider
    dividerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginBottom: 16,
    },
    dividerLine: { flex: 1, height: 1, backgroundColor: c.divider },
    dividerLabel: {
      fontFamily: SERIF,
      fontSize: 11,
      color: c.textTertiary,
      letterSpacing: 0.5,
    },

    // Secondary buttons
    secondaryBtn: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
      marginBottom: 10,
    },
    secondaryBtnText: {
      fontFamily: SERIF,
      fontSize: 14,
      color: c.textSecondary,
    },
    dimmed: { opacity: 0.4 },

    // Progress row
    progressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginBottom: 14,
      paddingLeft: 4,
    },
    progressText: { fontFamily: SERIF, fontSize: 13, color: c.textSecondary },

    // File ready section
    fileReady: {
      backgroundColor: c.card,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.border,
      padding: 14,
      marginBottom: 10,
    },
    fileReadyMeta: {
      fontFamily: SERIF,
      fontSize: 13,
      color: c.textSecondary,
      marginBottom: 2,
    },
    fileReadyTime: {
      fontFamily: SERIF,
      fontSize: 13,
      color: c.accent,
      marginBottom: 12,
    },

    savedBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: c.savedBg,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.savedBorder,
      paddingHorizontal: 12,
      paddingVertical: 8,
      marginBottom: 12,
    },
    savedText: { fontFamily: SERIF, fontSize: 12, color: c.savedText },
    savedClear: {
      fontFamily: SERIF,
      fontSize: 12,
      color: c.savedClear,
      textDecorationLine: 'underline',
    },

    startPageRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 14,
    },
    startPageLabel: { fontFamily: SERIF, fontSize: 13, color: c.textMuted },
    startPageControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    startPageBtn: {
      width: 30,
      height: 30,
      borderRadius: 15,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    startPageBtnText: { fontSize: 16, color: c.textPrimary, lineHeight: 18 },
    startPageInput: {
      width: 52,
      backgroundColor: c.bg,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: c.border,
      fontFamily: SERIF,
      fontSize: 14,
      color: c.textPrimary,
      textAlign: 'center',
      paddingVertical: 4,
    },

    startBtn: {
      backgroundColor: c.primaryBtn,
      borderRadius: 8,
      paddingVertical: 14,
      alignItems: 'center',
    },
    startBtnText: {
      fontFamily: SERIF,
      fontSize: 16,
      fontWeight: '700',
      color: c.primaryBtnText,
    },

    // Gutenberg section
    gutenbergSection: { marginBottom: 10 },
    urlRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
    urlInput: {
      flex: 1,
      backgroundColor: c.card,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      fontFamily: SERIF,
      fontSize: 13,
      color: c.textPrimary,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    urlBtn: {
      backgroundColor: c.primaryBtn,
      borderRadius: 8,
      paddingHorizontal: 16,
      justifyContent: 'center',
    },
    urlBtnText: {
      color: c.primaryBtnText,
      fontFamily: SERIF,
      fontSize: 14,
      fontWeight: '600',
    },

    bookResult: {
      backgroundColor: c.card,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: c.border,
      padding: 12,
      marginBottom: 8,
    },
    bookTitle: {
      fontFamily: SERIF,
      fontSize: 14,
      color: c.textPrimary,
      fontWeight: '600',
      marginBottom: 2,
    },
    bookAuthor: { fontFamily: SERIF, fontSize: 12, color: c.textMuted, marginBottom: 4 },
    bookMeta: { fontFamily: SERIF, fontSize: 11, color: c.textTertiary },

    // Site link
    siteLink: { alignItems: 'center', paddingVertical: 24 },
    siteLinkText: {
      fontFamily: SERIF,
      fontSize: 12,
      color: c.textTertiary,
      letterSpacing: 0.5,
    },
  });
}
