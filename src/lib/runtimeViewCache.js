const DEFAULT_MAX_ENTRIES = 12;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 4 * 1024 * 1024;

function boundedWholeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export class RuntimeViewCache {
  constructor(options = {}) {
    this.maxEntries = boundedWholeNumber(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxBytes = boundedWholeNumber(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxEntryBytes = boundedWholeNumber(options.maxEntryBytes, DEFAULT_MAX_ENTRY_BYTES);
    this.entries = new Map();
    this.totalBytes = 0;
  }

  get size() {
    return this.entries.size;
  }

  has(key) {
    return this.entries.has(key);
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value, byteLength = value?.metrics?.responseBytes) {
    const bytes = boundedWholeNumber(byteLength, 0);
    if (bytes > this.maxEntryBytes || bytes > this.maxBytes || this.maxEntries === 0) return false;

    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.totalBytes -= existing.bytes;
    }
    this.entries.set(key, { value, bytes });
    this.totalBytes += bytes;
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.totalBytes -= oldest?.bytes || 0;
    }
    return this.entries.has(key);
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
    return true;
  }

  clear() {
    this.entries.clear();
    this.totalBytes = 0;
  }
}
