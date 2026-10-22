const DB_NAME = "byou-intel-cache-v2";
const STORE_NAME = "snapshots";
const STARTUP_KEY = "latest-bootstrap-v4";

function openCacheDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the BYOU Intel browser cache."));
  });
}

function cacheRequest(mode, operation) {
  return openCacheDb().then(db => {
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      const request = operation(store);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error || new Error("BYOU Intel browser cache request failed."));
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => {
        db.close();
        reject(transaction.error || new Error("BYOU Intel browser cache transaction failed."));
      };
    });
  });
}

export async function readCachedStartupDataset() {
  try {
    const cached = await cacheRequest("readonly", store => store.get(STARTUP_KEY));
    if (!cached?.dataset || cached.dataset.schema !== "byou-intel-bootstrap-v4") return null;
    return cached;
  } catch {
    return null;
  }
}

export async function writeCachedStartupDataset(dataset, etag = "") {
  if (!dataset || dataset.schema !== "byou-intel-bootstrap-v4") return false;
  try {
    await cacheRequest("readwrite", store => store.put({
      dataset,
      etag:String(etag || ""),
      cachedAt:new Date().toISOString(),
    }, STARTUP_KEY));
    return true;
  } catch {
    return false;
  }
}
