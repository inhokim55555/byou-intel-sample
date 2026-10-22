(function installReloadTelemetry() {
  if (window.__BYOU_RELOAD_TELEMETRY__) return;
  var navigation = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
  var benchmarkEnabled = /(?:^|[?&])reloadBenchmark=1(?:&|$)/.test(String(window.location && window.location.search || ""));
  var state = {
    status:benchmarkEnabled ? "observing" : "disabled",
    navigationStart:0,
    navigationType:navigation && navigation.type || "navigate",
    longTasks:[],
    inputs:[],
    lastLongTaskEnd:0,
    lastProbeBusyAt:0,
    probeDelayMaxMs:0,
    appCandidateAt:null,
    readyAt:null,
    quietStartedAt:null,
    measurementEndAt:null,
    frozenSnapshot:null,
    pageWasHidden:document.visibilityState !== "visible",
    pageActivationCount:0,
    benchmarkActivationCount:0,
    lastBenchmarkActivationAt:null,
    tab:"",
    requestKey:"",
    observerSupport:{ longtask:false, event:false, firstInput:false },
    listeners:new Set(),
    observers:[],
  };
  state.notify = function notify() {
    state.listeners.forEach(function each(listener) {
      try { listener(); } catch (_) {}
    });
  };
  window.__BYOU_RELOAD_TELEMETRY__ = state;
  if (!benchmarkEnabled) return;

  function recordLongTask(entry) {
    if (state.frozenSnapshot) return;
    state.observerSupport.longtask = true;
    var item = { startTime:Number(entry.startTime || 0), duration:Number(entry.duration || 0) };
    state.longTasks.push(item);
    state.lastLongTaskEnd = Math.max(state.lastLongTaskEnd, item.startTime + item.duration);
  }
  function sameInput(candidate, item) {
    if (candidate.interactionId && item.interactionId && candidate.interactionId === item.interactionId) return true;
    if (candidate.name === item.name && Math.abs(candidate.startTime - item.startTime) <= 8) return true;
    var firstInputPair = candidate.source !== item.source
      && (candidate.source === "first-input" || item.source === "first-input");
    return firstInputPair && Math.abs(candidate.startTime - item.startTime) <= 1_000;
  }
  function sourcePriority(source) {
    return source === "event" ? 3 : source === "first-input" ? 2 : 1;
  }
  function benchmarkInputTarget(target) {
    try {
      return !!(target && typeof target.closest === "function" && target.closest('[data-reload-benchmark-input="true"]'));
    } catch (_) {
      return false;
    }
  }
  function recordInput(entry, source) {
    if (state.frozenSnapshot) return;
    if (!benchmarkInputTarget(entry && entry.target)) return;
    if (source === "first-input") state.observerSupport.firstInput = true;
    else if (source === "event") state.observerSupport.event = true;
    var item = {
      name:String(entry.name || entry.type || "input"),
      interactionId:Number(entry.interactionId || 0),
      startTime:Number(entry.startTime || 0),
      processingStart:Number(entry.processingStart || entry.startTime || 0),
      duration:Number(entry.duration || 0),
      inputToNextPaintMs:Number(entry.inputToNextPaintMs || entry.duration || 0),
      inputDelayMs:Math.max(0, Number(entry.processingStart || entry.startTime || 0) - Number(entry.startTime || 0)),
      inputEndTime:Number(entry.startTime || 0) + Number(entry.inputToNextPaintMs || entry.duration || 0),
      source:String(source || "fallback"),
      trusted:source === "event" || source === "first-input",
    };
    var existing = state.inputs.findIndex(function find(candidate) { return sameInput(candidate, item); });
    if (existing >= 0) {
      var previous = state.inputs[existing];
      var preferred = sourcePriority(item.source) >= sourcePriority(previous.source) ? item : previous;
      var inputDelayMs = Math.max(Number(previous.inputDelayMs || 0), Number(item.inputDelayMs || 0));
      var startTime = Math.min(Number(previous.startTime || 0), Number(item.startTime || 0));
      state.inputs[existing] = Object.assign({}, preferred, {
        interactionId:Number(previous.interactionId || item.interactionId || 0),
        startTime:startTime,
        processingStart:startTime + inputDelayMs,
        duration:Math.max(Number(previous.duration || 0), Number(item.duration || 0)),
        inputToNextPaintMs:Math.max(Number(previous.inputToNextPaintMs || 0), Number(item.inputToNextPaintMs || 0)),
        inputDelayMs:inputDelayMs,
        inputEndTime:Math.max(Number(previous.inputEndTime || 0), Number(item.inputEndTime || 0)),
        trusted:previous.trusted || item.trusted,
      });
    } else state.inputs.push(item);
  }
  function observe(type, callback, options) {
    try {
      if (!window.PerformanceObserver) return;
      var supported = window.PerformanceObserver.supportedEntryTypes || [];
      if (supported.length && supported.indexOf(type) < 0) return;
      var observer = new window.PerformanceObserver(function receive(list) { list.getEntries().forEach(callback); });
      observer.observe(options || { type:type, buffered:true });
      state.observers.push(observer);
      if (type === "first-input") state.observerSupport.firstInput = true;
      else state.observerSupport[type] = true;
    } catch (_) {}
  }
  observe("longtask", recordLongTask, { type:"longtask", buffered:true });
  observe("first-input", function firstInput(entry) { recordInput(entry, "first-input"); }, { type:"first-input", buffered:true });
  observe("event", function eventTiming(entry) {
    if (["pointerdown", "pointerup", "click", "keydown", "keyup"].indexOf(entry.name) >= 0) recordInput(entry, "event");
  }, { type:"event", buffered:true, durationThreshold:16 });
  document.addEventListener("click", function benchmarkActivation(event) {
    if (state.frozenSnapshot || event.isTrusted !== true) return;
    state.pageActivationCount += 1;
  }, true);
  document.addEventListener("visibilitychange", function visibilityChanged() {
    if (state.frozenSnapshot) return;
    if (document.visibilityState !== "visible") state.pageWasHidden = true;
    state.notify();
  });
})();
