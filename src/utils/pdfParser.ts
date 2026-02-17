export interface WordEntry {
  word: string;
  page: number;
}

export function buildWordList(pages: string[]): WordEntry[] {
  const words: WordEntry[] = [];
  pages.forEach((pageText, idx) => {
    const pageWords = pageText
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 0);
    pageWords.forEach((word) => {
      words.push({ word, page: idx + 1 });
    });
  });
  return words;
}

export function firstIndexOfPage(words: WordEntry[], page: number): number {
  const idx = words.findIndex((w) => w.page === page);
  return idx >= 0 ? idx : 0;
}

/**
 * HTML for the hidden WebView (native) / iframe (web).
 *
 * Libraries loaded from CDN:
 *   - PDF.js v3 (UMD)  – handles PARSE_PDF and PARSE_PDF_URL
 *   - JSZip v3         – handles PARSE_EPUB
 *
 * postBack() works in both contexts:
 *   - Native WebView  → window.ReactNativeWebView.postMessage
 *   - Web iframe      → window.parent.postMessage
 *
 * Incoming messages:
 *   { type: 'PARSE_PDF',     base64 }   PDF as base64
 *   { type: 'PARSE_PDF_URL', url }       PDF by URL (web only, PDF.js fetches it)
 *   { type: 'PARSE_EPUB',    base64 }   EPUB as base64
 *
 * Outgoing messages:
 *   { type: 'READY' }
 *   { type: 'PROGRESS', current, total }
 *   { type: 'DONE',     pages: string[], numPages: number }
 *   { type: 'ERROR',    error: string }
 */
export const PARSER_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"><\/script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"><\/script>
</head>
<body>
<script>
(function () {
  // ── Messaging bridge (native WebView + web iframe) ──────────────────────
  function postBack(data) {
    var str = JSON.stringify(data);
    try {
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(str);
      else window.parent.postMessage(str, '*');
    } catch (e) {}
  }

  // ── Shared HTML stripper (used for EPUB chapters) ────────────────────────
  function stripHtml(html) {
    return html
      .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
      .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&#\\d+;/gi, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
  }

  // ── PDF helpers ─────────────────────────────────────────────────────────
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  async function extractPdfPages(pdf) {
    var n = pdf.numPages, pages = [];
    for (var p = 1; p <= n; p++) {
      var page = await pdf.getPage(p);
      var tc   = await page.getTextContent();
      var text = tc.items.filter(function(i) { return i.str && i.str.trim(); })
                         .map(function(i) { return i.str; }).join(' ');
      pages.push(text);
      postBack({ type: 'PROGRESS', current: p, total: n });
    }
    postBack({ type: 'DONE', pages: pages, numPages: n });
  }

  async function parsePdfBase64(base64) {
    try {
      var bin = atob(base64), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
      await extractPdfPages(pdf);
    } catch (err) { postBack({ type: 'ERROR', error: err.message || String(err) }); }
  }

  async function parsePdfUrl(url) {
    try {
      var pdf = await pdfjsLib.getDocument({ url: url, withCredentials: false }).promise;
      await extractPdfPages(pdf);
    } catch (err) { postBack({ type: 'ERROR', error: err.message || String(err) }); }
  }

  // ── EPUB helpers ────────────────────────────────────────────────────────
  async function parseEpubBase64(base64) {
    try {
      var bin = atob(base64), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      var zip = await JSZip.loadAsync(bytes.buffer);

      // 1. Find OPF path via META-INF/container.xml
      var containerFile = zip.file('META-INF/container.xml');
      if (!containerFile) throw new Error('Not a valid EPUB: missing META-INF/container.xml');
      var containerXml = await containerFile.async('text');
      var opfMatch = containerXml.match(/full-path="([^"]+)"/);
      if (!opfMatch) throw new Error('Cannot find OPF path');
      var opfPath = opfMatch[1];
      var opfBase = opfPath.split('/').slice(0, -1).join('/');

      // 2. Parse OPF for manifest + spine
      var opfFile = zip.file(opfPath);
      if (!opfFile) throw new Error('OPF file not found: ' + opfPath);
      var opfXml = await opfFile.async('text');

      // Parse manifest — attribute-order independent (Gutenberg puts href before id)
      var manifest = {}, manifestTypes = {}, m;
      var itemRe = /<item\\b([^>]*)>/gi;
      while ((m = itemRe.exec(opfXml)) !== null) {
        var attrs = m[1];
        var idM   = attrs.match(/\\bid="([^"]+)"/i);
        var hrefM = attrs.match(/\\bhref="([^"]+)"/i);
        var mtM   = attrs.match(/\\bmedia-type="([^"]+)"/i);
        if (idM && hrefM) {
          manifest[idM[1]] = decodeURIComponent(hrefM[1].split('#')[0]);
          if (mtM) manifestTypes[idM[1]] = mtM[1];
        }
      }

      // Parse spine
      var spineIds = [];
      var sRe = /<itemref\\b([^>]*)>/gi;
      while ((m = sRe.exec(opfXml)) !== null) {
        var idrefM = m[1].match(/\\bidref="([^"]+)"/i);
        if (idrefM) spineIds.push(idrefM[1]);
      }
      if (spineIds.length === 0) throw new Error('EPUB spine is empty');

      // 3. Extract text from each spine item (= one "page")
      var pages = [], skipped = 0;
      for (var p = 0; p < spineIds.length; p++) {
        var itemId = spineIds[p];
        var href = manifest[itemId];
        if (!href) { skipped++; continue; }

        // Skip non-text media types (images, css, fonts…)
        var mt = manifestTypes[itemId] || '';
        if (mt && !/(html|xhtml|xml|text\\/plain)/i.test(mt)) continue;

        // Resolve path: try with opfBase prefix first, then bare href
        var filePath = opfBase ? opfBase + '/' + href : href;
        var contentFile = zip.file(filePath) || zip.file(href);

        // Last-resort case-insensitive scan
        if (!contentFile) {
          var needle = filePath.toLowerCase();
          zip.forEach(function(relPath, f) {
            if (!contentFile && relPath.toLowerCase() === needle) contentFile = f;
          });
        }
        if (!contentFile) { skipped++; continue; }

        var html = await contentFile.async('text');
        var text = stripHtml(html);
        if (text.trim().length > 10) pages.push(text);
        postBack({ type: 'PROGRESS', current: p + 1, total: spineIds.length });
      }

      if (pages.length === 0) {
        throw new Error(
          'No readable text found in EPUB. ' +
          '(Spine: ' + spineIds.length + ' items, manifest: ' +
          Object.keys(manifest).length + ' entries, skipped: ' + skipped + ')'
        );
      }
      postBack({ type: 'DONE', pages: pages, numPages: pages.length });
    } catch (err) { postBack({ type: 'ERROR', error: err.message || String(err) }); }
  }

  // ── Message router ───────────────────────────────────────────────────────
  function handleMessage(event) {
    try {
      var data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      if (!data) return;
      if (data.type === 'PARSE_PDF')     parsePdfBase64(data.base64);
      if (data.type === 'PARSE_PDF_URL') parsePdfUrl(data.url);
      if (data.type === 'PARSE_EPUB')    parseEpubBase64(data.base64);
    } catch (e) {}
  }

  document.addEventListener('message', handleMessage);
  window.addEventListener('message', handleMessage);
  postBack({ type: 'READY' });
})();
<\/script>
</body>
</html>
`;

/** @deprecated use PARSER_HTML */
export const PDF_PARSER_HTML = PARSER_HTML;
