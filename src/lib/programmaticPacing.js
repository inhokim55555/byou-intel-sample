import { normalizeDateValue, numberValue } from "./parse.js";

const MONTH_NUMBERS = new Map([
  ["january", 1], ["jan", 1],
  ["february", 2], ["feb", 2],
  ["march", 3], ["mar", 3],
  ["april", 4], ["apr", 4],
  ["may", 5],
  ["june", 6], ["jun", 6],
  ["july", 7], ["jul", 7],
  ["august", 8], ["aug", 8],
  ["september", 9], ["sep", 9], ["sept", 9],
  ["october", 10], ["oct", 10],
  ["november", 11], ["nov", 11],
  ["december", 12], ["dec", 12],
]);

function text(value) {
  return String(value ?? "").trim();
}

function normalizedText(value) {
  return text(value).replace(/\s+/g, " ");
}

function objectRowsToMatrix(rows = []) {
  const usable = (rows || []).filter(row => row && typeof row === "object");
  if (!usable.length) return [];
  const headers = Object.keys(usable[0]);
  const firstRow = headers.map(header => /^Column \d+$/i.test(header) ? "" : header);
  return [
    firstRow,
    ...usable.map(row => headers.map(header => row?.[header] ?? "")),
  ];
}

function rowText(row = []) {
  return row.map(normalizedText).filter(Boolean).join(" ");
}

function firstMatchingCell(matrix = [], pattern) {
  for (const row of matrix) {
    for (const value of row) {
      const candidate = normalizedText(value);
      if (pattern.test(candidate)) return candidate;
    }
  }
  return "";
}

function valueAfterLabel(row = [], labelPattern) {
  const labelIndex = row.findIndex(value => labelPattern.test(normalizedText(value)));
  if (labelIndex < 0) return "";
  for (let index = labelIndex + 1; index < row.length; index += 1) {
    if (text(row[index]) !== "") return row[index];
  }
  return "";
}

function metricRowIndex(matrix = [], start, end, metric) {
  const pattern = new RegExp(`^${metric}$`, "i");
  for (let index = start; index < end; index += 1) {
    if ((matrix[index] || []).some(value => pattern.test(normalizedText(value)))) return index;
  }
  return -1;
}

function metricValue(matrix = [], rowIndex, metric) {
  if (rowIndex < 0) return 0;
  return numberValue(valueAfterLabel(matrix[rowIndex], new RegExp(`^${metric}$`, "i")));
}

function monthLabel(value = "", year = 0) {
  const key = normalizedText(value).toLowerCase();
  const month = MONTH_NUMBERS.get(key);
  if (!month || !year) return null;
  return {
    label:`${key.charAt(0).toUpperCase()}${key.slice(1)} ${year}`,
    start:`${year}-${String(month).padStart(2, "0")}-01`,
  };
}

function monthlyMetricRows(matrix = [], start, end, year) {
  const rows = new Map();
  for (let index = start; index < end; index += 1) {
    const row = matrix[index] || [];
    const labelIndex = row.findIndex(value => monthLabel(value, year));
    if (labelIndex < 0) continue;
    const period = monthLabel(row[labelIndex], year);
    let rawValue = "";
    for (let valueIndex = labelIndex + 1; valueIndex < row.length; valueIndex += 1) {
      if (text(row[valueIndex]) !== "") {
        rawValue = row[valueIndex];
        break;
      }
    }
    rows.set(period.start, { ...period, value:numberValue(rawValue) });
  }
  return rows;
}

function audienceFromSource(source = "", product = "") {
  let base = text(source).replace(/^.*[\\/]/, "").replace(/\.(xlsx|xlsm)$/i, "");
  if (product) base = base.replace(new RegExp(`^${product.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[_\\s-]*`, "i"), "");
  base = base
    .replace(/pacing\s*report/i, "")
    .replace(/[_\s-]*\d{1,2}[._-]\d{1,2}[._-]\d{2,4}$/i, "")
    .replace(/_/g, " ")
    .replace(/^[\s-]+|[\s-]+$/g, "")
    .replace(/\s+/g, " ");
  return base || "Programmatic Audience";
}

function sharedFields(report) {
  return {
    Partner:"Programmatic",
    Product:report.product,
    "Campaign Name":report.audience,
    "Campaign Type":"Programmatic / ERM Audience",
    Audience:report.audience,
    "Snapshot Start":report.flightStart,
    "Snapshot End":report.snapshotDate,
    "Campaign Start Date":report.flightStart,
    "Campaign End Date":report.flightEnd,
    "Report Title":report.title,
    "Pacing Notes":report.pacingNotes,
    "Flight Progress":report.flightProgress,
    "Days Elapsed":report.daysElapsed,
    "Flight Days":report.flightDays,
    "Days Remaining":report.daysRemaining,
    "Source Sheet":report.sheetName,
  };
}

export function parseProgrammaticPacingRows(rows = [], source = "", sheetName = "") {
  const matrix = objectRowsToMatrix(rows);
  if (!matrix.length) return null;

  const title = firstMatchingCell(matrix, /\bpacing report\b/i);
  const flightText = firstMatchingCell(matrix, /^flight\s*:/i);
  const allText = matrix.map(rowText).join("\n");
  const creativeCount = matrix.filter(row => row.some(value => /^creative\s+[a-z0-9]/i.test(normalizedText(value)))).length;
  if (!title || !flightText || creativeCount < 1 || !/\buniques reached\b/i.test(allText) || !/\bimpressions\b/i.test(allText) || !/\bclicks\b/i.test(allText)) return null;

  const product = title.replace(/\bpacing report\b.*$/i, "").trim();
  const snapshotText = firstMatchingCell(matrix, /data\s+from\s+launch\s+to/i);
  const snapshotDate = normalizeDateValue(snapshotText);
  const flightMatch = flightText.match(/(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})\s*[-–—]\s*(\d{1,2}[/.]\d{1,2}[/.]\d{2,4})/);
  const flightStart = normalizeDateValue(flightMatch?.[1] || "");
  const flightEnd = normalizeDateValue(flightMatch?.[2] || "");
  const reportYear = Number((snapshotDate || flightStart || flightEnd).slice(0, 4));
  const pacingNotesRow = matrix.find(row => row.some(value => /^pacing notes\s*:?$/i.test(normalizedText(value)))) || [];
  const pacingNotes = normalizedText(valueAfterLabel(pacingNotesRow, /^pacing notes\s*:?$/i));
  const progressMatch = pacingNotes.match(/(\d+(?:\.\d+)?)%\s+through\s+flight/i);
  const elapsedMatch = pacingNotes.match(/\((\d+)\s+of\s+(\d+)\s+days\)/i);
  const remainingMatch = pacingNotes.match(/(\d+)\s+days?\s+remaining/i);
  const reachRow = matrix.find(row => row.some(value => /^uniques reached$/i.test(normalizedText(value)))) || [];
  const reach = Math.round(numberValue(valueAfterLabel(reachRow, /^uniques reached$/i)));

  const creativeStarts = [];
  matrix.forEach((row, index) => {
    const cell = row.find(value => /^creative\s+[a-z0-9]/i.test(normalizedText(value)));
    if (cell) creativeStarts.push({ index, name:normalizedText(cell) });
  });

  const creatives = creativeStarts.map((creative, creativeIndex) => {
    const end = creativeStarts[creativeIndex + 1]?.index ?? matrix.length;
    const impressionsIndex = metricRowIndex(matrix, creative.index + 1, end, "Impressions");
    const clicksIndex = metricRowIndex(matrix, creative.index + 1, end, "Clicks");
    const ctrIndex = metricRowIndex(matrix, creative.index + 1, end, "CTR");
    const impressions = Math.round(metricValue(matrix, impressionsIndex, "Impressions"));
    const clicks = Math.round(metricValue(matrix, clicksIndex, "Clicks"));
    const ctrRaw = metricValue(matrix, ctrIndex, "CTR");
    const impressionsByMonth = monthlyMetricRows(matrix, impressionsIndex + 1, clicksIndex > impressionsIndex ? clicksIndex : end, reportYear);
    const clicksByMonth = monthlyMetricRows(matrix, clicksIndex + 1, ctrIndex > clicksIndex ? ctrIndex : end, reportYear);
    const periods = [...new Set([...impressionsByMonth.keys(), ...clicksByMonth.keys()])].sort().map(periodStart => {
      const imp = impressionsByMonth.get(periodStart);
      const clk = clicksByMonth.get(periodStart);
      const periodImpressions = Math.round(imp?.value || 0);
      const periodClicks = Math.round(clk?.value || 0);
      return {
        reportingPeriod:imp?.label || clk?.label || periodStart,
        periodStart,
        impressions:periodImpressions,
        clicks:periodClicks,
        ctr:periodImpressions > 0 ? (periodClicks / periodImpressions) * 100 : 0,
      };
    });
    return {
      name:creative.name,
      impressions,
      clicks,
      ctr:impressions > 0 ? (clicks / impressions) * 100 : ctrRaw,
      periods,
    };
  });

  const impressions = creatives.reduce((sum, creative) => sum + creative.impressions, 0);
  const clicks = creatives.reduce((sum, creative) => sum + creative.clicks, 0);
  const report = {
    title,
    product,
    audience:audienceFromSource(source, product),
    snapshotDate,
    flightStart,
    flightEnd,
    pacingNotes,
    flightProgress:numberValue(progressMatch?.[1] || 0),
    daysElapsed:numberValue(elapsedMatch?.[1] || 0),
    flightDays:numberValue(elapsedMatch?.[2] || 0),
    daysRemaining:numberValue(remainingMatch?.[1] || 0),
    reach,
    impressions,
    clicks,
    ctr:impressions > 0 ? (clicks / impressions) * 100 : 0,
    sheetName,
    creatives,
  };
  const shared = sharedFields(report);
  const campaignRows = [{
    ...shared,
    Reach:reach,
    Impressions:impressions,
    Clicks:clicks,
    CTR:report.ctr,
  }];
  const lineItemRows = creatives.map(creative => ({
    ...shared,
    "Line Item Name":creative.name,
    Impressions:creative.impressions,
    Clicks:creative.clicks,
    CTR:creative.ctr,
  }));
  const periodRows = creatives.flatMap(creative => creative.periods.map(period => ({
    ...shared,
    "Line Item Name":creative.name,
    "Reporting Period":period.reportingPeriod,
    "Period Start":period.periodStart,
    Impressions:period.impressions,
    Clicks:period.clicks,
    CTR:period.ctr,
  })));
  return { report, campaignRows, lineItemRows, periodRows };
}

export function programmaticPacingSourcesFromWorkbook(workbook, source = "") {
  for (const sheetName of workbook?.SheetNames || []) {
    const parsed = parseProgrammaticPacingRows(workbook?.Sheets?.[sheetName] || [], source, sheetName);
    if (parsed) return parsed;
  }
  return null;
}
