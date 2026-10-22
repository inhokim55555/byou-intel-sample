function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasFinite(value) {
  return value !== null && value !== "" && Number.isFinite(Number(value));
}

export function createReloadInteractionState({ navigationStart = 0, navigationType = "navigate" } = {}) {
  return {
    status:"observing",
    navigationStart:finite(navigationStart),
    navigationType:String(navigationType || "navigate"),
    longTasks:[],
    inputs:[],
    lastLongTaskEnd:finite(navigationStart),
    lastProbeBusyAt:finite(navigationStart),
    probeDelayMaxMs:0,
    appCandidateAt:null,
    readyAt:null,
    quietStartedAt:null,
    measurementEndAt:null,
    frozenSnapshot:null,
    pageWasHidden:false,
    pageActivationCount:0,
    benchmarkActivationCount:0,
    lastBenchmarkActivationAt:null,
    tab:"",
    requestKey:"",
    observerSupport:{ longtask:false, event:false, firstInput:false },
    listeners:new Set(),
  };
}

function relevantInputs(state) {
  const cutoff = hasFinite(state.appCandidateAt) ? Number(state.appCandidateAt) : -Infinity;
  const end = hasFinite(state.measurementEndAt) ? Number(state.measurementEndAt) : Infinity;
  return (state.inputs || []).filter(entry => {
    const start = finite(entry.startTime, -Infinity);
    return entry.trusted === true && start >= cutoff && start <= end;
  }).sort((left, right) => finite(left.startTime) - finite(right.startTime));
}

function buildReloadInteractionSnapshot(state) {
  const navigationStart = finite(state.navigationStart);
  const measurementEnd = hasFinite(state.measurementEndAt) ? Number(state.measurementEndAt) : Infinity;
  const longTasks = (state.longTasks || []).filter(entry => finite(entry.startTime, Infinity) <= measurementEnd);
  const inputs = relevantInputs(state);
  const inputDelays = inputs.map(entry => hasFinite(entry.inputDelayMs)
    ? Math.max(0, finite(entry.inputDelayMs))
    : Math.max(0, finite(entry.processingStart) - finite(entry.startTime))).filter(Number.isFinite);
  const interactionDurations = inputs.map(entry => Math.max(0, finite(entry.inputToNextPaintMs, finite(entry.duration)))).filter(Number.isFinite);
  const candidate = hasFinite(state.appCandidateAt) ? Number(state.appCandidateAt) : null;
  const ready = hasFinite(state.readyAt) ? Number(state.readyAt) : null;
  const firstInput = inputs.length ? finite(inputs[0].startTime) : null;
  const inputSources = inputs.map(entry => String(entry.source || "fallback"));
  return {
    status:state.pageWasHidden ? "invalid-hidden" : String(state.status || "observing"),
    navigationType:String(state.navigationType || "navigate"),
    appCandidateMs:candidate == null ? null : Math.max(0, Math.round(candidate - navigationStart)),
    interactiveMs:ready == null ? null : Math.max(0, Math.round(ready - navigationStart)),
    postCommitQuietMs:ready == null || !hasFinite(state.quietStartedAt) ? null : Math.max(0, Math.round(ready - Number(state.quietStartedAt))),
    longTaskCount:longTasks.length,
    longTaskTotalMs:Math.round(longTasks.reduce((sum, entry) => sum + Math.max(0, finite(entry.duration)), 0)),
    longTaskMaxMs:Math.round(Math.max(0, ...longTasks.map(entry => Math.max(0, finite(entry.duration))))),
    inputDelayMs:inputDelays.length ? Math.round(Math.max(...inputDelays)) : null,
    inpMs:interactionDurations.length ? Math.round(Math.max(...interactionDurations)) : null,
    firstTrustedInputMs:firstInput == null ? null : Math.max(0, Math.round(firstInput - navigationStart)),
    inputAfterCandidateMs:firstInput == null || candidate == null ? null : Math.max(0, Math.round(firstInput - candidate)),
    inputCount:inputs.length,
    inputSource:inputSources[0] || "",
    eventInputCount:inputSources.filter(source => source === "event").length,
    pageActivationCount:Math.max(0, Math.round(finite(state.pageActivationCount))),
    benchmarkActivationCount:Math.max(0, Math.round(finite(state.benchmarkActivationCount))),
    probeDelayMaxMs:Math.round(Math.max(0, finite(state.probeDelayMaxMs))),
    tab:String(state.tab || ""),
    requestKey:String(state.requestKey || ""),
    observerSupport:{
      longtask:state.observerSupport?.longtask === true,
      event:state.observerSupport?.event === true,
      firstInput:state.observerSupport?.firstInput === true,
    },
  };
}

export function reloadInteractionSnapshot(state = createReloadInteractionState()) {
  if (state?.frozenSnapshot) return { ...state.frozenSnapshot };
  return buildReloadInteractionSnapshot(state);
}

export function getReloadInteractionTelemetry() {
  if (typeof window === "undefined") return createReloadInteractionState();
  if (!window.__BYOU_RELOAD_TELEMETRY__) {
    window.__BYOU_RELOAD_TELEMETRY__ = createReloadInteractionState({
      navigationStart:0,
      navigationType:performance.getEntriesByType?.("navigation")?.[0]?.type || "navigate",
    });
  }
  return window.__BYOU_RELOAD_TELEMETRY__;
}

export function subscribeReloadInteraction(state, listener) {
  if (!(state?.listeners instanceof Set) || typeof listener !== "function") return () => {};
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

function notify(state) {
  if (typeof state?.notify === "function") state.notify();
  else if (state?.listeners instanceof Set) {
    const snapshot = reloadInteractionSnapshot(state);
    state.listeners.forEach(listener => listener(snapshot));
  }
}

export function markReloadBenchmarkActivation(state, event = {}) {
  if (!state || state.frozenSnapshot) return false;
  state.benchmarkActivationCount = Math.max(0, Math.round(finite(state.benchmarkActivationCount))) + 1;
  state.lastBenchmarkActivationAt = finite(event?.timeStamp, finite(globalThis?.performance?.now?.()));
  notify(state);
  return true;
}

function finishReloadInteraction(state, status, at, quietStartedAt = null) {
  state.status = status;
  state.readyAt = status === "ready" ? at : null;
  state.quietStartedAt = status === "ready" ? quietStartedAt : null;
  state.measurementEndAt = at;
  state.frozenSnapshot = Object.freeze(buildReloadInteractionSnapshot(state));
  notify(state);
  return reloadInteractionSnapshot(state);
}

export async function waitForReloadInteractionReady({
  state = getReloadInteractionTelemetry(),
  now = () => performance.now(),
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  quietWindowMs = 500,
  probeIntervalMs = 50,
  maxProbeDelayMs = 50,
  maxWaitMs = 10_000,
  inputDeliveryGraceMs = 250,
  settleWaitMs = 60_000,
  detail = {},
} = {}) {
  if (state?.frozenSnapshot) return reloadInteractionSnapshot(state);
  const candidate = finite(now());
  if (!hasFinite(state.appCandidateAt)) state.appCandidateAt = candidate;
  state.tab = String(detail.tab || state.tab || "");
  state.requestKey = String(detail.requestKey || state.requestKey || "");
  if (state.pageWasHidden || typeof document !== "undefined" && document.visibilityState !== "visible") {
    state.pageWasHidden = true;
    return finishReloadInteraction(state, "invalid-hidden", candidate);
  }
  state.status = "awaiting-input";
  notify(state);
  const inputDeadline = candidate + Math.max(probeIntervalMs, maxWaitMs);
  let settleDeadline = null;
  while (true) {
    const before = finite(now());
    await wait(probeIntervalMs);
    const after = finite(now());
    const probeDelay = Math.max(0, after - before - probeIntervalMs);
    state.probeDelayMaxMs = Math.max(finite(state.probeDelayMaxMs), probeDelay);
    if (probeDelay > maxProbeDelayMs) state.lastProbeBusyAt = after;
    if (state.pageWasHidden || typeof document !== "undefined" && document.visibilityState !== "visible") {
      state.pageWasHidden = true;
      return finishReloadInteraction(state, "invalid-hidden", after);
    }
    const inputs = relevantInputs(state);
    const hasBenchmarkActivation = finite(state.benchmarkActivationCount) > 0;
    if (!inputs.length || !hasBenchmarkActivation) {
      const deliveryDeadline = inputDeadline
        + Math.max(probeIntervalMs, inputDeliveryGraceMs)
        + Math.max(0, finite(state.probeDelayMaxMs));
      if (after >= deliveryDeadline) return finishReloadInteraction(state, "timeout", after);
      continue;
    }
    if (settleDeadline === null) {
      settleDeadline = after + Math.max(quietWindowMs, settleWaitMs);
    }
    if (state.status !== "settling") {
      state.status = "settling";
      notify(state);
    }
    const lastInputEnd = Math.max(...inputs.map(entry => (
      hasFinite(entry.inputEndTime)
        ? finite(entry.inputEndTime)
        : finite(entry.startTime) + Math.max(0, finite(entry.inputToNextPaintMs, finite(entry.duration)))
    )));
    const lastBusyAt = Math.max(
      finite(state.appCandidateAt),
      finite(state.lastLongTaskEnd),
      finite(state.lastProbeBusyAt),
      lastInputEnd,
    );
    if (after - lastBusyAt >= quietWindowMs) {
      return finishReloadInteraction(state, "ready", after, lastBusyAt);
    }
    if (after >= settleDeadline) return finishReloadInteraction(state, "timeout", after);
  }
}
