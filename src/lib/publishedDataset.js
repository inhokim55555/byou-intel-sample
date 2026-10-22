import { normalizeOwnerInventoryDecisions } from "./ownerInventoryDecisions.js";
import { averageWeeklyRevenueDoorStats, campaignAutomaticDateRange, verifiedSellingWarehouseStats } from "./dashboardScope.js";
import { aggregateWarehouseDailySales } from "./effectiveSales.js";
import { buildOwnerSalesCorrectionHistory, normalizeOwnerSalesCorrections } from "./ownerSalesCorrections.js";

const NUMBER_FIELDS = [
  "rev", "units", "promo", "promoUnits", "refund", "refundUnits",
  "orders", "sessions", "adSpend", "inv", "inbound", "reserved",
];

function finiteNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function rowDate(row) {
  return String(row?.date || "");
}

function rowMetricKnown(row, field) {
  const knownField = `${field}Known`;
  if (Object.prototype.hasOwnProperty.call(row || {}, knownField)) {
    return row?.[knownField] === true && row?.[field] !== "" && row?.[field] != null && Number.isFinite(Number(row[field]));
  }
  return Object.prototype.hasOwnProperty.call(row || {}, field)
    && row?.[field] !== ""
    && row?.[field] != null
    && Number.isFinite(Number(row[field]))
    && Number(row[field]) !== 0;
}

function aggregateRows(rows = [], dimensions = [], options = {}) {
  const groups = new Map();
  for (const row of rows || []) {
    if (!row || typeof row !== "object") continue;
    const dimensionValues = dimensions.map(key => String(options.dimensionValue?.(row, key) ?? row?.[key] ?? ""));
    const key = dimensionValues.join("\u001f");
    let summary = groups.get(key);
    if (!summary) {
      summary = Object.fromEntries(dimensions.map((dimension, index) => [dimension, dimensionValues[index]]));
      summary.date = rowDate(row);
      if (row.product) summary.product = row.product;
      if (row.campaign) summary.campaign = row.campaign;
      if (row.channel) summary.channel = row.channel;
      summary.source = options.source || "Published summary";
      groups.set(key, summary);
    }
    const date = rowDate(row);
    summary.date = summary.date && summary.date > date ? summary.date : date;
    for (const field of NUMBER_FIELDS) {
      if (["inv", "inbound", "reserved"].includes(field)) continue;
      const value = finiteNumber(row[field]);
      if (value) summary[field] = finiteNumber(summary[field]) + value;
    }
    if (!summary.product && row.product) summary.product = row.product;
    if (!summary.campaign && row.campaign) summary.campaign = row.campaign;
    if (!summary.channel && row.channel) summary.channel = row.channel;
    for (const field of ["inv", "inbound", "reserved"]) {
      const inventoryDateKey = `__latest_${field}_date`;
      if (rowMetricKnown(row, field) && (!summary[inventoryDateKey] || date >= summary[inventoryDateKey])) {
        summary[inventoryDateKey] = date;
        summary[field] = finiteNumber(row[field]);
        summary[`${field}Known`] = true;
      }
    }
  }
  return Array.from(groups.values()).map(summary => {
    for (const field of ["inv", "inbound", "reserved"]) delete summary[`__latest_${field}_date`];
    if (options.summaryStart) summary.summaryStart = options.summaryStart;
    if (options.summaryEnd) summary.summaryEnd = options.summaryEnd;
    if (options.summaryType) summary.summaryType = options.summaryType;
    return summary;
  });
}

function boundsFromDataset(dataset = {}) {
  const dates = [];
  for (const rows of [dataset.sales, dataset.prodSales, dataset.inlineTotalSales, dataset.onlineSales]) {
    for (const row of rows || []) if (rowDate(row)) dates.push(rowDate(row));
  }
  const declaredStart = String(dataset?.workbookSales?.meta?.start || "");
  const declaredEnd = String(dataset?.workbookSales?.meta?.end || "");
  dates.sort();
  return {
    start:declaredStart || dates[0] || "",
    end:declaredEnd || dates[dates.length - 1] || "",
  };
}

function warehouseDirectory(dataset = {}) {
  return new Map((dataset.whs || []).map(warehouse => [String(warehouse?.id || ""), warehouse]));
}

function warehouseDimensionValue(directory, row, key) {
  const warehouse = directory.get(String(row?.wid || ""));
  if (key === "region") return warehouse?.region || "Unassigned";
  if (key === "st") return warehouse?.st || "";
  return row?.[key] || "";
}

function compactRevenueDoorStats(revenueRows, denominatorRows, warehouses, bounds) {
  const weeklyStats = averageWeeklyRevenueDoorStats(revenueRows, denominatorRows, warehouses, bounds);
  const verifiedStats = verifiedSellingWarehouseStats(denominatorRows, warehouses);
  return {
    revenuePerDoor:weeklyStats.revenuePerDoor,
    activeDoors:weeklyStats.weekly.length ? verifiedStats.count : 0,
    weeklyPeriodCount:weeklyStats.weekly.length,
  };
}

function buildRevenueDoorSummary(dataset, bounds) {
  const officialRows = (dataset.inlineTotalSales || []).filter(row => Number(row?.rev || 0) > 0);
  const productWarehouseRows = dataset.prodSales || [];
  const portfolioWarehouseRows = dataset.sales?.length ? dataset.sales : productWarehouseRows;
  const products = [...new Set(officialRows.map(row => String(row?.pid || "")).filter(Boolean))]
    .sort()
    .map(pid => ({
      pid,
      ...compactRevenueDoorStats(
        officialRows.filter(row => String(row?.pid || "") === pid),
        productWarehouseRows.filter(row => String(row?.pid || "") === pid),
        dataset.whs || [],
        bounds,
      ),
    }));
  return {
    portfolio:compactRevenueDoorStats(officialRows, portfolioWarehouseRows, dataset.whs || [], bounds),
    products,
  };
}

export function buildPublishedSummaries(dataset = {}) {
  const bounds = boundsFromDataset(dataset);
  const automaticBounds = campaignAutomaticDateRange(bounds);
  const directory = warehouseDirectory(dataset);
  const dimensionValue = (row, key) => warehouseDimensionValue(directory, row, key);
  const warehouseOptions = {
    dimensionValue,
    summaryStart:bounds.start,
    summaryEnd:bounds.end,
    summaryType:"warehouse-campaign-period",
  };
  return {
    bounds,
    ownerSalesCorrectionHistory:buildOwnerSalesCorrectionHistory(dataset),
    campaign:{
      dailyInline:aggregateRows(dataset.inlineTotalSales, ["date", "pid", "cid", "channel"], { source:"Costco_Daily_Totals summary", summaryType:"campaign-daily-inline" }),
      dailyOnline:aggregateRows(dataset.onlineSales, ["date", "pid", "cid", "channel"], { source:"Online_Sales_Raw summary", summaryType:"campaign-daily-online" }),
      warehouse:aggregateRows(dataset.prodSales, ["wid", "pid", "cid"], warehouseOptions),
      warehouseDaily:aggregateRows(dataset.prodSales, ["date", "wid", "pid", "cid"], { ...warehouseOptions, summaryType:"campaign-warehouse-daily" }),
      portfolioWarehouse:aggregateRows(dataset.sales?.length ? dataset.sales : dataset.prodSales, ["wid"], { ...warehouseOptions, summaryType:"warehouse-portfolio-period" }),
      portfolioWarehouseDaily:aggregateRows(dataset.sales?.length ? dataset.sales : dataset.prodSales, ["date", "wid"], { ...warehouseOptions, summaryType:"warehouse-portfolio-daily" }),
      revenueDoor:buildRevenueDoorSummary(dataset, bounds),
      automaticRevenueDoor:buildRevenueDoorSummary(dataset, automaticBounds),
    },
    analysis:{
      daily:aggregateWarehouseDailySales(dataset.prodSales),
      regionDaily:aggregateRows(dataset.prodSales, ["date", "pid", "cid", "region"], { dimensionValue, summaryType:"analysis-region-daily" }),
      stateDaily:aggregateRows(dataset.prodSales, ["date", "pid", "cid", "st"], { dimensionValue, summaryType:"analysis-state-daily" }),
    },
  };
}

export function buildRuntimeBootstrap(dataset = {}, precomputedSummaries = null) {
  const bounds = precomputedSummaries?.bounds || boundsFromDataset(dataset);
  const automaticBounds = campaignAutomaticDateRange(bounds);
  const dailyInline = precomputedSummaries?.campaign?.dailyInline || aggregateRows(dataset.inlineTotalSales, ["date", "pid", "cid", "channel"], { source:"Costco_Daily_Totals summary", summaryType:"campaign-daily-inline" });
  const dailyOnline = precomputedSummaries?.campaign?.dailyOnline || aggregateRows(dataset.onlineSales, ["date", "pid", "cid", "channel"], { source:"Online_Sales_Raw summary", summaryType:"campaign-daily-online" });
  const warehouseDailySales = precomputedSummaries?.analysis?.daily || aggregateWarehouseDailySales(dataset.prodSales);
  const directory = warehouseDirectory(dataset);
  const dimensionValue = (row, key) => warehouseDimensionValue(directory, row, key);
  const warehouseOptions = { dimensionValue, summaryStart:bounds.start, summaryEnd:bounds.end, summaryType:"warehouse-campaign-period" };
  const portfolioWarehouse = precomputedSummaries?.campaign?.portfolioWarehouse || aggregateRows(dataset.sales?.length ? dataset.sales : dataset.prodSales, ["wid"], { ...warehouseOptions, summaryType:"warehouse-portfolio-period" });
  const campaignTotals = aggregateRows([...dailyInline, ...dailyOnline], ["pid", "cid", "channel"], { summaryType:"campaign-official-period" });
  const activeWarehouseIds = [...new Set((dataset.sales?.length ? dataset.sales : dataset.prodSales || [])
    .filter(row => finiteNumber(row?.rev) > 0)
    .map(row => String(row?.wid || ""))
    .filter(Boolean))];
  return {
    schema:"byou-intel-bootstrap-v4",
    version:4,
    publishedAt:dataset.publishedAt || new Date().toISOString(),
    sourceSchema:dataset.schema || "byou-intel-dataset-v1",
    ownerInventoryDecisions:normalizeOwnerInventoryDecisions(dataset.ownerInventoryDecisions || [], dataset),
    ownerSalesCorrections:normalizeOwnerSalesCorrections(dataset.ownerSalesCorrections || [], dataset),
    ownerSalesCorrectionHistory:precomputedSummaries?.ownerSalesCorrectionHistory || buildOwnerSalesCorrectionHistory(dataset),
    productMeta:dataset.productMeta || {},
    campaignMeta:dataset.campaignMeta || {},
    inventoryApprovals:Array.isArray(dataset.inventoryApprovals) ? dataset.inventoryApprovals : [],
    inventoryReviewDispositions:Array.isArray(dataset.inventoryReviewDispositions) ? dataset.inventoryReviewDispositions : [],
    whs:Array.isArray(dataset.whs) ? dataset.whs : [],
    ppcRows:Array.isArray(dataset.ppcRows) ? dataset.ppcRows : [],
    activeWarehouseIds,
    inlineTotalSales:dailyInline,
    warehouseDailySales,
    onlineSales:dailyOnline,
    workbookSales:{ meta:dataset.workbookSales?.meta || { start:bounds.start, end:bounds.end, rows:0 } },
    summaries:{ bounds, campaign:{
      totals:campaignTotals,
      portfolioWarehouse,
      revenueDoor:precomputedSummaries?.campaign?.revenueDoor || buildRevenueDoorSummary(dataset, bounds),
      automaticRevenueDoor:precomputedSummaries?.campaign?.automaticRevenueDoor || buildRevenueDoorSummary(dataset, automaticBounds),
    } },
    detail:{
      available:true,
      salesRows:Array.isArray(dataset.sales) ? dataset.sales.length : 0,
      productRows:Array.isArray(dataset.prodSales) ? dataset.prodSales.length : 0,
    },
  };
}

export function runtimeBootstrapHasRevenueDoorSummary(bootstrap = {}) {
  return bootstrap?.schema === "byou-intel-bootstrap-v4"
    && !!bootstrap?.summaries?.campaign?.revenueDoor?.portfolio
    && !!bootstrap?.summaries?.campaign?.automaticRevenueDoor?.portfolio;
}

export function buildStartupDataset(dataset = {}) {
  const summaries = buildPublishedSummaries(dataset);
  const bootstrap = buildRuntimeBootstrap(dataset, summaries);
  return {
    ...bootstrap,
    schema:"byou-intel-startup-v2",
    version:2,
    footnotes:Array.isArray(dataset.footnotes) ? dataset.footnotes : [],
    videos:Array.isArray(dataset.videos) ? dataset.videos : [],
    videoMetrics:Array.isArray(dataset.videoMetrics) ? dataset.videoMetrics : [],
    summaries,
  };
}

export function startupWarehouseRows(dataset = {}) {
  return Array.isArray(dataset?.summaries?.campaign?.warehouse)
    ? dataset.summaries.campaign.warehouse
    : [];
}
export function startupPortfolioRows(dataset = {}) {
  return Array.isArray(dataset?.summaries?.campaign?.portfolioWarehouse)
    ? dataset.summaries.campaign.portfolioWarehouse
    : [];
}
