import AsyncStorage from '@react-native-async-storage/async-storage';

export interface LibraryItem {
  id: string;
  url: string;
  title: string;
  description: string;
  siteName: string;
  thumbnail?: string;
  estimatedMinutes: number;
  savedAt: number;
  /** 'unread' = in inbox; 'archived' = has been read */
  status: 'unread' | 'archived';
  wordIndex: number;
  totalWords: number;
}

const LIBRARY_KEY = 'sr_library_v1';

export async function getLibrary(): Promise<LibraryItem[]> {
  try {
    const raw = await AsyncStorage.getItem(LIBRARY_KEY);
    return raw ? (JSON.parse(raw) as LibraryItem[]) : [];
  } catch {
    return [];
  }
}

async function persistLibrary(items: LibraryItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(items));
  } catch {}
}

/** Add an item. Silently deduplicates by URL. */
export async function addToLibrary(item: LibraryItem): Promise<void> {
  const items = await getLibrary();
  if (items.some((i) => i.url === item.url)) return;
  await persistLibrary([item, ...items]);
}

export async function updateLibraryItem(
  id: string,
  updates: Partial<LibraryItem>,
): Promise<void> {
  const items = await getLibrary();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return;
  items[idx] = { ...items[idx], ...updates };
  await persistLibrary(items);
}

/** Move an item to the archive (marks as read). */
export async function archiveItem(id: string): Promise<void> {
  await updateLibraryItem(id, { status: 'archived' });
}

/** Move an archived item back to the inbox. */
export async function unarchiveItem(id: string): Promise<void> {
  await updateLibraryItem(id, { status: 'unread' });
}

/** Permanently delete a library item. */
export async function removeFromLibrary(id: string): Promise<void> {
  const items = await getLibrary();
  await persistLibrary(items.filter((i) => i.id !== id));
}
