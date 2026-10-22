export const RELOAD_BENCHMARK_STORAGE_KEY = "byou-intel:reload-benchmark:v1";
export const RELOAD_BENCHMARK_TARGET = 20;
export const RELOAD_BENCHMARK_INPUT_WINDOW_MS = 10_000;

const METRIC_KEYS = Object.freeze([
  "interactiveMs",
  "appCandidateMs",
  "postCommitQuietMs",
  "longTaskCount",
  "longTaskTotalMs",
  "longTaskMaxMs",
  "probeDelayMaxMs",
  "inputDelayMs",
  "inpMs",
  "firstTrustedInputMs",
  "inputAfterCandidateMs",
  "serverQueryMs",
]);

function text(value) {
  return String(value ?? "").trim();
}

function finite(value) {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptySession() {
  return {
    version:1,
    target:RELOAD_BENCHMARK_TARGET,
    createdAt:"",
    updatedAt:"",
    accepted:[],
    rejected:[],
  };
}

function normalizeSession(value) {
  if (!value || typeof value !== "object" || Number(value.version) !== 1) return emptySession();
  return {
    version:1,
    target:RELOAD_BENCHMARK_TARGET,
    createdAt:text(value.createdAt),
    updatedAt:text(value.updatedAt),
    accepted:Array.isArray(value.accepted) ? value.accepted : [],
    rejected:Array.isArray(value.rejected) ? value.rejected : [],
  };
}

export function isReloadBenchmarkEnabled(search = "") {
  try {
    return new URLSearchParams(String(search || "")).get("reloadBenchmark") === "1";
  } catch (_) {
    return false;
  }
}

export function readReloadBenchmarkSession(storage = globalThis?.sessionStorage) {
  if (!storage?.getItem) return emptySession();
  try {
    const raw = storage.getItem(RELOAD_BENCHMARK_STORAGE_KEY);
    return raw ? normalizeSession(JSON.parse(raw)) : emptySession();
  } catch (_) {
    return emptySession();
  }
}

function metricSummary(records, key) {
  const values = records
    .map(record => finite(record?.snapshot?.[key]))
    .filter(value => value !== null)
    .sort((left, right) => left - right);
  const nearestRank = probability => values.length
    ? values[Math.max(0, Math.ceil(values.length * probability) - 1)]
    : null;
  return { count:values.length, p50:nearestRank(0.5), p75:nearestRank(0.75) };
}

export function summarizeReloadBenchmark(session = emptySession()) {
  const normalized = normalizeSession(session);
  return {
    target:RELOAD_BENCHMARK_TARGET,
    acceptedCount:normalized.accepted.length,
    rejectedCount:normalized.rejected.length,
    complete:normalized.accepted.length >= RELOAD_BENCHMARK_TARGET,
    ...Object.fromEntries(METRIC_KEYS.map(key => [key, metricSummary(normalized.accepted, key)])),
  };
}

export function assessReloadBenchmarkSample(snapshot = {}, context = {}) {
  if (text(context.visibility) !== "visible") return { accepted:false, reason:"page-not-visible" };
  const inputCount = Number(snapshot.inputCount || 0);
  const pageActivationCount = Number(snapshot.pageActivationCount || 0);
  const benchmarkActivationCount = Number(snapshot.benchmarkActivationCount || 0);
  if (text(snapshot.status) !== "ready") {
    if (benchmarkActivationCount < 1 && inputCount > 0) return { accepted:false, reason:"benchmark-activation-missing" };
    if (benchmarkActivationCount > 0 && inputCount < 1) return { accepted:false, reason:"event-timing-input-missing" };
    return { accepted:false, reason:`measurement-${text(snapshot.status) || "missing"}` };
  }
  if (text(snapshot.navigationType) !== "reload") return { accepted:false, reason:"navigation-not-reload" };
  const longTaskObserverConfirmed = snapshot.observerSupport?.longtask === true || Number(snapshot.longTaskCount || 0) > 0;
  const inputObserverConfirmed = snapshot.observerSupport?.event === true
    || snapshot.observerSupport?.firstInput === true
    || Number(snapshot.eventInputCount || 0) > 0
    || text(snapshot.inputSource) === "first-input";
  if (!longTaskObserverConfirmed || !inputObserverConfirmed) {
    return { accepted:false, reason:"required-observer-unsupported" };
  }
  if (text(snapshot.tab) !== "campaign" || text(context.tab) !== "campaign") return { accepted:false, reason:"initial-view-not-campaign" };
  if (!text(context.build)) return { accepted:false, reason:"release-build-missing" };
  if (!text(context.publication)) return { accepted:false, reason:"publication-missing" };
  const requestKey = text(context.requestKey);
  if (!requestKey || text(context.readyKey) !== requestKey || text(snapshot.requestKey) !== requestKey) {
    return { accepted:false, reason:"request-key-mismatch" };
  }
  if (benchmarkActivationCount < 1) return { accepted:false, reason:"benchmark-activation-missing" };
  if (benchmarkActivationCount !== 1) return { accepted:false, reason:"benchmark-activation-count-invalid" };
  if (pageActivationCount > 1) return { accepted:false, reason:"page-activation-count-invalid" };
  if (inputCount < 1) return { accepted:false, reason:"event-timing-input-missing" };
  if (inputCount !== 1) return { accepted:false, reason:"trusted-input-count-invalid" };
  if (!["event", "first-input"].includes(text(snapshot.inputSource))) {
    return { accepted:false, reason:"event-timing-input-missing" };
  }
  if (finite(snapshot.interactiveMs) === null || finite(snapshot.inputDelayMs) === null || finite(snapshot.inpMs) === null) {
    return { accepted:false, reason:"interaction-metrics-missing" };
  }
  if (finite(snapshot.appCandidateMs) === null || finite(snapshot.interactiveMs) < finite(snapshot.appCandidateMs)) {
    return { accepted:false, reason:"interaction-before-candidate" };
  }
  if (finite(snapshot.inputAfterCandidateMs) === null || finite(snapshot.inputAfterCandidateMs) > RELOAD_BENCHMARK_INPUT_WINDOW_MS) {
    return { accepted:false, reason:"trusted-input-too-late" };
  }
  if (finite(snapshot.probeDelayMaxMs) === null || finite(snapshot.postCommitQuietMs) === null) {
    return { accepted:false, reason:"quiet-window-metrics-missing" };
  }
  return { accepted:true, reason:"" };
}

export function appendReloadBenchmarkSample(storage, snapshot = {}, context = {}) {
  const session = readReloadBenchmarkSession(storage);
  const runId = text(context.runId) || `${text(context.recordedAt)}|${text(snapshot.requestKey)}`;
  const existingAccepted = session.accepted.find(record => record.runId === runId);
  const existingRejected = session.rejected.find(record => record.runId === runId);
  const existing = existingAccepted || existingRejected;
  if (existing) {
    return {
      accepted:!!existingAccepted,
      duplicate:true,
      reason:text(existing.reason),
      session,
      summary:summarizeReloadBenchmark(session),
    };
  }

  if (session.accepted.length >= RELOAD_BENCHMARK_TARGET) {
    return { accepted:false, duplicate:false, complete:true, reason:"target-complete", session, summary:summarizeReloadBenchmark(session) };
  }

  const assessment = assessReloadBenchmarkSample(snapshot, context);
  const releaseBuild = text(session.accepted[0]?.context?.build);
  const currentBuild = text(context.build);
  const releasePublication = text(session.accepted[0]?.context?.publication);
  const currentPublication = text(context.publication);
  const finalAssessment = assessment.accepted && session.accepted.length > 0 && releaseBuild !== currentBuild
    ? { accepted:false, reason:"release-mismatch" }
    : assessment.accepted && session.accepted.length > 0 && releasePublication !== currentPublication
      ? { accepted:false, reason:"publication-mismatch" }
      : assessment;
  const recordedAt = text(context.recordedAt) || new Date().toISOString();
  const record = {
    runId,
    recordedAt,
    reason:finalAssessment.reason,
    context:{
      visibility:text(context.visibility),
      tab:text(context.tab),
      requestKey:text(context.requestKey),
      readyKey:text(context.readyKey),
      publication:text(context.publication),
      build:text(context.build),
      runtime:context.runtime && typeof context.runtime === "object" ? { ...context.runtime } : undefined,
    },
    snapshot:{ ...snapshot },
  };
  if (finalAssessment.accepted) session.accepted.push(record);
  else session.rejected.push(record);
  if (session.rejected.length > 50) session.rejected.splice(0, session.rejected.length - 50);
  session.createdAt ||= recordedAt;
  session.updatedAt = recordedAt;
  try {
    if (!storage?.setItem) throw new Error("storage unavailable");
    storage.setItem(RELOAD_BENCHMARK_STORAGE_KEY, JSON.stringify(session));
  } catch (_) {
    return {
      accepted:false,
      duplicate:false,
      reason:"storage-unavailable",
      record:{ ...record, reason:"storage-unavailable" },
      session:readReloadBenchmarkSession(storage),
      summary:summarizeReloadBenchmark(readReloadBenchmarkSession(storage)),
    };
  }
  return {
    accepted:finalAssessment.accepted,
    duplicate:false,
    reason:finalAssessment.reason,
    record,
    session,
    summary:summarizeReloadBenchmark(session),
  };
}

export function resetReloadBenchmarkSession(storage = globalThis?.sessionStorage) {
  try {
    storage?.removeItem?.(RELOAD_BENCHMARK_STORAGE_KEY);
    return true;
  } catch (_) {
    return false;
  }
}
