import { CAMPAIGN_TRANSPORT_SCHEMA, decodeCampaignView } from "./campaignTransport.js";

export function runtimeRequestUrl(query = {}, productKey = "") {
  const params = new URLSearchParams({ view:query.view || "campaign" });
  for (const field of [
    "from",
    "to",
    "cid",
    "wid",
    "region",
    "state",
    "representation",
    "section",
    "inventoryType",
    "storeSearch",
    "publication",
    "evaluationDate",
    "approvalRevision",
    "primaryPid",
    "primaryCid",
    "comparisonPid",
    "comparisonCid",
    "affinityRegion",
    "affinityState",
    "affinityMinimumPeriods",
    "affinityMinimumUnits",
    "compareA",
    "compareB",
    "compareCampaignA",
    "compareCampaignB",
    "compareBucket",
    "compareMetric",
    "compareNormMode",
    "compareMinUnits",
    "compareRegion",
    "compareState",
    "compareFrom",
    "compareTo",
  ]) {
    if (query[field] !== undefined && query[field] !== null && query[field] !== "") params.set(field, query[field]);
  }
  if (productKey) params.set("pids", productKey);
  if (query.cids?.length) params.set("cids", query.cids.join(","));
  return `/api/v2/view?${params}`;
}

export function runtimeDisplayState(requestKey, state = {}, local = false) {
  if (local) return "ready";
  if (state.key !== requestKey) return "loading";
  return state.status === "ready" ? "ready" : state.status === "error" ? "error" : "loading";
}

export function utf8ByteLength(value = "") {
  const text = String(value);
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export const SESSION_EXPIRED_EVENT = "byou-intel:session-expired";

// A 401 from any protected endpoint means the login cookie expired or was revoked.
// Instead of surfacing it as a "data failed" toast, tell the auth gate to show the
// login screen again. Uses a window event so lib code stays free of React state.
export function notifySessionExpired(response) {
  if (response?.status !== 401) return false;
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  }
  return true;
}

// The timeout covers the complete body read, not just response headers.
export async function fetchRuntimeView(url, { signal, fetchImpl = fetch, timeoutMs = 45000, now = () => performance.now(), expectedSchema = "" } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once:true });
  if (signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const start = now();
  try {
    // Exact-key warm reads use the dashboard's bounded in-memory cache. Bypass
    // the HTTP cache so serverCached always describes the current server call.
    const response = await fetchImpl(url, { headers:{ Accept:"application/json" }, cache:"no-store", signal:controller.signal });
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch {}
      notifySessionExpired(response);
      const error = new Error(payload.error || "The selected view could not be loaded.");
      error.status = response.status;
      error.code = payload.code || "";
      throw error;
    }
    const text = await response.text();
    const downloaded = now();
    if (controller.signal.aborted) throw new DOMException("Request cancelled", "AbortError");
    const payload = JSON.parse(text);
    const dataset = decodeCampaignView(payload);
    if (!["byou-intel-view-v1", "byou-intel-inventory-compact-v1", "byou-intel-analysis-section-v2", "byou-intel-sales-compact-v1"].includes(dataset?.schema)) {
      throw new Error("The selected view returned an incompatible response.");
    }
    if (expectedSchema && dataset.schema !== expectedSchema) {
      throw new Error("The selected view returned an incompatible response.");
    }
    const responseBytes = utf8ByteLength(text);
    return { dataset, metrics:{
      viewDownloadMs:downloaded - start,
      viewParseMs:now() - downloaded,
      responseBytes,
      cacheBytes:payload?.schema === CAMPAIGN_TRANSPORT_SCHEMA ? Math.max(payload.expandedBytes, responseBytes) : responseBytes,
      transferBytes:Number(response.headers?.get?.("content-length") || 0),
      contentEncoding:String(response.headers?.get?.("content-encoding") || ""),
      serverQueryMs:Number(dataset.queryMs || 0),
      serverCached:dataset.serverCached === true,
    } };
  } catch (error) {
    if (timedOut && !signal?.aborted) throw new Error("Loading took too long. Please retry.");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
