const LOS_ANGELES_TIME_ZONE = "America/Los_Angeles";

export function parseDailyWarmTime(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text || text === "off") return null;
  const match = text.match(/^(\d{2}):(\d{2})$/);
  if (!match) throw new Error("Daily warm time must use HH:mm in 24-hour time.");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("Daily warm time must use HH:mm in 24-hour time.");
  return { hour, minute };
}

export function zonedDateTimeParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone:LOS_ANGELES_TIME_ZONE,
    year:"numeric",
    month:"2-digit",
    day:"2-digit",
    hour:"2-digit",
    minute:"2-digit",
    hourCycle:"h23",
  }).formatToParts(value);
  const get = type => parts.find(part => part.type === type)?.value || "";
  return {
    date:`${get("year")}-${get("month")}-${get("day")}`,
    hour:Number(get("hour")),
    minute:Number(get("minute")),
  };
}

export function createDailyWarmController({ time, run, now = () => new Date(), retryMs = 300_000, logger = console } = {}) {
  const target = typeof time === "string" || time == null ? parseDailyWarmTime(time) : time;
  let completedDate = "";
  let failedAt = 0;
  let inFlight = null;
  const tick = async () => {
    if (!target) return "disabled";
    const current = now();
    const local = zonedDateTimeParts(current);
    const localMinutes = local.hour * 60 + local.minute;
    const targetMinutes = target.hour * 60 + target.minute;
    if (localMinutes < targetMinutes) return "early";
    if (completedDate === local.date) return "done";
    const currentMs = current.getTime();
    if (failedAt && currentMs - failedAt < retryMs) return "cooldown";
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(() => run())
      .then(result => {
        if (result && Object.prototype.hasOwnProperty.call(result, "warmed") && Number(result.warmed || 0) <= 0) {
          throw new Error("The scheduled Analysis warm did not populate a cache entry.");
        }
        completedDate = local.date;
        failedAt = 0;
        return "warmed";
      })
      .catch(error => {
        failedAt = currentMs;
        logger?.warn?.("[BYOU Intel] Scheduled Analysis warm failed:", error?.message || error);
        return "failed";
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
  return { tick, get completedDate(){ return completedDate; } };
}

export function startDailyWarmScheduler({ time, run, logger = console, intervalMs = 30_000, retryMs = 300_000 } = {}) {
  let controller;
  try {
    controller = createDailyWarmController({ time, run, logger, retryMs });
  } catch (error) {
    logger?.warn?.("[BYOU Intel] Scheduled Analysis warm disabled:", error.message);
    return { enabled:false, stop(){} };
  }
  if (!parseDailyWarmTime(time)) return { enabled:false, stop(){} };
  const timer = setInterval(() => { void controller.tick(); }, intervalMs);
  timer.unref?.();
  queueMicrotask(() => { void controller.tick(); });
  return { enabled:true, stop:() => clearInterval(timer), tick:controller.tick };
}
