import { readCachedStartupDataset, writeCachedStartupDataset } from "../lib/datasetCache.js";
import { notifySessionExpired } from "../lib/runtimeRequest.js";

export function createStartupLoader({ applyStartupDataset, showToast, setSharedDatasetStatus, setDatasetTimings, startupLoadStartedAtRef, readCache = readCachedStartupDataset, writeCache = writeCachedStartupDataset, request = fetch }) {
  let latestSequence = 0;
  let controller;
  const load = async ({ manual = false } = {}) => {
    const startedAt = performance.now();
    startupLoadStartedAtRef.current = startedAt;
    // Manual refresh, the inventory overlay, and the initial mount can all request a
    // bootstrap load. Only the newest request may apply its result, so an older response
    // that finishes late can never overwrite a newer publication.
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const sequence = ++latestSequence;
    const isCurrent = () => latestSequence === sequence && !signal.aborted;
    try { performance.mark("byou-startup-load-start"); } catch {}
    try {
      setSharedDatasetStatus(previous => ({
      ...previous,
      state:"loading",
      message:"Checking for the latest published Campaign data...",
      warning:"",
    }));
    let cached = null;
    const cacheStartedAt = performance.now();
    cached = await readCache();
    if (!isCurrent()) return false;
    const cacheMs = Math.round(performance.now() - cacheStartedAt);
    setDatasetTimings(previous => ({ ...previous, cacheMs }));
    if (cached?.dataset) {
      applyStartupDataset(cached.dataset, { source:"cache", startedAt, metrics:{ cacheMs } });
    }
    try {
      const requestStartedAt = performance.now();
      const headers = { Accept:"application/json" };
      if (cached?.etag) headers["If-None-Match"] = cached.etag;
      const response = await request("/api/v2/bootstrap", { headers, cache:"no-cache", signal });
      if (!isCurrent()) return false;
      if (notifySessionExpired(response)) throw new Error("Your login session expired. Sign in again to continue.");
      if (response.status === 304 && cached?.dataset) {
        const downloadMs = Math.round(performance.now() - requestStartedAt);
        setDatasetTimings(previous => ({ ...previous, downloadMs, parseMs:0 }));
        setSharedDatasetStatus(previous => ({
          ...previous,
          state:"loaded",
          message:"Published Campaign data is current. Showing the saved snapshot.",
          source:"cache-validated",
          warning:"",
        }));
        return true;
      }
      if (response.status === 404) throw new Error("No shared dataset has been published yet.");
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.includes("application/json")) {
        throw new Error("The optimized startup endpoint is not available on the deployed server.");
      }
      const text = await response.text();
      if (!isCurrent()) return false;
      const downloadMs = Math.round(performance.now() - requestStartedAt);
      const parseStartedAt = performance.now();
      const dataset = JSON.parse(text);
      const parseMs = Math.round(performance.now() - parseStartedAt);
      const etag = response.headers.get("etag") || "";
      applyStartupDataset(dataset, { source:"network", startedAt, metrics:{ cacheMs, downloadMs, parseMs } });
      void writeCache(dataset, etag);
      if (manual) showToast("Latest published data loaded");
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      if (cached?.dataset) {
        setSharedDatasetStatus(previous => ({
          ...previous,
          state:"loaded",
          message:"Showing the saved published snapshot.",
          source:"cache",
          warning:`Background refresh failed: ${error.message || "the latest dataset could not be checked"}`,
        }));
        showToast("Published data refresh failed; cached data is displayed");
        return true;
      }
      throw error;
    }
  } catch (error) {
    if (!isCurrent()) return false;
    const message = error.message || "Could not load published data.";
    setSharedDatasetStatus({ state:"error", message, publishedAt:"", source:"", warning:message });
    showToast("Published data failed to load");
    return false;
  }
  };
  load.cancel = () => { latestSequence++; controller?.abort(); };
  return load;
}
