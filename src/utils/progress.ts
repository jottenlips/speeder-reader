import AsyncStorage from '@react-native-async-storage/async-storage';

export interface SavedProgress {
  wordIndex: number;
  page: number;
}

const PREFIX = 'sr_progress:';

/** Normalize a filename or URL into a stable storage key. */
export function makeFileKey(nameOrUrl: string): string {
  return nameOrUrl.split('?')[0].split('#')[0].trim();
}

export async function loadProgress(fileKey: string): Promise<SavedProgress | null> {
  try {
    const raw = await AsyncStorage.getItem(PREFIX + fileKey);
    return raw ? (JSON.parse(raw) as SavedProgress) : null;
  } catch {
    return null;
  }
}

export async function saveProgress(fileKey: string, progress: SavedProgress): Promise<void> {
  try {
    await AsyncStorage.setItem(PREFIX + fileKey, JSON.stringify(progress));
  } catch {}
}

export async function clearProgress(fileKey: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(PREFIX + fileKey);
  } catch {}
}
