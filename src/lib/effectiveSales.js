const SALES_FIELDS = ["rev", "units", "promo", "promoUnits", "refund", "refundUnits"];

function finiteNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateKey(row) {
  const value = String(row?.date || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function productKey(row) {
  return String(row?.pid || row?.product || "").trim().toLowerCase();
}

function productDateKey(row) {
  const date = dateKey(row);
  const product = productKey(row);
  return date && product ? `${date}\u001f${product}` : "";
}

export function aggregateWarehouseDailySales(rows = []) {
  const groups = new Map();
  for (const row of rows || []) {
    const date = dateKey(row);
    const pid = String(row?.pid || row?.product || "").trim();
    if (!date || !pid) continue;
    const cid = String(row?.cid || "").trim();
    const channel = String(row?.channel || "Inline").trim() || "Inline";
    const key = [date, pid.toLowerCase(), cid.toLowerCase(), channel.toLowerCase()].join("\u001f");
    let summary = groups.get(key);
    if (!summary) {
      summary = {
        date,
        pid,
        cid,
        channel,
        product:row?.product || pid,
        campaign:row?.campaign || "",
        source:"Warehouse daily aggregate",
        sourceKind:"warehouse-derived",
        summaryType:"analysis-daily",
      };
      groups.set(key, summary);
    }
    for (const field of SALES_FIELDS) {
      const value = finiteNumber(row?.[field]);
      if (value) summary[field] = finiteNumber(summary[field]) + value;
    }
  }
  return [...groups.values()].sort((a, b) => (
    a.date.localeCompare(b.date)
    || String(a.pid || "").localeCompare(String(b.pid || ""))
    || String(a.cid || "").localeCompare(String(b.cid || ""))
  ));
}

export function effectiveInlineSalesRows(officialRows = [], warehouseDailyRows = []) {
  const officialProductDates = new Set((officialRows || []).map(productDateKey).filter(Boolean));
  const official = (officialRows || [])
    .filter(row => productDateKey(row))
    .map(row => ({ ...row, sourceKind:"official" }));
  const fallback = (warehouseDailyRows || [])
    .filter(row => {
      const key = productDateKey(row);
      return key && !officialProductDates.has(key)
        && (finiteNumber(row?.rev) !== 0 || finiteNumber(row?.units) !== 0);
    })
    .map(row => ({ ...row, sourceKind:"warehouse-derived" }));
  return [...official, ...fallback].sort((a, b) => (
    String(a.date || "").localeCompare(String(b.date || ""))
    || String(a.pid || a.product || "").localeCompare(String(b.pid || b.product || ""))
    || String(a.cid || "").localeCompare(String(b.cid || ""))
  ));
}
