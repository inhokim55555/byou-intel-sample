import { buildOwnerSalesCorrectionHistory } from "./ownerSalesCorrections.js";
import { inventoryCampaignActiveAt } from "./dashboardScope.js";

const NUMBER_FIELDS = [
  "rev", "units", "promo", "promoUnits", "refund", "refundUnits",
  "orders", "sessions", "adSpend", "inv", "inbound", "reserved",
];

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoDate(value) {
  const text = String(value || "");
  return text.length >= 10 && text[4] === "-" && text[7] === "-" ? text.slice(0, 10) : "";
}

function addDays(date, amount) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function dayDistance(start, end) {
  return Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
}

export function campaignComparisonRange(options = {}) {
  const from = isoDate(options.from);
  const to = isoDate(options.to);
  if (!from || !to || from > to) return null;
  const periodDays = dayDistance(from, to) + 1;
  const end = addDays(from, -1);
  return {
    start:addDays(end, -periodDays + 1),
    end,
  };
}

export function runtimeSourceOptions(options = {}) {
  if (String(options.view || "") === "inventory") return { ...options, from:"" };
  const comparisonRange = String(options.view || "campaign") === "campaign"
    ? campaignComparisonRange(options)
    : null;
  return comparisonRange ? { ...options, from:comparisonRange.start } : options;
}

// Match InventoryView's default current-campaign eligibility before downloading
// history. Explicit historical campaign selections must still load all history.
export function inventoryRuntimeScope(dataset = {}, options = {}) {
  const sourceOptions = runtimeSourceOptions(options);
  if (options.view !== "inventory" || campaignIds(options).length || !isoDate(options.to)
      || !Object.keys(dataset.campaignMeta || {}).length || !Object.keys(dataset.productMeta || {}).length) {
    return { sourceOptions, empty:false };
  }
  const cids = Object.entries(dataset.campaignMeta).filter(([id, metadata]) => {
    const campaign = { ...metadata, id:metadata.id || id };
    const metadataProduct = dataset.productMeta[campaign.pid];
    const product = { ...metadataProduct, id:metadataProduct?.id || campaign.pid };
    return ["physical_warehouse", "online_aggregate"].some(grain => inventoryCampaignActiveAt(campaign, product, { asOfDate:options.to, grain }));
  }).map(([id, metadata]) => metadata.id || id);
  return { sourceOptions:{ ...sourceOptions, cid:"", cids }, empty:cids.length === 0 };
}

function campaignScopeBounds(dataset = {}, options = {}) {
  const publishedBounds = dataset.summaries?.bounds || dataset.workbookSales?.meta || {};
  let start = isoDate(publishedBounds.start);
  let end = isoDate(publishedBounds.end);
  const ids = campaignIds(options);
  if (ids.length === 1) {
    const campaignId = ids[0];
    const campaign = Object.entries(dataset.campaignMeta || {})
      .find(([key, value]) => key === campaignId || String(value?.id || value?.cid || "") === campaignId)?.[1];
    const campaignStart = isoDate(campaign?.start);
    const campaignEnd = isoDate(campaign?.end);
    if (campaignStart && (!start || campaignStart > start)) start = campaignStart;
    if (campaignEnd && (!end || campaignEnd < end)) end = campaignEnd;
  }
  return { start, end };
}

function comparisonCoverage(dataset, options, range) {
  if (!range) return "none";
  const bounds = campaignScopeBounds(dataset, options);
  if (!bounds.start || !bounds.end) return "unknown";
  if (range.end < bounds.start || range.start > bounds.end) return "none";
  if (range.start >= bounds.start && range.end <= bounds.end) return "full";
  return "partial";
}

function campaignIds(options = {}) {
  if (options.cids?.length) return options.cids.map(value => String(value || "")).filter(Boolean);
  return options.cid ? [String(options.cid)] : [];
}

function rowMatches(row, options, warehouseById) {
  const date = isoDate(row?.date);
  if (options.from && date && date < options.from) return false;
  if (options.to && date && date > options.to) return false;
  if (options.pids?.length && !options.pids.includes(String(row?.pid || ""))) return false;
  const cids = campaignIds(options);
  if (cids.length && row?.cid && !cids.includes(String(row.cid))) return false;
  if (options.wid && String(row?.wid || "") !== options.wid) return false;
  const warehouse = warehouseById.get(String(row?.wid || ""));
  if (options.region && String(warehouse?.region || row?.region || "") !== options.region) return false;
  if (options.state && String(warehouse?.st || row?.st || "") !== options.state) return false;
  return true;
}

function aggregateRows(rows, dimensions, { source, summaryType, dateForRow } = {}) {
  const groups = new Map();
  for (const row of rows || []) {
    const date = dateForRow ? dateForRow(row) : isoDate(row?.date);
    const values = dimensions.map(key => key === "date" ? date : String(row?.[key] || ""));
    const key = values.join("\u001f");
    let output = groups.get(key);
    if (!output) {
      output = Object.fromEntries(dimensions.map((dimension, index) => [dimension, values[index]]));
      output.date = date;
      if (row?.product) output.product = row.product;
      if (row?.campaign) output.campaign = row.campaign;
      if (row?.channel) output.channel = row.channel;
      if (source || row?.source) output.source = source || row.source;
      if (summaryType) output.summaryType = summaryType;
      output.__latestDate = "";
      groups.set(key, output);
    }
    for (const field of NUMBER_FIELDS) {
      if (["inv", "inbound", "reserved"].includes(field)) continue;
      const value = number(row?.[field]);
      if (value) output[field] = number(output[field]) + value;
    }
    const rowDate = isoDate(row?.date);
    if (!output.__latestDate || rowDate >= output.__latestDate) {
      output.__latestDate = rowDate;
      for (const field of ["inv", "inbound", "reserved"]) {
        const knownField = `${field}Known`;
        if (row?.[field] !== undefined || row?.[knownField]) {
          output[field] = number(row?.[field]);
          output[knownField] = !!row?.[knownField] || row?.[field] !== undefined;
        }
      }
    }
  }
  return [...groups.values()].map(row => {
    delete row.__latestDate;
    return row;
  });
}

export function weeklyRows(rows, from, dimensions) {
  const anchor = from || isoDate(rows?.[0]?.date);
  if (!anchor) return [];
  const buckets = new Map();
  const bucketFor = value => {
    const date = isoDate(value) || anchor;
    if (!buckets.has(date)) buckets.set(date, addDays(anchor, Math.max(0, Math.floor(dayDistance(anchor, date) / 7)) * 7));
    return buckets.get(date);
  };
  return aggregateRows(rows, ["date", ...dimensions], {
    summaryType:"warehouse-weekly-query",
    dateForRow:row => bucketFor(row?.date),
  });
}

function periodRows(rows, to, dimensions) {
  return aggregateRows(rows, ["date", ...dimensions], {
    summaryType:"warehouse-period-query",
    dateForRow:() => to || isoDate(rows?.[rows.length - 1]?.date),
  });
}

function scopedRows(rows, options, warehouseById) {
  return (rows || []).filter(row => rowMatches(row, options, warehouseById));
}

function filterAnalysisRows(rows, options) {
  return (rows || []).filter(row => {
    const date = isoDate(row?.date);
    if (options.from && date < options.from) return false;
    if (options.to && date > options.to) return false;
    if (options.pids?.length && !options.pids.includes(String(row?.pid || ""))) return false;
    const cids = campaignIds(options);
    if (cids.length && row?.cid && !cids.includes(String(row.cid))) return false;
    if (options.region && row?.region && String(row.region) !== options.region) return false;
    if (options.state && row?.st && String(row.st) !== options.state) return false;
    return true;
  });
}

export function buildRuntimeView(dataset = {}, options = {}) {
  const view = String(options.view || "campaign");
  // Videos does not render sales, inventory or correction history. Return before
  // traversing those collections, even for the local immutable-file fallback.
  if (view === "videos") {
    const contextOptions = { ...options, region:"", state:"", wid:"" };
    const warehouseById = new Map();
    return {
      schema:"byou-intel-view-v1", view, publishedAt:dataset.publishedAt || "",
      filters:{ from:options.from || "", to:options.to || "", pids:options.pids || [], cid:options.cid || "", cids:campaignIds(options), wid:options.wid || "", region:options.region || "", state:options.state || "" },
      videos:scopedRows(dataset.videos || [], contextOptions, warehouseById),
      videoMetrics:scopedRows(dataset.videoMetrics || [], contextOptions, warehouseById),
    };
  }
  const inventoryScope = inventoryRuntimeScope(dataset, options);
  const warehouseScopeOptions = view === "inventory" ? inventoryScope.sourceOptions : options;
  const warehouseById = new Map((dataset.whs || []).map(row => [String(row?.id || ""), row]));
  const summaries = dataset.summaries || {};
  const campaign = summaries.campaign || {};
  const detailProdRows = campaign.warehouseDaily || dataset.prodSales || [];
  const detailSalesRows = campaign.portfolioWarehouseDaily || dataset.sales || dataset.prodSales || [];
  const prodScope = inventoryScope.empty ? [] : scopedRows(detailProdRows, warehouseScopeOptions, warehouseById);
  // Inventory uses product-level history, never the unscoped portfolio lane.
  const salesScope = view === "inventory" ? [] : scopedRows(detailSalesRows, { ...warehouseScopeOptions, pids:[], cid:"", cids:[] }, warehouseById);
  let prodSales = prodScope;
  let sales = salesScope;
  if (["campaign", "rankings", "analytics"].includes(view)) {
    prodSales = weeklyRows(prodScope, options.from, ["wid", "pid", "cid"]);
    sales = weeklyRows(salesScope, options.from, ["wid"]);
  } else if (view === "map") {
    prodSales = periodRows(prodScope, options.to, ["wid", "pid", "cid"]);
    sales = periodRows(salesScope, options.to, ["wid"]);
  }
  const contextOptions = { ...warehouseScopeOptions, region:"", state:"", wid:"" };
  const comparisonRange = view === "campaign" ? campaignComparisonRange(options) : null;
  const comparisonOptions = comparisonRange
    ? { ...options, from:comparisonRange.start, to:comparisonRange.end }
    : null;
  const comparisonContextOptions = comparisonOptions
    ? { ...comparisonOptions, region:"", state:"", wid:"" }
    : null;
  const comparisonProdScope = comparisonOptions
    ? scopedRows(detailProdRows, comparisonOptions, warehouseById)
    : [];
  const comparisonSalesScope = comparisonOptions
    ? scopedRows(detailSalesRows, { ...comparisonOptions, pids:[], cid:"", cids:[] }, warehouseById)
    : [];
  const comparison = comparisonOptions ? {
    range:comparisonRange,
    coverage:comparisonCoverage(dataset, options, comparisonRange),
    sales:weeklyRows(comparisonSalesScope, comparisonRange.start, ["wid"]),
    prodSales:weeklyRows(comparisonProdScope, comparisonRange.start, ["wid", "pid", "cid"]),
    inlineTotalSales:scopedRows(campaign.dailyInline || dataset.inlineTotalSales || [], comparisonContextOptions, warehouseById),
    onlineSales:scopedRows(campaign.dailyOnline || dataset.onlineSales || [], comparisonContextOptions, warehouseById),
  } : null;
  return {
    schema:"byou-intel-view-v1",
    view,
    publishedAt:dataset.publishedAt || "",
    ownerInventoryDecisions:dataset.ownerInventoryDecisions || [],
    ownerSalesCorrections:dataset.ownerSalesCorrections || [],
    ownerSalesCorrectionHistory:dataset.ownerSalesCorrectionHistory || summaries.ownerSalesCorrectionHistory || buildOwnerSalesCorrectionHistory(dataset),
    inventoryApprovals:Array.isArray(dataset.inventoryApprovals) ? dataset.inventoryApprovals : [],
    inventoryReviewDispositions:Array.isArray(dataset.inventoryReviewDispositions) ? dataset.inventoryReviewDispositions : [],
    filters:{ from:options.from || "", to:options.to || "", pids:options.pids || [], cid:options.cid || "", cids:campaignIds(options), wid:options.wid || "", region:options.region || "", state:options.state || "" },
    sales,
    prodSales,
    inlineTotalSales:inventoryScope.empty ? [] : scopedRows(campaign.dailyInline || dataset.inlineTotalSales || [], contextOptions, warehouseById),
    warehouseDailySales:filterAnalysisRows(summaries.analysis?.daily || dataset.warehouseDailySales || [], contextOptions),
    comparison,
    onlineSales:inventoryScope.empty ? [] : scopedRows(campaign.dailyOnline || dataset.onlineSales || [], contextOptions, warehouseById),
    ppcRows:scopedRows(dataset.ppcRows || [], contextOptions, warehouseById),
    footnotes:scopedRows(dataset.footnotes || [], options, warehouseById),
    videos:scopedRows(dataset.videos || [], contextOptions, warehouseById),
    videoMetrics:scopedRows(dataset.videoMetrics || [], contextOptions, warehouseById),
    analysis:view === "analytics" ? {
      daily:filterAnalysisRows(summaries.analysis?.daily, options),
      regionDaily:filterAnalysisRows(summaries.analysis?.regionDaily, options),
      stateDaily:filterAnalysisRows(summaries.analysis?.stateDaily, options),
    } : { daily:[], regionDaily:[], stateDaily:[] },
  };
}
