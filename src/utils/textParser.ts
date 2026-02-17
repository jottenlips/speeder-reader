import { WordEntry, buildWordList } from './pdfParser';

export type FileType = 'pdf' | 'epub' | 'html' | 'md' | 'txt';

export const WORDS_PER_PAGE = 250;

export function detectFileType(name: string): FileType {
  // Strip query string / fragment first, then lower-case
  const lower = name.split('?')[0].split('#')[0].toLowerCase();
  // Check for compound Gutenberg-style extensions first (.epub.images, .epub.noimages)
  if (lower.includes('.epub')) return 'epub';
  if (lower.includes('.pdf')) return 'pdf';
  const ext = lower.split('.').pop() ?? '';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'md';
  return 'txt';
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#\d+;/gi, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gm, ' ')      // fenced code blocks
    .replace(/`[^`\n]+`/g, ' ')             // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')  // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → label
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1') // ref links
    .replace(/^#{1,6}\s+/gm, '')            // ATX headers
    .replace(/^[=-]{2,}\s*$/gm, '')         // Setext headers
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/___([^_]+)___/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/^>\s?/gm, '')                 // blockquotes
    .replace(/^[-*_]{3,}\s*$/gm, '')        // horizontal rules
    .replace(/^[\s]*[-*+]\s+/gm, '')        // unordered lists
    .replace(/^[\s]*\d+\.\s+/gm, '')        // ordered lists
    .replace(/<[^>]+>/g, ' ')               // inline HTML
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a long clean string into ~250-word chunks, each chunk = 1 "page". */
export function splitIntoPages(clean: string): string[] {
  const words = clean.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [''];
  const pages: string[] = [];
  for (let i = 0; i < words.length; i += WORDS_PER_PAGE) {
    pages.push(words.slice(i, i + WORDS_PER_PAGE).join(' '));
  }
  return pages;
}

/** Parse a text-based file to WordEntry[]. Returns words and page count. */
export function parseTextContent(
  raw: string,
  type: 'txt' | 'md' | 'html'
): { words: WordEntry[]; numPages: number } {
  let clean: string;
  if (type === 'html') clean = stripHtml(raw);
  else if (type === 'md') clean = stripMarkdown(raw);
  else clean = raw.replace(/\s+/g, ' ').trim();

  const pages = splitIntoPages(clean);
  return { words: buildWordList(pages), numPages: pages.length };
}
