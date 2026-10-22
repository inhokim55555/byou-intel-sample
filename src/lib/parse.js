// Pure number/date parsing helpers for BYOU Intel.
//
// Extracted from ByouIntel.jsx so the workbook/CSV parsing logic that
// underpins every reported number can be unit-tested in isolation (no React
// or DOM dependencies). Behavior must stay identical — these helpers decide
// how raw spreadsheet cells become money and dates, so changes here directly
// move the figures leadership sees. See test/parse.test.mjs.

export function dateKey(dt) {
  return dt.toISOString().slice(0, 10);
}

export function validDateKey(y, m, d) {
  const year = Number(y), month = Number(m), day = Number(d);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return "";
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return "";
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return "";
  return dateKey(dt);
}

export function dateKeyFromIsoParts(y, m, d) {
  return validDateKey(y, m, d) || (Number(m) > 12 && Number(d) <= 12 ? validDateKey(y, d, m) : "");
}

export function dateKeyFromUsParts(m, d, y) {
  const year = String(y).length === 2 ? `20${y}` : y;
  return validDateKey(year, m, d);
}

export const MONTH_NAME_TO_NUMBER = {
  jan:1, january:1,
  feb:2, february:2,
  mar:3, march:3,
  apr:4, april:4,
  may:5,
  jun:6, june:6,
  jul:7, july:7,
  aug:8, august:8,
  sep:9, sept:9, september:9,
  oct:10, october:10,
  nov:11, november:11,
  dec:12, december:12,
};

export function normalizeDateValue(raw, fallbackYear = "") {
  if (raw === undefined || raw === null || raw === "") return "";
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return dateKey(raw);
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const dt = new Date(Date.UTC(1899, 11, 30) + raw * 864e5);
    return dateKey(dt);
  }
  const s = String(raw).trim();
  if (!s) return "";
  if (/^(calendar|fiscal)\s+year\b/i.test(s)) return "";
  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return dateKeyFromIsoParts(iso[1], iso[2], iso[3]);
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) return dateKeyFromUsParts(us[1], us[2], us[3]);
  const compactUs = s.match(/^(\d{1,2})[_-](\d{1,2})[_-](\d{2,4})$/);
  if (compactUs) return dateKeyFromUsParts(compactUs[1], compactUs[2], compactUs[3]);
  const embeddedIso = s.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (embeddedIso) return dateKeyFromIsoParts(embeddedIso[1], embeddedIso[2], embeddedIso[3]);
  const embeddedUs = s.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/);
  if (embeddedUs) return dateKeyFromUsParts(embeddedUs[1], embeddedUs[2], embeddedUs[3]);
  const year = Number(fallbackYear);
  if (Number.isInteger(year) && year >= 2000 && year <= 2100) {
    const mdMatches = [...s.matchAll(/\b(\d{1,2})[-/](\d{1,2})\b/g)];
    const md = mdMatches[mdMatches.length - 1];
    if (md) return dateKeyFromUsParts(md[1], md[2], year);
    const monthName = s.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})\b/i);
    if (monthName) return validDateKey(year, MONTH_NAME_TO_NUMBER[monthName[1].toLowerCase().replace(/\.$/, "")], monthName[2]);
    const dayMonthName = s.match(/\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\b/i);
    if (dayMonthName) return validDateKey(year, MONTH_NAME_TO_NUMBER[dayMonthName[2].toLowerCase().replace(/\.$/, "")], dayMonthName[1]);
  }
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return dateKey(parsed);
  return "";
}

export function numberValue(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const s = String(raw ?? "").trim().replace(/[$,%]/g, "").replace(/,/g, "");
  if (!s) return 0;
  const neg = /^\(.+\)$/.test(s);
  const unsigned = s.replace(/[()]/g, "");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(unsigned)) return 0;
  const n = Number(unsigned);
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
}
