import { stat } from 'node:fs/promises';
import { ParsedMarkdown } from './parser.js';

interface CacheEntry {
  parsed: ParsedMarkdown;
  mtimeMs: number;
  lastAccess: number;
}

const MAX_ENTRIES = 100;
const cache = new Map<string, CacheEntry>();

function evictIfNeeded(): void {
  if (cache.size < MAX_ENTRIES) return;

  let oldest: string | null = null;
  let oldestAccess = Infinity;

  for (const [key, entry] of cache) {
    if (entry.lastAccess < oldestAccess) {
      oldestAccess = entry.lastAccess;
      oldest = key;
    }
  }

  if (oldest) cache.delete(oldest);
}

export async function getCached(path: string): Promise<ParsedMarkdown | null> {
  const entry = cache.get(path);
  if (!entry) return null;

  try {
    const s = await stat(path);
    if (s.mtimeMs !== entry.mtimeMs) {
      cache.delete(path);
      return null;
    }
    entry.lastAccess = Date.now();
    return entry.parsed;
  } catch {
    cache.delete(path);
    return null;
  }
}

export async function setCached(path: string, parsed: ParsedMarkdown): Promise<void> {
  try {
    const s = await stat(path);
    evictIfNeeded();
    cache.set(path, {
      parsed,
      mtimeMs: s.mtimeMs,
      lastAccess: Date.now(),
    });
  } catch {
    // file not statable, skip caching
  }
}

export function clearCache(): void {
  cache.clear();
}
