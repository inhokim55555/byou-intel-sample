export function rowsToObjects(data = []) {
  const firstRowIndex = data.findIndex(row => (row || []).some(value => value !== undefined && value !== null && value !== ""));
  if (firstRowIndex < 0) return [];
  const counts = new Map();
  const headers = (data[firstRowIndex] || []).map((value, index) => {
    const base = String(value ?? "").trim() || `Column ${index + 1}`;
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    return count ? `${base}_${count + 1}` : base;
  });
  return data.slice(firstRowIndex + 1).map(row => {
    const out = {};
    headers.forEach((header, index) => { out[header] = row?.[index] ?? ""; });
    return out;
  }).filter(row => Object.values(row).some(value => value !== undefined && value !== null && value !== ""));
}

export function workbookFromSheets(sheets = []) {
  return {
    SheetNames:sheets.map(sheet => sheet.sheet),
    Sheets:Object.fromEntries(sheets.map(sheet => [sheet.sheet, rowsToObjects(sheet.data)])),
  };
}

function normalizedSheetName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasWorkbookSheet(workbook, aliases) {
  const names = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames : [];
  const available = new Set(names.map(normalizedSheetName));
  return aliases.some(alias => available.has(normalizedSheetName(alias)));
}

export function missingCoreWorkbookSheets(workbook, { salesSheetNames = [], inlineTotalSheetName = "" } = {}) {
  const missing = [];
  if (!salesSheetNames.length) missing.push("In_Line_Sales_Raw");
  if (!inlineTotalSheetName) missing.push("Costco_Daily_Totals");
  if (!hasWorkbookSheet(workbook, ["Stores_Master", "Stores"])) missing.push("Stores_Master");
  if (!hasWorkbookSheet(workbook, ["Products_Master", "Products"])) missing.push("Products_Master");
  return missing;
}

function upsertRows(previousRows, incomingRows, keyForRow) {
  const next = new Map((previousRows || []).map(row => [keyForRow(row), row]));
  (incomingRows || []).forEach(row => next.set(keyForRow(row), row));
  return Array.from(next.values());
}

export function mergeWorkbookRows(existing = {}, incoming = {}, replace = false) {
  return {
    sales:replace
      ? [...(incoming.sales || [])]
      : upsertRows(existing.sales, incoming.sales, row => `${row.date}|${row.wid}`),
    prodSales:replace
      ? [...(incoming.prodSales || [])]
      : upsertRows(existing.prodSales, incoming.prodSales, row => `${row.date}|${row.wid}|${row.pid}|${row.cid||""}`),
  };
}
