/**
 * Fetches an article from a URL via a CORS proxy and extracts its
 * metadata (title, description, site name, thumbnail) plus clean text
 * content for RSVP reading.
 *
 * Web-only: relies on fetch() and DOMParser (available in all modern browsers).
 */

import { stripHtml } from './textParser';

const CORS_PROXY = 'https://corsproxy.io/?url=';

async function fetchHtml(url: string): Promise<string> {
  const resp = await fetch(CORS_PROXY + encodeURIComponent(url));
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

function getMeta(doc: Document, selectors: string[]): string {
  for (const sel of selectors) {
    const val = doc.querySelector(sel)?.getAttribute('content');
    if (val?.trim()) return val.trim();
  }
  return '';
}

/** Extract the main readable text from a parsed HTML document. */
function extractText(doc: Document): string {
  // 1. Prefer <article> tag — most news/blog sites wrap content here
  const article = doc.querySelector('article');
  if (article) {
    const paras = Array.from(article.querySelectorAll('p')).filter(
      (p) => (p.textContent ?? '').trim().length > 40,
    );
    if (paras.length > 2) {
      return paras.map((p) => p.textContent ?? '').join(' ');
    }
    return stripHtml(article.innerHTML);
  }

  // 2. Fall back to <main>
  const main = doc.querySelector('main');
  if (main) {
    const paras = Array.from(main.querySelectorAll('p')).filter(
      (p) => (p.textContent ?? '').trim().length > 40,
    );
    if (paras.length > 2) {
      return paras.map((p) => p.textContent ?? '').join(' ');
    }
    return stripHtml(main.innerHTML);
  }

  // 3. Collect substantial <p> blocks from anywhere in the body
  const paras = Array.from(doc.querySelectorAll('p')).filter(
    (p) => (p.textContent ?? '').trim().length > 40,
  );
  if (paras.length > 0) {
    return paras.map((p) => p.textContent ?? '').join(' ');
  }

  // 4. Last resort: strip the entire body
  return stripHtml(doc.body?.innerHTML ?? '');
}

export interface FetchedArticle {
  title: string;
  description: string;
  siteName: string;
  thumbnail: string;
  /** Clean plain text ready for parseTextContent */
  text: string;
  wordCount: number;
}

export async function fetchArticle(url: string): Promise<FetchedArticle> {
  const html = await fetchHtml(url);
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const title =
    getMeta(doc, [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
    ]) || doc.title || '';

  const description = getMeta(doc, [
    'meta[property="og:description"]',
    'meta[name="description"]',
    'meta[name="twitter:description"]',
  ]);

  let siteName = getMeta(doc, ['meta[property="og:site_name"]']);
  if (!siteName) {
    try {
      siteName = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      siteName = url;
    }
  }

  const thumbnail = getMeta(doc, [
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
  ]);

  const text = extractText(doc);
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return { title, description, siteName, thumbnail, text, wordCount };
}
