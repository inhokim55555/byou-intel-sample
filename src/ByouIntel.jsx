// Calendar presentation is intentionally excluded from this local portfolio edition.
const PORTFOLIO_CALENDAR_NOTES = [];
import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useUiText, LanguageContext, VIDEO_METRICS, fmtCurrency, productValuesMatch, normalizedProductKey, productDisplayName, productLabelForValue, canonicalCompanyProductLabel, COMPANY_PRODUCT_ALIAS_TO_CANONICAL, PRODUCTS, productMetaForProduct, productMetaNameKey, rowMatchesCampaignScope, rowCampaignId, VIDEO_CHANGE_METRICS, productWithMeta, productColorForValue, C, metricGrowth, parseISODate, videoDisplayName, SANS, HELVETICA_NEUE_STACK, Panel, MONO, fmtMetricDelta, safeExternalHttpUrl, CARD_METRICS, fmtGrowth, MAP_W, MAP_H, KpiCard, fmtCompactMoney } from "./ui/dashboardShared.jsx";
const LazyVideosView = React.lazy(() => import("./features/videos/VideosView.jsx"));
const LazyMapView = React.lazy(() => import("./features/map/MapView.jsx"));
import useRuntimeView from "./data/useRuntimeView.js";
import useStartupDataset from "./data/useStartupDataset.js";
import { CAMPAIGN_TRANSPORT_REPRESENTATION } from "./lib/campaignTransport.js";
import { COMPANY_PRODUCT_CANONICAL_TO_ALIASES } from "./ui/dashboardShared.jsx";
import RuntimeViewBoundary from "./components/RuntimeViewBoundary.jsx";
import TabReady from "./components/TabReady.jsx";

import useInventoryFlow from "./components/useInventoryFlow.js";
import { SESSION_EXPIRED_EVENT, fetchRuntimeView, notifySessionExpired, runtimeRequestUrl, runtimeDisplayState } from "./lib/runtimeRequest.js";
import { RuntimeViewCache } from "./lib/runtimeViewCache.js";
import { getReloadInteractionTelemetry, markReloadBenchmarkActivation, reloadInteractionSnapshot, subscribeReloadInteraction, waitForReloadInteractionReady } from "./lib/reloadInteraction.js";
import {
  RELOAD_BENCHMARK_INPUT_WINDOW_MS,
  RELOAD_BENCHMARK_TARGET,
  appendReloadBenchmarkSample,
  isReloadBenchmarkEnabled,
  readReloadBenchmarkSession,
  resetReloadBenchmarkSession,
  summarizeReloadBenchmark,
} from "./lib/reloadBenchmark.js";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine
} from "recharts";
import _ from "lodash";

import { findStore, normalizeStoreText, warehouseLocationLabel, warehouseNumberFromText } from "./lib/storeLookup.js";
import { allocateWarehouseIdentity } from "./lib/warehouseIdentity.js";
import { mergeWorkbookRows, missingCoreWorkbookSheets, workbookFromSheets } from "./lib/workbookRows.js";
import { readCachedStartupDataset, writeCachedStartupDataset } from "./lib/datasetCache.js";
import { aggregateWarehouseDailySales, effectiveInlineSalesRows } from "./lib/effectiveSales.js";
import { OWNER_INVENTORY_SHEET, ownerInventoryDecisionsFromSheet, mergeOwnerInventoryDecisions, resolveOwnerInventoryDecision, applyOwnerInventoryResult, consumerWarehouseSales } from "./lib/ownerInventoryDecisions.js";
import { OWNER_SALES_CORRECTION_SHEET, ownerSalesCorrectionsFromSheet, completeOwnerCorrectionDirectory, mergeOwnerSalesCorrections, rebindOwnerSalesCorrections, buildOwnerSalesCorrectionHistory, ownerSalesTotalsForScope } from "./lib/ownerSalesCorrections.js";
import {
  aggregateOnlineInventoryRows,
  averageWeeklyUnits,
  averageWeeklyRevenueDoorStats,
  CAMPAIGN_DEFAULT_START,
  campaignAutomaticDateRange,
  campaignMetricDateBounds,
  campaignRevenueDoorDenominatorSources,
  chartDateDomain,
  comparisonValueState,
  dateAwareCampaignOptions,
  dateRangeAfterBoundsRefresh,
  filterWarehouseMatches,
  inventoryCampaignScopeKey,
  inventoryCampaignActiveAt,
  inventoryCoverageEvidence,
  inventoryEligibilityState,
  matchingInventoryApproval,
  matchingInventoryReviewDisposition,
  onlineInventoryValidationEvidence,
  inventoryRowHasKnownBalance,
  inventorySellThrough,
  inventoryValidationEvidence,
  isNonStoreWarehouse,
  rollingDatePreset,
  salesTrendDateLabel,
  scopeRowsToWarehouseMatches,
  shouldIncludeInventoryCoverageItem,
  verifiedSellingWarehouseStats,
} from "./lib/dashboardScope.js";
import {
  numberValue,
  normalizeDateValue,
  dateKey,
  validDateKey,
  dateKeyFromIsoParts,
  dateKeyFromUsParts,
  MONTH_NAME_TO_NUMBER,
} from "./lib/parse.js";

import { programmaticPacingSourcesFromWorkbook } from "./lib/programmaticPacing.js";
import { campaignChannelSupports } from "./lib/campaignChannel.js";
import { groupProductFilterOptions, expandProductFilterIds, channelViewDataset, campaignContextMatchesChannel } from "./lib/dashboardFilters.js";
import { buildRankingsPacingScope, buildRankingsRuntimeQuery, selectPacingCampaignRows } from "./lib/runtimeQuery.js";
import { ANALYSIS_COMPACT_REPRESENTATION, ANALYSIS_COMPACT_SCHEMA, analysisComparisonDefaults, analysisComparisonProductOptions } from "./lib/analysisCompact.js";
import { SALES_COMPACT_REPRESENTATION, SALES_COMPACT_SCHEMA } from "./lib/salesCompact.js";
import { buildMapRuntimeScope, mapComparisonMarkers, mapComparisonStoreIsVisible, mapSelectionKey } from "./lib/mapScope.js";
import { manualInventoryApprovalBusinessKey, upsertInventoryApproval } from "./lib/manualInventoryApproval.js";

const LazyRankingsView = React.lazy(() => import("./AnalysisView.jsx"));
const LazyPnlView = React.lazy(() => import("./PnlView.jsx"));
let papaModulePromise = null;
let spreadsheetExporterPromise = null;

function loadPapa() {
  papaModulePromise ||= import("papaparse").then(module => module.default || module);
  return papaModulePromise;
}

function loadSpreadsheetExporter() {
  spreadsheetExporterPromise ||= import("write-excel-file/browser").then(module => module.default || module);
  return spreadsheetExporterPromise;
}

// ═══════════════════════════════════════════════════════════════
// CONSTANTS & DATA GENERATION
// ═══════════════════════════════════════════════════════════════

const WAREHOUSES = [{"id":"W001","name":"Sample Cedar Bay","city":"Cedar Bay","st":"CA","region":"Los Angeles","lat":34.05,"lng":-118.25,"base":1000},{"id":"W002","name":"Sample Pine Valley","city":"Pine Valley","st":"CA","region":"Bay Area","lat":37.77,"lng":-122.42,"base":1150},{"id":"W003","name":"Sample Maple Harbor","city":"Maple Harbor","st":"WA","region":"Northwest","lat":47.6,"lng":-122.33,"base":1300},{"id":"W004","name":"Sample Oak Ridge","city":"Oak Ridge","st":"OR","region":"Northwest","lat":45.52,"lng":-122.67,"base":1450},{"id":"W005","name":"Sample Silver Meadow","city":"Silver Meadow","st":"TX","region":"Texas","lat":30.27,"lng":-97.74,"base":1600},{"id":"W006","name":"Sample Willow Creek","city":"Willow Creek","st":"TX","region":"Texas","lat":32.78,"lng":-96.8,"base":1750},{"id":"W007","name":"Sample Birch Falls","city":"Birch Falls","st":"IL","region":"Midwest","lat":41.88,"lng":-87.63,"base":1900},{"id":"W008","name":"Sample Aspen Grove","city":"Aspen Grove","st":"CO","region":"Midwest","lat":39.74,"lng":-104.99,"base":2050},{"id":"W009","name":"Sample Juniper Point","city":"Juniper Point","st":"NY","region":"Northeast","lat":40.71,"lng":-74.01,"base":2200},{"id":"W010","name":"Sample Clover Hill","city":"Clover Hill","st":"MA","region":"Northeast","lat":42.36,"lng":-71.06,"base":2350},{"id":"W011","name":"Sample Laurel Cove","city":"Laurel Cove","st":"GA","region":"Southeast","lat":33.75,"lng":-84.39,"base":2500},{"id":"W012","name":"Sample Fern Lake","city":"Fern Lake","st":"FL","region":"Southeast","lat":28.54,"lng":-81.38,"base":2650}];






function companyProductAliasKeys(value) {
  const canonical = canonicalCompanyProductLabel(value);
  const canonicalKey = normalizedProductKey(canonical);
  return canonicalKey ? (COMPANY_PRODUCT_CANONICAL_TO_ALIASES.get(canonicalKey) || []) : [];
}



const INIT_FOOTNOTES = [];

const FN_TYPES = {
  demo:     {label:"Demo",      short:"DEMO", col:"#EC4899"},
  tpd:      {label:"TPD",       short:"TPD",  col:"#60A5FA"},
  promo:    {label:"Promo",     short:"PRMO", col:"#2DD4A0"},
  meta:     {label:"Meta Ad",   short:"META", col:"#2563EB"},
  issue:    {label:"Issue",     short:"FLAG", col:"#F46C6C"},
  seasonal: {label:"Seasonal",  short:"SEAS", col:"#A78BFA"},
  markdown: {label:"Markdown",  short:"Markdown", col:"#A16207"},
  other:    {label:"Other",     short:"NOTE", col:"#94A3B8"},
};
const IMPACT_EVENT_TYPES = new Set(["tpd","markdown","promo","demo","seasonal","meta"]);

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAYS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const DATA_START = "2025-08-03";
const DATA_END   = "2026-04-26";


function localDateKey(dt = new Date()) {
  return validDateKey(dt.getFullYear(), dt.getMonth() + 1, dt.getDate()) || dateKey(dt);
}

function splitInventoryApprovalSources(rows = []) {
  const published = [];
  const manual = [];
  for (const approval of rows || []) {
    if (approval?.approvalSource === "manual_runtime") manual.push(approval);
    else published.push(approval);
  }
  return { published, manual };
}

function calendarYearValue(row) {
  const raw = cellValue(row, ["Calendar Year","CalendarYear","Year"]);
  const match = String(raw ?? "").match(/\b(20\d{2}|19\d{2})\b/);
  const year = match ? Number(match[1]) : Number(raw);
  return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : "";
}

function offsetDate(d, days) {
  const dt = parseISODate(d);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dateKey(dt);
}

function inclusiveDays(start, end) {
  return Math.round((parseISODate(end) - parseISODate(start)) / 864e5) + 1;
}

function maxDateKey(...dates) {
  return dates.filter(Boolean).sort().pop() || DATA_END;
}

function clampDateKey(date, minDate = DATA_START, maxDate = DATA_END) {
  const value = date || maxDate || DATA_END;
  if (minDate && value < minDate) return minDate;
  if (maxDate && value > maxDate) return maxDate;
  return value;
}

function monthStartKey(date) {
  return `${date.slice(0, 8)}01`;
}

function calendarDefaultDateRange(bounds = {}, today = localDateKey()) {
  const minDate = bounds.start || DATA_START;
  const maxDate = maxDateKey(bounds.end || DATA_END, today);
  const anchor = clampDateKey(today, minDate, maxDate);
  return {
    start:clampDateKey(monthStartKey(anchor), minDate, maxDate),
    end:clampDateKey(anchor, minDate, maxDate),
  };
}

function isWeekend(date) {
  const day = parseISODate(date).getUTCDay();
  return day === 0 || day === 6;
}

function uniqueByExisting(prev, rows, keyFn) {
  const seen = new Set(prev.map(keyFn));
  return rows.filter(row => {
    const key = keyFn(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function upsertByKey(prev, rows, keyFn) {
  const next = new Map(prev.map(row => [keyFn(row), row]));
  rows.forEach(row => next.set(keyFn(row), row));
  return Array.from(next.values());
}

function matchProduct(raw, productMeta = {}) {
  const exact = matchProductExact(raw, productMeta);
  if (exact) return exact;
  const display = productDisplayName(String(raw || "").trim());
  const s = display.toLowerCase();
  if (!s) return null;
  const legacy = PRODUCTS.find(p => s.includes(p.name.toLowerCase()) || s.includes(p.short.toLowerCase()) || p.name.toLowerCase().includes(s) || p.short.toLowerCase().includes(s));
  if (legacy) return productWithMeta(legacy.id, productMeta) || legacy;
  return { id:display, name:display, short:display, col:productColorForValue(display), active:true };
}

function matchProductExact(raw, productMeta = {}) {
  const key = normalizedProductKey(raw);
  if (!key) return null;
  const canonical = canonicalCompanyProductLabel(raw);
  if (canonical && normalizedProductKey(canonical) !== key) {
    return matchProductExact(canonical, productMeta);
  }
  const meta = productMetaForProduct(raw, productMeta);
  if (meta?.id || meta?.name || meta?.short) {
    const label = productDisplayName(meta.short || meta.name || meta.id || raw);
    return {
      id:productDisplayName(meta.id || label),
      name:productDisplayName(meta.name || label),
      short:productDisplayName(meta.short || meta.name || label),
      col:meta.col || productColorForValue(label),
      active:meta.active !== false,
      totalWarehouses:meta.totalWarehouses,
    };
  }
  return productCatalog(productMeta).find(p =>
    normalizedProductKey(p.id) === key ||
    normalizedProductKey(p.name) === key ||
    normalizedProductKey(p.short) === key
  ) || null;
}

const MAX_WORKBOOK_BYTES = 40 * 1024 * 1024;

function validateWorkbookUpload(file) {
  if (typeof window === "undefined") throw new Error("Workbook imports run in the browser preview.");
  if (/\.(xls)$/i.test(file.name)) throw new Error("Legacy .xls files are blocked for security. Save the file as .xlsx or upload CSV.");
  if (!/\.(xlsx|xlsm)$/i.test(file.name)) throw new Error("Workbook imports must be .xlsx or .xlsm files.");
  if (file.size > MAX_WORKBOOK_BYTES) throw new Error(`Workbook is too large. Limit is ${fmtBytes(MAX_WORKBOOK_BYTES)}.`);
}

function readWorkbookInWorker(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./workers/readWorkbook.worker.js", import.meta.url), { type:"module" });
    const finish = (callback, value) => {
      worker.terminate();
      callback(value);
    };
    worker.onmessage = event => {
      if (event.data?.ok) finish(resolve, event.data.workbook);
      else finish(reject, new Error(event.data?.error || "Could not read workbook"));
    };
    worker.onerror = event => finish(reject, new Error(event.message || "Workbook worker failed"));
    worker.postMessage({ file });
  });
}

async function readWorkbook(file) {
  validateWorkbookUpload(file);
  if (typeof Worker === "function") return readWorkbookInWorker(file);
  const { default:readExcelFile } = await import("read-excel-file/browser");
  const sheets = await readExcelFile(file);
  return workbookFromSheets(sheets);
}
function sheetDataFromObjects(rows = []) {
  const headers = [...new Set(rows.flatMap(row => Object.keys(row || {})))];
  if (!headers.length) return [[]];
  return [
    headers,
    ...rows.map(row => headers.map(header => row?.[header] ?? "")),
  ];
}

function templateSheet(sheet, rows) {
  return { sheet, data:sheetDataFromObjects(rows), stickyRowsCount:1 };
}

function normalizedHeaderKey(value) {
  return String(value ?? "").replace(/^[\uFEFF\u200B-\u200F\u2060]+/, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function cellValue(row, names = []) {
  if (!row || typeof row !== "object") return "";
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && row[name] !== "") return row[name];
  }
  const keys = Object.keys(row || {});
  for (const name of names) {
    const targetKey = normalizedHeaderKey(name);
    const key = keys.find(k => normalizedHeaderKey(k) === targetKey);
    if (key && row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  }
  return "";
}

function usableObjectRows(rows = []) {
  return (rows || []).filter(row =>
    row &&
    typeof row === "object" &&
    Object.values(row).some(value => value !== undefined && value !== null && value !== "")
  );
}

function rowHeaderKeys(rows = []) {
  return new Set(usableObjectRows(rows).slice(0, 20).flatMap(row =>
    Object.keys(row || {}).map(normalizedHeaderKey).filter(Boolean)
  ));
}

const PRODUCT_IMPORT_COLUMNS = ["Product","product","Item","item","Brand","brand","Brand Name","brand_name","SKU","sku","SKU Name","sku_name","Product Name","product_name","Product ID","Product_ID","product_id","PID","pid","Short Name","Short_Name","short_name","Product_Short","product_short","Product Short"];
const CAMPAIGN_IMPORT_COLUMNS = ["Campaign_ID","Campaign ID","campaign_id","CID","cid","Campaign","campaign","Campaign Name","Campaign_Name","campaign_name","Program","program","Program Name","program_name","Costco Campaign","Costco_Campaign","costco_campaign"];
const DATE_IMPORT_COLUMNS = ["Date","Week Ending","1 Week Ending","Order Date","Snapshot Date","Week","Time"];
const VIDEO_URL_COLUMNS = ["URL","Url","url","Video URL","Video_URL","video_url","Canonical URL","canonical_url","Link","link","Post URL","post_url"];
const VIDEO_TITLE_COLUMNS = ["Title","title","Video Title","Video_Title","video_title","Title Caption","Title_Caption","title_caption","Caption","caption","Description","description"];
const VIDEO_CREATOR_COLUMNS = ["Creator","creator","Influencer","influencer","Handle","handle","Username","username","Creator Handle","creator_handle"];
const VIDEO_PLATFORM_COLUMNS = ["Platform","platform","Channel","channel","Network","network"];
const VIDEO_TYPE_COLUMNS = ["Type","type","Video Type","Video_Type","video_type","Campaign Type","Campaign_Type","campaign_type","Video Category","video_category","Category","category","Source","source","Program","program","Program Type","program_type","__VideoType"];
const VIDEO_RATE_COLUMNS = ["Rate","rate","Fixed Rate","Fixed_Rate","fixed_rate","Paid Rate","Paid_Rate","paid_rate","Influencer Rate","influencer_rate","Creator Rate","creator_rate","Fee","fee","Flat Fee","flat_fee","Payment","payment","Paid Amount","paid_amount","Amount Paid","amount_paid","Cost","cost"];
const VIDEO_SNAPSHOT_DATE_COLUMNS = ["Snapshot Date","snapshot_date","Metrics Date","metrics_date","Metric Date","metric_date","Collected At","collected_at","Last Updated","last_updated","Last Updated Date","last_updated_date","Updated","updated","Updated At","updated_at","As Of","as_of","As Of Date","as_of_date"];
const VIDEO_POST_DATE_COLUMNS = ["Post Date","post_date","Posted Date","posted_date","Date Posted","date_posted","Publish Date","publish_date","Published Date","published_date","Published At","published_at","Upload Date","upload_date","Upload_Date","Uploaded At","uploaded_at","Date Uploaded","date_uploaded","Created At","created_at","First Seen At","first_seen_at"];
const VIDEO_COLLECTION_COLUMNS = ["Collection","collection","Collection Name","collection_name","Collection Title","collection_title","Campaign Collection","campaign_collection","Product Collection","product_collection","Folder","folder","Folder Name","folder_name","Group","group","Group Name","group_name","Playlist","playlist","Playlist Name","playlist_name","List","list","Tag","tag","Tags","tags","Label","label","Labels","labels"];
const VIDEO_PRIMARY_ASSIGNMENT_COLUMNS = [...PRODUCT_IMPORT_COLUMNS, ...CAMPAIGN_IMPORT_COLUMNS, ...VIDEO_COLLECTION_COLUMNS, ...VIDEO_TYPE_COLUMNS];
const PPC_PARTNER_DEFAULT = "Criteo";
const META_PARTNER = "Meta";
const PROGRAMMATIC_PARTNER = "Programmatic";
const PAID_MEDIA_PRODUCT_ALIASES = new Map();
const META_PRODUCT_ALIASES = PAID_MEDIA_PRODUCT_ALIASES;
const PPC_PRODUCT_COLUMNS = ["Product_ID","BYOU Product ID","BYOU Product","Product","Product Name","SKU Name","Item","Advertised Product","Promoted Product","Product ID"];
const PPC_CAMPAIGN_COLUMNS = ["BYOU Campaign ID","Costco Campaign ID","Costco Campaign_ID","Campaign_ID","CID"];
const PPC_EXTERNAL_CAMPAIGN_COLUMNS = ["External Criteo Campaign ID","External Campaign ID","Criteo Campaign ID","Criteo Campaign","Retailer Campaign ID","Meta Campaign ID","Campaign ID"];
const PPC_SNAPSHOT_START_COLUMNS = ["Snapshot_Start","Snapshot Start","Report Start","Report_Start","L7D Start","Period Start","Week Start","Reporting Starts","Reporting Start","Date Start","Day"];
const PPC_SNAPSHOT_END_COLUMNS = ["Snapshot_End","Snapshot End","Report End","Report_End","L7D End","Period End","Week Ending","Week End","Reporting Ends","Reporting End","Date Stop","Date","Day"];
const STORE_DETAIL_METRIC_COLUMNS = [
  "Revenue",
  "Dollar Sales",
  "Sales Dollars",
  "Unit Sales",
  "Units",
  "Units Sold",
  "Promoted Dollars",
  "Promo Dollars",
  "Promoted Units",
  "Promo Units",
  "Refund Dollars",
  "Refund Units",
  "Inventory",
  "Inventory On Hand",
  "On Hand",
  "Available Inventory",
  "Available Units",
  "Ending Inventory",
  "Stock On Hand",
  "Inbound",
  "Incoming",
  "Inbound Units",
  "Incoming Units",
  "On Order",
  "Reserved",
  "Committed",
  "Reserved Units",
  "Allocated",
  "Allocated Units",
];
const WAREHOUSE_SELLING_COLUMNS = [
  "Number of Warehouses Selling",
  "Warehouses Selling",
  "Warehouse Selling",
  "Selling Warehouses",
  "Active Warehouses",
  "Active Stores",
  "Active Doors",
  "Number of Stores Selling",
  "Stores Selling",
  "Doors Selling",
  "Number of Doors Selling",
];
const PRODUCT_TOTAL_WAREHOUSE_COLUMNS = [
  "Total Warehouses",
  "Total_Warehouses",
  "Total Warehouse",
  "Total_Warehouse",
  "Total Stores",
  "Total_Stores",
  "Total Doors",
  "Total_Doors",
  "Warehouse Count",
  "Warehouse_Count",
  "Store Count",
  "Store_Count",
  "Door Count",
  "Door_Count",
  "Number of Warehouses",
  "Number_of_Warehouses",
  "Number of Stores",
  "Number_of_Stores",
  "Number of Doors",
  "Number_of_Doors",
];
const COSTCO_TOTAL_SCOPE_COLUMNS = ["Venue","Region","Market","Scope","Location","Warehouse","Store"];

function importDateValue(row, names = []) {
  return normalizeDateValue(cellValue(row, [...names, ...DATE_IMPORT_COLUMNS]), calendarYearValue(row));
}

function totalScopeText(row) {
  return String(cellValue(row, COSTCO_TOTAL_SCOPE_COLUMNS) || "").trim();
}

function isStrictCostcoTotalRow(row) {
  const text = totalScopeText(row).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text || /\bsub\s*total\b/.test(text)) return false;
  return /^(grand\s+)?total$/.test(text) ||
    /^all(\s+(warehouses|stores|doors|locations|costco|regions|markets))?$/.test(text) ||
    /^(national|company|costco|u\.?s\.?a?|united states)$/.test(text) ||
    /^(national|company|costco|u\.?s\.?a?|united states)\s+total$/.test(text) ||
    /^total\s+(warehouses|stores|doors|locations|costco|regions|markets|national|u\.?s\.?a?|united states)$/.test(text);
}

function prepareCostcoBlockRows(data, { totalsOnly = false } = {}) {
  let lastProduct = "";
  let lastCampaign = "";
  let lastDate = "";
  const rows = (data || []).map(row => {
    const product = productDisplayName(String(cellValue(row, PRODUCT_IMPORT_COLUMNS)).trim());
    const campaign = campaignDisplayName(String(cellValue(row, CAMPAIGN_IMPORT_COLUMNS)).trim());
    const date = importDateValue(row);
    const productChanged = product && product !== lastProduct;
    if (productChanged && !campaign) lastCampaign = "";
    if (product) lastProduct = product;
    if (campaign) lastCampaign = campaignDisplayName(campaign);
    if (date) lastDate = date;
    const next = { ...row };
    if (!String(cellValue(next, PRODUCT_IMPORT_COLUMNS)).trim() && lastProduct) next.Product = lastProduct;
    if (!String(cellValue(next, CAMPAIGN_IMPORT_COLUMNS)).trim() && lastCampaign) next.Campaign = lastCampaign;
    if (!importDateValue(next) && lastDate) next.Date = lastDate;
    return next;
  });
  if (!totalsOnly) return rows;
  const totalRows = rows.filter(row => /\btotal\b/i.test(totalScopeText(row)));
  return totalRows.length ? totalRows : rows;
}

function warehouseSellingValue(row) {
  return Math.round(numberValue(cellValue(row, WAREHOUSE_SELLING_COLUMNS)));
}

function productFromRow(row, productMeta = {}) {
  const id = String(cellValue(row, ["Product_ID","Product ID","PID","ID"])).trim();
  if (id) {
    const exact = matchProductExact(id, productMeta);
    if (exact) return exact;
    const byId = PRODUCTS.find(p => p.id.toLowerCase() === id.toLowerCase());
    if (byId) return productWithMeta(byId.id, productMeta) || byId;
  }
  return matchProduct(cellValue(row, [...PRODUCT_IMPORT_COLUMNS, "Short Name", "Product_Short", "Product Short", "Short"]), productMeta);
}

function productMetaFromRows(rows) {
  const next = {};
  (rows || []).forEach(row => {
    const productId = productDisplayName(String(cellValue(row, ["Product_ID", "Product ID", "PID", "ID"])).trim());
    const prod = productFromRow(row);
    const productName = productDisplayName(String(cellValue(row, ["Product", "Product Name", "Short Name", "Short_Name", "Product_Short", "Product Short", "Item", "Brand"])).trim());
    const short = productDisplayName(String(cellValue(row, ["Short Name", "Short_Name", "Product_Short", "Product Short", "Short"])).trim());
    const canonicalId = productDisplayName(productName || short || prod?.short || prod?.name || productId);
    const keys = new Set();
    if (canonicalId) keys.add(canonicalId);
    if (prod?.id) keys.add(prod.id);
    if (productId) keys.add(productId);
    [canonicalId, productName, short, productId, prod?.name, prod?.short].map(productMetaNameKey).filter(Boolean).forEach(key => keys.add(key));
    if (!keys.size) return;
    const totalWarehouses = Math.round(numberValue(cellValue(row, PRODUCT_TOTAL_WAREHOUSE_COLUMNS)));
    const color = String(cellValue(row, ["Brand Color", "Brand_Color", "Color", "Product Color", "Product_Color"])).trim();
    const category = productDisplayName(String(cellValue(row, ["Category", "Product Category", "Segment", "Department"])).trim());
    const activeRaw = String(cellValue(row, ["Active", "Status"])).trim().toLowerCase();
    const patch = {};
    patch.id = canonicalId || productId || prod?.id || productName || short;
    if (totalWarehouses > 0) patch.totalWarehouses = totalWarehouses;
    if (productName || canonicalId) patch.name = productName || canonicalId;
    if (short || canonicalId) patch.short = short || canonicalId;
    if (category) patch.category = category;
    if (/^#[0-9a-f]{3,8}$/i.test(color)) patch.col = color;
    if (activeRaw) patch.active = !["no", "false", "inactive", "0"].includes(activeRaw);
    keys.forEach(key => {
      next[key] = { ...(next[key] || {}), ...patch };
    });
  });
  return next;
}



function productTotalWarehouses(pid, productMeta = {}) {
  return Math.max(0, Math.round(Number(productMetaForProduct(pid, productMeta)?.totalWarehouses || productWithMeta(pid, productMeta)?.totalWarehouses || 0)));
}

function productIsActive(pidOrName, productMeta = {}) {
  return productMetaForProduct(pidOrName, productMeta)?.active !== false;
}


function productIdentityKeys(value, productMeta = {}) {
  const keys = new Set();
  const add = candidate => {
    const key = normalizedProductKey(candidate);
    if (key) keys.add(key);
  };
  const base = PRODUCTS.find(p => p.id === value);
  const meta = productMetaForProduct(value, productMeta);
  const merged = productWithMeta(value, productMeta);
  [value, base?.id, base?.name, base?.short, meta?.id, meta?.name, meta?.short, merged?.id, merged?.name, merged?.short].forEach(candidate => {
    add(candidate);
    companyProductAliasKeys(candidate).forEach(key => keys.add(key));
  });
  return [...keys];
}

function productIdsFromRows(rows) {
  return [...new Set((rows || []).map(productIdForMetricRow).filter(Boolean))];
}

function totalWarehousesForProductIds(pids, productMeta = {}) {
  return [...new Set(pids || [])].reduce((sum, pid) => sum + productTotalWarehouses(pid, productMeta), 0);
}

function productMetaWarehouseCount(productMeta = {}) {
  const seen = new Set();
  Object.entries(productMeta || {}).forEach(([key, meta]) => {
    if (Number(meta?.totalWarehouses || 0) <= 0) return;
    seen.add(normalizedProductKey(meta?.name || meta?.short || key.replace(/^name:/, "")) || key);
  });
  return seen.size;
}

function productCatalog(productMeta = {}) {
  const byKey = new Map();
  const add = product => {
    if (!product?.id) return;
    const clean = {
      ...product,
      name:productDisplayName(product.name || product.short || product.id),
      short:productDisplayName(product.short || product.name || product.id),
      col:product.col || productColorForValue(product.short || product.name || product.id),
      active:product.active !== false,
    };
    const key = normalizedProductKey(clean.id) || normalizedProductKey(clean.name) || normalizedProductKey(clean.short);
    if (!key) return;
    byKey.set(key, { ...(byKey.get(key) || {}), ...clean });
  };
  PRODUCTS.forEach(p => add(productWithMeta(p.id, productMeta) || p));
  Object.entries(productMeta || {}).forEach(([key, meta]) => {
    const rawKey = key.startsWith("name:") ? key.slice(5) : key;
    const id = meta?.id || meta?.name || meta?.short || rawKey;
    add({
      id,
      name:meta?.name || meta?.short || id,
      short:meta?.short || meta?.name || id,
      col:meta?.col || productColorForValue(id),
      category:meta?.category || "",
      active:meta?.active !== false,
      totalWarehouses:meta?.totalWarehouses,
    });
  });
  return _.sortBy([...byKey.values()], p => productDisplayName(p.short || p.name).toLowerCase());
}

function productOptionIdForValue(value, products = [], productMeta = {}) {
  if (!value) return "";
  const exact = products.find(p => p.id === value);
  if (exact) return exact.id;
  const valueKeys = new Set(productIdentityKeys(value, productMeta));
  const match = products.find(p => {
    if (productValuesMatch(value, p.id, productMeta)) return true;
    return productIdentityKeys(p.id, productMeta).some(key => valueKeys.has(key));
  });
  return match?.id || "";
}

function campaignDisplayName(value) {
  return String(value || "").trim();
}

function normalizedCampaignKey(value) {
  return campaignDisplayName(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function campaignMetaNameKey(value) {
  const key = normalizedCampaignKey(value);
  return key ? `name:${key}` : "";
}

function campaignIdFromParts(productId, name) {
  const productKey = normalizedProductKey(productId || "campaign").replace(/\s+/g, "-") || "campaign";
  const nameKey = normalizedCampaignKey(name).replace(/\s+/g, "-") || "default";
  return `${productKey}-${nameKey}`;
}

function campaignMetaFromRows(rows, productMeta = {}) {
  const next = {};
  (rows || []).forEach(row => {
    const rawId = campaignDisplayName(cellValue(row, ["Campaign_ID","Campaign ID","CID","ID"]));
    const name = campaignDisplayName(cellValue(row, ["Campaign","Campaign Name","Campaign_Name","Program","Program Name","Costco Campaign","Costco_Campaign","Name"]));
    const short = campaignDisplayName(cellValue(row, ["Short Name","Campaign Short","Short","Label"]));
    const prod = productFromRow(row, productMeta);
    const productRaw = productDisplayName(String(cellValue(row, PRODUCT_IMPORT_COLUMNS)).trim());
    const pid = prod?.id || productRaw;
    if (!name && !rawId) return;
    const id = rawId || campaignIdFromParts(pid, name || short);
    const start = normalizeDateValue(cellValue(row, ["Start Date","Start","Campaign Start","Launch Date","Live Date","Begin Date"]));
    const end = normalizeDateValue(cellValue(row, ["End Date","End","Campaign End","Finish Date","End Date","End_Date"]));
    const channel = campaignDisplayName(cellValue(row, ["Channel","Online/Inline","Online/In-Line","Online_In_Line","Sales Channel","Scope"])) || "Inline";
    const type = campaignDisplayName(cellValue(row, ["Type","Campaign Type","Promo Type","Event Type"]));
    const color = campaignDisplayName(cellValue(row, ["Brand Color","Campaign Color","Color"]));
    const activeRaw = campaignDisplayName(cellValue(row, ["Active","Status"])).toLowerCase();
    const patch = {
      id,
      name:name || short || id,
      short:short || name || id,
      pid,
      product:prod?.short || productRaw || "",
      start,
      end,
      channel,
      type,
      active:activeRaw ? !["no","false","inactive","ended","complete","completed","0"].includes(activeRaw) : true,
    };
    if (/^#[0-9a-f]{3,8}$/i.test(color)) patch.col = color;
    [id, campaignMetaNameKey(name), campaignMetaNameKey(short)].filter(Boolean).forEach(key => {
      next[key] = { ...(next[key] || {}), ...patch };
    });
  });
  return next;
}

function campaignWithMeta(cid, campaignMeta = {}, productMeta = {}) {
  if (!cid) return null;
  const direct = campaignMeta?.[cid] || campaignMeta?.[campaignMetaNameKey(cid)];
  if (!direct) return null;
  const prod = productWithMeta(direct.pid, productMeta);
  const label = campaignDisplayName(direct.short || direct.name || cid);
  return {
    ...direct,
    id:direct.id || cid,
    name:campaignDisplayName(direct.name || label),
    short:label,
    pid:direct.pid || prod?.id || "",
    product:direct.product || prod?.short || "",
    col:direct.col || prod?.col || productColorForValue(label),
    active:direct.active !== false,
  };
}

function campaignCatalog(campaignMeta = {}, productMeta = {}, productId = "") {
  const byId = new Map();
  Object.entries(campaignMeta || {}).forEach(([key, meta]) => {
    const campaign = campaignWithMeta(meta?.id || key, campaignMeta, productMeta);
    if (!campaign?.id) return;
    if (productId && campaign.pid !== productId) return;
    byId.set(campaign.id, campaign);
  });
  return _.sortBy([...byId.values()], c => `${productLabelForValue(c.pid, productMeta)} ${c.start || ""} ${c.short}`.toLowerCase());
}

function campaignFilterCatalog(campaignMeta = {}, productMeta = {}, productId = "") {
  return campaignCatalog(campaignMeta, productMeta)
    .filter(campaign => !productId || productValuesMatch(campaign.pid, productId, productMeta));
}

function campaignAliasKeys(value) {
  const key = normalizedCampaignKey(value);
  if (!key) return [];
  const keys = new Set([key]);
  const inlineOnly = key
    .replace(/\s+(and|\+)\s+online\s+campaign\s+\d+\b/g, "")
    .replace(/\s+(and|\+)\s+online\b/g, "")
    .replace(/\s+online\s+campaign\s+\d+\b/g, "")
    .trim()
    .replace(/\s+/g, " ");
  if (inlineOnly && /\b(inline|in line|in-line)\b/.test(inlineOnly)) keys.add(inlineOnly);
  return [...keys];
}

function campaignIdentityKeys(value, campaignMeta = {}, productMeta = {}, fallbackPid = "") {
  const keys = new Set();
  const add = candidate => campaignAliasKeys(candidate).forEach(key => keys.add(key));
  add(value);
  if (fallbackPid && value) add(campaignIdFromParts(fallbackPid, value));
  const campaign = campaignWithMeta(value, campaignMeta, productMeta);
  if (campaign) {
    [campaign.id, campaign.name, campaign.short].forEach(add);
    [campaign.name, campaign.short].filter(Boolean).forEach(label => add(campaignIdFromParts(campaign.pid || fallbackPid, label)));
  }
  return keys;
}

function campaignValuesMatch(a = "", b = "", campaignMeta = {}, productMeta = {}, fallbackPid = "") {
  if (!a || !b) return !b;
  const aKeys = campaignIdentityKeys(a, campaignMeta, productMeta, fallbackPid);
  const bKeys = campaignIdentityKeys(b, campaignMeta, productMeta, fallbackPid);
  for (const key of aKeys) {
    if (bKeys.has(key)) return true;
  }
  return false;
}

function rowChannelForCampaignInference(row = {}) {
  const explicit = String(row.channel || row.sourceType || row.salesChannel || "").toLowerCase();
  if (explicit) return explicit;
  return row.wid ? "inline" : "";
}

function campaignMatchesRowChannel(campaign, row = {}) {
  const rowChannel = rowChannelForCampaignInference(row);
  if (!rowChannel) return true;
  return campaignChannelSupports(campaign?.channel, rowChannel);
}

function campaignMatchesDate(campaign, date) {
  if (!campaign || !date) return false;
  if (campaign.start && date < campaign.start) return false;
  if (campaign.end && date > campaign.end) return false;
  return true;
}

function campaignDateWindowLabel(campaign = {}) {
  const start = String(campaign?.start || "").slice(0, 10);
  const end = String(campaign?.end || "").slice(0, 10);
  if (start && end) return `${start} – ${end}`;
  if (start) return `${start}+`;
  if (end) return `≤ ${end}`;
  return "";
}

function matchCampaign(raw, { campaignMeta = {}, productMeta = {}, pid = "", date = "", channel = "", allowAdHoc = true } = {}) {
  const label = campaignDisplayName(raw);
  const datedCandidates = campaignCatalog(campaignMeta, productMeta, pid).filter(c => !date || campaignMatchesDate(c, date));
  const candidates = datedCandidates.filter(c => {
    if (channel && c.channel && !campaignChannelSupports(c.channel, channel)) return false;
    return true;
  });
  if (label) {
    const key = normalizedCampaignKey(label);
    const exactPool = channel ? candidates : datedCandidates;
    const exact = exactPool.find(c => c.id === label || normalizedCampaignKey(c.id) === key || normalizedCampaignKey(c.short) === key || normalizedCampaignKey(c.name) === key);
    if (exact) return exact;
    if (!allowAdHoc) return null;
    return { id:campaignIdFromParts(pid, label), name:label, short:label, pid, product:productLabelForValue(pid, productMeta), col:productWithMeta(pid, productMeta)?.col || productColorForValue(label), inferred:false, adHoc:true };
  }
  const dated = candidates.filter(c => campaignMatchesDate(c, date));
  return dated.length === 1 ? { ...dated[0], inferred:true } : null;
}

function campaignForRow(row, { campaignMeta = {}, productMeta = {}, pid = "", date = "", channel = "" } = {}) {
  const explicit = campaignDisplayName(cellValue(row, CAMPAIGN_IMPORT_COLUMNS));
  return matchCampaign(explicit, { campaignMeta, productMeta, pid, date, channel });
}

const VIDEO_ASSIGNMENT_STOPWORDS = new Set([
  "ad", "ads", "brand", "byou", "campaign", "collection", "content", "costco", "creator", "folder",
  "group", "ig", "instagram", "label", "list", "meta", "paid", "playlist", "post", "program",
  "reel", "reels", "seed", "seeded", "seeding", "short", "shorts", "tag", "tags", "tik",
  "tiktok", "tok", "upload", "video", "videos", "youtube"
]);
const VIDEO_ASSIGNMENT_GENERIC_PRODUCT_WORDS = new Set(["ampoule", "cream", "essence", "oil", "patch", "patches", "serum", "sh", "shampoo", "sun", "treatment"]);

function weakVideoAssignmentLabel(value) {
  const tokens = videoAssignmentTokens(value);
  return !tokens.length || tokens.every(token => VIDEO_ASSIGNMENT_GENERIC_PRODUCT_WORDS.has(token));
}

function videoAssignmentTokens(value) {
  return normalizedProductKey(value)
    .split(" ")
    .filter(token => token && !VIDEO_ASSIGNMENT_STOPWORDS.has(token) && (token.length > 1 || /\d/.test(token)));
}

function firstAttachedTrackifyValue(value) {
  return String(value ?? "")
    .split(";")
    .map(part => part.trim())
    .find(Boolean) || "";
}

const TRACKIFY_VIDEO_ASSIGNMENT_ALIASES = new Map();

const VIDEO_ASSIGNMENT_EQUIVALENT_LABELS = new Map();

function canonicalTrackifyVideoAssignmentLabel(value) {
  const label = firstAttachedTrackifyValue(value);
  const key = normalizedProductKey(label);
  return TRACKIFY_VIDEO_ASSIGNMENT_ALIASES.get(key) || label;
}

function isExcludedTrackifyVideoAssignmentValue(_value) { return false; }

function shouldSkipTrackifyVideoRow(row) {
  return [...PRODUCT_IMPORT_COLUMNS, ...CAMPAIGN_IMPORT_COLUMNS, ...VIDEO_COLLECTION_COLUMNS].some(column =>
    isExcludedTrackifyVideoAssignmentValue(cellValue(row, [column]))
  );
}

function videoImportStatusSuffix(result = {}) {
  return result.skipped ? `, ${result.skipped} skipped` : "";
}

function videoAssignmentCellValue(row, columns = []) {
  return canonicalTrackifyVideoAssignmentLabel(cellValue(row, columns));
}

function videoAssignmentTextKey(row, extraValues = []) {
  const values = [
    ...VIDEO_PRIMARY_ASSIGNMENT_COLUMNS.map(column => videoAssignmentCellValue(row, [column])),
    ...VIDEO_TITLE_COLUMNS.map(column => cellValue(row, [column])),
    ...extraValues,
  ];
  return normalizedProductKey(values.filter(value => value !== undefined && value !== null && value !== "").join(" "));
}

function videoAssignmentLabelScore(textKey, label) {
  const labelKey = normalizedProductKey(label);
  if (!textKey || !labelKey) return 0;
  if (textKey === labelKey) return 100;
  const labelTokens = videoAssignmentTokens(labelKey);
  if (!labelTokens.length) return 0;
  const textTokens = new Set(videoAssignmentTokens(textKey));
  if (textKey.includes(labelKey)) return 82 + Math.min(labelTokens.length * 3, 12);
  if (labelKey.length >= 6 && labelKey.includes(textKey)) return 48;
  const matched = labelTokens.filter(token => textTokens.has(token));
  if (matched.length >= 2) return 34 + (matched.length / labelTokens.length) * 30 + matched.length * 4;
  const distinctive = matched.find(token => token.length >= 5);
  if (distinctive) return labelTokens.length <= 3 ? 30 + Math.min(distinctive.length, 12) : 20 + Math.min(distinctive.length, 10);
  return 0;
}

function bestVideoAssignmentScore(textKey, labels = []) {
  return Math.max(0, ...labels.filter(Boolean).map(label => videoAssignmentLabelScore(textKey, label)));
}

function labelsWithVideoAssignmentEquivalents(labels = []) {
  const out = [];
  labels.filter(Boolean).forEach(label => {
    out.push(label);
    const equivalents = VIDEO_ASSIGNMENT_EQUIVALENT_LABELS.get(normalizedProductKey(label));
    if (equivalents?.length) out.push(...equivalents);
  });
  return out;
}

function productLabelsForVideoAssignment(product) {
  return labelsWithVideoAssignmentEquivalents([product?.id, product?.name, product?.short, product?.category]);
}

function campaignLabelsForVideoAssignment(campaign, productMeta = {}) {
  const product = productWithMeta(campaign?.pid, productMeta);
  return labelsWithVideoAssignmentEquivalents([
    campaign?.id,
    campaign?.name,
    campaign?.short,
    campaign?.product,
    product?.id,
    product?.name,
    product?.short,
  ]);
}

function chooseVideoAssignmentCandidate(ranked, minGap = 6) {
  const [best, second] = _.orderBy(
    ranked,
    ["score", "textScore", "dateScore", "activeScore", "startRank"],
    ["desc", "desc", "desc", "desc", "desc"]
  );
  if (!best) return null;
  if (!second || best.score >= second.score + minGap || best.textScore >= second.textScore + 10) return best.item;
  return null;
}

function inferVideoProductFromText(textKey, productMeta = {}) {
  if (!textKey) return null;
  const ranked = productCatalog(productMeta)
    .map(product => {
      const textScore = bestVideoAssignmentScore(textKey, productLabelsForVideoAssignment(product));
      return {
        item:product,
        textScore,
        score:textScore + (product.active !== false ? 8 : -20),
        activeScore:product.active !== false ? 1 : 0,
        dateScore:0,
        startRank:0,
      };
    })
    .filter(entry => entry.textScore >= 30);
  return chooseVideoAssignmentCandidate(ranked, 5);
}

function rankVideoCampaignCandidate(campaign, { textKey = "", date = "", pid = "", productMeta = {} } = {}) {
  const textScore = bestVideoAssignmentScore(textKey, campaignLabelsForVideoAssignment(campaign, productMeta));
  const dateScore = date ? (campaignMatchesDate(campaign, date) ? 28 : ((campaign.start || campaign.end) ? -18 : 0)) : 0;
  const activeScore = campaign.active !== false ? 12 : -30;
  const productScore = pid && productValuesMatch(pid, campaign.pid, productMeta) ? 18 : 0;
  const startRank = Number(String(campaign.start || "").replace(/-/g, "")) || 0;
  return {
    item:{ ...campaign, inferred:true },
    textScore,
    dateScore,
    activeScore,
    startRank,
    score:textScore + dateScore + activeScore + productScore,
  };
}

function campaignLooksInlineForVideo(campaign) {
  const channelKey = normalizedCampaignKey(campaign?.channel);
  const labelKey = normalizedCampaignKey([campaign?.id, campaign?.name, campaign?.short, campaign?.type].filter(Boolean).join(" "));
  const hasInline = /\bin\s*line\b|\binline\b/.test(`${channelKey} ${labelKey}`);
  const hasOnline = /\bonline\b|\becommerce\b|\be commerce\b/.test(`${channelKey} ${labelKey}`);
  if (hasInline) return true;
  if (hasOnline) return false;
  return !channelKey || channelKey === "costco";
}

function preferInlineCampaignsForVideo(campaigns = []) {
  const inlineCampaigns = campaigns.filter(campaignLooksInlineForVideo);
  return inlineCampaigns.length ? inlineCampaigns : campaigns;
}

function existingCampaignForVideoAssignment(raw, { campaignMeta = {}, productMeta = {}, pid = "", date = "" } = {}) {
  const label = campaignDisplayName(raw);
  if (!label) return null;
  const key = normalizedCampaignKey(label);
  const exact = preferInlineCampaignsForVideo(campaignCatalog(campaignMeta, productMeta, pid).filter(c =>
    c.id === label ||
    normalizedCampaignKey(c.id) === key ||
    normalizedCampaignKey(c.short) === key ||
    normalizedCampaignKey(c.name) === key
  ));
  return chooseVideoAssignmentCandidate(exact.map(campaign => rankVideoCampaignCandidate(campaign, {
    textKey:normalizedProductKey(label),
    date,
    pid,
    productMeta,
  })), 0);
}

function inferVideoCampaignFromText(textKey, { campaignMeta = {}, productMeta = {}, pid = "", date = "", minTextScore = 30 } = {}) {
  if (!textKey) return null;
  const ranked = preferInlineCampaignsForVideo(campaignCatalog(campaignMeta, productMeta, pid))
    .map(campaign => rankVideoCampaignCandidate(campaign, { textKey, date, pid, productMeta }))
    .filter(entry => entry.textScore >= minTextScore);
  return chooseVideoAssignmentCandidate(ranked, 6);
}

function inferVideoCampaignForProduct(pid, { campaignMeta = {}, productMeta = {}, date = "", textKey = "" } = {}) {
  if (!pid) return null;
  const campaigns = preferInlineCampaignsForVideo(campaignCatalog(campaignMeta, productMeta, pid));
  if (!campaigns.length) return null;
  const active = campaigns.filter(c => c.active !== false);
  const activeDateMatches = date ? active.filter(c => campaignMatchesDate(c, date)) : [];
  if (activeDateMatches.length === 1) return { ...activeDateMatches[0], inferred:true };
  const scored = inferVideoCampaignFromText(textKey, { campaignMeta, productMeta, pid, date, minTextScore:24 });
  if (scored) return scored;
  if (active.length === 1) return { ...active[0], inferred:true };
  const dateMatches = date ? campaigns.filter(c => campaignMatchesDate(c, date)) : [];
  if (dateMatches.length === 1) return { ...dateMatches[0], inferred:true };
  return null;
}

function inferVideoAssignmentForRow(row, { campaignMeta = {}, productMeta = {}, postedDate = "", snapshotDate = "", title = "", creator = "" } = {}) {
  const assignmentDate = postedDate || snapshotDate || "";
  const textKey = videoAssignmentTextKey(row, [title, creator]);
  const explicitProduct = productDisplayName(videoAssignmentCellValue(row, PRODUCT_IMPORT_COLUMNS));
  const explicitCampaign = campaignDisplayName(videoAssignmentCellValue(row, CAMPAIGN_IMPORT_COLUMNS));
  const explicitCollection = campaignDisplayName(videoAssignmentCellValue(row, VIDEO_COLLECTION_COLUMNS));
  let product = explicitProduct
    ? (matchProductExact(explicitProduct, productMeta) || inferVideoProductFromText(normalizedProductKey(explicitProduct), productMeta))
    : null;
  let pid = product?.id || "";
  let campaign = explicitCampaign
    ? existingCampaignForVideoAssignment(explicitCampaign, { campaignMeta, productMeta, pid, date:assignmentDate })
    : null;
  if (!campaign) campaign = inferVideoCampaignFromText(textKey, { campaignMeta, productMeta, pid, date:assignmentDate });
  if (campaign?.pid) {
    pid = pid || campaign.pid;
    product = product || productWithMeta(campaign.pid, productMeta);
  }
  if (!product) {
    product = inferVideoProductFromText(textKey, productMeta);
    pid = product?.id || pid;
  }
  if (pid && !campaign) {
    campaign = inferVideoCampaignForProduct(pid, { campaignMeta, productMeta, date:assignmentDate, textKey });
  }
  if (!product && explicitProduct && !weakVideoAssignmentLabel(explicitProduct)) {
    product = matchProduct(explicitProduct, productMeta);
    pid = product?.id || pid;
  }
  if (explicitCampaign && pid && !campaign && !weakVideoAssignmentLabel(explicitCampaign)) {
    campaign = matchCampaign(explicitCampaign, { campaignMeta, productMeta, pid, date:assignmentDate, channel:"Inline", allowAdHoc:false });
  }
  if (pid && !campaign) {
    const collectionCampaign = explicitCampaign || explicitCollection;
    if (collectionCampaign && !weakVideoAssignmentLabel(collectionCampaign)) {
      campaign = {
        id:collectionCampaign,
        name:collectionCampaign,
        short:collectionCampaign,
        pid,
        product:product?.short || product?.name || pid,
        start:assignmentDate,
        end:"",
        channel:"Trackify",
        active:true,
        inferred:true,
      };
    }
  }
  return { product, pid:pid || product?.id || "", campaign };
}

function ppcDateValue(row, names = []) {
  return normalizeDateValue(cellValue(row, names), calendarYearValue(row));
}

function ppcYearFromRows(rows = []) {
  for (const row of rows || []) {
    const values = [
      ppcDateValue(row, ["Snapshot Date","Report End","End Date","Date"]),
      ppcDateValue(row, ["Start Date","Campaign Start Date"]),
      ppcDateValue(row, ["End Date","Campaign End Date"]),
    ].filter(Boolean);
    const year = values.map(v => Number(String(v).slice(0, 4))).find(v => Number.isInteger(v) && v >= 2000 && v <= 2100);
    if (year) return year;
  }
  return new Date().getFullYear();
}

function ppcSnapshotWindowFromSource(source = "", rows = []) {
  for (const row of rows || []) {
    const start = ppcDateValue(row, PPC_SNAPSHOT_START_COLUMNS);
    const end = ppcDateValue(row, PPC_SNAPSHOT_END_COLUMNS);
    if (start || end) return { start:start || end, end:end || start };
  }
  const year = ppcYearFromRows(rows);
  const text = String(source || "");
  const match = text.match(/(\d{1,2})[-_](\d{1,2})[-_](\d{1,2})[-_](\d{1,2})(?:[-_](\d{2,4}))?/);
  if (match) {
    const y = match[5] ? (String(match[5]).length === 2 ? Number(`20${match[5]}`) : Number(match[5])) : year;
    const start = normalizeDateValue(`${match[1]}/${match[2]}/${y}`);
    const end = normalizeDateValue(`${match[3]}/${match[4]}/${y}`);
    if (start || end) return { start:start || end, end:end || start };
  }
  return { start:"", end:"" };
}

function ppcPercentValue(raw, numerator = 0, denominator = 0) {
  const num = Number(numerator || 0);
  const den = Number(denominator || 0);
  if (den > 0) return (num / den) * 100;
  const val = numberValue(raw);
  return val > 100 ? 0 : val;
}

function ppcRoasValue(sales = 0, spend = 0, raw = "") {
  const salesNum = Number(sales || 0);
  const spendNum = Number(spend || 0);
  if (spendNum > 0) return salesNum / spendNum;
  const val = numberValue(raw);
  return val > 25 ? val / 100 : val;
}

function fmtPercent(value, digits = 1) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? `${n.toFixed(digits).replace(/\.0+$/,"")}%` : "N/A";
}

function formatRoas(value) {
  const n = Number(value || 0);
  return n > 0 && Number.isFinite(n) ? `${n.toFixed(2)}x` : "N/A";
}

function ppcSnapshotDate(row) {
  return row?.snapshotEnd || row?.snapshotStart || row?.date || "";
}

function ppcRowInDateRange(row, dateRange = {}) {
  const start = row?.snapshotStart || row?.date || row?.snapshotEnd || "";
  const end = row?.snapshotEnd || row?.date || row?.snapshotStart || "";
  if (!start && !end) return true;
  const rangeStart = dateRange.start || DATA_START;
  const rangeEnd = dateRange.end || DATA_END;
  return (end || start) >= rangeStart && (start || end) <= rangeEnd;
}

function ppcRowMatchesProduct(row, pid = "", productMeta = {}) {
  if (!pid) return true;
  return productValuesMatch(productIdForMetricRow(row), pid, productMeta);
}

function ppcMapRowFor(row, mapRows = []) {
  const sku = String(cellValue(row, ["SKU ID","SKU","Item ID","Product ID","Retailer SKU ID"])).trim();
  const externalCampaignId = String(cellValue(row, PPC_EXTERNAL_CAMPAIGN_COLUMNS)).trim();
  const rawProduct = normalizedProductKey(cellValue(row, PPC_PRODUCT_COLUMNS));
  return (mapRows || []).find(mapRow => {
    const mapSku = String(cellValue(mapRow, ["SKU ID","SKU","Item ID","Retailer SKU ID","External SKU ID"])).trim();
    const mapCampaign = String(cellValue(mapRow, PPC_EXTERNAL_CAMPAIGN_COLUMNS)).trim();
    const mapProduct = normalizedProductKey(cellValue(mapRow, ["Criteo Product","Criteo Product Name","Report Product","Product","Product Name","SKU Name"]));
    const skuOk = !mapSku || !sku || mapSku === sku;
    const campaignOk = !mapCampaign || !externalCampaignId || mapCampaign === externalCampaignId;
    const productOk = !mapProduct || !rawProduct || mapProduct === rawProduct || mapProduct.includes(rawProduct) || rawProduct.includes(mapProduct);
    return skuOk && campaignOk && productOk;
  }) || null;
}

function metaPipeParts(value = "") {
  return String(value || "").split("|").map(part => part.trim()).filter(Boolean);
}

function metaCampaignNameForRow(row = {}) {
  return campaignDisplayName(cellValue(row, ["Campaign name","Campaign Name","Campaign"]));
}

function paidMediaProductAliasFromText(value = "") {
  const exactKey = normalizedProductKey(value);
  if (PAID_MEDIA_PRODUCT_ALIASES.has(exactKey)) return PAID_MEDIA_PRODUCT_ALIASES.get(exactKey);
  for (const [key, label] of PAID_MEDIA_PRODUCT_ALIASES.entries()) {
    if (exactKey.includes(key)) return label;
  }
  return "";
}

function paidMediaProductAliasFromRow(row = {}, campaignName = "") {
  const searchParts = [
    cellValue(row, PPC_PRODUCT_COLUMNS),
    campaignName,
    cellValue(row, ["Campaign Name","Campaign name","Campaign"]),
    cellValue(row, ["Line Item","Line Item Name","Ad set name","Ad Set Name"]),
    cellValue(row, ["Ad name","Ad Name"]),
    cellValue(row, ["SKU Name","Product Name","Item"]),
    cellValue(row, ["Brand"]),
  ];
  for (const part of searchParts) {
    const alias = paidMediaProductAliasFromText(part);
    if (alias) return alias;
  }
  return paidMediaProductAliasFromText(searchParts.filter(Boolean).join(" "));
}

function metaProductAliasFromRow(row = {}) {
  const explicit = productDisplayName(String(cellValue(row, PPC_PRODUCT_COLUMNS)).trim());
  if (explicit) return explicit;
  const campaignParts = metaPipeParts(metaCampaignNameForRow(row));
  const searchParts = [
    ...campaignParts,
    metaCampaignNameForRow(row),
    cellValue(row, ["Ad set name","Ad Set Name"]),
    cellValue(row, ["Ad name","Ad Name"]),
  ];
  for (const part of searchParts) {
    const alias = paidMediaProductAliasFromText(part);
    if (alias) return alias;
  }
  return paidMediaProductAliasFromText(searchParts.join(" "));
}

function metaCampaignCandidateLabels(row = {}) {
  const campaignName = metaCampaignNameForRow(row);
  const parts = metaPipeParts(campaignName);
  const explicit = campaignDisplayName(cellValue(row, PPC_CAMPAIGN_COLUMNS));
  return [
    explicit,
    parts[1],
    parts.slice(0, 2).join(" "),
    campaignName,
    cellValue(row, ["Ad set name","Ad Set Name"]),
  ].map(campaignDisplayName).filter(Boolean).filter((value, index, arr) => arr.indexOf(value) === index);
}

function metaCampaignForRow(row = {}, { campaignMeta = {}, productMeta = {}, pid = "", date = "" } = {}) {
  for (const label of metaCampaignCandidateLabels(row)) {
    const matched = matchCampaign(label, { campaignMeta, productMeta, pid, date, allowAdHoc:false });
    if (matched) return matched;
  }
  return matchCampaign("", { campaignMeta, productMeta, pid, date, allowAdHoc:false });
}

function metaObjectiveLabel(value = "") {
  const raw = String(value || "").replace(/^OUTCOME_/i, "").replace(/_/g, " ").trim();
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : "";
}

function metaCleanCampaignLabel(row = {}) {
  const parts = metaPipeParts(row.rawCampaign || row.campaign || "");
  const product = row.product && row.product !== "Unassigned" ? row.product : (metaProductAliasFromRow(row) || parts[0] || "Meta campaign");
  const campaign = parts[1] || row.campaign || "";
  const objective = parts[2] ? (parts[2] === "AWA" ? "Awareness" : parts[2] === "VV" ? "Video views" : parts[2]) : metaObjectiveLabel(row.objective);
  return [product, campaign, objective].filter(Boolean).join(" / ");
}

function normalizePpcRow(row, level, source, { productMeta = {}, campaignMeta = {}, mapRows = [], snapshotWindow = {} } = {}) {
  const mapRow = ppcMapRowFor(row, mapRows);
  const partner = ppcPartnerForRow(row, source);
  const campaignName = campaignDisplayName(cellValue(row, ["Campaign Name","Campaign name","Campaign","Line Item","Line Item Name","Ad set name","Ad Set Name","Ad name","Ad Name"]) || cellValue(mapRow || {}, ["Campaign","Campaign Name"]));
  const metaRow = partner === META_PARTNER;
  const metaProductLabel = metaRow ? metaProductAliasFromRow(row) : "";
  const paidMediaProductLabel = paidMediaProductAliasFromRow(row, campaignName);
  const rawProduct = productDisplayName(String(cellValue(row, PPC_PRODUCT_COLUMNS) || cellValue(mapRow || {}, ["Criteo Product","Criteo Product Name","Report Product"]) || metaProductLabel || paidMediaProductLabel || (metaRow ? campaignName : "")).trim());
  const mappedProduct = productDisplayName(String(cellValue(mapRow || {}, ["Product_ID","Product ID","BYOU Product ID","BYOU Product","Product"])).trim());
  const product = matchProduct(mappedProduct || rawProduct, productMeta);
  const pid = product?.id || mappedProduct || rawProduct || "";
  const snapshotStart = ppcDateValue(row, PPC_SNAPSHOT_START_COLUMNS) || snapshotWindow.start || "";
  const snapshotEnd = ppcDateValue(row, PPC_SNAPSHOT_END_COLUMNS) || snapshotWindow.end || snapshotStart || "";
  const date = snapshotEnd || snapshotStart;
  const explicitCampaign = campaignDisplayName(cellValue(mapRow || {}, ["Campaign_ID","Campaign ID","BYOU Campaign ID","Costco Campaign ID"]) || cellValue(row, PPC_CAMPAIGN_COLUMNS));
  const externalCampaignId = String(cellValue(row, PPC_EXTERNAL_CAMPAIGN_COLUMNS) || cellValue(row, ["Campaign ID"]) || "").trim();
  const inferredCampaign = metaRow ? null : matchCampaign("", { campaignMeta, productMeta, pid, date, allowAdHoc:false });
  const namedCampaign = metaRow ? null : (campaignName ? matchCampaign(campaignName, { campaignMeta, productMeta, pid, date, allowAdHoc:false }) : null);
  const campaign = metaRow
    ? metaCampaignForRow(row, { campaignMeta, productMeta, pid, date })
    : explicitCampaign
      ? matchCampaign(explicitCampaign, { campaignMeta, productMeta, pid, date, allowAdHoc:false }) || inferredCampaign || namedCampaign
      : inferredCampaign || namedCampaign;
  const spend = numberValue(cellValue(row, ["L7D Spend","Spend","Ad Spend","Media Spend","Cost","PPC Spend","Amount spent (USD)","Amount spent","Amount Spent"]));
  const attributedSales = numberValue(cellValue(row, ["L7D Sales","L7D Attributed Sales","Attributed Sales","PPC Sales","Sales","Purchase conversion value","Purchases conversion value","Website purchase conversion value","Website purchases conversion value","Conversion value","Purchase value"]));
  const attributedUnits = Math.round(numberValue(cellValue(row, ["L7D Units","L7D Attributed Units","Attributed Units","PPC Units","Units","Purchases","Website purchases","Website purchase"])));
  const clicks = Math.round(numberValue(cellValue(row, ["L7D Clicks","Clicks","Clicks (all)","Link clicks","Inline link clicks"])));
  const impressions = Math.round(numberValue(cellValue(row, ["L7D Impressions","Impressions"])));
  const reach = Math.round(numberValue(cellValue(row, ["Reach"])));
  const frequency = numberValue(cellValue(row, ["Frequency"]));
  const resultType = String(cellValue(row, ["Result type","Result Type"])).trim();
  const results = numberValue(cellValue(row, ["Results"]));
  const costPerResult = numberValue(cellValue(row, ["Cost per result","Cost Per Result"]));
  const views = Math.round(numberValue(cellValue(row, ["Views"])));
  const videoPlays = Math.round(numberValue(cellValue(row, ["Video plays","Video Plays"])));
  const videoPlays50 = Math.round(numberValue(cellValue(row, ["Video plays at 50%","Video Plays at 50%"])));
  const videoPlays75 = Math.round(numberValue(cellValue(row, ["Video plays at 75%","Video Plays at 75%"])));
  const videoPlays100 = Math.round(numberValue(cellValue(row, ["Video plays at 100%","Video Plays at 100%"])));
  const thruPlays = Math.round(numberValue(cellValue(row, ["ThruPlays","Thruplays"])));
  const landingPageViews = Math.round(numberValue(cellValue(row, ["Landing page views","Landing Page Views"])));
  const outboundClicks = Math.round(numberValue(cellValue(row, ["Outbound clicks","Outbound Clicks"])));
  const lifetimeSpend = numberValue(cellValue(row, ["LT Spend","Lifetime Spend"]));
  const lifetimeSales = numberValue(cellValue(row, ["LT Sales","Lifetime Sales","LT Attributed Sales","Lifetime Attributed Sales"]));
  const lifetimeUnits = Math.round(numberValue(cellValue(row, ["LT Units","Lifetime Units","LT Attributed Units","Lifetime Attributed Units"])));
  const lifetimeClicks = Math.round(numberValue(cellValue(row, ["LT Clicks","Lifetime Clicks"])));
  const lifetimeImpressions = Math.round(numberValue(cellValue(row, ["LT Impressions","Lifetime Impressions"])));
  const budgetRemaining = numberValue(cellValue(row, ["Budget Remaining","Remaining Budget"]));
  const missedSales = numberValue(cellValue(row, ["Missed Sales","L7D Missed Sales","Potential Missed Sales","Missed Attributed Sales"]));
  const missedSpend = numberValue(cellValue(row, ["Missed Spend","L7D Missed Spend","Potential Missed Spend"]));
  const missedClicks = Math.round(numberValue(cellValue(row, ["Missed Clicks","L7D Missed Clicks"])));
  const missedTraffic = Math.round(numberValue(cellValue(row, ["Missed Traffic","Missed Impressions","L7D Missed Traffic"])));
  const impressionShare = ppcPercentValue(cellValue(row, ["Impression Share","Impressions Share","L7D Impression Share","Current Impression Share"]));
  const avgCapoutHour = numberValue(cellValue(row, ["Avg Capout Hour","Average Capout Hour","Capout Hour"]));
  const hasMetric = spend || attributedSales || attributedUnits || clicks || impressions || reach || results || views || videoPlays || thruPlays || outboundClicks || lifetimeSpend || lifetimeSales || lifetimeUnits || budgetRemaining || missedSales || missedSpend || missedClicks || missedTraffic || impressionShare || avgCapoutHour;
  if (!hasMetric && !externalCampaignId && !rawProduct && !campaignName) return null;
  const lineItemId = String(cellValue(row, ["Line Item ID","Line_Item_ID","Line Item","Line Item Name","Ad set ID","Ad Set ID","Ad set name","Ad Set Name"])).trim();
  const adId = String(cellValue(row, ["Ad ID","Ad id","Ad name","Ad Name"])).trim();
  const reportingPeriod = String(cellValue(row, ["Reporting Period","Period","Month"])).trim();
  const periodStart = ppcDateValue(row, ["Period Start","Month Start"]);
  const effectiveLevel = metaRow
    ? (adId ? "ad" : lineItemId ? "ad_set" : "campaign")
    : level;
  return {
    id:[
      partner,
      effectiveLevel,
      snapshotStart,
      snapshotEnd,
      externalCampaignId,
      lineItemId,
      adId,
      reportingPeriod,
      String(cellValue(row, ["SKU ID","SKU","Item ID"])).trim(),
      pid,
      campaign?.id || explicitCampaign,
    ].join("|"),
    partner,
    source,
    level:effectiveLevel,
    date,
    snapshotStart,
    snapshotEnd,
    externalCampaignId,
    lineItemId,
    adId,
    reportingPeriod,
    periodStart,
    adName:String(cellValue(row, ["Ad name","Ad Name"])).trim(),
    adSetName:String(cellValue(row, ["Ad set name","Ad Set Name"])).trim(),
    skuId:String(cellValue(row, ["SKU ID","SKU","Item ID","Retailer SKU ID"])).trim(),
    rawCampaign:campaignName,
    rawProduct,
    brand:String(cellValue(row, ["Brand"])).trim(),
    pid,
    product:product?.short || mappedProduct || rawProduct || "Unassigned",
    cid:campaign?.id || explicitCampaign || "",
    campaign:campaign?.short || campaignName || explicitCampaign || "",
    campaignType:String(cellValue(row, ["Campaign Type","Ad Type","Type"])).trim(),
    audience:String(cellValue(row, ["Audience","Audience Name","Target Audience"])).trim(),
    reportTitle:String(cellValue(row, ["Report Title","Title"])).trim(),
    pacingNotes:String(cellValue(row, ["Pacing Notes","Notes","Summary"])).trim(),
    flightProgress:numberValue(cellValue(row, ["Flight Progress","Pacing","Percent Complete"])),
    daysElapsed:Math.round(numberValue(cellValue(row, ["Days Elapsed","Elapsed Days"]))),
    flightDays:Math.round(numberValue(cellValue(row, ["Flight Days","Total Flight Days"]))),
    daysRemaining:Math.round(numberValue(cellValue(row, ["Days Remaining","Remaining Days"]))),
    objective:String(cellValue(row, ["Objective"])).trim(),
    resultType,
    results,
    costPerResult,
    reach,
    frequency,
    views,
    videoPlays,
    videoPlays50,
    videoPlays75,
    videoPlays100,
    thruPlays,
    landingPageViews,
    outboundClicks,
    start:ppcDateValue(row, ["Campaign Start Date","Start Date","Start"]),
    end:ppcDateValue(row, ["Campaign End Date","End Date","End"]),
    spend,
    attributedSales,
    attributedUnits,
    clicks,
    impressions,
    ctr:ppcPercentValue(cellValue(row, ["L7D CTR","CTR","Click Through Rate","CTR (all)","Link click-through rate"]), clicks, impressions),
    avgCpc:clicks > 0 ? spend / clicks : numberValue(cellValue(row, ["L7D CPC","Avg CPC","Average CPC","CPC","CPC (all)","Cost per link click"])),
    cpm:impressions > 0 ? (spend / impressions) * 1000 : numberValue(cellValue(row, ["CPM (cost per 1,000 impressions)","CPM"])),
    roas:ppcRoasValue(attributedSales, spend, cellValue(row, ["L7D ROAS","ROAS","Return On Ad Spend","Purchase ROAS (return on ad spend)","Purchase ROAS","Website purchase ROAS"])),
    budgetRemaining,
    lifetimeSpend,
    lifetimeSales,
    lifetimeUnits,
    lifetimeClicks,
    lifetimeImpressions,
    lifetimeCtr:ppcPercentValue(cellValue(row, ["LT CTR","Lifetime CTR"]), lifetimeClicks, lifetimeImpressions),
    lifetimeRoas:ppcRoasValue(lifetimeSales, lifetimeSpend, cellValue(row, ["LT ROAS","Lifetime ROAS"])),
    impressionShare,
    avgCapoutHour,
    missedTraffic,
    missedClicks,
    missedSpend,
    missedSales,
    capoutStatus:String(cellValue(row, ["Capout Status","Status"])).trim(),
    daypartingSchedule:String(cellValue(row, ["Dayparting Schedule","Schedule"])).trim(),
  };
}

function ppcPartnerForRow(row = {}, source = "") {
  const explicit = String(cellValue(row, ["Partner","Platform","Network","Publisher","Source"])).trim();
  if (/meta|facebook|instagram/i.test(`${explicit} ${source}`)) return META_PARTNER;
  if (isMetaAdsReportRow(row)) return META_PARTNER;
  return explicit || PPC_PARTNER_DEFAULT;
}

function ppcAssignmentGroupKey(row = {}) {
  const campaignKey = String(row.externalCampaignId || "").trim()
    || normalizedCampaignKey(row.rawCampaign || row.campaign);
  return campaignKey ? `${normalizedCampaignKey(row.partner)}|${campaignKey}` : "";
}

function ppcNormalizedRowId(row = {}) {
  return [
    row.partner || "",
    row.level || "",
    row.snapshotStart || "",
    row.snapshotEnd || "",
    row.externalCampaignId || "",
    row.lineItemId || "",
    row.adId || "",
    row.reportingPeriod || "",
    row.skuId || "",
    row.pid || "",
    row.cid || "",
  ].join("|");
}

function canonicalPpcProduct(row = {}, productMeta = {}) {
  const candidates = [
    row.pid,
    row.product,
    row.rawProduct,
    paidMediaProductAliasFromText([
      row.product,
      row.rawProduct,
      row.rawCampaign,
      row.campaign,
      row.adSetName,
      row.adName,
      row.brand,
    ].filter(Boolean).join(" ")),
  ];
  for (const candidate of candidates) {
    if (!candidate || normalizedProductKey(candidate) === "unassigned") continue;
    const product = matchProduct(candidate, productMeta);
    if (product?.id) return product;
  }
  return null;
}

export function reconcilePpcAssignments(rows = [], productMeta = {}, campaignMeta = {}) {
  const canonicalRows = (rows || []).map(row => {
    const product = canonicalPpcProduct(row, productMeta);
    return product ? { ...row, pid:product.id, product:product.short || product.name || product.id } : { ...row };
  });
  const productsByGroup = new Map();
  canonicalRows.forEach(row => {
    const groupKey = ppcAssignmentGroupKey(row);
    if (!groupKey || !row.pid || normalizedProductKey(row.product) === "unassigned") return;
    if (!productsByGroup.has(groupKey)) productsByGroup.set(groupKey, new Map());
    productsByGroup.get(groupKey).set(row.pid, { pid:row.pid, product:row.product });
  });

  return canonicalRows.map(row => {
    let next = row;
    const groupProducts = productsByGroup.get(ppcAssignmentGroupKey(row));
    if ((!row.pid || normalizedProductKey(row.product) === "unassigned") && groupProducts?.size === 1) {
      const inherited = [...groupProducts.values()][0];
      next = { ...next, ...inherited };
    }

    if (next.pid) {
      const date = ppcSnapshotDate(next);
      const labels = [next.cid, next.campaign, next.rawCampaign].filter(Boolean);
      let campaign = null;
      for (const label of labels) {
        campaign = matchCampaign(label, {
          campaignMeta,
          productMeta,
          pid:next.pid,
          date,
          allowAdHoc:false,
        });
        if (campaign) break;
      }
      campaign ||= matchCampaign("", {
        campaignMeta,
        productMeta,
        pid:next.pid,
        date,
        allowAdHoc:false,
      });
      if (campaign) {
        next = { ...next, cid:campaign.id, campaign:campaign.short || campaign.name || campaign.id };
      }
    }

    return { ...next, id:ppcNormalizedRowId(next) };
  });
}

export function normalizePpcRows({ campaignRows = [], lineItemRows = [], skuRows = [], capoutRows = [], impressionRows = [], periodRows = [], mapRows = [], source = "", productMeta = {}, campaignMeta = {} } = {}) {
  const allRows = [...campaignRows, ...lineItemRows, ...skuRows, ...capoutRows, ...impressionRows, ...periodRows];
  const snapshotWindow = ppcSnapshotWindowFromSource(source, allRows);
  const build = (rows, level) => rows.map(row => normalizePpcRow(row, level, source, { productMeta, campaignMeta, mapRows, snapshotWindow })).filter(Boolean);
  return reconcilePpcAssignments([
    ...build(campaignRows, "campaign"),
    ...build(lineItemRows, "line_item"),
    ...build(skuRows, "sku"),
    ...build(capoutRows, "capout"),
    ...build(impressionRows, "impression_share"),
    ...build(periodRows, "period"),
  ], productMeta, campaignMeta).sort((a,b) => (ppcSnapshotDate(a) || "").localeCompare(ppcSnapshotDate(b) || "") || a.level.localeCompare(b.level) || a.product.localeCompare(b.product));
}

function ppcCampaignIdentityKey(row = {}) {
  const externalKey = String(row.externalCampaignId || "").trim();
  const nameKey = normalizedCampaignKey(row.rawCampaign || row.campaign);
  const campaignKey = String(row.cid || "").trim();
  return isMetaPpcRow(row)
    ? (nameKey || externalKey || campaignKey)
    : (externalKey || nameKey || campaignKey);
}

function ppcCampaignSnapshotKey(row = {}) {
  const campaignKey = ppcCampaignIdentityKey(row);
  return [
    ppcSnapshotDate(row),
    row.partner || "",
    campaignKey,
    campaignKey ? "" : (row.pid || normalizedProductKey(row.product || row.rawProduct) || ""),
  ].join("|");
}

function ppcPerformanceEntityKey(row = {}) {
  return [
    row.partner || "",
    row.level || "",
    ppcCampaignIdentityKey(row),
    row.lineItemId || normalizedCampaignKey(row.adSetName) || "",
    row.adId || normalizedCampaignKey(row.adName) || "",
    row.skuId || "",
    row.pid || normalizedProductKey(row.product || row.rawProduct) || "",
  ].join("|");
}

function latestPpcRowsByEntity(rows = []) {
  const latest = new Map();
  (rows || []).forEach(row => {
    const key = ppcPerformanceEntityKey(row);
    const previous = latest.get(key);
    const rowDate = ppcSnapshotDate(row);
    const previousDate = ppcSnapshotDate(previous);
    if (!previous || rowDate >= previousDate) latest.set(key, row);
  });
  return Array.from(latest.values());
}

function preferredPpcPerformanceRows(rows = []) {
  const candidates = (rows || []).filter(row => ["sku","campaign","line_item","ad_set","ad"].includes(row.level) && (Number(row.spend || 0) || Number(row.attributedSales || 0) || Number(row.attributedUnits || 0) || Number(row.clicks || 0) || Number(row.impressions || 0)));
  // One snapshot can contain the same performance at campaign, ad-set/ad, and SKU levels.
  // Keep a single authoritative level per campaign/date so rollups are never added together.
  return Object.values(_.groupBy(candidates, ppcCampaignSnapshotKey)).flatMap(groupRows => {
    const partner = groupRows[0]?.partner || "";
    const preferredLevels = partner === META_PARTNER
      ? ["campaign","ad_set","ad"]
      : ["sku","campaign","line_item","ad_set","ad"];
    for (const level of preferredLevels) {
      const levelRows = groupRows.filter(row => row.level === level);
      if (levelRows.length) return levelRows;
    }
    return groupRows;
  });
}

export function sumPpcRows(rows = []) {
  const granularRows = preferredPpcPerformanceRows(rows);
  // Meta is daily and additive. Criteo/PPC lifetime snapshots are cumulative, so only
  // the newest snapshot for each entity belongs in a headline total.
  const perfRows = [
    ...granularRows.filter(isMetaPpcRow),
    ...latestPpcRowsByEntity(granularRows.filter(row => !isMetaPpcRow(row))),
  ];
  const spend = _.sumBy(perfRows, row => Number(row.spend || 0));
  const attributedSales = _.sumBy(perfRows, row => Number(row.attributedSales || 0));
  const attributedUnits = _.sumBy(perfRows, row => Number(row.attributedUnits || 0));
  const clicks = _.sumBy(perfRows, row => Number(row.clicks || 0));
  const impressions = _.sumBy(perfRows, row => Number(row.impressions || 0));
  const ltSpend = _.sumBy(perfRows, row => Number(row.lifetimeSpend || 0));
  const ltSales = _.sumBy(perfRows, row => Number(row.lifetimeSales || 0));
  const ltUnits = _.sumBy(perfRows, row => Number(row.lifetimeUnits || 0));
  const ltClicks = _.sumBy(perfRows, row => Number(row.lifetimeClicks || 0));
  const ltImpressions = _.sumBy(perfRows, row => Number(row.lifetimeImpressions || 0));
  const hasLt = ltSpend > 0 || ltSales > 0 || ltClicks > 0 || ltImpressions > 0;
  const hasLifetimeMetrics = row => Number(row.lifetimeSpend || 0) || Number(row.lifetimeSales || 0) || Number(row.lifetimeUnits || 0) || Number(row.lifetimeClicks || 0) || Number(row.lifetimeImpressions || 0);
  const totalSpend = _.sumBy(perfRows, row => Number(hasLifetimeMetrics(row) ? row.lifetimeSpend : row.spend) || 0);
  const totalSales = _.sumBy(perfRows, row => Number(hasLifetimeMetrics(row) ? row.lifetimeSales : row.attributedSales) || 0);
  const totalUnits = _.sumBy(perfRows, row => Number(hasLifetimeMetrics(row) ? row.lifetimeUnits : row.attributedUnits) || 0);
  const totalClicks = _.sumBy(perfRows, row => Number(hasLifetimeMetrics(row) ? row.lifetimeClicks : row.clicks) || 0);
  const totalImpressions = _.sumBy(perfRows, row => Number(hasLifetimeMetrics(row) ? row.lifetimeImpressions : row.impressions) || 0);
  const campaignBudgetRows = latestPpcRowsByEntity((rows || []).filter(row => row.level === "campaign" && Number(row.budgetRemaining || 0)));
  const shareRows = latestPpcRowsByEntity((rows || []).filter(row => Number(row.impressionShare || 0)));
  const capoutRows = latestPpcRowsByEntity((rows || []).filter(row => row.level === "capout"));
  return {
    rows:perfRows.length,
    sourceRows:(rows || []).length,
    spend,
    attributedSales,
    attributedUnits,
    clicks,
    impressions,
    ctr:impressions > 0 ? (clicks / impressions) * 100 : averageValue(perfRows.map(row => row.ctr)),
    avgCpc:clicks > 0 ? spend / clicks : averageValue(perfRows.map(row => row.avgCpc)),
    roas:spend > 0 ? attributedSales / spend : averageValue(perfRows.map(row => row.roas)),
    ltSpend,
    ltSales,
    ltUnits,
    ltClicks,
    ltImpressions,
    hasLt,
    totalSpend,
    totalSales,
    totalUnits,
    totalClicks,
    totalImpressions,
    totalRoas:totalSpend > 0 ? totalSales / totalSpend : (spend > 0 ? attributedSales / spend : averageValue(perfRows.map(row => row.roas))),
    budgetRemaining:_.sumBy(campaignBudgetRows, row => Number(row.budgetRemaining || 0)),
    impressionShare:shareRows.length ? averageValue(shareRows.map(row => row.impressionShare)) : averageValue(perfRows.map(row => row.impressionShare)),
    missedSales:_.sumBy(capoutRows, row => Number(row.missedSales || 0)),
    missedSpend:_.sumBy(capoutRows, row => Number(row.missedSpend || 0)),
    missedClicks:_.sumBy(capoutRows, row => Number(row.missedClicks || 0)),
    missedTraffic:_.sumBy(capoutRows, row => Number(row.missedTraffic || 0)),
    level:perfRows[0]?.level || "",
  };
}

export function ppcProductMixRows(rows = [], productMeta = {}) {
  const performanceRows = preferredPpcPerformanceRows(rows);
  return _.orderBy(Object.entries(_.groupBy(performanceRows, row => productLabelForValue(row.pid || row.product, productMeta) || "Unassigned"))
    .map(([name, groupRows]) => {
      const prod = productWithMeta(name, productMeta);
      const groupTotals = sumPpcRows(groupRows);
      return { name, ...groupTotals, col:prod?.col || C.blue };
    }), "totalSales", "desc");
}

function isMetaPpcRow(row = {}) {
  return row.partner === META_PARTNER || /meta|facebook|instagram/i.test(`${row.partner || ""} ${row.source || ""}`);
}

function isProgrammaticPacingRow(row = {}) {
  return row.partner === PROGRAMMATIC_PARTNER || /programmatic|erm audience/i.test(`${row.partner || ""} ${row.campaignType || ""}`);
}

export function sumMetaRows(rows = []) {
  const metaRows = preferredPpcPerformanceRows((rows || []).filter(isMetaPpcRow));
  const sum = key => _.sumBy(metaRows, row => Number(row[key] || 0));
  const spend = sum("spend");
  const impressions = sum("impressions");
  const clicks = sum("clicks");
  const resultGroups = Object.entries(_.groupBy(metaRows, row => row.resultType || "Results"))
    .map(([type, groupRows]) => ({ type, results:_.sumBy(groupRows, row => Number(row.results || 0)) }))
    .sort((a,b) => b.results - a.results);
  return {
    rows:metaRows.length,
    spend,
    reach:sum("reach"),
    impressions,
    clicks,
    views:sum("views"),
    videoPlays:sum("videoPlays"),
    videoPlays50:sum("videoPlays50"),
    videoPlays75:sum("videoPlays75"),
    videoPlays100:sum("videoPlays100"),
    thruPlays:sum("thruPlays"),
    landingPageViews:sum("landingPageViews"),
    outboundClicks:sum("outboundClicks"),
    results:sum("results"),
    resultType:resultGroups[0]?.type || "",
    ctr:impressions > 0 ? (clicks / impressions) * 100 : averageValue(metaRows.map(row => row.ctr)),
    avgCpc:clicks > 0 ? spend / clicks : averageValue(metaRows.map(row => row.avgCpc)),
    cpm:impressions > 0 ? (spend / impressions) * 1000 : averageValue(metaRows.map(row => row.cpm)),
    costPerResult:sum("results") > 0 ? spend / sum("results") : averageValue(metaRows.map(row => row.costPerResult)),
  };
}

function metaCampaignStartEvents(rows = []) {
  const metaRows = (rows || []).filter(row => isMetaPpcRow(row) && ppcSnapshotDate(row));
  return Object.entries(_.groupBy(metaRows, row => [
    row.externalCampaignId || row.rawCampaign || row.campaign || "Meta campaign",
    row.pid || row.product || "",
    row.cid || "",
  ].join("|"))).map(([key, groupRows]) => {
    const sorted = _.sortBy(groupRows, row => ppcSnapshotDate(row));
    const first = sorted[0] || {};
    const totals = sumMetaRows(groupRows);
    const date = ppcSnapshotDate(first);
    const label = metaCleanCampaignLabel(first);
    return {
      id:`meta-start-${normalizedCampaignKey(key) || date}`,
      date,
      type:"meta",
      pid:first.pid || "",
      cid:first.cid || "",
      product:first.product || "",
      campaign:first.campaign || first.rawCampaign || "",
      title:`Meta campaign started: ${label}`,
      body:`${fmtCompactMoney(totals.spend)} spend, ${totals.impressions.toLocaleString()} impressions, ${totals.clicks.toLocaleString()} link clicks since launch.`,
      spend:totals.spend,
      impressions:totals.impressions,
      clicks:totals.clicks,
      rows:totals.rows,
    };
  }).filter(event => event.date).sort((a,b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

function normalizeCoords(latRaw, lngRaw, fallbackLat = 39.5, fallbackLng = -98.35) {
  let lat = numberValue(latRaw);
  let lng = numberValue(lngRaw);
  const hasLat = String(latRaw ?? "").trim() !== "";
  const hasLng = String(lngRaw ?? "").trim() !== "";
  const looksLikeUsSwap = lat < 0 && lng > 0 && lng <= 72 && Math.abs(lat) >= 50 && Math.abs(lat) <= 180;
  if (hasLat && hasLng && ((Math.abs(lat) > 90 && Math.abs(lng) <= 90) || looksLikeUsSwap)) {
    [lat, lng] = [lng, lat];
  }
  return {
    lat:hasLat && Math.abs(lat) <= 90 ? lat : fallbackLat,
    lng:hasLng && Math.abs(lng) <= 180 ? lng : fallbackLng,
  };
}

function sheetKey(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sheetRowsByName(workbook, sheetName) {
  if (!sheetName) return [];
  return (workbook.Sheets[sheetName] || [])
    .filter(row => Object.values(row).some(v => v !== undefined && v !== null && v !== ""));
}

function sheetRows(workbook, names) {
  return sheetRowsByName(workbook, sheetNameFor(workbook, names));
}

function appendRows(target, rows) {
  for (let i = 0; i < (rows || []).length; i++) target.push(rows[i]);
  return target;
}

function dateBoundsFromRows(seedStart, seedEnd, rowSets = []) {
  const dates = [];
  if (seedStart) dates.push(seedStart);
  if (seedEnd) dates.push(seedEnd);
  for (const rows of rowSets || []) {
    for (let i = 0; i < (rows || []).length; i++) {
      const date = rows[i]?.date;
      if (date) dates.push(date);
    }
  }
  dates.sort();
  return { start:dates[0] || DATA_START, end:dates[dates.length - 1] || DATA_END };
}

function sheetRowsFromNames(workbook, sheetNames) {
  const rows = [];
  (sheetNames || []).forEach(sheetName => appendRows(rows, sheetRowsByName(workbook, sheetName)));
  return rows;
}

function extractLastUpdatedDate(rows) {
  const dateColumns = [
    "Last Updated",
    "Last Updated Date",
    "Updated",
    "Updated At",
    "As Of",
    "As Of Date",
    "Upload Date",
    "Snapshot Date",
    "Metric Date",
    "Metrics Date",
    "Date",
    "Video Snapshot Date",
  ];
  for (const row of rows || []) {
    const direct = normalizeDateValue(cellValue(row, dateColumns));
    if (direct) return direct;
    for (const [key, value] of Object.entries(row || {})) {
      if (/(last|updated|as\s*of|snapshot|upload|metric|date)/i.test(String(key))) {
        const parsed = normalizeDateValue(value);
        if (parsed) return parsed;
      }
    }
  }
  for (const row of rows || []) {
    for (const value of Object.values(row || {})) {
      const parsed = normalizeDateValue(value);
      if (parsed) return parsed;
    }
  }
  return "";
}

function sheetNameFor(workbook, names) {
  for (const name of names) {
    const wanted = sheetKey(name);
    const match = workbook.SheetNames.find(n => sheetKey(n) === wanted);
    if (match) return match;
  }
  return "";
}

function sheetNamesFor(workbook, names, { allowNumbered = false } = {}) {
  const wanted = names.map(sheetKey).filter(Boolean);
  return workbook.SheetNames.filter(sheetName => {
    const key = sheetKey(sheetName);
    return wanted.some(base => {
      if (key === base) return true;
      return allowNumbered && key.startsWith(base) && /^\d+$/.test(key.slice(base.length));
    });
  });
}

function warehouseNumberFromRow(row) {
  return warehouseNumberFromText(cellValue(row, [
    "Warehouse ID",
    "Warehouse Number",
    "Warehouse #",
    "Warehouse No",
    "Store Number",
    "Store #",
    "Location Number",
    "Location #",
  ])) || warehouseNumberFromText(cellValue(row, ["Store","Warehouse","Venue","Source Venue","Location"]));
}

function storeNameFromRow(row) {
  const name = String(cellValue(row, ["Store","Warehouse","Venue","Source Venue","Location"])).trim();
  const no = warehouseNumberFromRow(row);
  return name || (no ? `WAREHOUSE ${no}` : "");
}

function hasFilledCell(row, names) {
  return (names || []).some(name => {
    const value = cellValue(row, [name]);
    return value !== undefined && value !== null && String(value).trim() !== "";
  });
}

function carryForwardStoreRows(rows, { dateColumns = DATE_IMPORT_COLUMNS, metricColumns = STORE_DETAIL_METRIC_COLUMNS } = {}) {
  let lastStore = "";
  return (rows || []).map(row => {
    const storeName = storeNameFromRow(row);
    if (storeName) {
      if (/\b(?:sub\s*total|grand\s+total|total)\b/i.test(storeName)) {
        lastStore = "";
        return row;
      }
      lastStore = storeName;
      return row;
    }
    if (!lastStore) return row;
    if (!importDateValue(row, dateColumns) || !hasFilledCell(row, metricColumns)) return row;
    return { ...row, Venue: lastStore };
  });
}

function normalizeEventType(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (s.includes("tpd") || s.includes("third")) return "tpd";
  if (s.includes("promo") || s.includes("discount") || s.includes("feature") || s.includes("endcap") || s.includes("end cap")) return "promo";
  if (s.includes("markdown") || s === "md") return "markdown";
  if (s.includes("issue") || s.includes("flag") || s.includes("risk")) return "issue";
  if (s.includes("season") || s.includes("holiday")) return "seasonal";
  if (s.includes("demo") || s.includes("event")) return "demo";
  return FN_TYPES[s] ? s : "other";
}

function mergeStoreRows(currentWhs, rows, replace = false) {
  let changed = 0;
  const referenceWhs = [...currentWhs];
  const nextWhs = replace ? [] : [...currentWhs];
  rows.forEach(row => {
    const active = String(cellValue(row, ["Active"])).trim().toLowerCase();
    if (active === "no" || active === "false") return;
    const name = storeNameFromRow(row);
    if (!name) return;
    const existing = findStore(name, referenceWhs);
    const existingInNext = findStore(name, nextWhs);
    const warehouseNo = warehouseNumberFromRow(row) || warehouseNumberFromText(existing?.name);
    const coords = normalizeCoords(
      cellValue(row, ["Latitude","Lat"]),
      cellValue(row, ["Longitude","Lng","Long"]),
      existing?.lat || 39.5,
      existing?.lng || -98.35
    );
    const patch = {
      name,
      warehouseNo,
      region:String(cellValue(row, ["Region"])).trim() || existing?.region || "Unassigned",
      city:String(cellValue(row, ["City"])).trim() || existing?.city || name,
      st:String(cellValue(row, ["State","State or Province"])).trim() || existing?.st || "",
      lat:coords.lat,
      lng:coords.lng,
    };
    if (existingInNext) {
      const idx = nextWhs.findIndex(w => w.id === existingInNext.id);
      nextWhs[idx] = { ...existingInNext, ...patch };
      changed++;
      return;
    }
    const identity = allocateWarehouseIdentity(name, nextWhs, existing);
    nextWhs.push({ ...existing, ...identity, base:existing?.base || 0, ...patch });
    changed++;
  });
  return { whs:nextWhs, changed };
}

function detectImportKind(rows = []) {
  const sampleRows = usableObjectRows(rows);
  const keys = rowHeaderKeys(sampleRows);
  const has = (...names) => names.some(n => keys.has(normalizedHeaderKey(n)));
  if ((has("url","video_url","video url","canonical_url","canonical url") || has("creator","platform","published_at","collected_at")) && has("views","likes","comments","saves","shares")) return "videos";
  if (has("type","event type") && has("title","event","event title") && has("notes","description","body")) return "events";
  const hasStore = has("store","warehouse","venue");
  const hasInventory = has("inventory","inventory on hand","on hand","available inventory","available units","ending inventory","stock on hand","inbound","incoming","reserved","allocated");
  const hasRevenue = has("revenue","dollar sales","sales dollars","net sales","gross sales");
  const hasPpcMetrics = has("l7d spend","l7d sales","l7d attributed sales","l7d roas","lt spend","lt sales","budget remaining","impression share","impressions share","avg capout hour","missed sales","missed spend");
  const hasMetaMetrics = has("amount spent (usd)","amount spent","spend") && has("campaign name","campaign id") && (has("ad set name","ad name","purchases","purchase conversion value","purchases conversion value","purchase roas (return on ad spend)","link clicks") || isMetaAdsReportRows(rows));
  if (hasPpcMetrics && (has("external criteo campaign id","external campaign id","criteo campaign id","campaign id","sku id","line item id") || has("campaign","campaign name","product","product name"))) return "ppc";
  if (hasMetaMetrics) return "ppc";
  const hasWarehouseSelling = has(...WAREHOUSE_SELLING_COLUMNS);
  const hasTotalScope = sampleRows.slice(0, 80).some(row => isStrictCostcoTotalRow(row) || /\btotal\b/i.test(totalScopeText(row)));
  if (hasRevenue && has("date","time","week ending","1 week ending") && hasWarehouseSelling) return "inline_total";
  if (hasRevenue && has("date","time","week ending","1 week ending") && hasStore && hasTotalScope) return "inline_total";
  if (hasInventory && !hasRevenue && has("date","time","week ending","1 week ending","snapshot date") && hasStore) return "inline_inventory";
  if (hasInventory && !hasRevenue && has("date","time","week ending","1 week ending","snapshot date")) return "online";
  if (hasRevenue && has("date","time","week ending","1 week ending") && (!hasStore || has("channel","orders","sessions","ad spend","platform"))) return "online";
  return "sales";
}

function looksLikePaidMediaRows(rows = []) {
  const sampleRows = usableObjectRows(rows);
  if (!sampleRows.length) return false;
  if (isMetaAdsReportRows(sampleRows)) return true;
  const keys = rowHeaderKeys(sampleRows);
  const has = (...names) => names.some(n => keys.has(normalizedHeaderKey(n)));
  const hasMetaSpend = has("amount spent (usd)", "amount spent", "meta spend");
  const hasMetaCampaign = has("campaign name", "campaign id");
  const hasMetaDetail = has("ad set name", "ad name", "results", "reach", "impressions", "link clicks", "views");
  if (hasMetaSpend && hasMetaCampaign && hasMetaDetail) return true;
  const hasPpcMetrics = has("l7d spend","l7d sales","l7d attributed sales","l7d roas","lt spend","lt sales","budget remaining","impression share","impressions share","avg capout hour","missed sales","missed spend");
  const hasPpcIdentity = has("external criteo campaign id","external campaign id","criteo campaign id","campaign id","campaign","campaign name","product","product name","sku id","line item id");
  return hasPpcMetrics && hasPpcIdentity;
}

function paidMediaCsvShapeSummary(rows = []) {
  const sampleRows = usableObjectRows(rows);
  const headers = Array.from(rowHeaderKeys(sampleRows)).filter(Boolean).slice(0, 8);
  const rowLabel = sampleRows.length === 1 ? "row" : "rows";
  if (!headers.length) return `Parsed ${sampleRows.length.toLocaleString()} usable ${rowLabel}, but no headers were detected.`;
  return `Parsed ${sampleRows.length.toLocaleString()} usable ${rowLabel}. Detected headers: ${headers.join(", ")}.`;
}

function isMetaAdsReportRows(rows = []) {
  return usableObjectRows(rows).some(row => isMetaAdsReportRow(row));
}

function isMetaAdsReportRow(row = {}) {
  const amountSpent = String(cellValue(row, ["Amount spent (USD)","Amount spent","Amount Spent","Meta Spend"])).trim();
  const campaignName = String(cellValue(row, ["Campaign name","Campaign Name","Campaign"])).trim();
  const metaSpecific = String(cellValue(row, ["Ad set name","Ad Set Name","Ad name","Ad Name","Purchase ROAS (return on ad spend)","Purchase ROAS","Purchases conversion value","Purchase conversion value","Link clicks"])).trim();
  return Boolean(amountSpent && campaignName && metaSpecific);
}

function ppcSourcesFromCsvData(data = []) {
  const rows = usableObjectRows(data);
  if (isMetaAdsReportRows(rows)) return { campaignRows:rows };
  const isCapout = rows.some(row => String(cellValue(row, ["Avg Capout Hour","Average Capout Hour","Capout Status"])).trim());
  const isShare = rows.some(row => String(cellValue(row, ["Impression Share","Impressions Share","L7D Impression Share"])).trim());
  const isLineItem = rows.some(row => String(cellValue(row, ["Line Item ID","Line_Item_ID","Line Item Name"])).trim());
  const isSku = rows.some(row => String(cellValue(row, ["SKU ID","SKU","Product","Product Name","SKU Name"])).trim());
  return {
    campaignRows:!isCapout && !isShare && !isLineItem && !isSku ? rows : [],
    lineItemRows:isLineItem && !isCapout && !isShare && !isSku ? rows : [],
    skuRows:isSku && !isCapout && !isShare ? rows : [],
    capoutRows:isCapout ? rows : [],
    impressionRows:isShare ? rows : [],
  };
}

const WORKBOOK_WEEKS = [];
const WORKBOOK_FACTS = [];

function buildWorkbookSeed() {
  const salesMap = new Map();
  const prodSales = [];
  WORKBOOK_FACTS.forEach(([wi, pi, di, rev, units, promo, refund, inv]) => {
    const w = WAREHOUSES[wi];
    const p = PRODUCTS[pi];
    const date = WORKBOOK_WEEKS[di];
    if (!w || !p || !date) return;
    prodSales.push({ wid:w.id, pid:p.id, date, rev, units, promo, refund, inv, isDemo:false });
    const key = `${w.id}|${date}`;
    const cur = salesMap.get(key) || { wid:w.id, date, rev:0, units:0, promo:0, refund:0, inv:0, isDemo:false };
    cur.rev += rev; cur.units += units; cur.promo += promo; cur.refund += refund; cur.inv += inv;
    salesMap.set(key, cur);
  });
  const sales = Array.from(salesMap.values()).sort((a,b) => a.wid.localeCompare(b.wid) || a.date.localeCompare(b.date));
  return { sales, prodSales, workbookSales:compileWorkbookSalesFromRows(sales, prodSales, "Awaiting upload", [], PRODUCTS) };
}

function compileWorkbookSalesFromRows(salesRows, productRows, source = "Uploaded CSV", whList = WAREHOUSES, productList = PRODUCTS) {
  const sumRows = rows => ({ rev:_.sumBy(rows,"rev"), units:_.sumBy(rows,"units"), promo:_.sumBy(rows,"promo"), refund:_.sumBy(rows,"refund"), inv:_.sumBy(rows,"inv"), rows:rows.length });
  const byWeek = _.groupBy(salesRows, "date");
  const weeks = Object.keys(byWeek).sort();
  return {
    meta:{ source, sheet:"Raw Consolidated", rows:productRows.length, start:weeks[0]||DATA_START, end:weeks[weeks.length-1]||DATA_END, regions:new Set(whList.map(w=>w.region).filter(Boolean)).size, states:new Set(whList.map(w=>w.st).filter(Boolean)).size, products:productList.length, stores:whList.length },
    weekly:weeks.map(date => { const b=sumRows(byWeek[date]); return [date,b.rev,b.units,b.promo,b.refund,b.inv]; }),
    groups:{
      Region:_.orderBy(Object.entries(_.groupBy(salesRows, r=>whList.find(w=>w.id===r.wid)?.region||"Unassigned")).map(([k,rows])=>[k,...Object.values(sumRows(rows))]), 1, "desc"),
      Product:_.orderBy(Object.entries(_.groupBy(productRows, "pid")).map(([pid,rows])=>[productList.find(p=>p.id===pid)?.name||pid,...Object.values(sumRows(rows))]), 1, "desc"),
      State:_.orderBy(Object.entries(_.groupBy(salesRows, r=>whList.find(w=>w.id===r.wid)?.st||"" )).map(([k,rows])=>[k,...Object.values(sumRows(rows))]), 1, "desc"),
      Store:_.orderBy(Object.entries(_.groupBy(salesRows, "wid")).map(([wid,rows])=>{ const w=whList.find(x=>x.id===wid); return [w?.name||wid,...Object.values(sumRows(rows)),w?.region,w?.st,w?.city]; }), 1, "desc"),
    },
  };
}

function compileWorkbookCsvData(data, source, currentWhs = WAREHOUSES, productMeta = {}, campaignMeta = {}) {
  let nextWhs = [...currentWhs];
  const prodMap = new Map();
  const num = v => Math.round(numberValue(v));
  carryForwardStoreRows(data).forEach(row => {
    const date = importDateValue(row, ["1 Week Ending","Week Ending","Date","Week","Time"]);
    const storeName = storeNameFromRow(row);
    const productRaw = productDisplayName(String(cellValue(row, PRODUCT_IMPORT_COLUMNS)).trim());
    const prod = matchProduct(productRaw, productMeta);
    const pid = prod?.id || productRaw;
    const product = productDisplayName(prod?.short || productRaw);
    if (!date || !storeName || !pid) return;
    const campaign = campaignForRow(row, { campaignMeta, productMeta, pid, date, channel:"Inline" });
    const inventoryRaw = cellValue(row, ["Inventory On Hand","Inventory"]);
    const inventoryKnown = hasKnownNumber(inventoryRaw);
    let w = findStore(storeName, nextWhs);
    if (!w) {
      const fallback = findStore(storeName, WAREHOUSES);
      const identity = allocateWarehouseIdentity(storeName, nextWhs, fallback);
      const coords = normalizeCoords(cellValue(row, ["Lat","Latitude"]), cellValue(row, ["Lng","Longitude","Long"]), fallback?.lat || 39.5, fallback?.lng || -98.35);
      w = { ...fallback, ...identity, name:storeName, warehouseNo:warehouseNumberFromText(storeName) || fallback?.warehouseNo, city:cellValue(row, ["City"])||fallback?.city||storeName, st:cellValue(row, ["State or Province","State"])||fallback?.st||"", region:cellValue(row, ["Region"])||fallback?.region||"Unassigned", lat:coords.lat, lng:coords.lng, base:0 };
      nextWhs.push(w);
    }
    const nonStore = isNonStoreInventoryLocation(w);
    const key = `${w.id}|${pid}|${campaign?.id || ""}|${date}`;
    const cur = prodMap.get(key) || { wid:w.id, pid, cid:campaign?.id || "", product, campaign:campaign?.short || "", date, rev:0, units:0, promo:0, refund:0, inv:0, invKnown:false, isDemo:false };
    cur.rev += nonStore ? 0 : numberValue(cellValue(row, ["Dollar Sales","Sales Dollars","Revenue"]));
    cur.units += nonStore ? 0 : num(cellValue(row, ["Unit Sales","Units","Units Sold"]));
    cur.promo += nonStore ? 0 : numberValue(cellValue(row, ["Promoted Dollars","Promo Dollars"]));
    cur.refund += nonStore ? 0 : numberValue(cellValue(row, ["Refund Dollars"]));
    if (inventoryKnown) cur.inv += num(inventoryRaw);
    cur.invKnown = cur.invKnown || inventoryKnown;
    prodMap.set(key, cur);
  });
  const prodSales = Array.from(prodMap.values());
  const salesMap = new Map();
  prodSales.forEach(r => {
    const key = `${r.wid}|${r.date}`;
    const cur = salesMap.get(key) || { wid:r.wid, date:r.date, rev:0, units:0, promo:0, refund:0, inv:0, invKnown:true, isDemo:false };
    cur.rev += r.rev; cur.units += r.units; cur.promo += r.promo; cur.refund += r.refund; cur.inv += r.inv;
    cur.invKnown = cur.invKnown && r.invKnown === true;
    salesMap.set(key, cur);
  });
  const sales = Array.from(salesMap.values()).sort((a,b)=>a.wid.localeCompare(b.wid)||a.date.localeCompare(b.date));
  return { whs:nextWhs, sales, prodSales, workbookSales:compileWorkbookSalesFromRows(sales, prodSales, source, nextWhs, PRODUCTS) };
}

function compileTotalSalesRows(data, source = "Costco daily totals", defaultChannel = "Inline", productMeta = {}, campaignMeta = {}) {
  const rowMap = new Map();
  const seenRows = new Set();
  prepareCostcoBlockRows(data, { totalsOnly:defaultChannel === "Inline" }).forEach(row => {
    const date = importDateValue(row, ["Date","Week Ending","1 Week Ending","Order Date","Snapshot Date","Time"]);
    const productRaw = productDisplayName(String(cellValue(row, PRODUCT_IMPORT_COLUMNS)).trim());
    const prod = matchProduct(productRaw, productMeta);
    const product = productDisplayName(prod?.short || productRaw || "Unassigned");
    const productKey = prod?.id || product;
    const rawChannel = String(cellValue(row, ["Channel","Storefront","Marketplace","Platform","Source","Sales Channel"])).trim();
    const channel = rawChannel || defaultChannel;
    const campaign = campaignForRow(row, { campaignMeta, productMeta, pid:productKey, date, channel });
    const rev = numberValue(cellValue(row, ["Revenue","Dollar Sales","Sales Dollars","Net Sales","Gross Sales"]));
    const units = Math.round(numberValue(cellValue(row, ["Units","Unit Sales","Units Sold","Quantity","Qty"])));
    const promo = numberValue(cellValue(row, ["Promoted Dollars","Promo Dollars"]));
    const promoUnits = Math.round(numberValue(cellValue(row, ["Promoted Units","Promo Units"])));
    const refund = numberValue(cellValue(row, ["Refund Dollars","Refunds"]));
    const refundUnits = Math.round(numberValue(cellValue(row, ["Refund Units"])));
    const orders = Math.round(numberValue(cellValue(row, ["Orders","Order Count","Transactions"])));
    const sessions = Math.round(numberValue(cellValue(row, ["Sessions","Visits","Traffic"])));
    const adSpend = numberValue(cellValue(row, ["Ad Spend","Ad_Spend","Marketing Spend","Media Spend","Spend"]));
    const invRaw = cellValue(row, ["Inventory","Inventory On Hand","On Hand","Available Inventory","Available Units","Ending Inventory","Stock On Hand"]);
    const inboundRaw = cellValue(row, ["Inbound","Incoming","Inbound Units","Incoming Units","On Order","Replenishment"]);
    const reservedRaw = cellValue(row, ["Reserved","Committed","Reserved Units","Allocated","Allocated Units"]);
    const invKnown = hasKnownNumber(invRaw);
    const inboundKnown = hasKnownNumber(inboundRaw);
    const reservedKnown = hasKnownNumber(reservedRaw);
    const inv = Math.round(numberValue(invRaw));
    const inbound = Math.round(numberValue(inboundRaw));
    const reserved = Math.round(numberValue(reservedRaw));
    const activeDoorsRaw = cellValue(row, WAREHOUSE_SELLING_COLUMNS);
    const activeDoors = warehouseSellingValue(row);
    const activeDoorsKnown = hasKnownNumber(activeDoorsRaw);
    const notes = String(cellValue(row, ["Notes","Context","Comment"])).trim();
    if (!date || (!rev && !units && !orders && !inv && !inbound && !reserved && !activeDoors && !activeDoorsKnown && !invKnown && !inboundKnown && !reservedKnown)) return;
    const rowSig = [
      date,
      productKey,
      campaign?.id || "",
      channel,
      totalScopeText(row).toLowerCase(),
      rev,
      units,
      promo,
      promoUnits,
      refund,
      refundUnits,
      orders,
      sessions,
      adSpend,
      inv,
      inbound,
      reserved,
      activeDoors,
    ].join("|");
    if (seenRows.has(rowSig)) return;
    seenRows.add(rowSig);
    const key = `${date}|${productKey}|${campaign?.id || ""}|${channel}`;
    const cur = rowMap.get(key) || { date, pid:productKey, cid:campaign?.id || "", product, campaign:campaign?.short || "", channel, rev:0, units:0, promo:0, promoUnits:0, refund:0, refundUnits:0, orders:0, sessions:0, adSpend:0, inv:0, inbound:0, reserved:0, activeDoors:0, activeDoorsKnown:false, invKnown:false, inboundKnown:false, reservedKnown:false, notes:"", source };
    cur.rev += rev;
    cur.units += units;
    cur.promo += promo;
    cur.promoUnits += promoUnits;
    cur.refund += refund;
    cur.refundUnits += refundUnits;
    cur.orders += orders;
    cur.sessions += sessions;
    cur.adSpend += adSpend;
    cur.inv += inv;
    cur.inbound += inbound;
    cur.reserved += reserved;
    if (activeDoorsKnown) {
      cur.activeDoors = activeDoors;
      cur.activeDoorsKnown = true;
    }
    cur.invKnown = cur.invKnown || invKnown;
    cur.inboundKnown = cur.inboundKnown || inboundKnown;
    cur.reservedKnown = cur.reservedKnown || reservedKnown;
    if (notes && !cur.notes.includes(notes)) cur.notes = [cur.notes, notes].filter(Boolean).join(" | ");
    rowMap.set(key, cur);
  });
  return Array.from(rowMap.values()).sort((a,b) => a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel) || a.product.localeCompare(b.product));
}

const WORKBOOK_SEED = buildWorkbookSeed();
const INIT_SALES = WORKBOOK_SEED.sales;
const INIT_PROD_SALES = WORKBOOK_SEED.prodSales;
const WORKBOOK_SALES = WORKBOOK_SEED.workbookSales;
const INIT_INLINE_TOTAL_SALES = [];
const INIT_ONLINE_SALES = [];

// VIDEO TRACKING DATA
// ═══════════════════════════════════════════════════════════════




const PLATFORMS = ["TikTok","Instagram","YouTube","Facebook"];
const VIDEO_TYPES = ["Paid","Seeding"];

function normalizePlatform(raw) {
  const s = String(raw || "").trim();
  const key = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return "";
  if (key.includes("tiktok")) return "TikTok";
  if (key === "ig" || key.includes("instagram")) return "Instagram";
  if (key === "yt" || key.includes("youtube") || key.includes("shorts")) return "YouTube";
  if (key === "fb" || key.includes("facebook") || key.includes("meta")) return "Facebook";
  return s.replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function normalizeVideoType(raw, fallback = "") {
  const s = String(raw || fallback || "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("paid")) return "Paid";
  if (s.includes("seed")) return "Seeding";
  return "";
}




function fmtUnits(value) {
  return Math.round(Number(value || 0)).toLocaleString();
}

function fmtBytes(bytes) {
  const n = Number(bytes || 0);
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${Math.round(n)} B`;
}

function fmtDuration(milliseconds) {
  const seconds = Math.max(0, Number(milliseconds || 0)) / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function waitForUiTick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function prepareDatasetUpload(json) {
  const rawBlob = new Blob([json], { type:"application/json" });
  const rawBytes = rawBlob.size;
  if (typeof CompressionStream === "function" && rawBytes > 1024 * 1024) {
    const stream = rawBlob.stream().pipeThrough(new CompressionStream("gzip"));
    const body = await new Response(stream).blob();
    return {
      body,
      bodyBlob:body,
      headers:{ "Content-Type":"application/json", "Content-Encoding":"gzip" },
      encoding:"gzip",
      rawBytes,
      uploadBytes:body.size,
      compressed:true,
    };
  }
  return {
    body:json,
    bodyBlob:rawBlob,
    headers:{ "Content-Type":"application/json" },
    encoding:"identity",
    rawBytes,
    uploadBytes:rawBytes,
    compressed:false,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 4 * 60 * 1000) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal:controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function waitForFullPublication(payload, token, onProgress) {
  if (payload?.status === "verified" && payload.dataset) return payload;
  if (!payload?.jobId || !payload?.statusUrl) throw new Error("The server did not return a durable publication job.");
  const statusUrl = new URL(payload.statusUrl, window.location.origin);
  if(statusUrl.origin !== window.location.origin || !statusUrl.pathname.startsWith("/api/")) throw new Error("Invalid publication status URL");
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30 * 60 * 1000) {
    await new Promise(resolve => window.setTimeout(resolve, 1500));
    const res = await fetchWithTimeout(statusUrl.href, {
      headers:{ Authorization:`Bearer ${token}` },
      cache:"no-store",
    }, 30 * 1000);
    const status = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(status.error || "Could not read the publication job status.");
    onProgress?.({ phase:"processing", status:status.status || "processing", jobId:payload.jobId });
    if (status.status === "failed") throw new Error(status.error || "The full publication job failed.");
    if (status.status === "verified" && status.dataset) return status;
    if (!["accepted", "processing"].includes(status.status)) throw new Error("The publication job returned an unknown status.");
  }
  throw new Error(`Publication job ${payload.jobId} is still processing. Check the same job instead of submitting it again.`);
}

function fullPublicationExpectationHeaders(dataset) {
  const coverage = rows => {
    const dates = [...new Set((rows || []).map(row => String(row?.date || "")).filter(Boolean))].sort();
    return { start:dates[0] || "", end:dates.at(-1) || "", dates:dates.length };
  };
  const warehouse = coverage(dataset?.prodSales);
  const official = coverage(dataset?.inlineTotalSales);
  const online = coverage(dataset?.onlineSales);
  return {
    "X-BYOU-Expected-Warehouses":String((dataset?.whs || []).length),
    "X-BYOU-Expected-Products":String(new Set(Object.values(dataset?.productMeta || {}).map(row => row?.id).filter(Boolean)).size),
    "X-BYOU-Expected-Campaigns":String(new Set(Object.values(dataset?.campaignMeta || {}).map(row => row?.id).filter(Boolean)).size),
    "X-BYOU-Expected-Product-Rows":String((dataset?.prodSales || []).length),
    "X-BYOU-Expected-Warehouse-Start":warehouse.start,
    "X-BYOU-Expected-Warehouse-End":warehouse.end,
    "X-BYOU-Expected-Warehouse-Dates":String(warehouse.dates),
    "X-BYOU-Expected-Inline-Total-Rows":String((dataset?.inlineTotalSales || []).length),
    "X-BYOU-Expected-Inline-Start":official.start,
    "X-BYOU-Expected-Inline-End":official.end,
    "X-BYOU-Expected-Inline-Dates":String(official.dates),
    "X-BYOU-Expected-Online-Rows":String((dataset?.onlineSales || []).length),
    "X-BYOU-Expected-Online-Start":online.start,
    "X-BYOU-Expected-Online-End":online.end,
    "X-BYOU-Expected-Online-Dates":String(online.dates),
    "X-BYOU-Expected-Sales-Corrections":String((dataset?.ownerSalesCorrections || []).length),
  };
}

async function publishDatasetUpload(upload, token, expectedPublishedAt, dataset, onProgress) {
  const chunkThreshold = 8 * 1024 * 1024;
  const publicationJobId = `full-${String(dataset?.publishedAt || Date.now()).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 72)}`;
  const expectationHeaders = fullPublicationExpectationHeaders(dataset);
  if (upload.uploadBytes <= chunkThreshold) {
    const res = await fetchWithTimeout("/api/dataset", {
      method:"POST",
      headers:{ ...upload.headers, ...expectationHeaders, Authorization:`Bearer ${token}`, "X-BYOU-Expected-Published-At":expectedPublishedAt || "", "X-BYOU-Publication-Job-Id":publicationJobId },
      body:upload.body,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Could not publish shared dataset.");
    return waitForFullPublication(payload, token, onProgress);
  }

  const chunkSize = 4 * 1024 * 1024;
  const total = Math.ceil(upload.uploadBytes / chunkSize);
  const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  let payload = {};
  for (let index = 0; index < total; index += 1) {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, upload.uploadBytes);
    onProgress?.({ index:index + 1, total, bytes:end });
    const res = await fetchWithTimeout("/api/dataset/chunk", {
      method:"POST",
      headers:{
        "Content-Type":"application/octet-stream",
        Authorization:`Bearer ${token}`,
        "X-Upload-Id":uploadId,
        "X-Chunk-Index":String(index),
        "X-Chunk-Total":String(total),
        "X-Dataset-Encoding":upload.encoding,
        "X-BYOU-Expected-Published-At":expectedPublishedAt || "",
        "X-BYOU-Publication-Job-Id":publicationJobId,
        ...expectationHeaders,
      },
      body:upload.bodyBlob.slice(start, end),
    }, 2 * 60 * 1000);
    payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `Could not upload dataset chunk ${index + 1} of ${total}.`);
  }
  if (!payload.complete) throw new Error("Dataset upload ended before the server finalized it.");
  return waitForFullPublication(payload, token, onProgress);
}

async function parseCsvRows(file, { preferWorker = true } = {}) {
  const Papa = await loadPapa();
  const run = worker => new Promise((resolve, reject) => {
    Papa.parse(file, {
      header:true,
      skipEmptyLines:true,
      worker,
      complete:({ data }) => resolve(usableObjectRows(data)),
      error:err => reject(err),
    });
  });
  if (!preferWorker) return run(false);
  return run(true).then(rows => rows.length ? rows : run(false)).catch(() => run(false));
}

const ANALYSIS_MIN_SELLING_UNITS = 100;
const ANALYSIS_MIN_SELLING_UNIT_OPTIONS = [0, 100, 200];
const MEANINGFUL_SALES_WINDOW_DAYS = 7;
const MEANINGFUL_SALES_MIN_REVENUE = 1000;
const MEANINGFUL_SALES_MIN_UNITS = ANALYSIS_MIN_SELLING_UNITS;
const MEANINGFUL_SALES_MIN_DAILY_REVENUE = 250;
const MEANINGFUL_SALES_MIN_DAILY_UNITS = 10;
const WAREHOUSE_DISPLAY_MIN_REVENUE = MEANINGFUL_SALES_MIN_REVENUE;
const WAREHOUSE_DISPLAY_MIN_UNITS = ANALYSIS_MIN_SELLING_UNITS;
const WAREHOUSE_DISPLAY_MIN_INVENTORY = ANALYSIS_MIN_SELLING_UNITS;

function aggregateDailySalesRows(rows = []) {
  const byDate = new Map();
  (rows || []).forEach(row => {
    const date = String(row?.date || "");
    if (!date) return;
    const cur = byDate.get(date) || { date, rev:0, units:0, inv:0 };
    cur.rev += Number(row.rev || 0);
    cur.units += Number(row.units || 0);
    cur.inv += Number(row.inv || 0);
    byDate.set(date, cur);
  });
  return _.sortBy([...byDate.values()], "date");
}

function meaningfulSalesStartDate(rows = [], options = {}) {
  const dailyRows = aggregateDailySalesRows(rows);
  const positiveRows = dailyRows.filter(row => Math.max(0, Number(row.rev || 0)) > 0 || Math.max(0, Number(row.units || 0)) > 0);
  const firstPositiveDate = positiveRows[0]?.date || "";
  if (!firstPositiveDate) return "";
  const windowDays = Math.max(1, Number(options.windowDays ?? MEANINGFUL_SALES_WINDOW_DAYS) || MEANINGFUL_SALES_WINDOW_DAYS);
  const minWindowRevenue = Math.max(0, Number(options.minRevenue ?? MEANINGFUL_SALES_MIN_REVENUE) || 0);
  const minWindowUnits = Math.max(0, Number(options.minUnits ?? MEANINGFUL_SALES_MIN_UNITS) || 0);
  const maxDailyRevenue = Math.max(0, ...positiveRows.map(row => Math.max(0, Number(row.rev || 0))));
  const maxDailyUnits = Math.max(0, ...positiveRows.map(row => Math.max(0, Number(row.units || 0))));
  const minDailyRevenue = Math.min(Number(options.minDailyRevenue ?? MEANINGFUL_SALES_MIN_DAILY_REVENUE) || 0, maxDailyRevenue * 0.2);
  const minDailyUnits = Math.min(Number(options.minDailyUnits ?? MEANINGFUL_SALES_MIN_DAILY_UNITS) || 0, maxDailyUnits * 0.2);
  let firstQualifiedWindowDate = "";
  for (const row of positiveRows) {
    const windowEnd = offsetDate(row.date, windowDays - 1);
    const windowRows = dailyRows.filter(item => item.date >= row.date && item.date <= windowEnd);
    const positiveRevenue = _.sumBy(windowRows, item => Math.max(0, Number(item.rev || 0)));
    const positiveUnits = _.sumBy(windowRows, item => Math.max(0, Number(item.units || 0)));
    const netRevenue = _.sumBy(windowRows, item => Number(item.rev || 0));
    const windowQualified = netRevenue > 0 && (positiveRevenue >= minWindowRevenue || positiveUnits >= minWindowUnits);
    if (!windowQualified) continue;
    if (!firstQualifiedWindowDate) firstQualifiedWindowDate = row.date;
    const dailyRevenue = Math.max(0, Number(row.rev || 0));
    const dailyUnits = Math.max(0, Number(row.units || 0));
    if ((minDailyRevenue > 0 && dailyRevenue >= minDailyRevenue) || (minDailyUnits > 0 && dailyUnits >= minDailyUnits)) {
      return row.date;
    }
  }
  return firstQualifiedWindowDate || firstPositiveDate;
}

function isNonStoreInventoryLocation(warehouse) {
  return isNonStoreWarehouse(warehouse);
}

function analysisWarehouseStats(rows = [], warehouse, options = {}) {
  const minUnits = Math.max(0, Number(options.minUnits ?? ANALYSIS_MIN_SELLING_UNITS) || 0);
  const minInventory = Math.max(0, Number(options.minInventory ?? minUnits) || 0);
  const minRevenue = Math.max(0, Number(options.minRevenue ?? MEANINGFUL_SALES_MIN_REVENUE) || 0);
  const requireMeaningfulVolume = options.requireMeaningfulVolume !== false;
  const sorted = _.sortBy((rows || []).filter(Boolean), "date");
  const positiveRev = _.sumBy(sorted, r => Math.max(0, Number(r.rev || 0)));
  const positiveUnits = _.sumBy(sorted, r => Math.max(0, Number(r.units || 0)));
  const netRev = _.sumBy(sorted, r => Number(r.rev || 0));
  const netUnits = _.sumBy(sorted, r => Number(r.units || 0));
  const inventoryValues = sorted.map(r => Number(r.inv || 0)).filter(Number.isFinite);
  const maxInventory = inventoryValues.length ? Math.max(...inventoryValues) : 0;
  const initialInventory = Number(sorted.find(r => Number(r.inv || 0) > 0)?.inv || 0);
  const hasMeaningfulRevenue = minRevenue <= 0 ? positiveRev > 0 : positiveRev >= minRevenue;
  const hasMeaningfulUnits = minUnits <= 0 ? positiveUnits > 0 : positiveUnits >= minUnits;
  const hasMeaningfulInventory = minInventory > 0 && maxInventory >= minInventory;
  const reason = (() => {
    if (!warehouse || isNonStoreInventoryLocation(warehouse)) return "non-store";
    if ((positiveRev <= 0 && positiveUnits <= 0) || (netRev <= 0 && netUnits <= 0)) return "returns-only";
    if (requireMeaningfulVolume && !hasMeaningfulRevenue && !hasMeaningfulUnits && !hasMeaningfulInventory) return "low-volume";
    return "";
  })();
  return {
    eligible:!reason,
    reason,
    rows:sorted,
    positiveRev,
    positiveUnits,
    netRev,
    netUnits,
    maxInventory,
    initialInventory,
    hasMeaningfulRevenue,
    hasMeaningfulUnits,
    hasMeaningfulInventory,
    minRevenue,
    minUnits,
    minInventory,
  };
}

function warehouseDisplayStats(rows = [], warehouse, options = {}) {
  return analysisWarehouseStats(rows, warehouse, {
    minRevenue:WAREHOUSE_DISPLAY_MIN_REVENUE,
    minUnits:WAREHOUSE_DISPLAY_MIN_UNITS,
    minInventory:WAREHOUSE_DISPLAY_MIN_INVENTORY,
    requireMeaningfulVolume:true,
    ...options,
  });
}

function shouldExcludeInventoryCoverage(warehouse, evidence = {}) {
  return !shouldIncludeInventoryCoverageItem(warehouse, evidence);
}



function pctChange(now, prev) {
  return prev > 0 ? ((now - prev) / prev) * 100 : null;
}

function daysBetweenISO(start, end) {
  if (!start || !end) return 0;
  return Math.round((parseISODate(end) - parseISODate(start)) / 864e5);
}

function shiftISODate(date, days) {
  const d = parseISODate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function storeTrendFromRows(rows, endDate) {
  const sorted = _.sortBy((rows || []).filter(r => r.date), "date");
  const latestDate = endDate || sorted[sorted.length - 1]?.date || "";
  const sellingRows = sorted.filter(r => Number(r.rev || 0) > 0 || Number(r.units || 0) > 0);
  const lastSaleDate = sellingRows[sellingRows.length - 1]?.date || "";
  if (!latestDate || !lastSaleDate) return { pct:null, label:"No sales history", status:"none", col:C.muted };

  const daysSinceSale = daysBetweenISO(lastSaleDate, latestDate);
  if (daysSinceSale > 45) return { pct:null, label:`Inactive ${daysSinceSale}d`, status:"inactive", col:C.muted };

  const firstDate = sorted[0]?.date || lastSaleDate;
  const spanDays = Math.max(1, daysBetweenISO(firstDate, latestDate) + 1);
  const windowDays = Math.max(7, Math.min(28, Math.floor(spanDays / 3) || 7));
  const recentStart = shiftISODate(latestDate, -windowDays + 1);
  const prevEnd = shiftISODate(recentStart, -1);
  const prevStart = shiftISODate(prevEnd, -windowDays + 1);
  const recentRows = sorted.filter(r => r.date >= recentStart && r.date <= latestDate);
  const priorRows = sorted.filter(r => r.date >= prevStart && r.date <= prevEnd);
  const recentRev = _.sumBy(recentRows, "rev");
  const priorRev = _.sumBy(priorRows, "rev");
  const minRows = spanDays <= 21 ? 1 : 2;

  if (recentRows.length < minRows || priorRows.length < minRows) {
    return { pct:null, label:"Limited history", status:"limited", col:C.muted };
  }
  if (recentRev > 0 && priorRev <= 0) return { pct:null, label:"New / restarted", status:"up", col:C.green };
  if (recentRev <= 0 && priorRev > 0) return { pct:null, label:"No recent sales", status:"inactive", col:C.muted };
  if (recentRev < 100 && priorRev < 100) return { pct:null, label:"Low volume", status:"limited", col:C.muted };

  const pct = pctChange(recentRev, priorRev);
  if (pct === null) return { pct:null, label:"Needs prior sales", status:"limited", col:C.muted };
  return {
    pct,
    label:`${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(Math.abs(pct) >= 100 ? 0 : 1)}% recent`,
    status:pct >= 0 ? "up" : "down",
    col:pct >= 0 ? C.green : C.red,
    recentRev,
    priorRev,
    windowDays,
  };
}

const INIT_VIDEOS = [];

const INIT_VIDEO_LIST = [];

const VIDEO_SNAP_DATES = [DATA_START, DATA_END];

function genVideoMetrics() {
  return [];
      // Realistic growth curve — fast early, then slows
}

const INIT_VIDEO_METRICS = [];


// ═══════════════════════════════════════════════════════════════
// DESIGN TOKENS
// ═══════════════════════════════════════════════════════════════

const EMPTY_MAP_COVERAGE = Object.freeze({ selectedCount:0, unionStores:0, sharedStores:0, partialStores:0, productStats:Object.freeze([]) });
const EMPTY_REVENUE_DOOR_STATS = Object.freeze({
  activeDoors:0, activeDoorDate:"", revenuePerDoor:0, rev:0, units:0,
  daily:Object.freeze([]), weekly:Object.freeze([]), weeklyPeriodCount:0,
  productIds:Object.freeze([]), totalWarehouses:0, verifiedWarehouseIds:Object.freeze([]),
  formulaLabel:"No verified weekly selling stores", source:"No verified weekly selling stores",
});
const EMPTY_CAMPAIGN_PLANNING_STATS = Object.freeze({
  latestDate:"", observedDays:0, avgDailyRevenue:0, recentDailyUnits:0, velocityUnits:0,
  latestInventory:0, latestInventoryKnown:false, fullPriceUnitPrice:0, inventorySalesTarget:0,
  daysToSellout:null, targetDays:0, projected30:0, projectedFull:0, sellThroughReviewDate:"",
});
const IMPORT_MODE_COPY = {
  workbook:{
    title:"Workbook / sales",
    mode:"Replace source of truth",
    detail:"Rebuilds Costco sales, products, campaigns, totals, inventory, imported calendar events, and workbook-paid-media sections from the uploaded workbook.",
  },
  dailyUpdate:{
    title:"Daily update",
    mode:"Merge new or changed dates",
    detail:"Uses a compact workbook containing only new or corrected rows. Matching business keys are updated and historical rows remain intact.",
  },
  csv:{
    title:"Single CSV",
    mode:"Update matched rows",
    detail:"Uses the row keys in the CSV to update matching records and add genuinely new rows without duplicating the same date, store, product, or campaign.",
  },
  paidMedia:{
    title:"Meta / Criteo",
    mode:"Append or update snapshots",
    detail:"Keeps paid-media history by date, campaign, ad set, ad, or SKU. Matching rows are updated; new reporting days are added.",
  },
  videos:{
    title:"Trackify videos",
    mode:"Append or update snapshots",
    detail:"Keeps video history by video and collected date. Existing video metrics are updated and new snapshots are added.",
  },
  publish:{
    title:"Publish current",
    mode:"Replace shared dataset",
    detail:"Overwrites the team dataset with the current compiled dashboard state.",
  },
};
function importModeLabel(key) {
  return IMPORT_MODE_COPY[key]?.mode || "Update matched rows";
}
function importedNoteMarker(source, importKind = "generic") {
  return { imported:true, importKind, source:String(source || "").trim() };
}
function isImportedFootnote(note = {}, importKind = "") {
  const imported = note.imported === true ||
    String(note.source || "").trim() !== "" ||
    /^Imported from\b/i.test(String(note.body || "").trim());
  if (!imported || !importKind) return imported;
  return note.importKind === importKind;
}
const PROXIMA_REGULAR_STACK = "'Proxima Nova BYOU','Proxima Nova Regular','Proxima Nova',"+HELVETICA_NEUE_STACK;
const REPORT_NAV_FONT = { fontFamily:PROXIMA_REGULAR_STACK };
function perfCol(t) { return t < 0.33 ? C.red : t < 0.66 ? C.warn : C.green; }
function campaignHealth(revenuePerDoor, activeDoors = 0) {
  if (!activeDoors) return { label:"Needs denominator", col:C.muted, severity:3 };
  if (revenuePerDoor >= 1000) return { label:"On Target", col:C.green, severity:0 };
  if (revenuePerDoor > 500) return { label:"Watch", col:C.warn, severity:1 };
  return { label:"Under Target", col:C.red, severity:2 };
}

function reportSeverityLabel(item) {
  const raw = item?.severity === "orange" ? "watch" : item?.severity || "";
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "";
}

function productIdForMetricRow(row) {
  if (row?.pid) return row.pid;
  const name = productDisplayName(row?.product || row?.name || "");
  if (!name) return "";
  const canonical = canonicalCompanyProductLabel(name) || name;
  return PRODUCTS.find(p => normalizedProductKey(p.short) === normalizedProductKey(canonical) || normalizedProductKey(p.name) === normalizedProductKey(canonical))?.id || canonical;
}




function rowMatchesCampaignScopeWithInference(row, campaignId = "", campaignMeta = {}, productMeta = {}, fallbackPid = "") {
  if (!campaignId) return true;
  const explicit = rowCampaignId(row);
  const target = campaignWithMeta(campaignId, campaignMeta, productMeta);
  const rowPid = productIdForMetricRow(row) || fallbackPid || target?.pid || "";
  const pid = target?.pid || rowPid || fallbackPid;
  if (explicit) return campaignValuesMatch(explicit, campaignId, campaignMeta, productMeta, pid);
  if (!target?.id || !row?.date) return false;
  if (target.pid && rowPid && !productValuesMatch(rowPid, target.pid, productMeta)) return false;
  if (!pid) return false;
  if (!campaignMatchesDate(target, row.date) || !campaignMatchesRowChannel(target, row)) return false;
  const matches = campaignCatalog(campaignMeta, productMeta, pid)
    .filter(camp => campaignMatchesDate(camp, row.date) && campaignMatchesRowChannel(camp, row));
  return matches.length === 1 && campaignValuesMatch(matches[0].id, target.id, campaignMeta, productMeta, pid);
}

function fullDateRange(bounds = {}) {
  return {
    start:bounds.start || DATA_START,
    end:bounds.end || DATA_END,
  };
}

function dateRangeForCampaign(campaign, bounds = {}) {
  const boundStart = bounds.start || DATA_START;
  const boundEnd = bounds.end || DATA_END;
  if (!campaign) return { start:boundStart, end:boundEnd };
  const start = campaign.start && campaign.start > boundStart ? campaign.start : boundStart;
  const campaignEnd = campaign.end || boundEnd;
  const end = campaignEnd && campaignEnd < boundEnd ? campaignEnd : boundEnd;
  return start <= end ? { start, end } : { start:end, end };
}

function averageValue(values = []) {
  const nums = values.filter(v => v !== null && v !== undefined && v !== "").map(v => Number(v)).filter(Number.isFinite);
  return nums.length ? _.sum(nums) / nums.length : 0;
}

function hasKnownNumber(value) {
  if (typeof value === "number") return Number.isFinite(value);
  let raw = String(value ?? "").trim();
  if (!raw) return false;
  raw = raw.replace(/[,$%()]/g, "").trim();
  return raw !== "" && Number.isFinite(Number(raw));
}

const EVENT_INDEX_ALL_PRODUCTS = "__all_products__";
const EVENT_INDEX_ALL_LOCATIONS = "__all_locations__";

function eventSalesProductKey(value) {
  const raw = String(value || "").trim();
  return normalizedProductKey(raw) || raw;
}

function buildEventSalesIndex(rows = []) {
  const index = new Map();
  const add = (productKey, locationKey, date, rev, units) => {
    if (!date) return;
    if (!index.has(productKey)) index.set(productKey, new Map());
    const byLocation = index.get(productKey);
    if (!byLocation.has(locationKey)) byLocation.set(locationKey, new Map());
    const byDate = byLocation.get(locationKey);
    const current = byDate.get(date) || { rev:0, units:0 };
    current.rev += rev;
    current.units += units;
    byDate.set(date, current);
  };

  rows.forEach(row => {
    const date = row.date;
    if (!date) return;
    const rev = Number(row.rev || 0);
    const units = Number(row.units || 0);
    const locationKeys = [EVENT_INDEX_ALL_LOCATIONS];
    if (row.wid) locationKeys.push(`wid:${row.wid}`);
    const productKeys = [EVENT_INDEX_ALL_PRODUCTS];
    const productKey = eventSalesProductKey(productIdForMetricRow(row));
    if (productKey) productKeys.push(productKey);
    productKeys.forEach(productKeyItem => {
      locationKeys.forEach(locationKey => add(productKeyItem, locationKey, date, rev, units));
    });
  });

  return index;
}

function sumEventSalesWindow(index, { productValue = "", wid = "", start = "", end = "" } = {}) {
  if (!start || !end) return { rev:0, units:0 };
  const productKey = productValue ? eventSalesProductKey(productValue) : EVENT_INDEX_ALL_PRODUCTS;
  const locationKey = wid ? `wid:${wid}` : EVENT_INDEX_ALL_LOCATIONS;
  const byDate = index.get(productKey)?.get(locationKey);
  if (!byDate) return { rev:0, units:0 };

  let rev = 0;
  let units = 0;
  for (let date = start; date <= end; date = offsetDate(date, 1)) {
    const row = byDate.get(date);
    if (row) {
      rev += row.rev;
      units += row.units;
    }
  }
  return { rev, units };
}

function totalRevenueDoorStats(rows, productMeta = {}, fallbackPids = [], options = {}) {
  const activeRows = (rows || []).filter(r => r.date && Number(r.rev || 0) > 0);
  const fallbackProductIds = [...new Set((fallbackPids || []).filter(Boolean))];
  const rowProductIds = [...new Set(activeRows.map(productIdForMetricRow).filter(Boolean))];
  const productIds = fallbackProductIds.length ? fallbackProductIds : rowProductIds;
  const rev = _.sumBy(activeRows, r => Number(r.rev || 0));
  const units = _.sumBy(activeRows, r => Number(r.units || 0));
  const totalWarehouses = totalWarehousesForProductIds(productIds, productMeta);
  const verifiedStats = verifiedSellingWarehouseStats(options.denominatorRows || [], options.warehouses || []);
  const weeklyStats = averageWeeklyRevenueDoorStats(activeRows, options.denominatorRows || [], options.warehouses || [], {
    start:options.start,
    end:options.end,
  });
  const activeDoors = weeklyStats.weekly.length ? verifiedStats.count : 0;
  return {
    activeDoors,
    activeDoorDate:"",
    revenuePerDoor:weeklyStats.revenuePerDoor,
    rev,
    units,
    daily:[],
    weekly:weeklyStats.weekly,
    weeklyPeriodCount:weeklyStats.weekly.length,
    productIds,
    totalWarehouses,
    verifiedWarehouseIds:verifiedStats.warehouseIds,
    formulaLabel:activeDoors ? `Average of ${weeklyStats.weekly.length.toLocaleString()} weekly Revenue / Door period${weeklyStats.weekly.length === 1 ? "" : "s"}` : "No verified weekly selling stores",
    source:activeDoors
      ? "Average Weekly Revenue / Verified Selling Stores"
      : "No verified weekly selling stores",
  };
}

function averageSevenDayRevenueDoorStats(rows, productMeta = {}, fallbackPids = [], options = {}) {
  const activeRows = (rows || []).filter(r => r.date && Number(r.rev || 0) > 0);
  const fallbackProductIds = [...new Set((fallbackPids || []).filter(Boolean))];
  const rowProductIds = [...new Set(activeRows.map(productIdForMetricRow).filter(Boolean))];
  const productIds = fallbackProductIds.length ? fallbackProductIds : rowProductIds;
  const rev = _.sumBy(activeRows, r => Number(r.rev || 0));
  const units = _.sumBy(activeRows, r => Number(r.units || 0));
  const totalWarehouses = totalWarehousesForProductIds(productIds, productMeta);
  const verifiedStats = verifiedSellingWarehouseStats(options.denominatorRows || [], options.warehouses || []);
  const weeklyStats = averageWeeklyRevenueDoorStats(activeRows, options.denominatorRows || [], options.warehouses || [], {
    start:options.start,
    end:options.end,
  });
  const activeDoors = weeklyStats.weekly.length ? verifiedStats.count : 0;
  if (!activeDoors || !activeRows.length) {
    return {
      activeDoors,
      activeDoorDate:"",
      revenuePerDoor:0,
      rev,
      units,
      daily:[],
      weekly:[],
      productIds,
      totalWarehouses,
      verifiedWarehouseIds:verifiedStats.warehouseIds,
      formulaLabel:activeDoors ? "No positive revenue rows" : "No verified weekly selling stores",
      source:activeDoors ? "Average Weekly Revenue / Door" : "No verified weekly selling stores",
    };
  }
  const byDate = _.groupBy(activeRows, "date");
  const dates = _.sortBy(Object.keys(byDate));
  const weekly = weeklyStats.weekly;
  const revenuePerDoor = weeklyStats.revenuePerDoor;
  return {
    activeDoors,
    activeDoorDate:"",
    revenuePerDoor,
    rev,
    units,
    daily:dates.map(date => ({ date, rev:_.sumBy(byDate[date] || [], r => Number(r.rev || 0)) })),
    weekly,
    productIds,
    totalWarehouses,
    verifiedWarehouseIds:verifiedStats.warehouseIds,
    formulaLabel:activeDoors ? `Average of ${weekly.length.toLocaleString()} weekly Revenue / Door period${weekly.length === 1 ? "" : "s"}` : "No verified weekly selling stores",
    source:activeDoors ? "Average Weekly Revenue / Door" : "No verified weekly selling stores",
  };
}

function positiveWarehouseDoorStats(rows, whById) {
  const locations = Object.entries(_.groupBy(rows || [], "wid")).map(([wid, groupRows]) => {
    if (!wid || wid === "undefined") return null;
    const wh = whById?.get?.(wid);
    const analysisStats = analysisWarehouseStats(groupRows, wh, { requireMeaningfulVolume:false });
    if (!analysisStats.eligible) return null;
    const rev = _.sumBy(groupRows, r => Number(r.rev || 0));
    const units = _.sumBy(groupRows, r => Math.max(0, Number(r.units || 0)));
    return { wid, rev, units };
  }).filter(Boolean);
  return {
    activeDoors:locations.length,
    rev:_.sumBy(locations, "rev"),
    units:_.sumBy(locations, "units"),
    locations,
  };
}

const INP = {
  background:C.card, border:`1px solid ${C.border}`, borderRadius:8,
  padding:"6px 9px", color:C.text, fontSize:10, ...MONO, outline:"none",
  width:"100%", boxSizing:"border-box",
};
const SELECT = {
  ...INP,
  padding:"8px 10px",
  background:C.card,
  color:C.text,
  ...SANS,
  fontSize:11,
};

// ═══════════════════════════════════════════════════════════════
const UI_LANG_STORAGE_KEY = "byou-intel-ui-language";
const UI_COPY = {
  ko: {
    "app.loading":"BYOU Intel을 불러오는 중...",
    "login.subtitle":"공유 Costco 인텔리전스 대시보드를 보려면 로그인하세요.",
    "login.team":"팀 / 사용자",
    "login.optional":"선택 사항",
    "login.password":"비밀번호",
    "login.passwordPlaceholder":"대시보드 비밀번호",
    "login.checking":"접속 권한 확인 중...",
    "login.incorrect":"로그인 정보가 올바르지 않습니다.",
    "login.failed":"로그인할 수 없습니다.",
    "login.signingIn":"로그인 중...",
    "login.signIn":"로그인",
    "lang.english":"EN",
    "lang.korean":"한국어",
    "nav.campaign":"캠페인",
    "nav.map":"지도",
    "nav.calendar":"캘린더",
    "nav.sales":"매출",
    "nav.inventory":"재고",
    "nav.analysis":"분석",
    "analysis.sectionWarehouses":"웨어하우스",
    "nav.pnl":"손익",
    "nav.videos":"영상",
    "nav.dataSources":"데이터 소스",
    "nav.logout":"로그아웃",
    "common.filters":"필터",
    "filters.viewing":"조회 중",
    "filters.clearAll":"전체 필터 해제",
    "filters.clear":"해제",
    "filters.date":"기간",
    "filters.product":"제품",
    "filters.campaign":"캠페인",
    "filters.mapProducts":"지도 제품",
    "filters.store":"매장",
    "filters.region":"지역",
    "filters.state":"주",
    "filters.inventory":"재고",
    "filters.videoType":"영상 유형",
    "filters.platform":"플랫폼",
    "filter.dateRange":"기간",
    "filter.lastWeek":"지난 7일",
    "filter.lastMonth":"지난 30일",
    "filter.selecting":"선택 중",
    "filter.startDate":"시작일",
    "filter.endDate":"종료일",
    "filter.dailyView":"일별 보기",
    "filter.weeklyView":"주별 보기",
    "filter.product":"제품",
    "filter.products":"제품",
    "filter.campaign":"캠페인",
    "filter.baselineProduct":"기준 제품",
    "filter.baselineCampaign":"기준 캠페인",
    "filter.comparisonProduct":"비교 제품",
    "filter.comparisonCampaign":"비교 캠페인",
    "filter.platform":"플랫폼",
    "filter.type":"유형",
    "filter.inventoryType":"재고 유형",
    "filter.all":"전체",
    "filter.allProducts":"전체 제품",
    "filter.allCampaigns":"전체 캠페인",
    "filter.noComparison":"비교 없음",
    "filter.allPlatforms":"전체 플랫폼",
    "filter.allVideos":"전체 영상",
    "filter.allInventory":"전체 재고",
    "filter.inline":"인라인",
    "filter.inlineStores":"인라인 매장",
    "filter.online":"온라인",
    "filter.inlineOnline":"인라인 + 온라인",
    "filter.selected":"선택됨",
    "filter.addCampaigns":"제품을 Costco 캠페인별로 나누려면 Campaigns_Master를 추가하세요.",
    "data.title":"데이터 소스",
    "data.subtitle":"팀 데이터셋을 업로드, 새로고침 또는 게시합니다",
    "data.close":"데이터 소스 닫기",
    "data.liveUrl":"실시간 데이터 URL - Google Sheets CSV",
    "data.refresh":"새로고침",
    "data.lastRefreshed":"마지막 새로고침",
    "data.autoRefresh":"30분마다 자동 새로고침",
    "data.setupLabel":"설정",
    "data.setupText":"BYOU 워크북을 직접 업로드하거나 원본 탭을 CSV로 게시하세요. Products_Master는 제품을 정의하고, Campaigns_Master는 제품별 Costco 캠페인을 정의하며, Sales_Raw는 매장 매출, Costco_Daily_Totals는 공식 인라인 합계, Paid_Videos_Raw / Seeding_Videos_Raw는 영상 데이터를 제공합니다.",
    "data.imports":"업로드 및 템플릿",
    "data.uploadWorkbook":"워크북 / CSV 업로드",
    "data.applyDailyUpdate":"\uc77c\uc77c \uc5c5\ub370\uc774\ud2b8 \uc801\uc6a9",
    "data.workbookTemplate":"워크북 템플릿",
    "data.uploadCriteo":"Paid Media Upload",
    "data.uploadVideos":"영상 업로드",
    "data.videoTemplate":"영상 템플릿",
    "data.sharedDataset":"공유 팀 데이터셋",
    "data.loadShared":"공유 데이터 불러오기",
    "data.publishCurrent":"현재 데이터 게시",
    "data.stats":"데이터 현황",
    "data.loadedStores":"불러온 매장",
    "data.activeStores":"활성 매장",
    "data.products":"제품",
    "data.campaigns":"캠페인",
    "data.salesRows":"매출 행",
    "data.inlineTotalRows":"인라인 합계 행",
    "data.onlineRows":"온라인 행",
    "data.sourceRows":"원본 행",
    "data.productRows":"제품 행",
    "data.videoRows":"영상 행",
    "data.footnotes":"메모",
    "kpi.totalRevenue":"총 매출",
    "kpi.topPerformer":"상위 성과 매장",
    "kpi.needsAttention":"점검 필요",
    "kpi.marketingEvents":"마케팅 이벤트",
    "kpi.matchedCoverage":"일치 매장 커버리지",
    "kpi.revenueDoor":"Revenue / Door",
    "kpi.storeVelocity":"매장 속도",
    "kpi.inlineSales":"인라인 매출",
    "kpi.inlineUnits":"인라인 유닛",
    "kpi.totalWarehouses":"총 웨어하우스",
    "kpi.dollarSales":"매출액",
    "kpi.unitSales":"유닛 판매",
    "kpi.availableUnits":"가용 유닛",
    "kpi.onlineUnits":"온라인 유닛",
    "kpi.sellThrough":"Sell-Through",
    "common.missing":"누락",
    "common.notAvailable":"N/A",
    "common.exportCsv":"CSV 내보내기",
    "common.searchWarehouses":"웨어하우스 검색",
    "common.searchCoverage":"커버리지 검색",
    "common.searchStores":"매장 검색",
    "common.noStoreMatches":"이 검색어 또는 제품 필터와 일치하는 매장이 없습니다.",
    "common.clearStore":"매장 선택 해제",
    "common.matches":"개 일치",
    "common.showTop":"상위 보기",
    "common.showAll":"전체 보기",
    "common.collapse":"접기",
    "common.expand":"펼치기",
    "common.copy":"복사",
    "common.retry":"다시 시도",
    "common.clear":"지우기",
    "common.send":"보내기",
    "common.thinking":"생각 중...",
    "common.leftAxis":"왼쪽 축",
    "common.rightAxis":"오른쪽 축",
    "common.unitsOnHand":"보유 유닛",
    "common.postedInRange":"선택 기간 내 게시",
    "common.startedInRange":"선택 기간 내 시작",
    "common.videos":"영상",
    "common.events":"이벤트",
    "common.units":"유닛",
    "common.noMinimum":"최소 없음",
    "common.revenue":"매출",
    "common.status":"상태",
    "common.share":"비중",
    "common.location":"위치",
    "common.warehouse":"웨어하우스",
    "nav.filters":"필터",
    "data.ppcRows":"Paid media rows",
    "data.parsing":"업로드 분석 중...",
    "data.parsingHint":"큰 워크북은 시간이 걸릴 수 있습니다. 탭을 닫지 마세요.",
    "data.publishTitle":"팀 전체에 게시할까요?",
    "data.publishBody":"모두가 불러오는 공유 팀 데이터셋을 덮어씁니다.",
    "data.lastPublished":"마지막 게시",
    "data.publishToken":"관리자 게시 토큰",
    "data.publishConfirm":"게시",
    "status.loadingData":"\ub370\uc774\ud130\ub97c \ubd88\ub7ec\uc624\ub294 \uc911...",
    "status.dataLoadComplete":"\ub370\uc774\ud130 \ubd88\ub7ec\uc624\uae30\uac00 \uc644\ub8cc\ub418\uc5c8\uc2b5\ub2c8\ub2e4.",
    "common.cancel":"취소",
    "common.source":"출처",
    "common.paidMedia":"Paid media",
    "common.needsHistory":"기록이 더 필요합니다",
    "inventory.sellThroughHint":"판매 유닛 / (판매 유닛 + 보유 유닛). 60% 이상 녹색, 35~60% 주의, 35% 미만 적색.",
    "filter.sharedWithCampaign":"이 기간은 캠페인 / 분석 탭과 공유됩니다.",
    "map.velocityHint":"현재 지도 범위에서 활성 매장당 일평균 판매 유닛",
    "analysis.pacing":"페이싱 & 계획",
    "analysis.affinity":"판매 친화도",
    "analysis.affinityTitle":"캠페인 판매 친화도",
    "analysis.affinityWarehouseReading":"\uc6e8\uc5b4\ud558\uc6b0\uc2a4 \ub9ac\ub529",
    "analysis.affinityLeader":"\uc120\ub3c4 \uc6e8\uc5b4\ud558\uc6b0\uc2a4",
    "analysis.affinityWatch":"\uad00\ucc30 \ud544\uc694 \uc6e8\uc5b4\ud558\uc6b0\uc2a4",
    "analysis.demographics":"시장 인구통계",
    "analysis.comparison":"비교",
    "analysis.events":"이벤트 영향",
    "login.enterTeam":"팀 / 사용자 로그인을 입력하세요.",
  },
};

const UI_LABELS_KO = {
  "Campaign":"캠페인",
  "Map":"지도",
  "Calendar":"캘린더",
  "Sales":"매출",
  "Inventory":"재고",
  "Analysis":"분석",
  "Videos":"영상",
  "Data Sources":"데이터 소스",
  "Product":"제품",
  "Products":"제품",
  "Category":"카테고리",
  "All":"전체",
  "All Products":"전체 제품",
  "All Campaigns":"전체 캠페인",
  "All Platforms":"전체 플랫폼",
  "All Videos":"전체 영상",
  "All Inventory":"전체 재고",
  "Inline Stores":"인라인 매장",
  "Online":"온라인",
  "Inline + Online":"인라인 + 온라인",
  "Date":"기간",
  "Region":"지역",
  "State":"주",
  "Store":"매장",
  "Stores":"매장",
  "All Stores":"전체 매장",
  "All Regions":"전체 지역",
  "All States":"전체 주",
  "Platform":"플랫폼",
  "Type":"유형",
  "Video Type":"영상 유형",
  "Total Revenue":"총 매출",
  "Top Performer":"상위 성과 매장",
  "Needs Attention":"점검 필요",
  "Marketing Events":"마케팅 이벤트",
  "Matched Coverage":"일치 매장 커버리지",
  "Revenue / Door":"Revenue / Door",
  "7-Day Avg Revenue / Door":"Revenue / Door",
  "Avg 7-Day $/Door":"Revenue / Door",
  "Store Velocity":"매장 속도",
  "Inline Sales":"인라인 매출",
  "Inline Units":"인라인 유닛",
  "Total Warehouses":"총 웨어하우스",
  "Dollar Sales":"매출액",
  "Unit Sales":"유닛 판매",
  "Available Units":"가용 유닛",
  "Online Units":"온라인 유닛",
  "Sell-Through":"Sell-Through",
  "Revenue":"매출",
  "Online Revenue":"온라인 매출",
  "Units Sold":"판매 유닛",
  "Revenue Lift":"매출 리프트",
  "Product Mix":"제품 믹스",
  "Tracked Events":"추적 이벤트",
  "Comparable":"비교 가능",
  "Positive Lift":"긍정 리프트",
  "Sales Drag":"매출 하락",
  "Impact by Type":"유형별 영향",
  "Generated Read":"자동 분석",
  "Baseline Product":"기준 제품",
  "Compare Against":"비교 제품",
  "Breakdown":"분류",
  "Metric":"지표",
  "Normalize":"정규화",
  "Min Units":"최소 유닛",
  "Region Filter":"지역 필터",
  "State Filter":"주 필터",
  "Start":"시작",
  "End":"종료",
  "Delta":"차이",
  "Matched Warehouses":"일치 웨어하우스",
  "Buckets Ahead":"우위 버킷",
  "Winner":"우세",
  "Units":"유닛",
  "Status":"상태",
  "Share":"비중",
  "Location":"위치",
  "Warehouse":"웨어하우스",
  "Scope":"범위",
  "Last Updated":"마지막 업데이트",
  "Last Known Sale":"마지막 판매일",
  "Reported Inventory":"보고된 재고",
  "Review Level":"검토 수준",
  "Reason":"사유",
  "Action":"작업",
  "Sold Units":"판매 유닛",
  "Avg Weekly":"주간 평균",
  "Warehouse Performance":"웨어하우스별 성과",
  "Campaign Activity":"캠페인 활동",
  "Campaign Portfolio":"캠페인 포트폴리오",
  "Product Portfolio":"제품 포트폴리오",
  "Inline Sales Trend":"인라인 매출 추이",
  "Inline Inventory Flow":"인라인 재고 흐름",
  "Inline Inventory":"인라인 재고",
  "Online Sales":"온라인 매출",
  "Online Orders":"온라인 주문",
  "Online Channels":"온라인 채널",
  "Online Inventory":"온라인 재고",
  "Online Inventory Flow":"온라인 재고 흐름",
  "Online Sales Flow":"온라인 판매 흐름",
  "Online-only":"온라인 전용",
  "Inline-only metric":"인라인 전용 지표",
  "Inventory Flow":"재고 흐름",
  "Daily Online Sales Trend":"일별 온라인 매출 추이",
  "Inventory Upload Blueprint":"재고 업로드 설계",
  "Costco Store Performance Map — United States":"Costco 매장 성과 지도 - 미국",
  "Report Flags":"리포트 플래그",
  "Observed Days":"관측 일수",
  "Avg Daily Sales":"평균 일일 매출",
  "First 14 Days":"첫 14일",
  "30-Day Projection":"30일 예상",
  "Full-Window Projection":"전체 기간 예상",
  "Inventory Days":"재고 일수",
  "Sell-Through Read":"재고 소진 리드",
  "Sales Target":"매출 목표",
  "Paid Video Target":"유료 영상 목표",
  "Seeding Video Target":"시딩 영상 목표",
  "Launch Bar":"런칭 기준",
  "Planning Actions":"계획 액션",
  "Future Campaign Inputs":"향후 캠페인 입력값",
  "Store Planning Priorities":"매장 계획 우선순위",
  "Campaign Pacing Comparison":"캠페인 페이싱 비교",
  "Pace Snapshot":"페이스 스냅샷",
  "Event Impact Report - TPD / Markdown / Promo Lift":"이벤트 영향 리포트 - TPD / 마크다운 / 프로모션 리프트",
  "Product Comparison Histogram":"제품 비교 히스토그램",
  "Metric Change":"지표 변화",
  "Clear all filters":"전체 필터 해제",
  "Export CSV":"CSV 내보내기",
  "Copy":"복사",
  "Retry":"다시 시도",
  "Clear":"지우기",
  "Send":"보내기",
  "Thinking...":"생각 중...",
  "Collapse":"접기",
  "Expand":"펼치기",
  "On Target":"목표 달성",
  "Watch":"주의",
  "Under Target":"목표 미달",
  "Needs denominator":"분모 필요",
  "Critical":"위험",
  "Healthy":"양호",
  "Sold Through":"완판",
  "Sold Out":"품절",
  "No Movement":"판매 없음",
  "Costco Daily Totals":"Costco 일별 합계",
  "Warehouse Master":"웨어하우스 마스터",
  "Warehouse Sales":"웨어하우스 매출",
  "Warehouse rows - filtered scope":"웨어하우스 행 - 필터 범위",
  "Campaign Pacing Comparison - First 120 Days":"캠페인 페이싱 비교 - 첫 120일",
  "Campaign Pacing Comparison - First 120 Active-Sales Days":"캠페인 페이싱 비교 - 첫 120 활성 판매일",
  "Inline Inventory - At-Risk Store Coverage":"인라인 재고 - 위험 매장 커버리지",
  "Inline Inventory - Store Coverage":"인라인 재고 - 매장 커버리지",
  "Online Inventory - Channel Coverage":"온라인 재고 - 채널 커버리지",
  "Demo":"데모",
  "Promo":"프로모션",
  "Issue":"이슈",
  "Seasonal":"시즌",
  "Markdown":"마크다운",
  "Other":"기타",
  "Sales Activity":"매출 활동",
  "Video Post":"영상 게시",
  "Positive lift":"상승",
  "Sales drag":"하락",
  "Flat":"보합",
  "No baseline":"기준 없음",
  "Pending / no sales":"대기 / 판매 없음",
  "Baseline Campaign":"기준 캠페인",
  "Comparison Campaign":"비교 캠페인",
  "PPC Sales":"PPC 매출",
  "PPC Spend":"PPC 지출",
  "Impressions":"노출수",
  "Missed Opportunity":"놓친 기회",
  "Pacing & Planning":"페이싱 & 계획",
  "Comparison":"비교",
  "Event Impact":"이벤트 영향",
};

function translateUiText(lang, key, fallback = "") {
  if (lang !== "ko") return fallback;
  return UI_COPY.ko[key] || UI_LABELS_KO[fallback] || fallback;
}

function translateLabel(lang, value) {
  if (lang !== "ko" || typeof value !== "string") return value;
  const exact = UI_LABELS_KO[value];
  if (exact) return exact;
  return value
    .replace(/^Costco Store Performance Map\s*[—-]\s*United States/, "Costco 매장 성과 지도 - 미국")
    .replace(/^Inline Daily Sales Trend/, "인라인 일별 매출 추이")
    .replace(/^Daily Online Sales Trend/, "일별 온라인 매출 추이")
    .replace(/^Inventory Flow/, "재고 흐름")
    .replace(/^Report Flags/, "리포트 플래그")
    .replace(/^Videos - sorted by/, "영상 - 정렬 기준")
    .replace(/^Videos Uploaded by Brand/, "브랜드별 업로드 영상")
    .replace(/^Warehouse Performance/, "웨어하우스별 성과")
    .replace(/^Master Calendar/, "마스터 캘린더")
    .replace(/^Calendar Activity/, "캘린더 활동")
    .replace(/^Event Impact Report - TPD \/ Markdown \/ Promo Lift/, "이벤트 영향 리포트 - TPD / 마크다운 / 프로모션 리프트")
    .replace(/^Product Comparison Histogram/, "제품 비교 히스토그램")
    .replace(/^Metric Change/, "지표 변화")
    .replace(/^(.+) Over Time/, "$1 시간별 추이")
    .replace(/^Campaign Activity/, "캠페인 활동")
    .replace(/^Campaign Portfolio/, "캠페인 포트폴리오")
    .replace(/^Product Portfolio/, "제품 포트폴리오")
    .replace(/^Inline Sales Trend/, "인라인 매출 추이")
    .replace(/^Inline Inventory Flow/, "인라인 재고 흐름")
    .replace(/^Inventory Upload Blueprint/, "재고 업로드 설계");
}



function LanguageToggle({ lang, setLang, dark = false, muted = false, style = {} }) {
  const { t } = useUiText();
  const options = [
    ["en", t("lang.english", "EN")],
    ["ko", t("lang.korean", "한국어")],
  ];
  return (
    <div role="group" aria-label="Language" style={{ display:"inline-flex", alignItems:"center", gap:2, background:muted ? "transparent" : dark ? "rgba(255,255,255,0.08)" : C.bg, border:muted ? "none" : `1px solid ${dark ? "rgba(255,255,255,0.14)" : C.border}`, borderRadius:6, padding:muted ? 0 : 3, ...style }}>
      {options.map(([key, text]) => {
        const active = lang === key;
        return (
          <button key={key} type="button" onClick={() => setLang(key)} style={{ border:"none", borderRadius:5, background:active ? (muted ? C.card : dark ? "#FFFFFF" : C.accent) : "transparent", color:active ? (muted ? C.text : dark ? C.nav : "#FFFFFF") : (dark ? C.navText : C.muted), opacity:active ? 1 : 0.78, cursor:"pointer", padding:"5px 8px", fontSize:11, fontWeight:active ? 500 : 300, ...SANS, flex:muted ? 1 : "0 0 auto" }}>
            {text}
          </button>
        );
      })}
    </div>
  );
}

// SHARED UI
// ═══════════════════════════════════════════════════════════════

function SmBtn({ children, onClick, active = false, disabled = false, type = "button", style = {} }) {
  return (
    <button type={type} onClick={onClick} disabled={disabled} style={{ padding:"6px 10px", borderRadius:5, border:`1px solid ${active ? C.accent : C.border}`, background:active ? C.accent : C.card, color:active ? "#FFFFFF" : disabled ? "#AAB4C0" : C.text, cursor:disabled ? "default" : "pointer", fontSize:11, ...SANS, fontWeight:500, boxShadow:"none", ...style }}>
      {children}
    </button>
  );
}
function StatusChip({ label, col = C.muted }) {
  const { label:uiLabel } = useUiText();
  return <span style={{ color:col, border:`1px solid ${col}44`, background:`${col}14`, borderRadius:5, padding:"3px 7px", ...MONO, fontSize:10, whiteSpace:"nowrap" }}>{uiLabel(label)}</span>;
}
function SourceTag({ children, title }) {
  const { t } = useUiText();
  return (
    <span title={title} style={{ display:"inline-flex", alignItems:"center", gap:5, ...MONO, fontSize:10, color:C.muted, background:C.bg, border:`1px solid ${C.border}`, borderRadius:999, padding:"3px 8px", whiteSpace:"nowrap" }}>
      <span style={{ width:6, height:6, borderRadius:"50%", background:C.blue, display:"inline-block" }}/>
      {t("common.source", "Source")}: {children}
    </span>
  );
}
function LoginScreen({ onLogin, usernameRequired = false, initialMessage = "" }) {
  const [lang, setLang] = useState(() => {
    try { return localStorage.getItem(UI_LANG_STORAGE_KEY) || "en"; } catch { return "en"; }
  });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState({ state:initialMessage ? "error" : "idle", message:initialMessage });
  const t = useCallback((key, fallback = "") => translateUiText(lang, key, fallback), [lang]);
  const label = useCallback(value => translateLabel(lang, value), [lang]);
  const langContext = useMemo(() => ({ lang, setLang, t, label }), [lang, t, label]);

  useEffect(() => {
    try { localStorage.setItem(UI_LANG_STORAGE_KEY, lang); } catch {}
  }, [lang]);

  const submit = async e => {
    e.preventDefault();
    if (!password.trim() || status.state === "loading") return;
    if (usernameRequired && !username.trim()) {
      setStatus({ state:"error", message:t("login.enterTeam", "Enter the team / user login.") });
      return;
    }
    setStatus({ state:"loading", message:t("login.checking", "Checking access...") });
    try {
      const res = await fetch("/api/login", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body:JSON.stringify({ username, password }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || t("login.incorrect", "Incorrect login."));
      setStatus({ state:"loaded", message:"" });
      onLogin?.();
    } catch (error) {
      setStatus({ state:"error", message:error.message || t("login.failed", "Could not log in.") });
    }
  };

  return (
    <LanguageContext.Provider value={langContext}>
      <div style={{ minHeight:"100vh", display:"grid", placeItems:"center", background:`linear-gradient(135deg, ${C.nav} 0%, #082B44 52%, #F8FAFC 52%, #F8FAFC 100%)`, padding:24, ...SANS }}>
        <form onSubmit={submit} style={{ width:"min(420px, 100%)", background:C.card, border:`1px solid ${C.border}`, borderRadius:12, boxShadow:"0 28px 80px rgba(15,23,42,0.24)", padding:"30px 24px 24px" }}>
        <div style={{ marginBottom:24 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, marginBottom:18 }}>
            <strong>BYOU Intel</strong>
            <LanguageToggle lang={lang} setLang={setLang}/>
          </div>
          <div style={{ fontSize:12, color:C.muted, lineHeight:1.6 }}>{t("login.subtitle", "Sign in to view the shared Costco intelligence dashboard.")}</div>
        </div>
        <label style={{ display:"block", fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>{t("login.team", "Team / user")}</label>
        <input value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" required={usernameRequired} placeholder={usernameRequired ? t("login.required", "Required") : t("login.optional", "Optional")} style={{ ...INP, fontSize:13, padding:"10px 12px", marginBottom:12 }}/>
        <label style={{ display:"block", fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>{t("login.password", "Password")}</label>
        <input value={password} onChange={e=>setPassword(e.target.value)} type="password" autoComplete="current-password" placeholder={t("login.passwordPlaceholder", "Dashboard password")} style={{ ...INP, fontSize:13, padding:"10px 12px", marginBottom:14 }}/>
        {status.message && <div style={{ marginBottom:12, color:status.state === "error" ? C.red : C.muted, fontSize:11, lineHeight:1.5 }}>{status.message}</div>}
        <button type="submit" disabled={!password.trim() || status.state === "loading"} style={{ width:"100%", border:"none", borderRadius:9, padding:"11px 14px", background:password.trim() && status.state !== "loading" ? C.accent : C.border, color:"#FFFFFF", fontWeight:500, cursor:password.trim() && status.state !== "loading" ? "pointer" : "default", ...SANS }}>
          {status.state === "loading" ? t("login.signingIn", "Signing in...") : t("login.signIn", "Sign in")}
        </button>
      </form>
      </div>
    </LanguageContext.Provider>
  );
}

function AuthGate({ children }) {
  const [session, setSession] = useState({ state:"loading", authenticated:false, required:false, usernameRequired:false, error:"" });
  const refreshSession = useCallback(async () => {
    try {
      const res = await fetch("/api/session", { cache:"no-store" });
      if (res.status === 404) {
        throw new Error("Authentication server is unavailable.");
      }
      const payload = await res.json().catch(() => null);
      if (!res.ok || !payload) throw new Error("Session check failed.");
      setSession({
        state:"ready",
        authenticated:!!payload.authenticated,
        required:payload.required !== false,
        usernameRequired:!!payload.usernameRequired,
        error:payload.error || "",
      });
    } catch (error) {
      setSession({
        state:"ready",
        authenticated:false,
        required:true,
        usernameRequired:false,
        error:error.message || "Could not verify login. Contact the dashboard administrator.",
      });
    }
  }, []);
  useEffect(() => { refreshSession(); }, [refreshSession]);
  useEffect(() => {
    // Any protected request that returns 401 re-gates the app instead of leaving
    // the dashboard showing "data failed" until the next manual reload.
    const onExpired = () => setSession(previous => ({
      ...previous,
      state:"ready",
      authenticated:false,
      required:true,
      error:previous.error || "Your login session expired. Sign in again to continue.",
    }));
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);
  if (session.state === "loading") {
    let lang = "en";
    try { lang = localStorage.getItem(UI_LANG_STORAGE_KEY) || "en"; } catch {}
    return <div style={{ minHeight:"100vh", display:"grid", placeItems:"center", background:C.bg, color:C.muted, ...SANS }}>{translateUiText(lang, "app.loading", "Loading BYOU Intel...")}</div>;
  }
  if (session.required && !session.authenticated) return <LoginScreen onLogin={refreshSession} usernameRequired={session.usernameRequired} initialMessage={session.error}/>;
  return children;
}

function logoutAndReload() {
  fetch("/api/logout", { method:"POST" }).finally(() => window.location.reload());
}

function shortDateRangeLabel(range = {}) {
  const startRaw = String(range.start || "");
  const endRaw = String(range.end || "");
  const sameYear = startRaw.slice(0, 4) === endRaw.slice(0, 4);
  const start = (sameYear ? startRaw.slice(5) : startRaw) || "Start";
  const end = (sameYear ? endRaw.slice(5) : endRaw) || "End";
  return `${start} to ${end}`;
}

function ActiveFilterBar({ chips = [], onClearAll }) {
  const { t, label } = useUiText();
  return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, flexWrap:"wrap", background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:"9px 11px", marginBottom:14, boxShadow:"0 1px 2px rgba(15,23,42,0.04)" }}>
      <div style={{ display:"flex", alignItems:"center", gap:7, flexWrap:"wrap", minWidth:0 }}>
        <span style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1 }}>{t("filters.viewing", "Viewing")}</span>
        {chips.map(chip => (
          <button key={chip.key} onClick={chip.onClear} disabled={!chip.onClear} title={chip.onClear ? `${t("filters.clear", "Clear")} ${label(chip.label)}` : label(chip.label)} style={{ display:"inline-flex", alignItems:"center", gap:6, border:`1px solid ${chip.strong ? C.accent+"66" : C.border}`, background:chip.strong ? C.accentFade : C.bg, color:chip.strong ? C.accent : C.text, borderRadius:999, padding:"5px 8px", fontSize:10, lineHeight:1, cursor:chip.onClear ? "pointer" : "default", maxWidth:260, ...SANS }}>
            <span style={{ color:C.muted }}>{label(chip.label)}:</span>
            <span style={{ fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{chip.value}</span>
            {chip.onClear && <span style={{ color:C.muted, fontWeight:500 }}>x</span>}
          </button>
        ))}
      </div>
      {onClearAll && (
        <button onClick={onClearAll} style={{ border:`1px solid ${C.border}`, background:C.bg, color:C.muted, borderRadius:8, padding:"5px 9px", fontSize:10, cursor:"pointer", ...SANS, fontWeight:500 }}>
          {t("filters.clearAll", "Clear all filters")}
        </button>
      )}
    </div>
  );
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}


function safeLiveCsvUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    const isGoogleSheetCsv =
      parsed.protocol === "https:" &&
      parsed.hostname === "docs.google.com" &&
      parsed.pathname.startsWith("/spreadsheets/d/") &&
      parsed.searchParams.get("output") === "csv";
    return isGoogleSheetCsv ? parsed.href : "";
  } catch {
    return "";
  }
}

function downloadRowsCsv(filename, columns, rows) {
  const header = columns.map(col => csvCell(col.label)).join(",");
  const body = rows.map(row => columns.map(col => csvCell(typeof col.value === "function" ? col.value(row) : row[col.value])).join(",")).join("\n");
  const blob = new Blob([[header, body].filter(Boolean).join("\n")], { type:"text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sortedRows(rows, sortKey, sortDir = "desc") {
  if (!sortKey) return rows;
  const dir = sortDir === "asc" ? "asc" : "desc";
  return _.orderBy(rows, [row => {
    const value = typeof sortKey === "function" ? sortKey(row) : row[sortKey];
    return typeof value === "string" ? value.toLowerCase() : Number.isFinite(Number(value)) ? Number(value) : value;
  }], [dir]);
}

function Badge({ type }) {
  const { label } = useUiText();
  const typeInfo = FN_TYPES[type] || FN_TYPES.other;
  return (
    <span style={{ fontSize:10, ...MONO, color:typeInfo.col, background:`${typeInfo.col}16`, border:`1px solid ${typeInfo.col}30`, padding:"3px 7px", borderRadius:999, letterSpacing:0.2, whiteSpace:"nowrap" }}>{label(typeInfo.label)}</span>
  );
}
function TT({ active, payload, label, col = C.accent }) {
  const { label:uiLabel } = useUiText();
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload || {};
  const notes = point.notes || [];
  const visibleNotes = notes.slice(0, 2);
  const revenueEntry = payload.find(p => p.dataKey === "rev") || payload[0];
  const promoEntry = payload.find(p => p.dataKey === "promoPlot" && Number(p.value || 0) > 0);
  const rows = [
    { label:"Revenue", value:fmtCurrency(revenueEntry?.value || 0), color:col, strong:true },
    Number(point.units || 0) > 0 ? { label:"Units", value:Number(point.units || 0).toLocaleString(), color:C.text } : null,
    promoEntry ? { label:"Promoted", value:fmtCurrency(promoEntry.value || 0), color:C.green } : null,
    Number(point.orders || 0) > 0 ? { label:"Orders", value:Number(point.orders || 0).toLocaleString(), color:C.text } : null,
  ].filter(Boolean);
  return (
    <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:"10px 12px", fontSize:11, ...SANS, minWidth:190, maxWidth:270, boxShadow:"0 18px 44px rgba(15,23,42,0.14)" }}>
      <div style={{ ...MONO, color:C.muted, fontSize:10, textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>{point.date || label}</div>
      {rows.map(row => (
        <div key={row.label} style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", gap:18, marginTop:row.strong ? 0 : 5 }}>
          <span style={{ color:C.muted }}>{uiLabel(row.label)}</span>
          <span style={{ ...MONO, color:row.color, fontWeight:row.strong ? 800 : 700 }}>{row.value}</span>
        </div>
      ))}
      {notes.length > 0 && (
        <div style={{ borderTop:`1px solid ${C.border}`, marginTop:9, paddingTop:8 }}>
          <div style={{ ...MONO, color:C.muted, fontSize:10, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>Context</div>
          {visibleNotes.map((note, i) => (
            <div key={`${note.type}-${i}`} style={{ display:"grid", gridTemplateColumns:"8px minmax(0,1fr)", gap:8, alignItems:"start", fontSize:10, color:C.text, lineHeight:1.45, marginBottom:i === visibleNotes.length - 1 ? 0 : 6 }}>
              <span style={{ width:7, height:7, borderRadius:"50%", background:note.col || C.accent, marginTop:4 }}/>
              <span><span style={{ ...MONO, color:note.col || C.accent, fontSize:10, marginRight:5 }}>{note.label || "NOTE"}</span>{note.preview}</span>
            </div>
          ))}
          {notes.length > visibleNotes.length && <div style={{ ...MONO, color:C.muted, fontSize:10, marginTop:6 }}>+{notes.length - visibleNotes.length} more</div>}
        </div>
      )}
    </div>
  );
}

function trimPreview(text, max = 58) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function chartNote(fn, max = 58) {
  const type = FN_TYPES[fn.type] || FN_TYPES.other;
  const raw = [fn.title, fn.body].filter(Boolean).join(" - ") || type.label || "Calendar note";
  return { ...fn, label:type.short || "NOTE", col:type.col || C.accent, preview:trimPreview(raw, max), fullPreview:raw };
}

// ─── Sidebar date filter (compact, vertical) ─────────────────

function SidebarDateFilter({ dateRange, setDateRange, minDate = DATA_START, maxDate = DATA_END }) {
  const { lang, t } = useUiText();
  const [monthKey, setMonthKey] = useState((dateRange.end || maxDate).slice(0,7));
  const [pickMode, setPickMode] = useState("start");
  const rangeMonthKey = (dateRange.end || maxDate).slice(0,7);
  useEffect(() => {
    setMonthKey(rangeMonthKey);
  }, [rangeMonthKey]);
  const PRESETS = [
    { l:"7D",  s:offsetDate(maxDate,-6) },
    { l:"30D", s:offsetDate(maxDate,-29)},
    { l:"MTD", s:`${maxDate.slice(0,8)}01` },
    { l:t("filter.all", "All"), s:minDate },
  ];
  const days = inclusiveDays(dateRange.start, dateRange.end);
  const [year, month] = monthKey.split("-").map(Number);
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstDow = monthStart.getUTCDay();
  const cells = [
    ...Array(firstDow).fill(null),
    ...Array.from({length:daysInMonth}, (_, i) => `${monthKey}-${String(i + 1).padStart(2,"0")}`),
  ];
  while (cells.length % 7) cells.push(null);
  const moveMonth = delta => {
    const next = new Date(Date.UTC(year, month - 1 + delta, 1));
    const nextKey = dateKey(next).slice(0,7);
    if (nextKey >= minDate.slice(0,7) && nextKey <= maxDate.slice(0,7)) setMonthKey(nextKey);
  };
  const applyPreset = preset => {
    setDateRange({ start:preset.s, end:maxDate });
    setMonthKey(maxDate.slice(0,7));
    setPickMode("start");
  };
  const chooseDate = date => {
    if (!date || date < minDate || date > maxDate) return;
    setDateRange(r => {
      if (pickMode === "start") return { start:date, end:date > r.end ? date : r.end };
      return date < r.start ? { start:date, end:r.start } : { ...r, end:date };
    });
    setPickMode(p => p === "start" ? "end" : "start");
  };
  return (
    <div style={{ padding:"10px 12px 12px", borderBottom:`1px solid ${C.border}` }}>
      <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>{t("filter.dateRange", "Date Range")}</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:3, marginBottom:7 }}>
        {PRESETS.map(p => {
          const isOn = dateRange.start === p.s && dateRange.end === maxDate;
          return (
            <button key={p.l} onClick={() => applyPreset(p)} style={{ padding:"4px 0", borderRadius:4, border:`1px solid ${isOn?C.accent+"55":C.border}`, background:isOn?C.accentFade:"transparent", color:isOn?C.accent:C.muted, cursor:"pointer", fontSize:10, ...SANS, fontWeight:isOn?600:400 }}>
              {p.l}
            </button>
          );
        })}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:4, marginBottom:8 }}>
        <input type="date" value={dateRange.start} min={minDate} max={dateRange.end}
          onChange={e => { setDateRange(r => ({...r,start:e.target.value})); setMonthKey(e.target.value.slice(0,7)); setPickMode("end"); }} style={INP}/>
        <input type="date" value={dateRange.end} min={dateRange.start} max={maxDate}
          onChange={e => { setDateRange(r => ({...r,end:e.target.value})); setMonthKey(e.target.value.slice(0,7)); setPickMode("start"); }} style={INP}/>
      </div>
      <div style={{ border:`1px solid ${C.border}`, borderRadius:7, background:C.bg, padding:7 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
          <button onClick={() => moveMonth(-1)} style={{ width:22, height:22, borderRadius:5, border:`1px solid ${C.border}`, background:"transparent", color:C.muted, cursor:"pointer" }}>{"<"}</button>
          <div style={{ ...MONO, fontSize:10, color:C.text }}>{MONTHS[month - 1]} {year}</div>
          <button onClick={() => moveMonth(1)} style={{ width:22, height:22, borderRadius:5, border:`1px solid ${C.border}`, background:"transparent", color:C.muted, cursor:"pointer" }}>{">"}</button>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2, marginBottom:3 }}>
          {DAYS.map(d => <div key={d} style={{ textAlign:"center", fontSize:9, color:C.muted, ...MONO }}>{d[0]}</div>)}
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2 }}>
          {cells.map((date, i) => {
            const disabled = !date || date < minDate || date > maxDate;
            const selected = date === dateRange.start || date === dateRange.end;
            const inRange = date && date > dateRange.start && date < dateRange.end;
            return (
              <button key={`${date || "blank"}-${i}`} disabled={disabled} onClick={() => chooseDate(date)}
                style={{ height:22, borderRadius:4, border:`1px solid ${selected?C.accent+"77":"transparent"}`, background:selected?C.accentFade:inRange?"rgba(232,160,32,0.06)":"transparent", color:disabled?C.subtle:selected?C.accent:C.text, cursor:disabled?"default":"pointer", fontSize:10, ...MONO, padding:0 }}>
                {date ? Number(date.slice(8)) : ""}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize:10, color:C.muted, marginTop:5 }}>
          {t("filter.selecting", "Selecting")}: <span style={{ color:C.accent }}>{pickMode === "start" ? t("filter.startDate", "start date") : t("filter.endDate", "end date")}</span>
        </div>
      </div>
      <div style={{ fontSize:10, color:C.muted, marginTop:5, textAlign:"right" }}>
        {days} {lang === "ko" ? "일" : `day${days!==1?"s":""}`} · {days<=14 ? t("filter.dailyView", "daily view") : t("filter.weeklyView", "weekly view")}
      </div>
    </div>
  );
}

// ─── Sidebar product filter ───────────────────────────────────

function CampaignChannelSelect({ value, onChange, style }) {
  const { t } = useUiText();
  return <select value={value} onChange={event => onChange(event.target.value)} style={style}>
    <option value="inline">{t("filter.inline", "Inline")}</option>
    <option value="online">{t("filter.online", "Online")}</option>
  </select>;
}

function InventoryCampaignSelect({ channel, campaignId, campaigns = [], productMeta = {}, onChangeChannel, onChangeCampaign, style }) {
  const { t } = useUiText();
  const value = campaignId ? `campaign:${campaignId}` : `channel:${channel}`;
  const handleChange = event => {
    const next = event.target.value;
    if (next.startsWith("campaign:")) onChangeCampaign(next.slice("campaign:".length));
    else onChangeChannel(next.slice("channel:".length));
  };
  return <select value={value} onChange={handleChange} style={style}>
    <optgroup label={t("filter.channelViews", "Channel Views")}>
      <option value="channel:inline">{t("filter.inline", "Inline")}</option>
      <option value="channel:online">{t("filter.online", "Online")}</option>
    </optgroup>
    {campaigns.length > 0 && <optgroup label={t("filter.namedCampaigns", "Named Campaigns")}>
      {campaigns.map(campaign => <option key={campaign.id} value={`campaign:${campaign.id}`}>{[productLabelForValue(campaign.pid, productMeta), campaign.short || campaign.name, campaignDateWindowLabel(campaign)].filter(Boolean).join(" / ")}</option>)}
    </optgroup>}
  </select>;
}

function SidebarProductFilter({ selPid, setSelPid, showAll = false, label = "Product", products = PRODUCTS }) {
  const { label:uiLabel, t } = useUiText();
  return (
    <div style={{ padding:"10px 12px 12px", borderBottom:`1px solid ${C.border}` }}>
      <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>{uiLabel(label)}</div>
      <select value={selPid} onChange={e => setSelPid(e.target.value)} style={SELECT}>
        {showAll && <option value="">{t("filter.allProducts", "All Products")}</option>}
        {products.map(p => <option key={p.id} value={p.id}>{p.short}</option>)}
      </select>
    </div>
  );
}

function SidebarProductMultiFilter({ selPids, setSelPids, label = "Campaigns", products = PRODUCTS }) {
  const { label:uiLabel, t } = useUiText();
  const selected = new Set(selPids || []);
  const toggleProduct = id => {
    setSelPids(prev => prev.includes(id) ? prev.filter(pid => pid !== id) : prev.length >= 2 ? [prev[1], id] : [...prev, id]);
  };
  return (
    <div style={{ padding:"10px 12px 12px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8, marginBottom:7 }}>
        <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1 }}>{uiLabel(label)}</div>
        <div style={{ fontSize:10, color:C.muted }}>{selected.size ? `${selected.size}/2 ${t("filter.selected", "selected")}` : t("filter.all", "All")}</div>
      </div>
      <button onClick={() => setSelPids([])} style={{ width:"100%", padding:"6px 8px", borderRadius:7, border:`1px solid ${!selected.size ? C.accent+"66" : C.border}`, background:!selected.size ? C.accentFade : C.card, color:!selected.size ? C.accent : C.text, cursor:"pointer", fontSize:11, ...SANS, fontWeight:500, textAlign:"left", marginBottom:7 }}>
        {t("filter.all", "All")} {uiLabel(label)}
      </button>
      <div style={{ display:"flex", flexDirection:"column", gap:5, maxHeight:250, overflowY:"auto", paddingRight:2 }}>
        {products.map(p => {
          const active = selected.has(p.id);
          return (
            <button key={p.id} data-product-id={p.id} data-selected={active ? "true" : "false"} onClick={() => toggleProduct(p.id)} style={{ display:"grid", gridTemplateColumns:"12px minmax(0,1fr) 14px", alignItems:"center", gap:7, width:"100%", padding:"6px 7px", borderRadius:7, border:`1px solid ${active ? p.col+"66" : C.border}`, background:active ? `${p.col}14` : C.card, color:C.text, cursor:"pointer", fontSize:10, ...SANS, textAlign:"left" }}>
              <span style={{ width:9, height:9, borderRadius:"50%", background:p.col, boxShadow:active ? `0 0 0 3px ${p.col}22` : "none" }}/>
              <span style={{ whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{p.short}</span>
              <span style={{ ...MONO, color:active ? p.col : C.subtle, fontSize:11, textAlign:"right" }}>{active ? "x" : ""}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
// ─── Sidebar platform filter (Videos tab) ───────────────────────

function SidebarCampaignFilter({ campaignId, setCampaignId, campaigns = [], productMeta = {} }) {
  const { t } = useUiText();
  return (
    <div style={{ padding:"10px 12px 12px", borderBottom:`1px solid ${C.border}` }}>
      <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>{t("filter.campaign", "Campaign")}</div>
      <select value={campaignId} onChange={e => setCampaignId(e.target.value)} style={SELECT}>
        <option value="">{t("filter.allCampaigns", "All Campaigns")}</option>
        {campaigns.map(c => (
          <option key={c.id} value={c.id}>
            {c.short}{c.pid ? ` / ${productLabelForValue(c.pid, productMeta)}` : ""}{c.start ? ` (${c.start.slice(5)}${c.end ? `-${c.end.slice(5)}` : ""})` : ""}
          </option>
        ))}
      </select>
      {!campaigns.length && (
        <div style={{ fontSize:10, color:C.muted, marginTop:6, lineHeight:1.35 }}>{t("filter.addCampaigns", "Add Campaigns_Master to split this product by Costco campaign.")}</div>
      )}
    </div>
  );
}

function SidebarPlatformFilter({ selPlatform, setSelPlatform }) {
  const { t } = useUiText();
  const icons = { TikTok:"♪", Instagram:"◈", YouTube:"▶", Facebook:"f" };
  return (
    <div style={{ padding:"10px 12px 12px", borderBottom:`1px solid ${C.border}` }}>
      <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>{t("filter.platform", "Platform")}</div>
      <select value={selPlatform} onChange={e => setSelPlatform(e.target.value)} style={SELECT}>
        <option value="">{t("filter.allPlatforms", "All Platforms")}</option>
        {PLATFORMS.map(p => <option key={p} value={p}>{icons[p] || "-"} {p}</option>)}
      </select>
    </div>
  );
}

function SidebarVideoTypeFilter({ selType, setSelType }) {
  const { t } = useUiText();
  return (
    <div style={{ padding:"10px 12px 12px", borderBottom:`1px solid ${C.border}` }}>
      <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>{t("filter.type", "Type")}</div>
      <select value={selType} onChange={e => setSelType(e.target.value)} style={SELECT}>
        <option value="">{t("filter.allVideos", "All Videos")}</option>
        {VIDEO_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
      </select>
    </div>
  );
}

function SidebarInventoryTypeFilter({ value, setValue }) {
  const { t } = useUiText();
  const options = [
    ["", t("filter.allInventory", "All Inventory")],
    ["inline", t("filter.inlineStores", "Inline Stores")],
    ["online", t("filter.online", "Online")],
  ];
  return (
    <div style={{ padding:"10px 12px 12px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
      <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>{t("filter.inventoryType", "Inventory Type")}</div>
      <select value={value} onChange={e => setValue(e.target.value)} style={SELECT}>
        {options.map(([key, label]) => <option key={key || "all"} value={key}>{label}</option>)}
      </select>
    </div>
  );
}

function SidebarOptionFilter({ label, value, setValue, options, allLabel = "All" }) {
  const { label:uiLabel } = useUiText();
  return (
    <div style={{ padding:"10px 12px 12px", borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>
      <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>{uiLabel(label)}</div>
      <select value={value} onChange={e => setValue(e.target.value)} style={SELECT}>
        <option value="">{uiLabel(allLabel)}</option>
        {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    </div>
  );
}

const RELOAD_BENCHMARK_BUTTON = {
  ...SANS,
  appearance:"none",
  border:`1px solid ${C.border}`,
  borderRadius:7,
  background:C.card,
  color:C.text,
  cursor:"pointer",
  fontSize:11,
  fontWeight:700,
  padding:"7px 10px",
};

function reloadBenchmarkRejectionMessage(reason) {
  const messages = {
    "trusted-input-count-invalid":"More than one benchmark activation was recorded. Click the green button only once.",
    "benchmark-activation-missing":"The timing system saw input on the button, but the button was not activated. Click and release the green button once.",
    "benchmark-activation-count-invalid":"The green button was activated more than once. Click it only once.",
    "page-activation-count-invalid":"Another page control was clicked during this run. Retry and click only the green button.",
    "trusted-input-too-late":"The green button was clicked after its ten-second window.",
    "event-timing-input-missing":"The browser did not attach a usable Performance Event Timing record to the benchmark button.",
    "required-observer-unsupported":"This browser does not support the timing observers required for this test.",
    "measurement-timeout":"No benchmark-button activation was recorded within ten seconds.",
    "trusted-input-missing":"No benchmark-button activation was recorded within ten seconds.",
    "page-not-visible":"The dashboard was not visible for the complete measurement.",
    "measurement-invalid-hidden":"The dashboard became hidden during the measurement.",
    "request-key-mismatch":"The Campaign data identity changed before the measurement finished.",
    "release-mismatch":"The application release changed during this cohort. Start over on the current release.",
    "publication-mismatch":"The published dataset changed during this cohort. Start over on the current publication.",
    "storage-unavailable":"This tab could not save the measurement. Allow tab storage or use a fresh tab.",
    "navigation-not-reload":"This page was opened normally instead of reloaded. Press the benchmark start button once.",
    "initial-view-not-campaign":"The reload did not finish on the Campaign view. Start over without changing tabs.",
    "release-build-missing":"The page could not identify the current application release. Reload the benchmark page.",
    "publication-missing":"The page could not identify the current data publication. Reload the benchmark page.",
    "interaction-metrics-missing":"The browser did not provide complete input-delay and paint timing for this click.",
    "interaction-before-candidate":"The recorded input occurred before Campaign was ready. Retry and click only the green button.",
    "quiet-window-metrics-missing":"The page did not finish the required post-click quiet-window measurement.",
  };
  return messages[String(reason || "")] || `The run did not satisfy the trusted measurement checks (${String(reason || "unknown reason")}).`;
}

function reloadBenchmarkRequiresReset(reason) {
  return reason === "release-mismatch" || reason === "publication-mismatch";
}

function ReloadBenchmarkPanel({ telemetry, summary, result, onStart, onDownload, onReset }) {
  const [snapshot, setSnapshot] = useState(() => reloadInteractionSnapshot(telemetry));
  const [clickPaint, setClickPaint] = useState(0);
  useEffect(() => subscribeReloadInteraction(telemetry, () => {
    setSnapshot(reloadInteractionSnapshot(telemetry));
  }), [telemetry]);
  const acceptedCount = summary?.acceptedCount || 0;
  const hasProgress = acceptedCount > 0 || (summary?.rejectedCount || 0) > 0;
  return (
    <div role="dialog" aria-label="Trusted reload benchmark" style={{ position:"fixed", right:18, bottom:18, zIndex:2100, width:"min(360px, calc(100vw - 36px))", padding:"14px 16px", borderRadius:12, border:`1px solid ${C.accent}66`, background:"rgba(255,255,255,0.98)", boxShadow:"0 18px 50px rgba(15,23,42,0.24)", ...SANS }}>
      <div style={{ display:"flex", justifyContent:"space-between", gap:12, alignItems:"baseline" }}>
        <strong style={{ color:C.text, fontSize:13 }}>Trusted reload test</strong>
        <span style={{ ...MONO, color:C.accent, fontSize:11 }}>{acceptedCount}/{RELOAD_BENCHMARK_TARGET}</span>
      </div>
      <div style={{ color:C.muted, fontSize:11, lineHeight:1.5, marginTop:6 }}>
        {summary?.complete
          ? "Twenty trusted reloads are saved in this tab. Download the result before closing it."
          : result && !result.accepted
            ? `Rejected: ${reloadBenchmarkRejectionMessage(result.reason)} [${result.reason}]`
            : snapshot.navigationType !== "reload"
              ? "Start once. After each reload, click only the green test button as soon as it appears."
              : snapshot.status === "awaiting-input"
                ? "Campaign is ready. Click now - do not wait. The ten-second maximum is already running."
                : snapshot.status === "settling"
                  ? "Input recorded. Measuring long tasks and paint delay..."
                  : result?.accepted
                    ? "Accepted. Starting the next reload..."
                    : "Loading Campaign and preparing the trusted input check..."}
      </div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginTop:10 }}>
        {summary?.complete ? (
          <>
            <button onClick={onDownload} style={{ ...RELOAD_BENCHMARK_BUTTON, background:C.accent, color:"#FFFFFF", borderColor:C.accent }}>Download JSON</button>
            <button onClick={onReset} style={RELOAD_BENCHMARK_BUTTON}>Reset and reload</button>
          </>
        ) : snapshot.navigationType !== "reload" ? (
          <>
            <button onClick={() => onStart(acceptedCount === 0)} style={{ ...RELOAD_BENCHMARK_BUTTON, background:C.accent, color:"#FFFFFF", borderColor:C.accent }}>{acceptedCount ? "Resume reload test" : "Start 20 reloads"}</button>
            {!!acceptedCount && <button onClick={() => onStart(true)} style={RELOAD_BENCHMARK_BUTTON}>Start over</button>}
          </>
        ) : snapshot.status === "awaiting-input" ? (
          <button data-reload-benchmark-input="true" disabled={clickPaint > 0} onClick={event => { markReloadBenchmarkActivation(telemetry, event); setClickPaint(value => value + 1); }} style={{ ...RELOAD_BENCHMARK_BUTTON, background:C.green, color:"#FFFFFF", borderColor:C.green, opacity:clickPaint ? 0.65 : 1, cursor:clickPaint ? "default" : "pointer" }}>{clickPaint ? "Click received - validating timing..." : "Click now - do not wait"}</button>
        ) : result && !result.accepted ? (
          <button onClick={() => onStart(reloadBenchmarkRequiresReset(result.reason))} style={{ ...RELOAD_BENCHMARK_BUTTON, background:C.accent, color:"#FFFFFF", borderColor:C.accent }}>{reloadBenchmarkRequiresReset(result.reason) ? "Start over" : "Retry this run"}</button>
        ) : null}
        {hasProgress && !summary?.complete && !["awaiting-input", "settling"].includes(snapshot.status) && (
          <button onClick={onDownload} style={RELOAD_BENCHMARK_BUTTON}>Download progress</button>
        )}
      </div>
    </div>
  );
}

function DashboardApp() {
  const navRef = useRef(null);
  const [sidebarViewportOffset, setSidebarViewportOffset] = useState(58);

  useEffect(() => {
    const onWheel = ev => {
      if (!ev.deltaY) return;
      const root = document.getElementById("root");
      if (root && ev.target instanceof Node && !root.contains(ev.target)) return;
      const unit = ev.deltaMode === 1 ? 36 : ev.deltaMode === 2 ? window.innerHeight : 1;
      const dy = ev.deltaY * unit;
      let el = ev.target instanceof Element ? ev.target : null;
      while (el && root && el !== root) {
        const style = window.getComputedStyle(el);
        const canScrollY = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
        if (canScrollY) {
          const atTop = el.scrollTop <= 0;
          const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
          if ((dy < 0 && !atTop) || (dy > 0 && !atBottom)) return;
        }
        el = el.parentElement;
      }
      const scroller = document.scrollingElement || document.documentElement;
      const maxScroll = scroller.scrollHeight - scroller.clientHeight;
      if (maxScroll <= 0) return;
      const next = Math.max(0, Math.min(maxScroll, scroller.scrollTop + dy));
      if (next !== scroller.scrollTop) {
        ev.preventDefault();
        scroller.scrollTop = next;
      }
    };
    window.addEventListener("wheel", onWheel, { passive:false, capture:true });
    return () => window.removeEventListener("wheel", onWheel, { capture:true });
  }, []);

  useEffect(() => {
    let frame = 0;
    const updateSidebarOffset = () => {
      frame = 0;
      const navHeight = navRef.current?.getBoundingClientRect().height || 0;
      const next = Math.max(0, Math.round(navHeight - window.scrollY));
      setSidebarViewportOffset(prev => (prev === next ? prev : next));
    };
    const scheduleUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(updateSidebarOffset);
    };
    updateSidebarOffset();
    window.addEventListener("scroll", scheduleUpdate, { passive:true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, []);

  const [uiLang, setUiLang] = useState(() => {
    try { return localStorage.getItem(UI_LANG_STORAGE_KEY) || "en"; } catch { return "en"; }
  });
  const t = useCallback((key, fallback = "") => translateUiText(uiLang, key, fallback), [uiLang]);
  const uiLabel = useCallback(value => translateLabel(uiLang, value), [uiLang]);
  const languageContext = useMemo(() => ({ lang:uiLang, setLang:setUiLang, t, label:uiLabel }), [uiLang, t, uiLabel]);
  useEffect(() => {
    try { localStorage.setItem(UI_LANG_STORAGE_KEY, uiLang); } catch {}
    if (typeof document !== "undefined") document.documentElement.lang = uiLang === "ko" ? "ko" : "en";
  }, [uiLang]);

  const [tab, setTab]                     = useState("campaign");
  const [sales, setSales]                 = useState(INIT_SALES);
  const [prodSales, setProdSales]         = useState(INIT_PROD_SALES);
  const [inlineTotalSales, setInlineTotalSales] = useState(INIT_INLINE_TOTAL_SALES);
  const [warehouseDailySales, setWarehouseDailySales] = useState(() => aggregateWarehouseDailySales(INIT_PROD_SALES));
  const [onlineSales, setOnlineSales]     = useState(INIT_ONLINE_SALES);
  const [ppcRows, setPpcRows]             = useState([]);
  const [workbookSales, setWorkbookSales] = useState(WORKBOOK_SALES);
  const [whs, setWhs]                     = useState(WAREHOUSES);
  const [productMeta, setProductMeta]     = useState({});
  const [campaignMeta, setCampaignMeta]   = useState({});
  const [inventoryApprovals, setInventoryApprovals] = useState([]);
  const [manualInventoryApprovals, setManualInventoryApprovals] = useState([]);
  const [inventoryApprovalEnabled, setInventoryApprovalEnabled] = useState(false);
  const [inventoryApprovalEvaluationDate, setInventoryApprovalEvaluationDate] = useState(() => localDateKey());
  const [inventoryApprovalRevision, setInventoryApprovalRevision] = useState("0");
  const [inventoryApprovalOverlayPublication, setInventoryApprovalOverlayPublication] = useState("");
  const [inventoryApprovalOverlayError, setInventoryApprovalOverlayError] = useState("");
  const [inventoryViewModel, setInventoryViewModel] = useState(null);
  const [analysisViewModel, setAnalysisViewModel] = useState(null);
  const [salesViewModel, setSalesViewModel] = useState(null);
  const [analysisOptions, setAnalysisOptions] = useState({
    affinityRegion:"",
    affinityState:"",
    affinityMinimumPeriods:3,
    affinityMinimumUnits:5,
    compareBucket:"warehouse",
    compareMetric:"rev",
    compareNormMode:"sellingAge",
    compareMinUnits:ANALYSIS_MIN_SELLING_UNITS,
    compareRegion:"",
    compareState:"",
    compareFrom:"",
    compareTo:"",
    warehousePid:"",
    warehouseCid:"",
    warehouseFrom:"",
    warehouseTo:"",
    warehouseRegion:"",
    warehouseState:"",
  });
  const [detailDatasetLoaded, setDetailDatasetLoaded] = useState(false);
  const [inventoryReviewDispositions, setInventoryReviewDispositions] = useState([]);
  const [ownerInventoryDecisions, setOwnerInventoryDecisions] = useState([]);
  const consumerProdSales = useMemo(() => consumerWarehouseSales(prodSales, ownerInventoryDecisions), [prodSales, ownerInventoryDecisions]);
  const [ownerSalesCorrections, setOwnerSalesCorrections] = useState([]);
  const [ownerSalesCorrectionHistory, setOwnerSalesCorrectionHistory] = useState([]);
  const [localOwnerSalesHistory, setLocalOwnerSalesHistory] = useState(false);
  const [footnotes, setFootnotes]         = useState(INIT_FOOTNOTES);
  const [selId, setSelId]                 = useState(null);
  const [mapFeatures, setMapFeatures]     = useState([]);
  const [mapProjectionLibrary, setMapProjectionLibrary] = useState(null);
  const [mapFeaturesInitialized, setMapFeaturesInitialized] = useState(false);
  const [mapFeaturesError, setMapFeaturesError] = useState("");
  const [toast, setToast]                 = useState(null);
  const [publishedStatusToast, setPublishedStatusToast] = useState(null);
  const [liveUrl, setLiveUrl]             = useState("");
  const [showSettings, setShowSettings]   = useState(false);
  const [lastRefresh, setLastRefresh]     = useState(null);
  const [sharedDatasetStatus, setSharedDatasetStatus] = useState({ state:"idle", message:"Waiting to load published data.", publishedAt:"", source:"", warning:"" });
  const [detailDatasetStatus, setDetailDatasetStatus] = useState({ state:"idle", message:"Warehouse detail loads when needed." });
  const [publishedActiveWarehouseIds, setPublishedActiveWarehouseIds] = useState([]);
  const [analysisSummaries, setAnalysisSummaries] = useState({ daily:[], regionDaily:[], stateDaily:[] });
  const [campaignRevenueDoorSummary, setCampaignRevenueDoorSummary] = useState(null);
  const [campaignAutomaticRevenueDoorSummary, setCampaignAutomaticRevenueDoorSummary] = useState(null);
  const [campaignComparison, setCampaignComparison] = useState(null);
  const [datasetTimings, setDatasetTimings] = useState({ cacheMs:null, downloadMs:null, parseMs:null, campaignReadyMs:null, detailDownloadMs:null, detailParseMs:null, analysisReadyMs:null, responseBytes:null, transferBytes:null });
  const [startupRenderToken, setStartupRenderToken] = useState(0);
  const detailLoadedRef = useRef(false);
  const detailLoadPromiseRef = useRef(null);
  const runtimeViewAbortRef = useRef(null);
  const runtimeViewCacheRef = useRef(new RuntimeViewCache());
  const runtimeViewAppliedKeyRef = useRef("");
  const [runtimeRequestState, setRuntimeRequestState] = useState({key:"",status:"loading"});
  const [runtimeRetry, setRuntimeRetry] = useState(0);
  const inventoryApprovalRefreshRef = useRef({ sequence:0, controller:null, mutationPending:0 });
  const latestStartupDatasetRef = useRef(null);
  const effectiveInventoryApprovals = useMemo(() => (
    manualInventoryApprovals.reduce((rows, approval) => upsertInventoryApproval(rows, approval), inventoryApprovals)
  ), [inventoryApprovals, manualInventoryApprovals]);
  const runtimeViewAppliedRef = useRef(false);
  const invalidateRuntimeModelsForLocalData = useCallback(() => {
    runtimeViewAbortRef.current?.abort();
    runtimeViewCacheRef.current.clear();
    runtimeViewAppliedKeyRef.current = "";
    runtimeViewAppliedRef.current = false;
    setInventoryViewModel(null);
    setAnalysisViewModel(null);
    setSalesViewModel(null);
    setCampaignComparison(null);
  }, []);
  const startupPaintRef = useRef(null);
  const startupLoadStartedAtRef = useRef(0);
  const analysisPaintRef = useRef(null);
  const reportPaintRef = useRef(null);
  const reportRuntimeKeyRef = useRef("");
  const [viewReadyMs, setViewReadyMs] = useState(null);
  const [lazyTabReadyKey, setLazyTabReadyKey] = useState("");
  const [viewReadyKey, setViewReadyKey] = useState("");
  const [reloadBenchmarkEnabled] = useState(() => typeof window !== "undefined" && isReloadBenchmarkEnabled(window.location.search));
  const reloadInteractionRef = useRef(null);
  if (reloadBenchmarkEnabled && !reloadInteractionRef.current) reloadInteractionRef.current = getReloadInteractionTelemetry();
  const reloadInteractionStartedRef = useRef(false);
  const mapFeaturesLoadStartedRef = useRef(false);
  const [reloadInteraction, setReloadInteraction] = useState(() => reloadBenchmarkEnabled
    ? reloadInteractionSnapshot(reloadInteractionRef.current)
    : { status:"disabled", navigationType:"", inputCount:0, observerSupport:{ longtask:false, event:false, firstInput:false } });
  const [reloadBenchmarkSession, setReloadBenchmarkSession] = useState(() => reloadBenchmarkEnabled
    ? readReloadBenchmarkSession(window.sessionStorage)
    : null);
  const [reloadBenchmarkResult, setReloadBenchmarkResult] = useState(null);
  const reloadBenchmarkSummary = reloadBenchmarkEnabled
    ? summarizeReloadBenchmark(reloadBenchmarkSession || undefined)
    : null;
  const startupBoundsRef = useRef({ start:"", end:"" });
  const publishedAtRef = useRef("");
  const [importStatus, setImportStatus] = useState({ state:"idle", message:"" });
  const [importBusy, setImportBusy] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [publishToken, setPublishToken] = useState("");
  const [publishAction, setPublishAction] = useState("dataset");
  const pendingDailyUpdateRef = useRef(null);
  useEffect(() => { setSidebarOpen(false); }, [tab]);
  useEffect(() => {
    if (!showSettings) return;
    const onKey = e => { if (e.key === "Escape") setShowSettings(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showSettings]);
  const [notesDirty, setNotesDirty] = useState(false);
  const fileRef = useRef();
  const dailyFileRef = useRef();
  const criteoFileRef = useRef();
  const todayKey = useMemo(() => localDateKey(), []);
  const initialCalendarRange = useMemo(() => calendarDefaultDateRange(WORKBOOK_SALES.meta, todayKey), [todayKey]);
  const calendarDateAutoRef = useRef(true);
  const campaignDateAutoRef = useRef(true);
  const analyticsDateAutoRef = useRef(true);
  const inventoryDateAutoRef = useRef(true);

  // Lifted filter state — controlled by sidebar
  const [analyticsDR, setAnalyticsDR]   = useState({ start:WORKBOOK_SALES.meta.start, end:WORKBOOK_SALES.meta.end });
  const [campaignDR, setCampaignDR]     = useState({ start:WORKBOOK_SALES.meta.start, end:WORKBOOK_SALES.meta.end });
  const [campaignPid, setCampaignPid]   = useState("");
  const [campaignCid, setCampaignCid]   = useState("");
  const [activeCampaignId, setActiveCampaignId] = useState("");
  const [campaignChannel, setCampaignChannel] = useState("inline");
  const [campaignSubtab, setCampaignSubtab] = useState("overview");
  const [analysisSection, setAnalysisSection] = useState("pacing");
  const [compareA, setCompareA] = useState("");
  const [compareB, setCompareB] = useState("");
  const [compareCampaignA, setCompareCampaignA] = useState("");
  const [compareCampaignB, setCompareCampaignB] = useState("");
  const [pacingCompPid, setPacingCompPid] = useState("");
  const [pacingCompCid, setPacingCompCid] = useState("");
  const [productsDR, setProductsDR]     = useState({ start:DATA_START, end:DATA_END });
  const [selPid, setSelPid]             = useState("");
  const [salesRegion, setSalesRegion]   = useState("");
  const [salesState, setSalesState]     = useState("");
  const [mapSelections, setMapSelections] = useState([
    { pid:"", cid:"" },
    { pid:"", cid:"" },
  ]);
  const mapPids = useMemo(() => mapSelections.map(selection => selection.pid).filter(Boolean), [mapSelections]);
  const [mapRegion, setMapRegion]       = useState("");
  const [mapState, setMapState]         = useState("");
  const [calendarPid, setCalendarPid]   = useState("");   // "" = all products
  const [calendarDR, setCalendarDR]     = useState(initialCalendarRange);
  const [storeSearch, setStoreSearch]   = useState("");
  const [salesStoreSearch, setSalesStoreSearch] = useState("");
  const [inventoryStoreSearch, setInventoryStoreSearch] = useState("");
  const [inventoryDR, setInventoryDR]   = useState({ start:WORKBOOK_SALES.meta.start, end:WORKBOOK_SALES.meta.end });
  const [inventoryPid, setInventoryPid] = useState("");
  const inventoryType = campaignChannel;
  const [inventoryRegion, setInventoryRegion] = useState("");
  const [inventoryState, setInventoryState] = useState("");

  useEffect(() => {
    if (tab !== "analytics") {
      setSalesStoreSearch("");
      return;
    }
    const timer = window.setTimeout(() => setSalesStoreSearch(storeSearch.trim()), 600);
    return () => window.clearTimeout(timer);
  }, [tab, storeSearch]);

  useEffect(() => {
    if (tab !== "inventory") {
      setInventoryStoreSearch("");
      return;
    }
    const timer = window.setTimeout(() => setInventoryStoreSearch(storeSearch.trim()), 600);
    return () => window.clearTimeout(timer);
  }, [tab, storeSearch]);

  // Video tracking state — fully independent of store data
  const [videos, setVideos]               = useState(INIT_VIDEO_LIST);
  const [videoMetrics, setVideoMetrics]   = useState(INIT_VIDEO_METRICS);
  const [videoSelPid, setVideoSelPid]     = useState("");  // "" = all products
  const [videoPlatform, setVideoPlatform] = useState("");  // "" = all platforms
  const [videoType, setVideoType]         = useState("");  // "" = paid + seeding
  const [videoDateRange, setVideoDateRange] = useState({ start:VIDEO_SNAP_DATES[0], end:VIDEO_SNAP_DATES[VIDEO_SNAP_DATES.length - 1] });
  const videoDateAutoRef = useRef(true);
  const [selVid, setSelVid]               = useState(null);
  const [selVideoMetric, setSelVideoMetric] = useState("views");
  const videoFileRef = useRef();

  const videoDateBounds = useMemo(() => {
    const dates = [...new Set(videoMetrics.map(m => m.date).filter(Boolean))].sort();
    return { start:dates[0] || VIDEO_SNAP_DATES[0], end:dates[dates.length - 1] || VIDEO_SNAP_DATES[VIDEO_SNAP_DATES.length - 1] };
  }, [videoMetrics]);

  useEffect(() => {
    setVideoDateRange(r => {
      if (videoDateAutoRef.current) return { start:videoDateBounds.start, end:videoDateBounds.end };
      const next = {
        start:!r.start || r.start < videoDateBounds.start ? videoDateBounds.start : r.start,
        end:!r.end || r.end > videoDateBounds.end ? videoDateBounds.end : r.end,
      };
      return next.start === r.start && next.end === r.end ? r : next;
    });
  }, [videoDateBounds.start, videoDateBounds.end]);

  const setVideoDateRangeFromUser = useCallback(range => {
    videoDateAutoRef.current = false;
    setVideoDateRange(range);
  }, []);

  const videoVisibleCount = useMemo(() => {
    const activeVidIds = new Set(videoMetrics
      .filter(m => (!videoDateRange.start || m.date >= videoDateRange.start) && (!videoDateRange.end || m.date <= videoDateRange.end))
      .map(m => m.vid));
    return videos.filter(v =>
      (!videoSelPid || productValuesMatch(v.pid, videoSelPid, productMeta)) &&
      campaignContextMatchesChannel(v, campaignChannel, campaignMeta) &&
      rowMatchesCampaignScope(v, activeCampaignId) &&
      (!videoType || v.type === videoType) &&
      (!videoPlatform || v.platform === videoPlatform) &&
      activeVidIds.has(v.id)
    ).length;
  }, [videos, videoMetrics, videoSelPid, videoType, videoPlatform, videoDateRange, activeCampaignId, campaignChannel, campaignMeta, productMeta]);

  const setCalendarDateRangeFromUser = useCallback(update => {
    calendarDateAutoRef.current = false;
    setCalendarDR(current => typeof update === "function" ? update(current) : update);
  }, []);

  const salesDateBounds = useMemo(() => {
    return dateBoundsFromRows(workbookSales.meta.start, workbookSales.meta.end, [sales, prodSales, inlineTotalSales, onlineSales, ppcRows]);
  }, [workbookSales.meta.start, workbookSales.meta.end, sales, prodSales, inlineTotalSales, onlineSales, ppcRows]);
  const effectiveCampaignSales = useMemo(() => effectiveInlineSalesRows(inlineTotalSales, warehouseDailySales), [inlineTotalSales, warehouseDailySales]);
  const campaignDateBounds = useMemo(() => campaignMetricDateBounds(effectiveCampaignSales, onlineSales, salesDateBounds), [effectiveCampaignSales, onlineSales, salesDateBounds.start, salesDateBounds.end]);
  const campaignAutomaticRange = useMemo(() => campaignAutomaticDateRange(campaignDateBounds, CAMPAIGN_DEFAULT_START), [campaignDateBounds.start, campaignDateBounds.end]);
  const calendarDateBounds = useMemo(() => ({
    start:salesDateBounds.start,
    end:maxDateKey(salesDateBounds.end, todayKey),
  }), [salesDateBounds.start, salesDateBounds.end, todayKey]);

  useEffect(() => {
    setCampaignDR(current => dateRangeAfterBoundsRefresh(current, campaignDateAutoRef.current ? campaignAutomaticRange : salesDateBounds, campaignDateAutoRef.current));
    setAnalyticsDR(current => dateRangeAfterBoundsRefresh(current, salesDateBounds, analyticsDateAutoRef.current));
    setInventoryDR(current => dateRangeAfterBoundsRefresh(current, salesDateBounds, inventoryDateAutoRef.current));
    setCalendarDR(current => {
      if (calendarDateAutoRef.current) return calendarDefaultDateRange(calendarDateBounds, todayKey);
      const next = {
        start:clampDateKey(current.start, calendarDateBounds.start, calendarDateBounds.end),
        end:clampDateKey(current.end, calendarDateBounds.start, calendarDateBounds.end),
      };
      return next.start <= next.end ? next : calendarDefaultDateRange(calendarDateBounds, todayKey);
    });
  }, [campaignAutomaticRange.start, campaignAutomaticRange.end, salesDateBounds.start, salesDateBounds.end, calendarDateBounds, todayKey]);

  const revenueStoreIds = useMemo(() => new Set(publishedActiveWarehouseIds.length ? publishedActiveWarehouseIds : sales.filter(r => Number(r.rev || 0) > 0).map(r => r.wid)), [publishedActiveWarehouseIds, sales]);
  const activeWhs = useMemo(() => whs.filter(w => revenueStoreIds.has(w.id)), [whs, revenueStoreIds]);
  const inventoryLocationIds = useMemo(() => new Set(prodSales
    .filter(r => Number(r.rev || 0) > 0 || Number(r.units || 0) > 0 || Number(r.inv || 0) > 0 || Number(r.inbound || 0) > 0 || Number(r.reserved || 0) > 0)
    .map(r => r.wid)), [prodSales]);
  const inventoryWhs = useMemo(() => whs.filter(w => revenueStoreIds.has(w.id) || inventoryLocationIds.has(w.id)), [whs, revenueStoreIds, inventoryLocationIds]);
  const inventoryCoverageWhs = useMemo(() => inventoryWhs.filter(w => !isNonStoreInventoryLocation(w)), [inventoryWhs]);
  const productOptions = useMemo(() => groupProductFilterOptions(productCatalog(productMeta)), [productMeta]);
  const comparisonProductOptions = useMemo(() => analysisComparisonProductOptions(productMeta, inlineTotalSales), [productMeta, inlineTotalSales]);
  const comparisonDefaults = useMemo(() => analysisComparisonDefaults(productMeta, inlineTotalSales), [productMeta, inlineTotalSales]);
  const defaultCompareA = productOptionIdForValue(comparisonDefaults.compareA, comparisonProductOptions, productMeta);
  const defaultCompareB = productOptionIdForValue(comparisonDefaults.compareB, comparisonProductOptions, productMeta);
  const effectiveCompareA = productOptionIdForValue(compareA, comparisonProductOptions, productMeta) || defaultCompareA;
  const effectiveCompareB = productOptionIdForValue(compareB, comparisonProductOptions, productMeta) || defaultCompareB;
  const channelData = useMemo(() => channelViewDataset({
    sales, prodSales:consumerProdSales, inlineTotalSales, warehouseDailySales, onlineSales, ppcRows, footnotes, videos,
  }, campaignChannel, campaignMeta), [sales, consumerProdSales, inlineTotalSales, warehouseDailySales, onlineSales, ppcRows, footnotes, videos, campaignChannel, campaignMeta]);
  const channelComparison = useMemo(() => campaignComparison
    ? channelViewDataset(campaignComparison, campaignChannel, campaignMeta) : null,
  [campaignComparison, campaignChannel, campaignMeta]);
  const allCampaignOptions = useMemo(() => campaignFilterCatalog(campaignMeta, productMeta), [campaignMeta, productMeta]);
  const activeCampaign = useMemo(() => campaignWithMeta(activeCampaignId, campaignMeta, productMeta), [activeCampaignId, campaignMeta, productMeta]);
  const campaignOptions = useMemo(() => campaignPid ? campaignFilterCatalog(campaignMeta, productMeta, campaignPid) : [], [campaignMeta, productMeta, campaignPid]);
  const currentSidebarProductId = tab === "campaign" || tab === "rankings" ? campaignPid : tab === "calendar" ? calendarPid : tab === "inventory" ? inventoryPid : tab === "analytics" ? selPid : tab === "videos" ? videoSelPid : tab === "map" && mapPids.length === 1 ? mapPids[0] : "";
  const sidebarCampaignOptions = useMemo(() => {
    if (!currentSidebarProductId) return allCampaignOptions;
    return allCampaignOptions.filter(c => productValuesMatch(c.pid, currentSidebarProductId, productMeta));
  }, [allCampaignOptions, currentSidebarProductId, productMeta]);
  const pacingBaselineCampaignOptions = useMemo(() =>
    _.orderBy(sidebarCampaignOptions, [c => c.active ? 1 : 0, c => c.start || "", c => c.end || "", c => c.short || ""], ["desc","desc","desc","asc"])
  , [sidebarCampaignOptions]);
  const inventoryCampaignOptions = useMemo(() => inventoryPid
    ? _.orderBy(campaignFilterCatalog(campaignMeta, productMeta, inventoryPid), [c => c.active ? 1 : 0, c => c.start || "", c => c.end || "", c => c.short || ""], ["desc","desc","desc","asc"])
    : []
  , [campaignMeta, productMeta, inventoryPid]);
  const comparisonCampaignOptions = useMemo(() => ({
    a: _.orderBy(campaignFilterCatalog(campaignMeta, productMeta, effectiveCompareA), [c => c.active ? 1 : 0, c => c.start || "", c => c.end || "", c => c.short || ""], ["desc","desc","desc","asc"]),
    b: _.orderBy(campaignFilterCatalog(campaignMeta, productMeta, effectiveCompareB), [c => c.active ? 1 : 0, c => c.start || "", c => c.end || "", c => c.short || ""], ["desc","desc","desc","asc"]),
  }), [campaignMeta, productMeta, effectiveCompareA, effectiveCompareB]);
  const pacingCompCampaignOptions = useMemo(() =>
    _.orderBy(campaignFilterCatalog(campaignMeta, productMeta, pacingCompPid), [c => c.active ? 1 : 0, c => c.start || "", c => c.end || ""], ["desc","desc","desc"])
  , [campaignMeta, productMeta, pacingCompPid]);
  useEffect(() => {
    setPacingCompCid(current => {
      if (!pacingCompPid) return "";
      if (pacingCompCampaignOptions.some(campaign => campaign.id === current)) return current;
      return pacingCompCampaignOptions[0]?.id || "";
    });
  }, [pacingCompPid, pacingCompCampaignOptions]);
  useEffect(() => {
    const resolvePid = pid => productOptionIdForValue(pid, productOptions, productMeta);
    const normalizePid = (pid, setter) => {
      if (!pid) return;
      const resolved = resolvePid(pid);
      if (!resolved) setter("");
      else if (resolved !== pid) setter(resolved);
    };
    normalizePid(campaignPid, setCampaignPid);
    normalizePid(selPid, setSelPid);
    normalizePid(calendarPid, setCalendarPid);
    normalizePid(inventoryPid, setInventoryPid);
    normalizePid(videoSelPid, setVideoSelPid);
    setMapSelections(prev => {
      const next = prev.slice(0, 2).map(selection => {
        const pid = resolvePid(selection?.pid);
        const cid = pid && allCampaignOptions.some(campaign => campaign.id === selection?.cid && productValuesMatch(campaign.pid, pid, productMeta))
          ? selection.cid
          : "";
        return { pid, cid };
      });
      while (next.length < 2) next.push({ pid:"", cid:"" });
      if (!next[0].pid) next[1] = { pid:"", cid:"" };
      return _.isEqual(prev, next) ? prev : next;
    });
  }, [productOptions, productMeta, allCampaignOptions, campaignPid, selPid, calendarPid, inventoryPid, videoSelPid]);
  useEffect(() => {
    if (campaignCid && (!campaignPid || !campaignOptions.some(c => c.id === campaignCid))) setCampaignCid("");
  }, [campaignCid, campaignPid, campaignOptions]);
  useEffect(() => {
    if (activeCampaignId && !allCampaignOptions.some(c => c.id === activeCampaignId)) {
      setActiveCampaignId("");
      setCampaignCid("");
    }
  }, [activeCampaignId, allCampaignOptions]);

  const applyCampaignToTab = useCallback((campaign, targetTab = tab) => {
    if (!campaign) return;
    const pid = productOptionIdForValue(campaign.pid, productOptions, productMeta);
    const salesRange = dateRangeForCampaign(campaign, salesDateBounds);
    if (targetTab === "campaign" || targetTab === "rankings") {
      setCampaignPid(pid);
      setCampaignCid(campaign.id);
      campaignDateAutoRef.current = false;
      setCampaignDR(salesRange);
    } else if (targetTab === "analytics") {
      setSelPid(pid);
      analyticsDateAutoRef.current = false;
      setAnalyticsDR(salesRange);
    } else if (targetTab === "calendar") {
      setCalendarPid(pid);
      calendarDateAutoRef.current = false;
      setCalendarDR(salesRange);
    } else if (targetTab === "inventory") {
      setInventoryPid(pid);
      inventoryDateAutoRef.current = false;
      setInventoryDR(salesRange);
    } else if (targetTab === "map") {
      setMapSelections([
        { pid, cid:campaign.id || "" },
        { pid:"", cid:"" },
      ]);
      campaignDateAutoRef.current = false;
      setCampaignDR(salesRange);
    } else if (targetTab === "videos") {
      setVideoSelPid(pid);
      setVideoDateRange(dateRangeForCampaign(campaign, videoDateBounds));
      setSelVid(null);
    }
    setSelId(null);
  }, [tab, salesDateBounds, videoDateBounds, productOptions, productMeta]);
  const applyCampaignToTabRef = useRef(applyCampaignToTab);
  applyCampaignToTabRef.current = applyCampaignToTab;

  const handleCampaignFilterChange = useCallback((campaignId) => {
    setActiveCampaignId(campaignId);
    if (!campaignId) {
      setCampaignCid("");
      return;
    }
    const campaign = campaignWithMeta(campaignId, campaignMeta, productMeta);
    if (campaign) applyCampaignToTab(campaign);
  }, [campaignMeta, productMeta, applyCampaignToTab]);

  const handleInventoryCampaignFilterChange = useCallback((campaignId) => {
    const campaign = campaignWithMeta(campaignId, campaignMeta, productMeta);
    if (!campaign) return;
    const nextChannel = campaignChannelSupports(campaign.channel, campaignChannel)
      ? campaignChannel
      : campaignChannelSupports(campaign.channel, "inline") ? "inline" : "online";
    setCampaignChannel(nextChannel);
    setSelId(null);
    handleCampaignFilterChange(campaignId);
  }, [campaignMeta, productMeta, campaignChannel, handleCampaignFilterChange]);

  useEffect(() => {
    if (activeCampaign) applyCampaignToTabRef.current(activeCampaign, tab);
  }, [activeCampaign?.id, tab]);

  const setProductForCurrentTab = useCallback((pid) => {
    if (tab === "rankings" && analysisSection === "warehouses") {
      setAnalysisOptions(previous => ({ ...previous, warehousePid:pid, warehouseCid:"" }));
    }
    else if (tab === "campaign" || tab === "rankings") {
      campaignDateAutoRef.current = false;
      setCampaignPid(pid);
    }
    else if (tab === "analytics") setSelPid(pid);
    else if (tab === "calendar") setCalendarPid(pid);
    else if (tab === "inventory") setInventoryPid(pid);
    else if (tab === "videos") setVideoSelPid(pid);
    // A product filter must retain the selected date window and include every
    // available day for that product. Campaign selection is intentionally
    // separate because automatically selecting the newest campaign can hide
    // earlier sales history.
    if (!(tab === "rankings" && analysisSection === "warehouses")) {
      setActiveCampaignId("");
      setCampaignCid("");
    }
  }, [tab, analysisSection]);

  const handleChannelFilterChange = useCallback(channel => {
    setCampaignChannel(channel);
    setActiveCampaignId("");
    setCampaignCid("");
    setSelId(null);
    setSalesRegion("");
    setSalesState("");
    setInventoryRegion("");
    setInventoryState("");
    setStoreSearch("");
  }, []);

  const salesRegions = useMemo(() => _.sortBy([...new Set(activeWhs.map(w => w.region).filter(Boolean))]), [activeWhs]);
  const salesStates = useMemo(() => _.sortBy([...new Set(activeWhs.filter(w => !salesRegion || w.region === salesRegion).map(w => w.st).filter(Boolean))]), [activeWhs, salesRegion]);
  useEffect(() => {
    if (salesState && !salesStates.includes(salesState)) setSalesState("");
  }, [salesState, salesStates]);
  const mapRegions = useMemo(() => tab === "map" ? _.sortBy([...new Set(activeWhs.map(w => w.region).filter(Boolean))]) : [], [tab, activeWhs]);
  const mapStates = useMemo(() => tab === "map" ? _.sortBy([...new Set(activeWhs.filter(w => !mapRegion || w.region === mapRegion).map(w => w.st).filter(Boolean))]) : [], [tab, activeWhs, mapRegion]);
  useEffect(() => {
    if (tab === "map" && mapState && !mapStates.includes(mapState)) setMapState("");
  }, [tab, mapState, mapStates]);
  const inventoryRegions = useMemo(() => _.sortBy([...new Set(inventoryCoverageWhs.map(w => w.region).filter(Boolean))]), [inventoryCoverageWhs]);
  const inventoryStates = useMemo(() => _.sortBy([...new Set(inventoryCoverageWhs.filter(w => !inventoryRegion || w.region === inventoryRegion).map(w => w.st).filter(Boolean))]), [inventoryCoverageWhs, inventoryRegion]);
  useEffect(() => {
    if (inventoryState && !inventoryStates.includes(inventoryState)) setInventoryState("");
  }, [inventoryState, inventoryStates]);
  const mapAllowedStoreIds = useMemo(() => tab === "map" ? new Set(activeWhs
    .filter(w => (!mapRegion || w.region === mapRegion) && (!mapState || w.st === mapState))
    .map(w => w.id)) : new Set(), [tab, activeWhs, mapRegion, mapState]);
  const mapScopes = useMemo(() => {
    if (tab !== "map") return [];
    const usedColors = new Set();
    const alternateColors = [C.blue, C.warn, C.green, C.red];
    return mapSelections.map((selection, index) => {
      if (!selection.pid) return null;
      const product = productWithMeta(selection.pid, productMeta);
      const campaign = campaignWithMeta(selection.cid, campaignMeta, productMeta);
      const productLabel = product?.short || productLabelForValue(selection.pid, productMeta) || selection.pid;
      const campaignLabel = campaign?.short || campaign?.name || "";
      let col = campaign?.col || product?.col || productColorForValue(selection.pid);
      if (usedColors.has(String(col).toLowerCase())) {
        col = alternateColors.find(candidate => !usedColors.has(candidate.toLowerCase())) || col;
      }
      usedColors.add(String(col).toLowerCase());
      return {
        index,
        key:mapSelectionKey(selection, index),
        pid:selection.pid,
        cid:selection.cid || "",
        product:productLabel,
        campaign:campaignLabel,
        label:campaignLabel ? `${productLabel} / ${campaignLabel}` : `${productLabel} / ${t("filter.allCampaigns", "All Campaigns")}`,
        col,
      };
    }).filter(Boolean);
  }, [tab, mapSelections, productMeta, campaignMeta, t]);
  const mapCampaignOptions = useMemo(() => tab === "map" ? mapSelections.map(selection => (
    _.orderBy(campaignFilterCatalog(campaignMeta, productMeta, selection.pid), [campaign => campaign.active ? 1 : 0, campaign => campaign.start || "", campaign => campaign.end || ""], ["desc", "desc", "desc"])
  )) : [[], []], [tab, mapSelections, campaignMeta, productMeta]);
  const mapRuntimeScope = useMemo(() => buildMapRuntimeScope(mapScopes), [mapScopes]);
  const mapComparisonMode = mapScopes.length === 2;
  const mapProductScope = useMemo(() => {
    const canonicalCache = new Map();
    const canonicalPidForValue = value => {
      const cacheKey = String(value || "");
      if (canonicalCache.has(cacheKey)) return canonicalCache.get(cacheKey);
      const prod = productWithMeta(value, productMeta);
      const canonical = prod?.id || value || "";
      canonicalCache.set(cacheKey, canonical);
      return canonical;
    };
    return { canonicalPidForValue };
  }, [productMeta]);
  const mapRowMatchesScope = useCallback((row, scope) => {
    if (!scope?.pid || !productValuesMatch(productIdForMetricRow(row), scope.pid, productMeta)) return false;
    return rowMatchesCampaignScopeWithInference(row, scope.cid, campaignMeta, productMeta, scope.pid);
  }, [campaignMeta, productMeta]);
  const mapSelectedPidForRow = useCallback(row => (
    mapScopes.find(scope => productValuesMatch(productIdForMetricRow(row), scope.pid, productMeta))?.pid || ""
  ), [mapScopes, productMeta]);
  const mapRowInProductScope = useCallback(row => (
    !mapScopes.length || mapScopes.some(scope => mapRowMatchesScope(row, scope))
  ), [mapScopes, mapRowMatchesScope]);
  const mapProductKeyForRow = useCallback(row => {
    const rowPid = productIdForMetricRow(row);
    return mapSelectedPidForRow(row) || mapProductScope.canonicalPidForValue(rowPid);
  }, [mapSelectedPidForRow, mapProductScope]);

  // Use bundled map topology so the internal dashboard does not fetch runtime code from a public CDN.
  useEffect(() => {
    if (tab !== "map" || mapFeaturesInitialized || mapFeaturesLoadStartedRef.current) return;
    mapFeaturesLoadStartedRef.current = true;
    Promise.all([
      import("d3"),
      import("topojson-client"),
      import("us-atlas/states-10m.json"),
    ]).then(([d3Module, topojsonModule, atlasModule]) => {
      const atlas = atlasModule.default || atlasModule;
      const features = topojsonModule.feature(atlas, atlas.objects.states)?.features;
      if (!Array.isArray(features) || !features.length) throw new Error("US map topology returned no features.");
      setMapProjectionLibrary(d3Module);
      setMapFeatures(features);
      setMapFeaturesError("");
    }).catch(() => {
      setMapProjectionLibrary(null);
      setMapFeatures([]);
      setMapFeaturesError("US map geometry could not be initialized.");
    }).finally(() => {
      setMapFeaturesInitialized(true);
    });
  }, [tab, mapFeaturesInitialized]);
  const retryMapFeatures = useCallback(() => {
    mapFeaturesLoadStartedRef.current = false;
    setMapFeaturesInitialized(false);
    setMapProjectionLibrary(null);
    setMapFeatures([]);
    setMapFeaturesError("");
  }, []);

  // ── Aggregations ──────────────────────────────────────────────
  const totals = useMemo(() => {
    const grp = _.groupBy(sales, "wid");
    const latestDate = _.max(sales.map(r => r.date).filter(Boolean)) || DATA_END;
    return activeWhs.map(w => {
      const rows = grp[w.id] || [];
      const displayStats = warehouseDisplayStats(rows, w);
      if (!displayStats.eligible) return null;
      const sorted = _.sortBy(rows, "date");
      const trend = storeTrendFromRows(sorted, latestDate);
      return { ...w, total:_.sumBy(rows,"rev"), units:_.sumBy(rows,"units"), pct:trend.pct, trend, rows:sorted };
    }).filter(w => w && w.total > 0);
  }, [sales, activeWhs]);

  const ranked   = useMemo(() => _.orderBy(totals, "total", "desc"), [totals]);
  const demographicsWarehouseId = useMemo(() => {
    const validStores = activeWhs.filter(warehouse => !isNonStoreInventoryLocation(warehouse));
    const validIds = new Set(validStores.map(warehouse => warehouse.id));
    if (selId && validIds.has(selId)) return selId;
    return ranked.find(warehouse => validIds.has(warehouse.id))?.id || validStores[0]?.id || "";
  }, [activeWhs, ranked, selId]);
  const totalRev = _.sumBy(totals, "total");
  const avgRevenuePerStore = ranked.length ? totalRev / ranked.length : 0;
  const storeVelocity = useMemo(() => {
    const activeRows = sales.filter(r => Number(r.rev || 0) > 0 || Number(r.units || 0) > 0);
    const activeStores = new Set(activeRows.map(r => r.wid)).size;
    const activeDays = new Set(activeRows.map(r => r.date)).size;
    return activeStores && activeDays ? _.sumBy(activeRows, "units") / activeStores / activeDays : 0;
  }, [sales]);
  const best = ranked[0], worst = ranked[ranked.length - 1];
  const minT = worst?.total || 0, maxT = best?.total || 1;

  const salesSidebarRanked = useMemo(() => {
    if (tab !== "analytics") return [];
    if (campaignChannel === "online") return [];
    if (salesViewModel?.schema === SALES_COMPACT_SCHEMA) return Array.isArray(salesViewModel.sidebarRows) ? salesViewModel.sidebarRows : [];
    const allowed = new Set(activeWhs.filter(w => (!salesRegion || w.region === salesRegion) && (!salesState || w.st === salesState)).map(w => w.id));
    const rows = (activeCampaignId || selPid ? consumerProdSales.filter(r => (!selPid || productValuesMatch(r.pid, selPid, productMeta))) : sales)
      .filter(r =>
        r.date >= analyticsDR.start &&
        r.date <= analyticsDR.end &&
        allowed.has(r.wid) &&
        rowMatchesCampaignScopeWithInference(r, activeCampaignId, campaignMeta, productMeta, selPid)
      );
    const byWid = _.groupBy(rows, "wid");
    const latestDate = analyticsDR.end || _.max(rows.map(r => r.date).filter(Boolean)) || DATA_END;
    return _.orderBy(activeWhs.filter(w => allowed.has(w.id)).map(w => {
      const storeRows = _.sortBy(byWid[w.id] || [], "date");
      const displayStats = warehouseDisplayStats(storeRows, w);
      if (!displayStats.eligible) return null;
      const trend = storeTrendFromRows(storeRows, latestDate);
      return { ...w, total:_.sumBy(storeRows,"rev"), units:_.sumBy(storeRows,"units"), pct:trend.pct, trend, rows:storeRows };
    }).filter(w => w && w.total > 0), "total", "desc");
  }, [tab, activeWhs, sales, consumerProdSales, selPid, activeCampaignId, salesRegion, salesState, analyticsDR, campaignMeta, productMeta, campaignChannel, salesViewModel]);

  const calendarSidebarRanked = useMemo(() => {
    if (tab !== "calendar") return [];
    if (campaignChannel === "online") return [];
    const rows = (activeCampaignId || calendarPid ? consumerProdSales.filter(r => (!calendarPid || productValuesMatch(r.pid, calendarPid, productMeta))) : sales)
      .filter(r => r.date >= calendarDR.start && r.date <= calendarDR.end && rowMatchesCampaignScope(r, activeCampaignId));
    const byWid = _.groupBy(rows, "wid");
    const latestDate = calendarDR.end || _.max(rows.map(r => r.date).filter(Boolean)) || DATA_END;
    return _.orderBy(activeWhs.map(w => {
      const storeRows = _.sortBy(byWid[w.id] || [], "date");
      const displayStats = warehouseDisplayStats(storeRows, w);
      if (!displayStats.eligible) return null;
      const trend = storeTrendFromRows(storeRows, latestDate);
      return { ...w, total:_.sumBy(storeRows,"rev"), units:_.sumBy(storeRows,"units"), pct:trend.pct, trend, rows:storeRows };
    }).filter(w => w && w.total > 0), "total", "desc");
  }, [tab, activeWhs, sales, consumerProdSales, calendarPid, calendarDR, activeCampaignId, campaignChannel, productMeta]);

  const mapRanked = useMemo(() => {
    if (tab !== "map") return [];
    const singleSelectedScope = mapScopes.length === 1 ? mapScopes[0] : null;
    const rows = (mapScopes.length ? consumerProdSales.filter(mapRowInProductScope) : sales)
      .filter(r => r.date >= campaignDR.start && r.date <= campaignDR.end && mapAllowedStoreIds.has(r.wid) && (Number(r.rev || 0) > 0 || Number(r.units || 0) > 0));
    const productRows = consumerProdSales
      .filter(r => r.date >= campaignDR.start && r.date <= campaignDR.end && mapAllowedStoreIds.has(r.wid) && mapRowInProductScope(r) && (Number(r.rev || 0) > 0 || Number(r.units || 0) > 0));
    const byWid = _.groupBy(rows, "wid");
    const productByWid = _.groupBy(productRows, "wid");
    const latestDate = campaignDR.end || _.max(rows.map(r => r.date).filter(Boolean)) || DATA_END;
    return _.orderBy(activeWhs.filter(w => mapAllowedStoreIds.has(w.id)).map(w => {
      const storeRows = _.sortBy(byWid[w.id] || [], "date");
      const displayStats = warehouseDisplayStats(storeRows, w);
      if (!displayStats.eligible) return null;
      const breakdown = _.orderBy(Object.entries(_.groupBy(productByWid[w.id] || [], mapProductKeyForRow)).map(([pid, pidRows]) => {
        const prod = productWithMeta(pid, productMeta);
        return { pid, product:prod?.short || pid || "Product", col:prod?.col || C.blue, rev:_.sumBy(pidRows, "rev"), units:_.sumBy(pidRows, "units") };
      }), "rev", "desc");
      const compareBreakdown = mapScopes.length
        ? mapScopes.map(scope => {
            const scopeRows = (productByWid[w.id] || []).filter(row => mapRowMatchesScope(row, scope));
            const rev = _.sumBy(scopeRows, "rev");
            const units = _.sumBy(scopeRows, "units");
            return { key:scope.key, pid:scope.pid, cid:scope.cid, product:scope.label, col:scope.col, rev, units, missing:rev <= 0 && units <= 0 };
          })
        : breakdown;
      const selectedHits = mapScopes.length ? compareBreakdown.filter(p => Number(p.rev || 0) > 0 || Number(p.units || 0) > 0).length : 0;
      if (mapComparisonMode && !mapComparisonStoreIsVisible(compareBreakdown, mapScopes.length)) return null;
      const comparisonA = mapComparisonMode ? compareBreakdown[0] : null;
      const comparisonB = mapComparisonMode ? compareBreakdown[1] : null;
      const comparisonLeader = mapComparisonMode
        ? Number(comparisonB?.rev || 0) > Number(comparisonA?.rev || 0) ? comparisonB : comparisonA
        : null;
      const comparisonDelta = mapComparisonMode ? Number(comparisonB?.rev || 0) - Number(comparisonA?.rev || 0) : 0;
      const comparisonEdge = mapComparisonMode
        ? Math.abs(comparisonDelta) / Math.max(Number(comparisonA?.rev || 0), Number(comparisonB?.rev || 0), 1)
        : 0;
      const trend = storeTrendFromRows(storeRows, latestDate);
      const markerColor = singleSelectedScope?.col || comparisonLeader?.col || breakdown[0]?.col || C.blue;
      const markerLabel = singleSelectedScope?.label || comparisonLeader?.product || breakdown[0]?.product || "";
      const visibleBreakdown = mapScopes.length ? compareBreakdown : breakdown;
      return { ...w, total:_.sumBy(storeRows,"rev"), units:_.sumBy(storeRows,"units"), pct:trend.pct, trend, rows:storeRows, productBreakdown:visibleBreakdown, compareBreakdown:mapScopes.length ? compareBreakdown : null, selectedHits, sharedSelectedProducts:mapScopes.length > 1 && selectedHits === mapScopes.length, markerColor, markerLabel, comparisonMode:mapComparisonMode, comparisonLeader:comparisonLeader?.product || "", comparisonLeaderKey:comparisonLeader?.key || comparisonLeader?.pid || "", comparisonLeaderPid:comparisonLeader?.pid || "", comparisonDelta, comparisonEdge, displayReason:displayStats.reason };
    }).filter(w => w && (w.total > 0 || w.units > 0)), "total", "desc");
  }, [tab, mapScopes, mapComparisonMode, mapRowInProductScope, mapRowMatchesScope, mapProductKeyForRow, activeWhs, consumerProdSales, sales, mapAllowedStoreIds, campaignDR, productMeta]);

  const inventoryAllowedStoreIds = useMemo(() => new Set(inventoryCoverageWhs
    .filter(w => (!inventoryRegion || w.region === inventoryRegion) && (!inventoryState || w.st === inventoryState))
    .map(w => w.id)), [inventoryCoverageWhs, inventoryRegion, inventoryState]);

  const inventorySidebarRanked = useMemo(() => {
    if (tab !== "inventory") return [];
    if (inventoryViewModel?.schema === "byou-intel-inventory-compact-v1") {
      return Array.isArray(inventoryViewModel.sidebarRows) ? inventoryViewModel.sidebarRows : [];
    }
    const rows = prodSales.filter(r =>
      r.date <= inventoryDR.end &&
      inventoryAllowedStoreIds.has(r.wid) &&
      (!inventoryPid || productValuesMatch(r.pid, inventoryPid, productMeta)) &&
      rowMatchesCampaignScope(r, activeCampaignId) &&
      (activeCampaignId || inventoryCampaignActiveAt(
        campaignWithMeta(r.cid, campaignMeta, productMeta),
        productWithMeta(r.pid, productMeta),
        { asOfDate:inventoryDR.end, grain:"physical_warehouse" },
      ))
    );
    const byWid = _.groupBy(rows, "wid");
    return _.orderBy(inventoryCoverageWhs.filter(w => inventoryAllowedStoreIds.has(w.id)).map(w => {
      const storeRows = _.sortBy(byWid[w.id] || [], "date");
      const campaignGroups = Object.values(_.groupBy(storeRows, inventoryCampaignScopeKey)).map(groupRows => {
        const sorted = _.sortBy(groupRows, "date");
        const evidence = inventoryCoverageEvidence(sorted);
        const latest = sorted.at(-1) || {};
        const approvalScope = {
          grain:"physical_warehouse",
          wid:latest.wid,
          pid:latest.pid,
          cid:latest.cid || "",
          inventoryDate:evidence.latestInventoryDate,
          onHand:evidence.onHand,
        };
        const approvedAllocation = matchingInventoryApproval(effectiveInventoryApprovals, approvalScope, inventoryApprovalEvaluationDate);
        const reviewDisposition = matchingInventoryReviewDisposition(inventoryReviewDispositions, approvalScope);
        const validationOptions = { asOfDate:inventoryDR.end, evaluationDate:inventoryApprovalEvaluationDate, approvedAllocation };
        const eligibility = inventoryEligibilityState(sorted, w, validationOptions);
        let validation = inventoryValidationEvidence(sorted, validationOptions);
        const ownerResult = resolveOwnerInventoryDecision(ownerInventoryDecisions, { ...approvalScope, grain:"physical_warehouse" }, sorted, inventoryDR.end);
        if (ownerResult?.conflict) {
          eligibility.countsAsStocked = false;
          validation = { ...validation, requiresReview:true };
        }
        if (ownerResult?.applied) {
          eligibility.countsAsStocked = ownerResult.includeInTotals && ownerResult.consumerEligible && ownerResult.onHand > 0;
          eligibility.evidence = { ...eligibility.evidence, onHand:ownerResult.onHand };
          validation = { ...validation, requiresReview:false };
        }
        const dispositionExcludesVerifiedInventory = !ownerResult?.applied && (reviewDisposition?.decision === "rejected"
          || (reviewDisposition?.decision === "reviewed_quarantined" && !validation.approvalApplied));
        return {
          rows:sorted,
          pid:String(sorted.at(-1)?.pid || ""),
          cid:String(sorted.at(-1)?.cid || ""),
          latestDate:eligibility.evidence.latestInventoryDate || String(sorted.at(-1)?.date || ""),
          eligibility,
          validation,
          dispositionExcludesVerifiedInventory,
        };
      });
      const eligibleProductGroups = campaignGroups.filter(group => group.eligibility.countsAsStocked && !group.validation.requiresReview && !group.dispositionExcludesVerifiedInventory);
      const total = _.sumBy(eligibleProductGroups, group => Number(group.eligibility.evidence.onHand || 0));
      const periodRows = eligibleProductGroups.flatMap(group => group.rows.filter(row => row.date >= inventoryDR.start));
      const coverageEvidence = inventoryCoverageEvidence(periodRows);
      const soldUnits = coverageEvidence.totalUnits;
      const netUnits = coverageEvidence.netUnits;
      const peakOnHand = Math.max(0, ...eligibleProductGroups.map(group => Number(group.eligibility.evidence.peakOnHand || 0)));
      const revenue = coverageEvidence.revenue;
      const sellThrough = inventorySellThrough(soldUnits, total);
      return { ...w, total, units:total, soldUnits, netUnits, peakOnHand, pct:sellThrough, sellThrough, revenue, rows:periodRows, hasCurrentInventory:eligibleProductGroups.length > 0 };
    }).filter(w => w && w.hasCurrentInventory), ["sellThrough", "name"], ["asc", "asc"]);
  }, [tab, inventoryViewModel, inventoryCoverageWhs, prodSales, inventoryDR, inventoryAllowedStoreIds, inventoryPid, activeCampaignId, effectiveInventoryApprovals, inventoryApprovalEvaluationDate, inventoryReviewDispositions, ownerInventoryDecisions, campaignMeta, productMeta]);

  const mapRankedStoreIds = useMemo(() => new Set(mapRanked.map(w => w.id)), [mapRanked]);
  const mapSales = useMemo(() => {
    if (tab !== "map") return [];
    return (mapScopes.length ? consumerProdSales.filter(mapRowInProductScope) : sales)
      .filter(r => r.date >= campaignDR.start && r.date <= campaignDR.end && mapAllowedStoreIds.has(r.wid) && mapRankedStoreIds.has(r.wid) && (Number(r.rev || 0) > 0 || Number(r.units || 0) > 0));
  }, [tab, mapScopes, mapRowInProductScope, mapRankedStoreIds, consumerProdSales, sales, mapAllowedStoreIds, campaignDR]);

  useEffect(() => {
    if (tab === "map" && selId && !mapRanked.some(w => w.id === selId)) setSelId(null);
  }, [tab, selId, mapRanked]);
  useEffect(() => {
    if (tab === "inventory" && selId && !inventorySidebarRanked.some(w => w.id === selId)) setSelId(null);
  }, [tab, selId, inventorySidebarRanked]);

  // dailyMap — respects both selId and calendarPid for Calendar tab
  // ── CSV processing ────────────────────────────────────────────
  const processCsvData = useCallback((data, source, baseWhs = whs, options = {}) => {
    invalidateRuntimeModelsForLocalData();
    if (detailLoadedRef.current) setLocalOwnerSalesHistory(true);
    const replace = !!options.replace;
    const importProductMeta = options.productMeta || productMeta;
    const importCampaignMeta = options.campaignMeta || campaignMeta;
    const rawConsolidated = data.some(row => cellValue(row, ["1 Week Ending","Week Ending","Dollar Sales","Venue"]));
    if (rawConsolidated) {
      const compiled = compileWorkbookCsvData(data, source, baseWhs, importProductMeta, importCampaignMeta);
      const mergedRows = mergeWorkbookRows({ sales, prodSales }, compiled, replace);
      const nextSales = mergedRows.sales;
      const nextProdSales = mergedRows.prodSales;
      const nextWorkbookSales = replace
        ? compiled.workbookSales
        : compileWorkbookSalesFromRows(nextSales, nextProdSales, source, compiled.whs, PRODUCTS);
      setWhs(compiled.whs);
      setSales(nextSales);
      setProdSales(nextProdSales);
      setWarehouseDailySales(aggregateWarehouseDailySales(nextProdSales));
      setWorkbookSales(nextWorkbookSales);
      setAnalyticsDR({ start:nextWorkbookSales.meta.start, end:nextWorkbookSales.meta.end });
      return compiled.workbookSales.meta.rows;
    }
    let nextWhs = [...baseWhs];
    const newRows = [], newProdRows = [], newNotes = [];
    const prodAgg = new Map();
    carryForwardStoreRows(data).forEach(row => {
      const date    = importDateValue(row, ["Date","1 Week Ending","Week Ending","Week","Time"]);
      const wname   = storeNameFromRow(row);
      let rev       = numberValue(cellValue(row, ["Revenue","Dollar Sales","Sales Dollars"]));
      let units     = Math.round(numberValue(cellValue(row, ["Units","Unit Sales","Units Sold"])));
      const invRaw  = cellValue(row, ["Inventory On Hand","Inventory","On Hand","Available Inventory","Available Units","Ending Inventory","Stock On Hand"]);
      const invKnown= hasKnownNumber(invRaw);
      const inv     = Math.round(numberValue(invRaw));
      const inbound = Math.round(numberValue(cellValue(row, ["Inbound","Incoming","Inbound Units","Incoming Units","On Order","Replenishment"])));
      const reserved= Math.round(numberValue(cellValue(row, ["Reserved","Committed","Reserved Units","Allocated","Allocated Units"])));
      const evLabel = String(cellValue(row, ["Event","Title"])).trim();
      const prodStr = String(cellValue(row, ["Product","Item","Brand"])).trim();
      if (!date || !wname || (!rev && !units && !invKnown && !inbound && !reserved)) return;
      let w = findStore(wname, nextWhs);
      if (!w) {
        const fallback = findStore(wname, WAREHOUSES);
        const identity = allocateWarehouseIdentity(wname, nextWhs, fallback);
        const coords = normalizeCoords(
          cellValue(row, ["Lat","Latitude"]),
          cellValue(row, ["Lng","Longitude","Long"]),
          fallback?.lat || 39.5,
          fallback?.lng || -98.35
        );
        w = { ...fallback, ...identity, name:wname, warehouseNo:warehouseNumberFromText(wname) || fallback?.warehouseNo, city:cellValue(row, ["City"])||fallback?.city||wname, st:cellValue(row, ["State","State or Province"])||fallback?.st||"CA",
              region:cellValue(row, ["Region"])||fallback?.region||"Unassigned",
              lat:coords.lat,
              lng:coords.lng, base:isNonStoreInventoryLocation({ name:wname }) ? 0 : rev };
        nextWhs = [...nextWhs, w];
      }
      if (isNonStoreInventoryLocation(w)) {
        rev = 0;
        units = 0;
      }
      const prod = matchProduct(prodStr, importProductMeta);
      const campaign = prod ? campaignForRow(row, { campaignMeta:importCampaignMeta, productMeta:importProductMeta, pid:prod.id, date, channel:"Inline" }) : null;
      if (prod) {
        newProdRows.push({ wid:w.id, pid:prod.id, cid:campaign?.id || "", campaign:campaign?.short || "", date, rev, units, promo:0, refund:0, inv, invKnown, inbound, reserved, isDemo:!!evLabel });
        const key = `${date}|${w.id}`;
        const agg = prodAgg.get(key) || { wid:w.id, date, rev:0, units:0, inv:0, invKnown:true, inbound:0, reserved:0, isDemo:false, pids:new Set() };
        agg.rev += rev; agg.units += units; agg.inv += inv; agg.inbound += inbound; agg.reserved += reserved; agg.isDemo = agg.isDemo || !!evLabel;
        agg.invKnown = agg.invKnown && invKnown;
        agg.pids.add(prod.id);
        prodAgg.set(key, agg);
      } else {
        newRows.push({ wid:w.id, date, rev, units, inv, invKnown, inbound, reserved, isDemo:!!evLabel });
      }
      if (evLabel) newNotes.push({ id:Date.now()+Math.random(), date, wid:w.id, pid:prod?.id||null, cid:campaign?.id || "", type:"demo", title:evLabel, body:`Imported from ${source}.`, ...importedNoteMarker(source, "sales_event") });
    });
    const explicitSales = new Set(newRows.map(r => `${r.date}|${r.wid}`));
    let syntheticSales = 0;
    prodAgg.forEach((agg, key) => {
      if (explicitSales.has(key)) return;
      const existing = replace ? [] : prodSales.filter(r => r.date===agg.date && r.wid===agg.wid && !agg.pids.has(r.pid));
      newRows.push({
        wid:agg.wid, date:agg.date,
        rev:agg.rev + _.sumBy(existing,"rev"),
        units:agg.units + _.sumBy(existing,"units"),
        inv:agg.inv + _.sumBy(existing,"inv"),
        invKnown:agg.invKnown && existing.every(inventoryRowHasKnownBalance),
        inbound:agg.inbound + _.sumBy(existing,"inbound"),
        reserved:agg.reserved + _.sumBy(existing,"reserved"),
        isDemo:agg.isDemo || existing.some(r => r.isDemo),
      });
      syntheticSales++;
    });
    if (nextWhs.length !== baseWhs.length) setWhs(nextWhs);
    if (newRows.length || replace)     setSales(prev => upsertByKey(replace ? [] : prev,newRows,r=>`${r.date}|${r.wid}`));
    if (newProdRows.length || replace) {
      const nextProdSales = upsertByKey(replace ? [] : prodSales,newProdRows,r=>`${r.date}|${r.wid}|${r.pid}|${r.cid||""}`);
      setProdSales(nextProdSales);
      setWarehouseDailySales(aggregateWarehouseDailySales(nextProdSales));
    }
    if (newNotes.length || replace)    setFootnotes(prev => { const base = replace ? prev.filter(note => !isImportedFootnote(note, "sales_event")) : prev; const unique=uniqueByExisting(base,newNotes,f=>`${f.date}|${f.wid||""}|${f.pid||""}|${f.type}|${f.title}`); return unique.length ? [...base,...unique] : base; });
    return newRows.length - syntheticSales + newProdRows.length;
  }, [whs, sales, prodSales, productMeta, campaignMeta, invalidateRuntimeModelsForLocalData]);

  const processCalendarRows = useCallback((data, source, whList = whs, options = {}) => {
    const replace = !!options.replace;
    const importProductMeta = options.productMeta || productMeta;
    const importCampaignMeta = options.campaignMeta || campaignMeta;
    const newNotes = [];
    data.forEach(row => {
      const date = normalizeDateValue(cellValue(row, ["Date","Event Date","Post Date"]));
      const type = normalizeEventType(cellValue(row, ["Type","Event Type","Category"]));
      const productRaw = productDisplayName(String(cellValue(row, ["Product","Product Name","SKU","Product ID","Product_ID","PID","Short Name","Product_Short","Product Short"])).trim());
      const prod = matchProductExact(productRaw, importProductMeta);
      const productValue = prod?.id || productRaw || "";
      const campaign = campaignForRow(row, { campaignMeta:importCampaignMeta, productMeta:importProductMeta, pid:prod?.id || productRaw, date });
      const storeName = storeNameFromRow(row);
      const store = findStore(storeName, whList);
      const channel = String(cellValue(row, ["Online/Inline","Online/In-Line","Online_In_Line","Channel","Sales Channel","Scope"])).trim();
      const title = String(cellValue(row, ["Title","Event","Event Title"])).trim();
      const notes = String(cellValue(row, ["Notes","Description","Body","Context"])).trim();
      const region = String(cellValue(row, ["Region"])).trim();
      const state = String(cellValue(row, ["State","State or Province"])).trim();
      if (!date || !title) return;
      const scope = [region, state].filter(Boolean).join(" / ");
      const body = [notes, scope ? `Scope: ${scope}` : "", `Imported from ${source}.`].filter(Boolean).join("\n");
      newNotes.push({ id:Date.now()+Math.random(), date, wid:store?.id||"", pid:productValue, cid:campaign?.id || "", campaign:campaign?.short || "", product:productDisplayName(prod?.short || productRaw), channel, type, title, body, ...importedNoteMarker(source, "calendar_event") });
    });
    if (newNotes.length || replace) {
      setFootnotes(prev => {
        const base = replace ? prev.filter(note => !isImportedFootnote(note, "calendar_event")) : prev;
        const unique = uniqueByExisting(base, newNotes, f => `${f.date}|${f.wid||""}|${f.pid||""}|${f.type}|${f.title}`);
        return unique.length ? [...base, ...unique] : base;
      });
    }
    return newNotes.length;
  }, [whs, productMeta, campaignMeta]);

  const processInlineInventoryRows = useCallback((data, source = "Inline inventory", baseWhs = whs, options = {}) => {
    const importProductMeta = options.productMeta || productMeta;
    const importCampaignMeta = options.campaignMeta || campaignMeta;
    let nextWhs = [...baseWhs];
    const newRows = [];
    carryForwardStoreRows(data).forEach(row => {
      const date = importDateValue(row, ["Date","Week Ending","1 Week Ending","Snapshot Date","Time"]);
      const wname = storeNameFromRow(row);
      const prod = matchProduct(cellValue(row, PRODUCT_IMPORT_COLUMNS), importProductMeta);
      const campaign = prod ? campaignForRow(row, { campaignMeta:importCampaignMeta, productMeta:importProductMeta, pid:prod.id, date, channel:"Inline" }) : null;
      const invRaw = cellValue(row, ["Inventory","Inventory On Hand","On Hand","Available Inventory","Available Units","Ending Inventory","Stock On Hand"]);
      const invKnown = hasKnownNumber(invRaw);
      const inv = Math.round(numberValue(invRaw));
      const inbound = Math.round(numberValue(cellValue(row, ["Inbound","Incoming","Inbound Units","Incoming Units","On Order","Replenishment"])));
      const reserved = Math.round(numberValue(cellValue(row, ["Reserved","Committed","Reserved Units","Allocated","Allocated Units"])));
      let units = Math.round(numberValue(cellValue(row, ["Units","Unit Sales","Units Sold","Sales Units","Quantity","Qty"])));
      if (!date || !wname || !prod || (!invKnown && !inbound && !reserved && !units)) return;
      let w = findStore(wname, nextWhs);
      if (!w) {
        const fallback = findStore(wname, WAREHOUSES);
        const identity = allocateWarehouseIdentity(wname, nextWhs, fallback);
        const coords = normalizeCoords(
          cellValue(row, ["Lat","Latitude"]),
          cellValue(row, ["Lng","Longitude","Long"]),
          fallback?.lat || 39.5,
          fallback?.lng || -98.35
        );
        w = {
          ...fallback,
          ...identity,
          name:wname,
          warehouseNo:warehouseNumberFromText(wname) || fallback?.warehouseNo,
          city:String(cellValue(row, ["City"])).trim() || fallback?.city || wname,
          st:String(cellValue(row, ["State","State or Province"])).trim() || fallback?.st || "",
          region:String(cellValue(row, ["Region"])).trim() || fallback?.region || "Unassigned",
          lat:coords.lat,
          lng:coords.lng,
          base:0,
        };
        nextWhs = [...nextWhs, w];
      }
      if (isNonStoreInventoryLocation(w)) units = 0;
      newRows.push({ wid:w.id, pid:prod.id, cid:campaign?.id || "", campaign:campaign?.short || "", date, rev:0, units, promo:0, refund:0, inv, invKnown, inbound, reserved, isDemo:false, source });
    });
    if (nextWhs.length !== baseWhs.length) setWhs(nextWhs);
    if (newRows.length) {
      setProdSales(prev => {
        const next = new Map(prev.map(r => [`${r.date}|${r.wid}|${r.pid}|${r.cid||""}`, r]));
        newRows.forEach(row => {
          const key = `${row.date}|${row.wid}|${row.pid}|${row.cid||""}`;
          const old = next.get(key);
          next.set(key, {
            ...old,
            ...row,
            rev:old?.rev || row.rev || 0,
            units:old?.units || row.units || 0,
            promo:old?.promo || 0,
            refund:old?.refund || 0,
            inv:row.invKnown ? row.inv : old?.inv || 0,
            invKnown:row.invKnown || inventoryRowHasKnownBalance(old),
            inbound:row.inbound,
            reserved:row.reserved,
            isDemo:old?.isDemo || row.isDemo || false,
          });
        });
        return Array.from(next.values());
      });
      const aggregateRows = Object.entries(_.groupBy(newRows, r => `${r.date}|${r.wid}`)).map(([, rows]) => ({
        wid:rows[0].wid,
        date:rows[0].date,
        rev:0,
        units:_.sumBy(rows, "units"),
        promo:0,
        refund:0,
        inv:_.sumBy(rows, "inv"),
        invKnown:rows.every(inventoryRowHasKnownBalance),
        inbound:_.sumBy(rows, "inbound"),
        reserved:_.sumBy(rows, "reserved"),
        isDemo:false,
      }));
      setSales(prev => {
        const next = new Map(prev.map(r => [`${r.date}|${r.wid}`, r]));
        aggregateRows.forEach(row => {
          const old = next.get(`${row.date}|${row.wid}`);
          next.set(`${row.date}|${row.wid}`, {
            ...old,
            ...row,
            rev:old?.rev || 0,
            units:old?.units || row.units || 0,
            promo:old?.promo || 0,
            refund:old?.refund || 0,
            inv:row.invKnown ? row.inv : old?.inv || 0,
            invKnown:row.invKnown || inventoryRowHasKnownBalance(old),
            inbound:row.inbound,
            reserved:row.reserved,
            isDemo:old?.isDemo || false,
          });
        });
        return Array.from(next.values()).sort((a,b) => a.wid.localeCompare(b.wid) || a.date.localeCompare(b.date));
      });
    }
    return newRows.length;
  }, [whs, productMeta, campaignMeta]);

  const processInlineTotalSalesRows = useCallback((data, source = "Costco inline totals", options = {}) => {
    const replace = !!options.replace;
    const rows = compileTotalSalesRows(data, source, "Inline", options.productMeta || productMeta, options.campaignMeta || campaignMeta);
    if (rows.length || replace) {
      setInlineTotalSales(prev => {
        const next = new Map((replace ? [] : prev).map(r => [`${r.date}|${r.pid}|${r.cid||""}|${r.channel}`, r]));
        rows.forEach(row => next.set(`${row.date}|${row.pid}|${row.cid||""}|${row.channel}`, row));
        return Array.from(next.values()).sort((a,b) => a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel) || a.product.localeCompare(b.product));
      });
    }
    return rows.length;
  }, [productMeta, campaignMeta]);

  const processOnlineSalesRows = useCallback((data, source = "Online upload", options = {}) => {
    setInventoryViewModel(null);
    if (detailLoadedRef.current) setLocalOwnerSalesHistory(true);
    const replace = !!options.replace;
    const importProductMeta = options.productMeta || productMeta;
    const importCampaignMeta = options.campaignMeta || campaignMeta;
    const rowMap = new Map();
    prepareCostcoBlockRows(data).forEach(row => {
      const date = importDateValue(row, ["Date","Week Ending","1 Week Ending","Order Date","Snapshot Date","Time"]);
      const prod = matchProduct(cellValue(row, PRODUCT_IMPORT_COLUMNS), importProductMeta);
      const channel = String(cellValue(row, ["Channel","Storefront","Marketplace","Platform","Source"])).trim() || "Online";
      const campaign = prod ? campaignForRow(row, { campaignMeta:importCampaignMeta, productMeta:importProductMeta, pid:prod.id, date, channel }) : null;
      const rev = numberValue(cellValue(row, ["Revenue","Dollar Sales","Sales Dollars","Net Sales","Gross Sales"]));
      const units = Math.round(numberValue(cellValue(row, ["Units","Unit Sales","Units Sold","Quantity","Qty"])));
      const orders = Math.round(numberValue(cellValue(row, ["Orders","Order Count","Transactions"])));
      const sessions = Math.round(numberValue(cellValue(row, ["Sessions","Visits","Traffic"])));
      const adSpend = numberValue(cellValue(row, ["Ad Spend","Ad_Spend","Marketing Spend","Media Spend","Spend"]));
      const invRaw = cellValue(row, ["Inventory","Inventory On Hand","On Hand","Available Inventory","Available Units","Ending Inventory","Stock On Hand"]);
      const inboundRaw = cellValue(row, ["Inbound","Incoming","Inbound Units","Incoming Units","On Order","Replenishment"]);
      const reservedRaw = cellValue(row, ["Reserved","Committed","Reserved Units","Allocated","Allocated Units"]);
      const invKnown = hasKnownNumber(invRaw);
      const inboundKnown = hasKnownNumber(inboundRaw);
      const reservedKnown = hasKnownNumber(reservedRaw);
      const inv = Math.round(numberValue(invRaw));
      const inbound = Math.round(numberValue(inboundRaw));
      const reserved = Math.round(numberValue(reservedRaw));
      const notes = String(cellValue(row, ["Notes","Context","Comment"])).trim();
      if (!date || (!rev && !units && !orders && !inv && !inbound && !reserved)) return;
      const key = `${date}|${prod?.id || ""}|${campaign?.id || ""}|${channel}`;
      const cur = rowMap.get(key) || { date, pid:prod?.id || "", cid:campaign?.id || "", product:prod?.short || productDisplayName(String(cellValue(row, PRODUCT_IMPORT_COLUMNS)).trim()) || "Unassigned", campaign:campaign?.short || "", channel, rev:0, units:0, orders:0, sessions:0, adSpend:0, inv:0, inbound:0, reserved:0, invKnown:false, inboundKnown:false, reservedKnown:false, notes:"", source };
      cur.rev += rev;
      cur.units += units;
      cur.orders += orders;
      cur.sessions += sessions;
      cur.adSpend += adSpend;
      cur.inv += inv;
      cur.inbound += inbound;
      cur.reserved += reserved;
      cur.invKnown = cur.invKnown || invKnown;
      cur.inboundKnown = cur.inboundKnown || inboundKnown;
      cur.reservedKnown = cur.reservedKnown || reservedKnown;
      if (notes && !cur.notes.includes(notes)) cur.notes = [cur.notes, notes].filter(Boolean).join(" | ");
      rowMap.set(key, cur);
    });
    const rows = Array.from(rowMap.values()).sort((a,b) => a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel) || a.product.localeCompare(b.product));
    if (rows.length || replace) {
      setOnlineSales(prev => {
        const next = new Map((replace ? [] : prev).map(r => [`${r.date}|${r.pid}|${r.cid||""}|${r.channel}`, r]));
        rows.forEach(row => {
          const key = `${row.date}|${row.pid}|${row.cid||""}|${row.channel}`;
          const old = next.get(key);
          next.set(key, {
            ...old,
            ...row,
            rev:row.rev || old?.rev || 0,
            units:row.units || old?.units || 0,
            orders:row.orders || old?.orders || 0,
            sessions:row.sessions || old?.sessions || 0,
            adSpend:row.adSpend || old?.adSpend || 0,
            inv:row.invKnown ? row.inv : old?.inv || 0,
            inbound:row.inboundKnown ? row.inbound : old?.inbound || 0,
            reserved:row.reservedKnown ? row.reserved : old?.reserved || 0,
            notes:[old?.notes, row.notes].filter(Boolean).join(" | "),
          });
        });
        return Array.from(next.values()).sort((a,b) => a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel) || a.product.localeCompare(b.product));
      });
    }
    return rows.length;
  }, [productMeta, campaignMeta]);

  const looksLikeInlineTotalSource = useCallback((data, source = "") => {
    const sourceText = String(source || "").toLowerCase();
    const keys = new Set((data[0] ? Object.keys(data[0]) : []).map(k => k.trim().toLowerCase()));
    const hasKey = (...names) => names.some(n => keys.has(String(n).toLowerCase()));
    const sampleText = data.slice(0, 20).map(row => [
      cellValue(row, ["Channel","Storefront","Marketplace","Platform","Source","Sales Channel"]),
      cellValue(row, ["Dataset","Sheet","Type"]),
      cellValue(row, ["Venue","Region","Market"]),
    ].filter(Boolean).join(" ")).join(" ").toLowerCase();
    const text = `${sourceText} ${sampleText}`;
    if (hasKey(...WAREHOUSE_SELLING_COLUMNS) && /\btotal\b/i.test(sampleText)) return true;
    return /(inline|in[-_\s]*line|costco.*daily|daily.*sales|total.*sales)/i.test(text) &&
      !/(online|e[-_\s]*commerce|amazon|dtc|shopify|tiktok\s*shop)/i.test(text);
  }, []);

  const showToast = useCallback(msg => {
    setToast(msg);
    setTimeout(() => setToast(null), String(msg).startsWith("⚠") || /failed|unavailable/i.test(String(msg)) ? 6500 : 4000);
  }, []);

  useEffect(() => {
    if (sharedDatasetStatus.state === "loading") {
      setPublishedStatusToast({ id:`loading-${Date.now()}`, message:t("status.loadingData", "Loading data...") });
      return;
    }
    if (sharedDatasetStatus.state === "loaded" && ["network", "cache-validated"].includes(sharedDatasetStatus.source)) {
      setPublishedStatusToast({ id:`complete-${Date.now()}`, message:t("status.dataLoadComplete", "Data load complete.") });
      const timeoutId = window.setTimeout(() => setPublishedStatusToast(null), 3000);
      return () => window.clearTimeout(timeoutId);
    }
    if (sharedDatasetStatus.state === "error" || sharedDatasetStatus.warning) setPublishedStatusToast(null);
  }, [sharedDatasetStatus.state, sharedDatasetStatus.source, sharedDatasetStatus.warning, t]);

  useEffect(() => {
    if (!notesDirty) return;
    const handler = e => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [notesDirty]);

  const datasetDateBoundsFrom = useCallback(dataset => {
    const summaryBounds = dataset?.summaries?.bounds;
    if (summaryBounds?.start && summaryBounds?.end) return summaryBounds;
    return dateBoundsFromRows(dataset?.workbookSales?.meta?.start, dataset?.workbookSales?.meta?.end, [
      dataset?.sales,
      dataset?.prodSales,
      dataset?.inlineTotalSales,
      dataset?.onlineSales,
      dataset?.ppcRows,
    ]);
  }, []);

  const effectiveOwnerSalesHistory = useMemo(() => localOwnerSalesHistory
    ? buildOwnerSalesCorrectionHistory({ ownerSalesCorrections, productMeta, campaignMeta, whs, prodSales, onlineSales })
    : ownerSalesCorrectionHistory,
  [localOwnerSalesHistory, ownerSalesCorrections, ownerSalesCorrectionHistory, productMeta, campaignMeta, whs, prodSales, onlineSales]);

  const buildPublishedDataset = useCallback(() => ({
    schema:"byou-intel-dataset-v1",
    version:1,
    publishedAt:new Date().toISOString(),
    productMeta,
    campaignMeta,
    inventoryApprovals,
    inventoryReviewDispositions,
    ownerInventoryDecisions,
    ownerSalesCorrections,
    whs,
    sales,
    prodSales,
    inlineTotalSales,
    onlineSales,
    ppcRows,
    workbookSales,
    footnotes,
    videos,
    videoMetrics,
  }), [productMeta, campaignMeta, inventoryApprovals, inventoryReviewDispositions, ownerInventoryDecisions, ownerSalesCorrections, whs, sales, prodSales, inlineTotalSales, onlineSales, ppcRows, workbookSales, footnotes, videos, videoMetrics]);

  const restoreStartupSummaryDataset = useCallback(() => {
    const dataset = latestStartupDatasetRef.current;
    if (!dataset) return false;
    setLocalOwnerSalesHistory(false);
    setOwnerInventoryDecisions(dataset.ownerInventoryDecisions || []);
    setOwnerSalesCorrections(dataset.ownerSalesCorrections || []);
    setOwnerSalesCorrectionHistory(dataset.ownerSalesCorrectionHistory || []);
    detailLoadedRef.current = false;
    setDetailDatasetLoaded(false);
    runtimeViewAppliedRef.current = false;
    setInventoryViewModel(null);
    setAnalysisViewModel(null);
    setSalesViewModel(null);
    setCampaignComparison(null);
    setSales(Array.isArray(dataset?.summaries?.campaign?.portfolioWarehouse) ? dataset.summaries.campaign.portfolioWarehouse : []);
    setProdSales(Array.isArray(dataset?.summaries?.campaign?.warehouse) ? dataset.summaries.campaign.warehouse : []);
    setInlineTotalSales(Array.isArray(dataset.inlineTotalSales) ? dataset.inlineTotalSales : []);
    setWarehouseDailySales(Array.isArray(dataset.warehouseDailySales) ? dataset.warehouseDailySales : []);
    setOnlineSales(Array.isArray(dataset.onlineSales) ? dataset.onlineSales : []);
    setInventoryApprovals(splitInventoryApprovalSources(dataset.inventoryApprovals).published);
    setInventoryReviewDispositions(Array.isArray(dataset.inventoryReviewDispositions) ? dataset.inventoryReviewDispositions : []);
    setPpcRows(reconcilePpcAssignments(Array.isArray(dataset.ppcRows) ? dataset.ppcRows : [], dataset.productMeta || productMeta, dataset.campaignMeta || campaignMeta));
    setFootnotes([]);
    setVideos([]);
    setVideoMetrics([]);
    setAnalysisSummaries({ daily:[], regionDaily:[], stateDaily:[] });
    return true;
  }, [productMeta, campaignMeta]);

  const applyStartupDataset = useCallback((dataset, { source = "network", startedAt = performance.now(), metrics = {} } = {}) => {
    if (!["byou-intel-bootstrap-v4", "byou-intel-bootstrap-v3", "byou-intel-startup-v2"].includes(dataset?.schema)) throw new Error("The published startup dataset is not compatible with this BYOU Intel build.");
    setLocalOwnerSalesHistory(false);
    setOwnerInventoryDecisions(dataset.ownerInventoryDecisions || []);
    setOwnerSalesCorrections(dataset.ownerSalesCorrections || []);
    setOwnerSalesCorrectionHistory(dataset.ownerSalesCorrectionHistory || []);
    const startupApprovalRows = Array.isArray(dataset.publishedInventoryApprovals)
      ? dataset.publishedInventoryApprovals
      : dataset.inventoryApprovals;
    const approvalSources = splitInventoryApprovalSources(startupApprovalRows);
    latestStartupDatasetRef.current = { ...dataset, inventoryApprovals:approvalSources.published };
    const nextWhs = Array.isArray(dataset.whs) && dataset.whs.length ? dataset.whs : WAREHOUSES;
    const nextWorkbookSales = dataset.workbookSales || compileWorkbookSalesFromRows([], [], "Published startup", [], PRODUCTS);
    const nextProductMeta = dataset.productMeta || {};
    const nextCampaignMeta = dataset.campaignMeta || {};
    const samePublishedDataset = !!publishedAtRef.current && publishedAtRef.current === dataset.publishedAt;
    const keepLoadedDetails = detailLoadedRef.current && samePublishedDataset;
    const keepLoadedView = samePublishedDataset && runtimeViewCacheRef.current.size > 0;
    if (!samePublishedDataset) runtimeViewAppliedRef.current = false;
    publishedAtRef.current = dataset.publishedAt || "";
    startupBoundsRef.current = datasetDateBoundsFrom(dataset);
    setProductMeta(nextProductMeta);
    setCampaignMeta(nextCampaignMeta);
    setInventoryApprovals(approvalSources.published);
    if (dataset.approvalRevision !== undefined) setInventoryApprovalRevision(String(dataset.approvalRevision || "0"));
    // The small, authenticated approval endpoint exclusively owns the manual runtime overlay.
    // Startup/bootstrap responses may be stale relative to an in-flight approval or removal.
    if (!samePublishedDataset) {
      setManualInventoryApprovals([]);
      setInventoryApprovalEnabled(false);
      setInventoryApprovalOverlayPublication("");
      setInventoryApprovalOverlayError("");
      setInventoryViewModel(null);
      setAnalysisViewModel(null);
      setSalesViewModel(null);
    }
    setInventoryReviewDispositions(Array.isArray(dataset.inventoryReviewDispositions) ? dataset.inventoryReviewDispositions : []);
    setWhs(nextWhs);
    const legacyActiveIds = (dataset?.summaries?.campaign?.portfolioWarehouse || []).filter(row => Number(row?.rev || 0) > 0 || Number(row?.units || 0) > 0).map(row => String(row?.wid || "")).filter(Boolean);
    setPublishedActiveWarehouseIds(Array.isArray(dataset.activeWarehouseIds) ? dataset.activeWarehouseIds : legacyActiveIds);
    setCampaignRevenueDoorSummary(dataset?.summaries?.campaign?.revenueDoor || null);
    setCampaignAutomaticRevenueDoorSummary(dataset?.summaries?.campaign?.automaticRevenueDoor || null);
    if (!samePublishedDataset) runtimeViewCacheRef.current.clear();
    if (!keepLoadedDetails && !keepLoadedView) {
      detailLoadedRef.current = false;
      setDetailDatasetLoaded(false);
      setSales(Array.isArray(dataset?.summaries?.campaign?.portfolioWarehouse) ? dataset.summaries.campaign.portfolioWarehouse : []);
      setProdSales(Array.isArray(dataset?.summaries?.campaign?.warehouse) ? dataset.summaries.campaign.warehouse : []);
      setPpcRows(reconcilePpcAssignments(Array.isArray(dataset.ppcRows) ? dataset.ppcRows : [], nextProductMeta, nextCampaignMeta));
      setFootnotes([]);
      setVideos([]);
      setVideoMetrics([]);
      setAnalysisSummaries({ daily:[], regionDaily:[], stateDaily:[] });
      setDetailDatasetStatus({ state:"idle", message:"Loading the current Campaign query..." });
    }
    setInlineTotalSales(Array.isArray(dataset.inlineTotalSales) ? dataset.inlineTotalSales : []);
    setWarehouseDailySales(Array.isArray(dataset.warehouseDailySales) ? dataset.warehouseDailySales : []);
    setOnlineSales(Array.isArray(dataset.onlineSales) ? dataset.onlineSales : []);
    setWorkbookSales(nextWorkbookSales);
    const bounds = startupBoundsRef.current;
    const nextCampaignBounds = campaignMetricDateBounds(
      effectiveInlineSalesRows(dataset.inlineTotalSales || [], dataset.warehouseDailySales || []),
      dataset.onlineSales || [],
      bounds,
    );
    const nextCalendarBounds = { start:bounds.start, end:maxDateKey(bounds.end, todayKey) };
    if (!samePublishedDataset) {
      setCampaignComparison(null);
      setCampaignDR(campaignAutomaticDateRange(nextCampaignBounds, CAMPAIGN_DEFAULT_START));
      setAnalyticsDR(bounds);
      setInventoryDR(bounds);
      calendarDateAutoRef.current = true;
      setCalendarDR(calendarDefaultDateRange(nextCalendarBounds, todayKey));
      setSelId(null);
      setSelVid(null);
      setCampaignCid("");
    }
    setNotesDirty(false);
    setDatasetTimings(previous => ({ ...previous, ...metrics }));
    setSharedDatasetStatus({
      state:"loaded",
      message:source === "cache"
        ? "Showing the last published snapshot while BYOU Intel checks for a newer version."
        : "Published dashboard definitions are loaded. Fetching the current view...",
      publishedAt:dataset.publishedAt || "",
      source,
      warning:"",
    });
    startupPaintRef.current = { startedAt, source };
    setStartupRenderToken(token => token + 1);
  }, [datasetDateBoundsFrom, todayKey]);

  const applyDetailDataset = useCallback((dataset, metrics = {}) => {
    if (dataset?.schema !== "byou-intel-dataset-v1") throw new Error("The warehouse-detail dataset is not compatible with BYOU Intel.");
    invalidateRuntimeModelsForLocalData();
    setLocalOwnerSalesHistory(false);
    setOwnerInventoryDecisions(dataset.ownerInventoryDecisions || []);
    setOwnerSalesCorrections(dataset.ownerSalesCorrections || []);
    setOwnerSalesCorrectionHistory(buildOwnerSalesCorrectionHistory(dataset));
    const nextProductMeta = dataset.productMeta || productMeta;
    const nextCampaignMeta = dataset.campaignMeta || campaignMeta;
    if (Array.isArray(dataset.whs) && dataset.whs.length) setWhs(dataset.whs);
    if (Array.isArray(dataset.sales)) setSales(dataset.sales);
    if (Array.isArray(dataset.prodSales)) setProdSales(dataset.prodSales);
    // Manual approvals are a small database-backed overlay. The deferred full
    // dataset file intentionally does not replace this authoritative runtime state.
    if (Array.isArray(dataset.inventoryReviewDispositions)) setInventoryReviewDispositions(dataset.inventoryReviewDispositions);
    if (Array.isArray(dataset.warehouseDailySales)) setWarehouseDailySales(dataset.warehouseDailySales);
    if (dataset.workbookSales) setWorkbookSales(dataset.workbookSales);
    detailLoadedRef.current = true;
    setDetailDatasetLoaded(true);
    setPublishedActiveWarehouseIds([]);
    setDatasetTimings(previous => ({ ...previous, ...metrics }));
    setDetailDatasetStatus({
      state:"loaded",
      message:`Warehouse detail loaded: ${(dataset.sales || []).length.toLocaleString()} sales rows and ${(dataset.prodSales || []).length.toLocaleString()} product rows.`,
    });
  }, [campaignMeta, productMeta, invalidateRuntimeModelsForLocalData]);

  useEffect(() => {
    if (!startupRenderToken || !startupPaintRef.current) return;
    const frameOne = requestAnimationFrame(() => {
      const frameTwo = requestAnimationFrame(() => {
        const readyMs = performance.now() - startupPaintRef.current.startedAt;
        setDatasetTimings(previous => ({ ...previous, bootstrapReadyMs:Math.round(readyMs), campaignReadyMs:Math.round(readyMs) }));
        try {
          performance.mark("byou-bootstrap-ready");
          performance.measure("byou-login-to-bootstrap-ready", "byou-startup-load-start", "byou-bootstrap-ready");
        } catch {}
      });
      startupPaintRef.current.frameTwo = frameTwo;
    });
    return () => {
      cancelAnimationFrame(frameOne);
      if (startupPaintRef.current?.frameTwo) cancelAnimationFrame(startupPaintRef.current.frameTwo);
    };
  }, [startupRenderToken]);

  const loadSharedDataset = useStartupDataset({ applyStartupDataset, showToast, setSharedDatasetStatus, setDatasetTimings, startupLoadStartedAtRef });

  const refreshPublishedAnalysis = useCallback(
    () => loadSharedDataset({ manual:true }),
    [loadSharedDataset],
  );

  const refreshInventoryApprovalOverlay = useCallback(async ({ quiet = true } = {}) => {
    if (inventoryApprovalRefreshRef.current.mutationPending > 0) return false;
    inventoryApprovalRefreshRef.current.controller?.abort();
    const controller = new AbortController();
    const sequence = inventoryApprovalRefreshRef.current.sequence + 1;
    inventoryApprovalRefreshRef.current.sequence = sequence;
    inventoryApprovalRefreshRef.current.controller = controller;
    setInventoryApprovalOverlayError("");
    const isCurrent = () => inventoryApprovalRefreshRef.current.sequence === sequence && !controller.signal.aborted;
    try {
      const response = await fetch("/api/inventory-approvals", { headers:{ Accept:"application/json" }, cache:"no-store", signal:controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!isCurrent()) return false;
      notifySessionExpired(response);
      if (!response.ok) throw new Error(payload.error || "Inventory approvals could not be refreshed.");
      if (payload.publishedAt && sharedDatasetStatus.publishedAt && payload.publishedAt !== sharedDatasetStatus.publishedAt) {
        return loadSharedDataset({ manual:!quiet });
      }
      const enabled = payload.enabled === true;
      setInventoryApprovalEnabled(enabled);
      if (payload.evaluationDate) setInventoryApprovalEvaluationDate(payload.evaluationDate);
      if (payload.approvalRevision !== undefined) setInventoryApprovalRevision(String(payload.approvalRevision || "0"));
      setInventoryApprovalOverlayPublication(payload.publishedAt || sharedDatasetStatus.publishedAt);
      setInventoryApprovalOverlayError("");
      if (!enabled) {
        setManualInventoryApprovals([]);
        return true;
      }
      if (Array.isArray(payload.approvals)) {
        const approvalSources = splitInventoryApprovalSources(payload.approvals);
        setInventoryApprovals(approvalSources.published);
        setManualInventoryApprovals(approvalSources.manual);
        if (latestStartupDatasetRef.current) latestStartupDatasetRef.current = {
          ...latestStartupDatasetRef.current,
          inventoryApprovals:approvalSources.published,
        };
      }
      return true;
    } catch (error) {
      if (error?.name === "AbortError" || !isCurrent()) return false;
      setInventoryApprovalEnabled(false);
      setManualInventoryApprovals([]);
      setInventoryApprovalOverlayPublication("");
      setInventoryApprovalOverlayError(error.message || "Inventory approvals could not be refreshed.");
      if (!quiet) showToast(error.message || "Inventory approvals could not be refreshed");
      return false;
    } finally {
      if (inventoryApprovalRefreshRef.current.sequence === sequence) inventoryApprovalRefreshRef.current.controller = null;
    }
  }, [loadSharedDataset, sharedDatasetStatus.publishedAt, showToast]);

  const approveInventoryOnHand = useCallback(async ({ row, evidence, approvalPassword, confirmation, idempotencyKey, signal }) => {
    inventoryApprovalRefreshRef.current.mutationPending += 1;
    inventoryApprovalRefreshRef.current.sequence += 1;
    inventoryApprovalRefreshRef.current.controller?.abort();
    inventoryApprovalRefreshRef.current.controller = null;
    try {
      const response = await fetch("/api/inventory-approvals", {
        method:"POST",
        headers:{ "content-type":"application/json", Accept:"application/json" },
        signal,
        body:JSON.stringify({
          idempotencyKey,
          sourcePublishedAt:sharedDatasetStatus.publishedAt,
          confirmation:confirmation === true,
          approvalPassword,
          scope:{
            pid:row.productId,
            cid:row.campaignId,
            wid:row.warehouseId,
            inventoryDate:row.date,
            onHand:row.available,
          },
          evidence,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (notifySessionExpired(response)) throw new Error("Your login session expired. Sign in again to continue.");
      if (!response.ok) throw new Error(payload.error || "This inventory fact could not be approved.");
      if (payload.approval) {
        setManualInventoryApprovals(previous => upsertInventoryApproval(previous, payload.approval));
        runtimeViewCacheRef.current.clear();
        setInventoryViewModel(null);
      }
      if (payload.evaluationDate) setInventoryApprovalEvaluationDate(payload.evaluationDate);
      if (payload.approvalRevision !== undefined) setInventoryApprovalRevision(String(payload.approvalRevision || "0"));
      showToast(payload.alreadyApplied
        ? (uiLang === "ko" ? "재고 승인이 이미 최신 상태입니다" : "Inventory approval was already current")
        : (uiLang === "ko" ? "현재 보유 재고가 승인되었습니다" : "On-hand inventory approved"));
      return payload.approval;
    } catch (error) {
      window.setTimeout(() => refreshInventoryApprovalOverlay(), 1500);
      throw error;
    } finally {
      inventoryApprovalRefreshRef.current.mutationPending = Math.max(0, inventoryApprovalRefreshRef.current.mutationPending - 1);
    }
  }, [refreshInventoryApprovalOverlay, sharedDatasetStatus.publishedAt, showToast, uiLang]);

  const revokeInventoryOnHand = useCallback(async ({ row, reason, reviewer, approvalPassword, confirmation, idempotencyKey, signal }) => {
    inventoryApprovalRefreshRef.current.mutationPending += 1;
    inventoryApprovalRefreshRef.current.sequence += 1;
    inventoryApprovalRefreshRef.current.controller?.abort();
    inventoryApprovalRefreshRef.current.controller = null;
    try {
      const approval = row.approvedAllocation;
      const response = await fetch("/api/inventory-approvals", {
        method:"DELETE",
        headers:{ "content-type":"application/json", Accept:"application/json" },
        signal,
        body:JSON.stringify({
          idempotencyKey,
          sourcePublishedAt:sharedDatasetStatus.publishedAt,
          confirmation:confirmation === true,
          approvalPassword,
          reason,
          reviewer,
          scope:{
            pid:approval?.pid || row.productId,
            cid:approval?.cid || row.campaignId,
            wid:approval?.wid || row.warehouseId,
            inventoryDate:approval?.inventoryDate || row.date,
            onHand:approval?.onHand ?? row.available,
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (notifySessionExpired(response)) throw new Error("Your login session expired. Sign in again to continue.");
      if (!response.ok) throw new Error(payload.error || "This manual inventory approval could not be removed.");
      if (payload.revocation) {
        const revokedKey = manualInventoryApprovalBusinessKey(payload.revocation);
        setManualInventoryApprovals(previous => previous.filter(item => manualInventoryApprovalBusinessKey(item) !== revokedKey));
        runtimeViewCacheRef.current.clear();
        setInventoryViewModel(null);
      }
      if (payload.evaluationDate) setInventoryApprovalEvaluationDate(payload.evaluationDate);
      if (payload.approvalRevision !== undefined) setInventoryApprovalRevision(String(payload.approvalRevision || "0"));
      showToast(payload.alreadyApplied
        ? (uiLang === "ko" ? "수동 재고 승인이 이미 제거되었습니다" : "Manual inventory approval was already removed")
        : (uiLang === "ko" ? "수동 승인이 제거되어 재검토 대기 상태로 돌아갔습니다" : "Manual approval removed; inventory returned to review"));
      return payload.revocation;
    } catch (error) {
      window.setTimeout(() => refreshInventoryApprovalOverlay(), 1500);
      throw error;
    } finally {
      inventoryApprovalRefreshRef.current.mutationPending = Math.max(0, inventoryApprovalRefreshRef.current.mutationPending - 1);
    }
  }, [refreshInventoryApprovalOverlay, sharedDatasetStatus.publishedAt, showToast, uiLang]);

  const loadDetailDataset = useCallback(async ({ reason = "detail view" } = {}) => {
    if (detailLoadedRef.current) return true;
    if (detailLoadPromiseRef.current) return detailLoadPromiseRef.current;
    const task = (async () => {
      const startedAt = performance.now();
      setDetailDatasetStatus({ state:"loading", message:`Loading warehouse detail for ${reason}...` });
      try {
        const response = await fetch("/api/dataset/details", { headers:{ Accept:"application/json" }, cache:"no-cache" });
        if (notifySessionExpired(response)) throw new Error("Your login session expired. Sign in again to continue.");
        if (response.status === 404) throw new Error("Warehouse detail has not been published yet.");
        const contentType = response.headers.get("content-type") || "";
        if (!response.ok || !contentType.includes("application/json")) throw new Error("Warehouse detail endpoint is not available.");
        const text = await response.text();
        const detailDownloadMs = Math.round(performance.now() - startedAt);
        const parseStartedAt = performance.now();
        const dataset = JSON.parse(text);
        const detailParseMs = Math.round(performance.now() - parseStartedAt);
        applyDetailDataset(dataset, { detailDownloadMs, detailParseMs });
        return true;
      } catch (error) {
        const message = error.message || "Warehouse detail could not be loaded.";
        setDetailDatasetStatus({ state:"error", message });
        showToast("Warehouse detail failed to load");
        return false;
      } finally {
        detailLoadPromiseRef.current = null;
      }
    })();
    detailLoadPromiseRef.current = task;
    return task;
  }, [applyDetailDataset, showToast]);

  useEffect(() => {
    loadSharedDataset();
  }, [loadSharedDataset]);

  useEffect(() => {
    if (tab !== "inventory" || !sharedDatasetStatus.publishedAt) return;
    refreshInventoryApprovalOverlay();
    const onFocus = () => refreshInventoryApprovalOverlay();
    const refreshTimer = window.setInterval(() => refreshInventoryApprovalOverlay(), 5 * 60 * 1000);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(refreshTimer);
      window.removeEventListener("focus", onFocus);
      setInventoryApprovalOverlayPublication("");
      setInventoryApprovalOverlayError("");
      inventoryApprovalRefreshRef.current.sequence += 1;
      inventoryApprovalRefreshRef.current.controller?.abort();
      inventoryApprovalRefreshRef.current.controller = null;
    };
  }, [tab, sharedDatasetStatus.publishedAt, refreshInventoryApprovalOverlay]);

  const runtimeQuery = useMemo(() => {
    if (tab === "analytics") {
      const focused = !!(selPid || activeCampaignId || selId || salesRegion || salesState);
      return {
        view:"analytics",
        ...(focused ? { representation:SALES_COMPACT_REPRESENTATION } : {}),
        publication:sharedDatasetStatus.publishedAt,
        from:analyticsDR.start,
        to:analyticsDR.end,
        pids:selPid ? [selPid] : [],
        cid:activeCampaignId,
        wid:selId || "",
        region:salesRegion,
        state:salesState,
        storeSearch:focused ? salesStoreSearch : "",
      };
    }
    if (tab === "inventory") return {
      view:"inventory",
      representation:"inventory-compact-v1",
      from:inventoryDR.start,
      to:inventoryDR.end,
      pids:inventoryPid ? [inventoryPid] : [],
      cid:activeCampaignId,
      wid:selId || "",
      region:inventoryRegion,
      state:inventoryState,
      inventoryType,
      storeSearch:inventoryStoreSearch,
      publication:sharedDatasetStatus.publishedAt,
      evaluationDate:inventoryApprovalEvaluationDate,
      approvalRevision:inventoryApprovalRevision,
    };
    if (tab === "map") return { view:"map", publication:sharedDatasetStatus.publishedAt, from:campaignDR.start, to:campaignDR.end, pids:mapRuntimeScope.pids, cids:mapRuntimeScope.cids, region:mapRegion, state:mapState };
    if (tab === "calendar") return { view:"calendar", publication:sharedDatasetStatus.publishedAt, from:calendarDR.start, to:calendarDR.end, pids:calendarPid ? [calendarPid] : [], cid:activeCampaignId, wid:selId || "" };
    if (tab === "videos") return { view:"videos", publication:sharedDatasetStatus.publishedAt, from:videoDateRange.start, to:videoDateRange.end, pids:videoSelPid ? [videoSelPid] : [], cid:activeCampaignId };
    if (tab === "rankings") {
      const warehouseActive = analysisSection === "warehouses";
      const publishedAnalysisRange = startupBoundsRef.current.start && startupBoundsRef.current.end
        ? startupBoundsRef.current
        : campaignDR;
      const warehouseRange = {
        start:analysisOptions.warehouseFrom || publishedAnalysisRange.start,
        end:analysisOptions.warehouseTo || publishedAnalysisRange.end,
      };
      const rankingRanges = {
        selectedRange:warehouseActive ? warehouseRange : campaignDR,
        publishedRange:startupBoundsRef.current,
        warehouseId:analysisSection === "demographics" ? demographicsWarehouseId : "",
      };
      const pairedScope = analysisSection === "comparison"
        ? buildRankingsRuntimeQuery({ ...rankingRanges, baselinePid:effectiveCompareA, baselineCid:compareCampaignA, comparisonPid:effectiveCompareB, comparisonCid:compareCampaignB })
        : analysisSection === "pacing"
          ? {
            from:rankingRanges.selectedRange.start,
            to:rankingRanges.selectedRange.end,
            ...buildRankingsPacingScope({ baselinePid:campaignPid, baselineCid:campaignCid || activeCampaignId, comparisonPid:pacingCompPid, comparisonCid:pacingCompCid }),
          }
          : warehouseActive
            ? {
              from:warehouseRange.start,
              to:warehouseRange.end,
              pids:analysisOptions.warehousePid ? [analysisOptions.warehousePid] : [],
              cids:analysisOptions.warehouseCid ? [analysisOptions.warehouseCid] : [],
              region:analysisOptions.warehouseRegion || "",
              state:analysisOptions.warehouseState || "",
            }
          : buildRankingsRuntimeQuery({ ...rankingRanges, baselinePid:campaignPid, baselineCid:campaignCid || activeCampaignId });
      const primaryPid = analysisSection === "comparison" ? effectiveCompareA : warehouseActive ? analysisOptions.warehousePid : campaignPid;
      const primaryCid = analysisSection === "comparison" ? compareCampaignA : warehouseActive ? analysisOptions.warehouseCid : campaignCid || activeCampaignId;
      const comparisonPid = analysisSection === "comparison" ? effectiveCompareB : analysisSection === "pacing" ? pacingCompPid : "";
      const comparisonCid = analysisSection === "comparison" ? compareCampaignB : analysisSection === "pacing" ? pacingCompCid : "";
      const publishedRange = rankingRanges.publishedRange.start && rankingRanges.publishedRange.end
        ? rankingRanges.publishedRange
        : rankingRanges.selectedRange;
      const affinityActive = analysisSection === "affinity";
      const comparisonActive = analysisSection === "comparison";
      return {
        view:"rankings",
        representation:ANALYSIS_COMPACT_REPRESENTATION,
        section:analysisSection,
        publication:sharedDatasetStatus.publishedAt,
        primaryPid,
        primaryCid,
        comparisonPid,
        comparisonCid,
        affinityRegion:affinityActive ? analysisOptions.affinityRegion : "",
        affinityState:affinityActive ? analysisOptions.affinityState : "",
        affinityMinimumPeriods:affinityActive ? analysisOptions.affinityMinimumPeriods : 3,
        affinityMinimumUnits:affinityActive ? analysisOptions.affinityMinimumUnits : 5,
        compareA:comparisonActive ? effectiveCompareA : "",
        compareB:comparisonActive ? effectiveCompareB : "",
        compareCampaignA:comparisonActive ? compareCampaignA : "",
        compareCampaignB:comparisonActive ? compareCampaignB : "",
        compareBucket:comparisonActive ? analysisOptions.compareBucket : "warehouse",
        compareMetric:comparisonActive ? analysisOptions.compareMetric : "rev",
        compareNormMode:comparisonActive ? analysisOptions.compareNormMode : "sellingAge",
        compareMinUnits:comparisonActive ? analysisOptions.compareMinUnits : ANALYSIS_MIN_SELLING_UNITS,
        compareRegion:comparisonActive ? analysisOptions.compareRegion : "",
        compareState:comparisonActive ? analysisOptions.compareState : "",
        compareFrom:comparisonActive && analysisOptions.compareFrom ? analysisOptions.compareFrom : publishedRange.start,
        compareTo:comparisonActive && analysisOptions.compareTo ? analysisOptions.compareTo : publishedRange.end,
        ...pairedScope,
      };
    }
    return { view:"campaign", representation:CAMPAIGN_TRANSPORT_REPRESENTATION, publication:sharedDatasetStatus.publishedAt, from:campaignDR.start, to:campaignDR.end, pids:campaignPid ? [campaignPid] : [], cid:campaignCid || activeCampaignId };
  }, [tab, analyticsDR.start, analyticsDR.end, selPid, activeCampaignId, selId, salesRegion, salesState, salesStoreSearch, inventoryDR.start, inventoryDR.end, inventoryPid, inventoryRegion, inventoryState, inventoryType, inventoryStoreSearch, inventoryApprovalEvaluationDate, inventoryApprovalRevision, sharedDatasetStatus.publishedAt, campaignDR.start, campaignDR.end, mapRuntimeScope, mapRegion, mapState, calendarDR.start, calendarDR.end, calendarPid, videoDateRange.start, videoDateRange.end, videoSelPid, campaignPid, campaignCid, analysisSection, demographicsWarehouseId, pacingCompPid, pacingCompCid, effectiveCompareA, effectiveCompareB, compareCampaignA, compareCampaignB, analysisOptions]);
  const runtimeProductKey = useMemo(() => expandProductFilterIds(
    runtimeQuery.pids,
    runtimeQuery.section === "comparison" ? comparisonProductOptions : productOptions,
  ).join(","), [runtimeQuery.pids, runtimeQuery.section, comparisonProductOptions, productOptions]);
  const runtimeUrl = runtimeRequestUrl(runtimeQuery, runtimeProductKey);
  const runtimeRequestKey = `${sharedDatasetStatus.publishedAt}|${runtimeUrl}`;
  const latestRuntimeRequestKey = useRef(runtimeRequestKey);
  latestRuntimeRequestKey.current = runtimeRequestKey;
  const inventoryStoreSearchPending = tab === "inventory" && storeSearch.trim() !== inventoryStoreSearch;
  const salesStoreSearchPending = tab === "analytics"
    && runtimeQuery.representation === SALES_COMPACT_REPRESENTATION
    && storeSearch.trim() !== salesStoreSearch;
  const runtimeUsesPublishedAnalysis = runtimeQuery.representation === ANALYSIS_COMPACT_REPRESENTATION;
  const runtimeHasLocalDetail = detailLoadedRef.current && !runtimeUsesPublishedAnalysis;
  const inventoryApprovalOverlayWaiting = tab === "inventory"
    && !!sharedDatasetStatus.publishedAt
    && inventoryApprovalOverlayPublication !== sharedDatasetStatus.publishedAt;
  const inventoryApprovalOverlayFailed = inventoryApprovalOverlayWaiting && !!inventoryApprovalOverlayError;
  const runtimeState = inventoryApprovalOverlayFailed
    ? "error"
    : inventoryApprovalOverlayWaiting || inventoryStoreSearchPending || salesStoreSearchPending
    ? "loading"
    : !detailLoadedRef.current && !sharedDatasetStatus.publishedAt && sharedDatasetStatus.state === "error"
      ? "error" : runtimeDisplayState(runtimeRequestKey, runtimeRequestState, runtimeHasLocalDetail);
  const retryRuntimeView = useCallback(() => {
    if (inventoryApprovalOverlayWaiting) {void refreshInventoryApprovalOverlay({quiet:false});return;}
    if (!sharedDatasetStatus.publishedAt) {void loadSharedDataset({manual:true});return;}
    runtimeViewCacheRef.current.delete(latestRuntimeRequestKey.current);
    runtimeViewAppliedKeyRef.current = "";
    setRuntimeRequestState({key:latestRuntimeRequestKey.current,status:"loading"});
    setRuntimeRetry(n => n + 1);
  }, [inventoryApprovalOverlayWaiting, refreshInventoryApprovalOverlay, sharedDatasetStatus.publishedAt, loadSharedDataset]);

  const runtimeQueryEnabled = useMemo(() => {
    if (tab === "pnl") return false;
    // The small local sample uses the original full campaign response so its
    // seeded videos and calendar notes remain consistent with the overview.
    if (runtimeQuery.view === "campaign") return true;
    if (runtimeQuery.representation === "inventory-compact-v1"
      && inventoryApprovalOverlayPublication !== sharedDatasetStatus.publishedAt) return false;
    if ([ANALYSIS_COMPACT_REPRESENTATION, SALES_COMPACT_REPRESENTATION].includes(runtimeQuery.representation)) return true;
    const bounds = startupBoundsRef.current;
    const hasScope = !!(runtimeQuery.pids?.length || runtimeQuery.cids?.length || runtimeQuery.cid || runtimeQuery.wid || runtimeQuery.region || runtimeQuery.state);
    const coversPublishedRange = !!bounds.start && !!bounds.end && runtimeQuery.from === bounds.start && runtimeQuery.to === bounds.end;
    const coversAutomaticCampaignRange = runtimeQuery.view === "campaign" && campaignDateAutoRef.current && runtimeQuery.from === campaignAutomaticRange.start && runtimeQuery.to === campaignAutomaticRange.end;
    if (["campaign", "rankings", "analytics"].includes(runtimeQuery.view) && !hasScope && coversPublishedRange) return false;
    if (!hasScope && coversAutomaticCampaignRange) return false;
    return true;
  }, [tab, runtimeQuery, sharedDatasetStatus.publishedAt, inventoryApprovalOverlayPublication, campaignAutomaticRange.start, campaignAutomaticRange.end]);
  const applyRuntimeViewDataset = useCallback((dataset, metrics = {}) => {
    if (sharedDatasetStatus.publishedAt && dataset?.publishedAt !== sharedDatasetStatus.publishedAt) {
      throw new Error("The requested dashboard result belongs to a different publication.");
    }
    if (dataset?.schema === "byou-intel-inventory-compact-v1") {
      if (sharedDatasetStatus.publishedAt && dataset.publishedAt !== sharedDatasetStatus.publishedAt) {
        throw new Error("The requested Inventory result belongs to a different publication.");
      }
      setInventoryViewModel(dataset);
      setAnalysisViewModel(null);
      setSalesViewModel(null);
      runtimeViewAppliedRef.current = true;
      setCampaignComparison(null);
      setDatasetTimings(previous => ({ ...previous, ...metrics, serverQueryMs:Number(dataset.queryMs || 0) }));
      const compactRows = (dataset.inlineRows?.length || 0) + (dataset.inlineSoldThroughRows?.length || 0)
        + (dataset.onlineRows?.length || 0) + (dataset.onlineSoldThroughRows?.length || 0);
      setDetailDatasetStatus({
        state:"loaded",
        message:`Inventory result loaded from ${dataset.source === "postgres" ? "the database" : "the file fallback"}: ${compactRows.toLocaleString()} compact rows.`,
      });
      return;
    }
    if (dataset?.schema === ANALYSIS_COMPACT_SCHEMA) {
      if (sharedDatasetStatus.publishedAt && dataset.publishedAt !== sharedDatasetStatus.publishedAt) {
        throw new Error("The requested Analysis result belongs to a different publication.");
      }
      if (dataset.section !== analysisSection) {
        throw new Error("The requested Analysis result belongs to a different section.");
      }
      setAnalysisViewModel(dataset);
      setInventoryViewModel(null);
      setSalesViewModel(null);
      runtimeViewAppliedRef.current = true;
      setCampaignComparison(null);
      setDatasetTimings(previous => ({ ...previous, ...metrics, serverQueryMs:Number(dataset.queryMs || 0) }));
      setDetailDatasetStatus({
        state:"loaded",
        message:`${dataset.section} Analysis result loaded from ${dataset.source === "postgres" ? "the database" : "the file fallback"} as a compact display model.`,
      });
      return;
    }
    if (dataset?.schema === SALES_COMPACT_SCHEMA) {
      if (dataset.view !== "analytics") throw new Error("The requested compact Sales result is not an Analytics view.");
      setSalesViewModel({
        ...dataset,
        ppcRows:reconcilePpcAssignments(Array.isArray(dataset.ppcRows) ? dataset.ppcRows : [], productMeta, campaignMeta),
      });
      setInventoryViewModel(null);
      setAnalysisViewModel(null);
      runtimeViewAppliedRef.current = true;
      setCampaignComparison(null);
      setDatasetTimings(previous => ({ ...previous, ...metrics, serverQueryMs:Number(dataset.queryMs || 0) }));
      setDetailDatasetStatus({
        state:"loaded",
        message:`Sales result loaded from ${dataset.source === "postgres" ? "the database" : "the file source"}: ${(dataset.chartRows || []).length.toLocaleString()} chart points and ${(dataset.sidebarRows || []).length.toLocaleString()} stores.`,
      });
      return;
    }
    if (dataset?.schema !== "byou-intel-view-v1") throw new Error("The requested dashboard view is not compatible with this BYOU Intel build.");
    if (dataset.view === "videos") {
      // This view owns video state only. Retain the published sales/owner context
      // for other tabs instead of replacing it with absent transport fields.
      setInventoryViewModel(null);
      setAnalysisViewModel(null);
      setSalesViewModel(null);
      runtimeViewAppliedRef.current = true;
      setCampaignComparison(null);
      setVideos(Array.isArray(dataset.videos) ? dataset.videos : []);
      setVideoMetrics(Array.isArray(dataset.videoMetrics) ? dataset.videoMetrics : []);
      setDatasetTimings(previous => ({ ...previous, ...metrics, serverQueryMs:Number(dataset.queryMs || 0) }));
      setDetailDatasetStatus({ state:"loaded", message:`Videos loaded: ${(dataset.videos || []).length.toLocaleString()} videos.` });
      return;
    }
    setInventoryViewModel(null);
    setAnalysisViewModel(null);
    setSalesViewModel(null);
    setLocalOwnerSalesHistory(false);
    setOwnerInventoryDecisions(dataset.ownerInventoryDecisions || []);
    setOwnerSalesCorrections(dataset.ownerSalesCorrections || []);
    setOwnerSalesCorrectionHistory(dataset.ownerSalesCorrectionHistory || []);
    runtimeViewAppliedRef.current = true;
    setCampaignComparison(dataset.view === "campaign" && dataset.comparison ? dataset.comparison : null);
    if (Array.isArray(dataset.sales)) setSales(dataset.sales);
    if (Array.isArray(dataset.prodSales)) setProdSales(dataset.prodSales);
    // Approval state is refreshed through the small approval endpoint. Runtime
    // view responses may arrive out of order and must not replace it.
    if (Array.isArray(dataset.inventoryReviewDispositions)) setInventoryReviewDispositions(dataset.inventoryReviewDispositions);
    setInlineTotalSales(Array.isArray(dataset.inlineTotalSales) ? dataset.inlineTotalSales : []);
    setWarehouseDailySales(Array.isArray(dataset.warehouseDailySales) ? dataset.warehouseDailySales : []);
    setOnlineSales(Array.isArray(dataset.onlineSales) ? dataset.onlineSales : []);
    setPpcRows(reconcilePpcAssignments(Array.isArray(dataset.ppcRows) ? dataset.ppcRows : [], productMeta, campaignMeta));
    setFootnotes(Array.isArray(dataset.footnotes) ? dataset.footnotes : []);
    setVideos(Array.isArray(dataset.videos) ? dataset.videos : []);
    setVideoMetrics(Array.isArray(dataset.videoMetrics) ? dataset.videoMetrics : []);
    setAnalysisSummaries({
      daily:Array.isArray(dataset.analysis?.daily) ? dataset.analysis.daily : [],
      regionDaily:Array.isArray(dataset.analysis?.regionDaily) ? dataset.analysis.regionDaily : [],
      stateDaily:Array.isArray(dataset.analysis?.stateDaily) ? dataset.analysis.stateDaily : [],
    });
    setDatasetTimings(previous => ({ ...previous, ...metrics, serverQueryMs:Number(dataset.queryMs || 0) }));
    setDetailDatasetStatus({
      state:"loaded",
      message:`${dataset.view || "Dashboard"} query loaded from ${dataset.source === "postgres" ? "the database" : "the file fallback"}: ${(dataset.prodSales || []).length.toLocaleString()} warehouse rows.`,
    });
  }, [productMeta, campaignMeta, sharedDatasetStatus.publishedAt, analysisSection]);

useRuntimeView({ analysisPaintRef, applyRuntimeViewDataset, detailLoadedRef, inventoryApprovalOverlayError, inventoryApprovalOverlayFailed, inventoryApprovalOverlayWaiting, latestRuntimeRequestKey, loadSharedDataset, refreshInventoryApprovalOverlay, restoreStartupSummaryDataset, runtimeProductKey, runtimeQuery, runtimeQueryEnabled, runtimeRequestKey, runtimeRetry, runtimeUrl, runtimeViewAbortRef, runtimeViewAppliedKeyRef, runtimeViewAppliedRef, runtimeViewCacheRef, setCampaignComparison, setDatasetTimings, setDetailDatasetStatus, setInventoryViewModel, setRuntimeRequestState, setSharedDatasetStatus, sharedDatasetStatus, showToast, startupLoadStartedAtRef });

  const publishSharedDataset = useCallback(async (token) => {
    if (!token) return;
    try {
      setSharedDatasetStatus(s => ({ ...s, state:"publishing", message:"Preparing shared dataset..." }));
      await waitForUiTick();
      const dataset = buildPublishedDataset();
      setSharedDatasetStatus(s => ({ ...s, state:"publishing", message:"Serializing shared dataset..." }));
      await waitForUiTick();
      const json = JSON.stringify(dataset);
      const rawBytes = new Blob([json]).size;
      setSharedDatasetStatus(s => ({ ...s, state:"publishing", message:`Compressing shared dataset (${fmtBytes(rawBytes)})...` }));
      await waitForUiTick();
      const upload = await prepareDatasetUpload(json);
      const detail = upload.compressed
        ? `${fmtBytes(upload.rawBytes)} compressed to ${fmtBytes(upload.uploadBytes)}`
        : fmtBytes(upload.uploadBytes);
      setSharedDatasetStatus(s => ({ ...s, state:"publishing", message:`Uploading shared dataset (${detail})...` }));
      const payload = await publishDatasetUpload(upload, token, sharedDatasetStatus.publishedAt, dataset, ({ index, total, bytes, phase, jobId }) => {
        setSharedDatasetStatus(s => ({
          ...s,
          state:"publishing",
          message:phase === "processing"
            ? `Publication job ${jobId} is validating and loading the dataset on the server...`
            : `Uploading shared dataset (${detail}) - chunk ${index} of ${total}, ${fmtBytes(bytes)} sent...`,
        }));
      });
      setSharedDatasetStatus({
        state:"published",
        message:`Published for everyone: ${(payload.dataset?.productRows || prodSales.length).toLocaleString()} product rows, ${(payload.dataset?.inlineTotalRows || inlineTotalSales.length).toLocaleString()} inline total rows, ${(payload.dataset?.ppcRows || ppcRows.length).toLocaleString()} paid-media rows. Upload size: ${detail}.`,
        publishedAt:payload.dataset?.publishedAt || dataset.publishedAt,
      });
      showToast("Shared dataset published");
      setNotesDirty(false);
    } catch (error) {
      const message = error?.name === "AbortError"
        ? "Publishing timed out after 4 minutes. The dataset may be too large for this connection, or the shared backend is not responding."
        : error.message || "Could not publish shared dataset.";
      setSharedDatasetStatus({ state:"error", message, publishedAt:"" });
      showToast("Publish failed");
    }
  }, [buildPublishedDataset, prodSales.length, inlineTotalSales.length, ppcRows.length, sharedDatasetStatus.publishedAt, showToast]);

  const openDailyUpdatePicker = useCallback(() => {
    dailyFileRef.current?.click();
  }, []);

  const openPublishModal = useCallback(async () => {
    if (!detailLoadedRef.current) {
      const loaded = await loadDetailDataset({ reason:"publishing" });
      if (!loaded) return;
      await waitForUiTick();
    }
    setPublishAction("dataset");
    setPublishToken("");
    setPublishModalOpen(true);
  }, [loadDetailDataset]);

  const applyServerDailyUpdate = useCallback(async (file, token) => {
    if (!file || !token) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 4 * 60 * 1000);
    setImportBusy(true);
    setImportStatus({ state:"loading", message:`Securely applying compact daily update (${fmtBytes(file.size)}) on the server...` });
    setSharedDatasetStatus(previous => ({ ...previous, state:"publishing", message:"Validating and publishing the compact daily update on the server..." }));
    try {
      const response = await fetch("/api/dataset/daily-update", {
        method:"POST",
        headers:{
          "content-type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "x-admin-token":token,
          "x-byou-filename":encodeURIComponent(file.name),
          "x-byou-batch-id":`daily-${Date.now()}`,
        },
        body:file,
        signal:controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "The compact daily update could not be published.");
      const sourceRows = payload.result?.sourceRows || {};
      const mergedRows = payload.result?.mergedRows || {};
      const dataThrough = payload.result?.dataThrough || "unknown";
      const message = payload.alreadyApplied
        ? `Daily update already applied. Published data is through ${dataThrough}.`
        : `Daily update published through ${dataThrough}: validated ${(sourceRows.In_Line_Sales_Raw || 0).toLocaleString()} warehouse rows, ${(sourceRows.Costco_Daily_Totals || 0).toLocaleString()} Costco rows, and ${(sourceRows.Online_Sales_Raw || 0).toLocaleString()} online rows; merged ${(mergedRows.warehouse || 0).toLocaleString()} warehouse rows, ${(mergedRows.inlineTotal || 0).toLocaleString()} official total rows, and ${(mergedRows.online || 0).toLocaleString()} online rows.`;
      setImportStatus({ state:"loaded", message });
      setSharedDatasetStatus({ state:"published", message, publishedAt:payload.publishedAt || "", source:"network", warning:"" });
      detailLoadedRef.current = false;
      setDetailDatasetLoaded(false);
      runtimeViewCacheRef.current.clear();
      showToast(payload.alreadyApplied ? "Daily update already published" : "Daily update published");
      await loadSharedDataset({ manual:true });
    } catch (error) {
      const message = error?.name === "AbortError"
        ? "Daily update timed out after 4 minutes. Nothing can be treated as published until the shared timestamp is verified."
        : error.message || "Could not publish the compact daily update.";
      setImportStatus({ state:"error", message });
      setSharedDatasetStatus(previous => ({ ...previous, state:"error", message, warning:message }));
      showToast("Daily update failed");
    } finally {
      window.clearTimeout(timeout);
      setPublishAction("dataset");
      setPublishToken("");
      setImportBusy(false);
    }
  }, [loadSharedDataset, showToast]);

  const confirmPublishAction = useCallback(() => {
    const token = publishToken.trim();
    if (!token) return;
    setPublishModalOpen(false);
    setPublishToken("");
    if (publishAction === "dailyUpdate") {
      const file = pendingDailyUpdateRef.current;
      pendingDailyUpdateRef.current = null;
      void applyServerDailyUpdate(file, token);
      return;
    }
    void publishSharedDataset(token);
  }, [applyServerDailyUpdate, publishAction, publishSharedDataset, publishToken]);

  const cancelPublishAction = useCallback(() => {
    setPublishModalOpen(false);
    setPublishToken("");
    if (publishAction === "dailyUpdate") pendingDailyUpdateRef.current = null;
    setPublishAction("dataset");
  }, [publishAction]);
  const processVideoCsvData = useCallback((data, fallbackType = "", options = {}) => {
    const replace = !!options.replace;
    const importProductMeta = options.productMeta || productMeta;
    const importCampaignMeta = options.campaignMeta || campaignMeta;
    let nextVideos = replace ? [] : [...videos];
    const newMetrics = [];
    let skippedRows = 0;
    const fallbackVideoType = normalizeVideoType(fallbackType);
    const fallbackSnapshotDate = normalizeDateValue(options.snapshotDate || options.lastUpdated || "");
    data.forEach(row => {
      const rawUrl   = String(cellValue(row, VIDEO_URL_COLUMNS)).trim();
      const url      = safeExternalHttpUrl(rawUrl);
      const title    = String(cellValue(row, VIDEO_TITLE_COLUMNS)).trim();
      const creator  = String(cellValue(row, VIDEO_CREATOR_COLUMNS)).trim();
      const platform = normalizePlatform(cellValue(row, VIDEO_PLATFORM_COLUMNS) || url || rawUrl);
      const videoType = normalizeVideoType(videoAssignmentCellValue(row, VIDEO_TYPE_COLUMNS), fallbackVideoType);
      const rowRate  = numberValue(cellValue(row, VIDEO_RATE_COLUMNS));
      const explicitSnapshotDate = normalizeDateValue(cellValue(row, VIDEO_SNAPSHOT_DATE_COLUMNS));
      const rowDate  = normalizeDateValue(cellValue(row, ["Date"]));
      const postDate = normalizeDateValue(cellValue(row, VIDEO_POST_DATE_COLUMNS));
      const postedDate = postDate || rowDate || "";
      const date     = explicitSnapshotDate || fallbackSnapshotDate || rowDate || postedDate;
      const views    = Math.round(numberValue(cellValue(row, ["Views"])));
      const likes    = Math.round(numberValue(cellValue(row, ["Likes"])));
      const comments = Math.round(numberValue(cellValue(row, ["Comments"])));
      const saves    = Math.round(numberValue(cellValue(row, ["Saves"])));
      const shares   = Math.round(numberValue(cellValue(row, ["Shares"])));
      if (!url && !creator && !title && !date) return;
      if (shouldSkipTrackifyVideoRow(row)) {
        skippedRows += 1;
        return;
      }
      const assignment = inferVideoAssignmentForRow(row, {
        campaignMeta:importCampaignMeta,
        productMeta:importProductMeta,
        postedDate,
        snapshotDate:date,
        title,
        creator,
      });
      const pid = assignment.pid || "";
      const campaign = assignment.campaign;
      let vid = nextVideos.find(v => {
        if (url && v.url === url && (!videoType || !v.type || v.type === videoType)) return true;
        if (title && v.title === title && v.creator === creator && (!videoType || !v.type || v.type === videoType)) return true;
        return !url && !title && v.creator === creator && v.platform === platform && v.pid === pid && (v.cid || "") === (campaign?.id || "") && (!videoType || !v.type || v.type === videoType);
      });
      if (!vid) {
        const nid = `V${String(nextVideos.length + 1).padStart(3,"0")}`;
        vid = { id:nid, url:url||"", title:title||"", creator:creator||"Unknown", platform:platform||"Unknown", pid, cid:campaign?.id || "", campaign:campaign?.short || "", type:videoType, rate:rowRate, postedDate:postedDate||"" };
        nextVideos = [...nextVideos, vid];
      } else {
        const patched = {
          ...vid,
          title:title || vid.title || "",
          creator:creator || vid.creator || "Unknown",
          platform:platform || vid.platform || "Unknown",
          pid:pid || vid.pid || "",
          cid:campaign?.id || vid.cid || "",
          campaign:campaign?.short || vid.campaign || "",
          type:videoType || vid.type || "",
          rate:rowRate || vid.rate || 0,
          postedDate:postedDate || vid.postedDate || "",
        };
        if (patched.title !== vid.title || patched.creator !== vid.creator || patched.platform !== vid.platform || patched.pid !== vid.pid || patched.cid !== vid.cid || patched.type !== vid.type || patched.rate !== vid.rate || patched.postedDate !== vid.postedDate) {
          nextVideos = nextVideos.map(v => v.id === vid.id ? patched : v);
          vid = patched;
        }
      }
      if (date) {
        const engagement = views > 0 ? +((likes+comments+saves+shares)/views*100).toFixed(2) : 0;
        newMetrics.push({ vid:vid.id, date, views, likes, comments, saves, shares, engagement, rate:vid.rate || rowRate || 0 });
      }
    });
    const nextMetrics = (newMetrics.length || replace)
      ? upsertByKey(replace ? [] : videoMetrics,newMetrics,m=>`${m.vid}|${m.date}`)
      : videoMetrics;
    const metricDates = [...new Set(nextMetrics.map(m => m.date).filter(Boolean))].sort();
    setVideos(nextVideos);
    if (newMetrics.length || replace) {
      setVideoMetrics(nextMetrics);
      if (metricDates.length) {
        setVideoDateRange({ start:metricDates[0], end:metricDates[metricDates.length - 1] });
      }
    }
    return {
      newVideos:replace ? nextVideos.length : nextVideos.length - videos.length,
      snapshots:newMetrics.length,
      videoStart:metricDates[0] || "",
      videoEnd:metricDates[metricDates.length - 1] || "",
      skipped:skippedRows,
    };
  }, [videos, videoMetrics, productMeta, campaignMeta]);

  const processPpcData = useCallback((sources = {}, source = "PPC report", options = {}) => {
    const rows = normalizePpcRows({
      ...sources,
      source,
      productMeta:options.productMeta || productMeta,
      campaignMeta:options.campaignMeta || campaignMeta,
      mapRows:options.mapRows || sources.mapRows || [],
    });
    if (options.replace) {
      setPpcRows(rows);
    } else if (rows.length) {
      setPpcRows(prev => upsertByKey(prev, rows, row => row.id));
    }
    return rows.length;
  }, [productMeta, campaignMeta]);

  const processWorkbookFile = useCallback(async (file, onProgress = () => {}, options = {}) => {
    invalidateRuntimeModelsForLocalData();
    const replace = options.replace !== false;
    const startedAt = performance.now();
    let workbookReadMs = 0;
    const progress = async message => {
      onProgress?.(message);
      await waitForUiTick();
    };
    await progress(`Preparing workbook ${file.name} (${fmtBytes(file.size)})...`);
    await progress("Opening workbook sheets...");
    const workbookStartedAt = performance.now();
    const workbook = await readWorkbook(file);
    workbookReadMs = performance.now() - workbookStartedAt;
    const readSheet = async (label, names) => {
      await progress(`Reading ${label}...`);
      return sheetRows(workbook, names);
    };
    const readSheets = async (label, sheetNames) => {
      const rows = [];
      for (const sheetName of sheetNames || []) {
        await progress(`Reading ${label}: ${sheetName}...`);
        appendRows(rows, sheetRowsByName(workbook, sheetName));
      }
      return rows;
    };
    const storeRows = await readSheet("Stores_Master", ["Stores_Master","Stores"]);
    const productRows = await readSheet("Products_Master", ["Products_Master","Products"]);
    const campaignRows = await readSheet("Campaigns_Master", ["Campaigns_Master","Campaigns","Campaign_Master","Costco_Campaigns"]);
    const ownerInventoryRows = await readSheet(OWNER_INVENTORY_SHEET, [OWNER_INVENTORY_SHEET]);
    const ownerCorrectionRows = await readSheet(OWNER_SALES_CORRECTION_SHEET, [OWNER_SALES_CORRECTION_SHEET]);
    const totalWarehouseRows = await readSheet("Total Warehouses", ["Total_Warehouses","Total Warehouses","Product_Warehouses","Product Warehouses","Warehouse_Totals","Warehouse Totals"]);
    const inlineSalesSheets = ["In_Line_Sales_Raw","Inline_Sales_Raw","Inline Sales Raw","In Line Sales Raw","In-Line Sales Raw","Sales_Raw","Raw Consolidated","Sales"];
    const salesSheetNames = sheetNamesFor(workbook, inlineSalesSheets, { allowNumbered:true });
    const salesRows = await readSheets("warehouse sales", salesSheetNames);
    const inlineTotalSheetName = sheetNameFor(workbook, ["Costco_Daily_Totals","Costco Daily Totals","Inline_Daily_Sales_Raw","Inline Daily Sales Raw","Inline_Daily_Sales","Inline Daily Sales","Daily_Sales_Raw","Daily Sales Raw","Inline_Total_Sales","Inline Total Sales"]);
    const inlineTotalRowsRaw = inlineTotalSheetName ? await readSheet("Costco_Daily_Totals", [inlineTotalSheetName]) : [];
    await progress("Normalizing Costco daily totals...");
    const inlineTotalRows = prepareCostcoBlockRows(inlineTotalRowsRaw, { totalsOnly:true });
    const onlineRows = await readSheet("Online_Sales_Raw", ["Online_Sales_Raw","Online Sales","Online_Sales","Ecommerce_Raw","E-Commerce_Raw"]);
    const inlineInventoryRows = await readSheet("Inline_Inventory_Raw", ["Inline_Inventory_Raw","In_Line_Inventory_Raw","Inline Inventory","In Line Inventory","Inline_Inventory","Inventory_Raw","Warehouse_Inventory_Raw"]);
    const inlineInventoryHasStore = inlineInventoryRows.some(row => storeNameFromRow(row));
    const inlineInventoryTotalRows = inlineInventoryHasStore ? [] : prepareCostcoBlockRows(inlineInventoryRows, { totalsOnly:true });
    const inlineDailyTotalRows = inlineTotalRows.concat(inlineInventoryTotalRows);
    const isOnlineDailyRow = row => /(online|e[-_\s]*commerce|amazon|dtc|shopify|tiktok\s*shop)/i.test([
      cellValue(row, ["Channel","Storefront","Marketplace","Platform","Source","Sales Channel"]),
      cellValue(row, ["Dataset","Sheet","Type"]),
    ].filter(Boolean).join(" "));
    const dailyOnlineRows = inlineDailyTotalRows.filter(isOnlineDailyRow);
    const dailyInlineRows = inlineDailyTotalRows.filter(row => !isOnlineDailyRow(row));
    const allOnlineRows = onlineRows.concat(dailyOnlineRows);
    const onlineInventoryRows = await readSheet("Online_Inventory_Raw", ["Online_Inventory_Raw","Online Inventory","Online_Inventory","Ecommerce_Inventory_Raw"]);
    const hasInventoryValue = row => String(cellValue(row, ["Inventory","Inventory On Hand","On Hand","Available Inventory","Available Units","Ending Inventory","Stock On Hand"])).trim() !== "";
    const importedInventoryRows = salesRows.concat(dailyInlineRows, allOnlineRows, inlineInventoryRows, onlineInventoryRows).filter(hasInventoryValue).length;
    const eventRows = await readSheet("Calendar_Events", ["Calendar_Events","Events","Calendar"]);
    const lastUpdatedRows = await readSheet("Last_Updated", ["Last_Updated","Last Updated","LastUpdated","Update_Log","Upload_Metadata","Metadata"]);
    const videoSnapshotDate = extractLastUpdatedDate(lastUpdatedRows);
    const paidVideoRows = (await readSheet("Paid_Videos_Raw", ["Paid_Videos_Raw","Paid Videos","Paid_Videos"])).map(row => ({ ...row, __VideoType:"Paid" }));
    const seedingVideoRows = (await readSheet("Seeding_Videos_Raw", ["Seeding_Videos_Raw","Seeding Videos","Seeding_Videos"])).map(row => ({ ...row, __VideoType:"Seeding" }));
    const genericVideoRows = await readSheet("Videos_Raw", ["Videos_Raw","Videos","Trackify","Trackify_Videos","Trackify_Videos_Raw","latest_video_metrics","video_metric_history"]);
    const videoRows = paidVideoRows.concat(seedingVideoRows, genericVideoRows);
    const ppcMapRows = await readSheet("PPC product map", ["PPC_Product_Map","PPC Product Map","Criteo_Product_Map","Criteo Product Map"]);
    const ppcCampaignRows = await readSheet("PPC campaign snapshots", ["PPC_Campaign_Snapshots","PPC Campaign Snapshots","Criteo_Campaign_Snapshots","Criteo Campaign Snapshots","Campaign Reporting","Meta_Ads_Snapshots","Meta Ads Snapshots","Meta Ads Export","Meta Campaign Reporting"]);
    const ppcLineItemRows = await readSheet("PPC line-item snapshots", ["PPC_Line_Item_Snapshots","PPC Line Item Snapshots","Criteo_Line_Item_Snapshots","Criteo Line Item Snapshots","Line Item Reporting"]);
    const ppcSkuRows = await readSheet("PPC SKU snapshots", ["PPC_SKU_Snapshots","PPC SKU Snapshots","Criteo_SKU_Snapshots","Criteo SKU Snapshots","SKU Reporting"]);
    const ppcCapoutRows = await readSheet("PPC capout snapshots", ["PPC_Capout_Snapshots","PPC Capout Snapshots","Criteo_Capout_Snapshots","Criteo Capout Snapshots","Capout Reporting"]);
    const ppcShareRows = await readSheet("PPC impression-share snapshots", ["PPC_Impression_Share_Snapshots","PPC Impression Share Snapshots","Criteo_Impression_Share_Snapshots","Criteo Impression Share Snapshots","Impressions Share Reporting"]);
    const programmaticPacing = programmaticPacingSourcesFromWorkbook(workbook, file.name);
    const emptyWorkbookSales = compileWorkbookSalesFromRows([], [], file.name, [], PRODUCTS);
    const parsedProductMeta = { ...productMetaFromRows(productRows), ...productMetaFromRows(totalWarehouseRows) };
    const productMetaPatch = (productRows.length || totalWarehouseRows.length)
      ? (replace ? parsedProductMeta : { ...productMeta, ...parsedProductMeta })
      : productMeta;
    const parsedCampaignMeta = campaignRows.length ? campaignMetaFromRows(campaignRows, productMetaPatch) : {};
    const campaignMetaPatch = campaignRows.length
      ? (replace ? parsedCampaignMeta : { ...campaignMeta, ...parsedCampaignMeta })
      : campaignMeta;
    const mergedStores = storeRows.length
      ? mergeStoreRows(replace ? WAREHOUSES : whs, storeRows, replace)
      : replace ? { whs:WAREHOUSES, changed:whs !== WAREHOUSES } : { whs, changed:false };
    if (ownerCorrectionRows.length || ownerSalesCorrections.length) {
      const correctionWarehouses = completeOwnerCorrectionDirectory(ownerCorrectionRows, mergedStores.whs, salesRows.map(storeNameFromRow), { ownerSalesCorrections, whs });
      if (correctionWarehouses.length !== mergedStores.whs.length) mergedStores.changed = true;
      mergedStores.whs = correctionWarehouses;
    }
    const correctionContext = { productMeta:productMetaPatch, campaignMeta:campaignMetaPatch, whs:mergedStores.whs };
    const nextInventoryDecisions = mergeOwnerInventoryDecisions(ownerInventoryDecisions, ownerInventoryDecisionsFromSheet(ownerInventoryRows, correctionContext), correctionContext);
    const parsedCorrections = ownerSalesCorrectionsFromSheet(ownerCorrectionRows, correctionContext);
    const retainedCorrections = rebindOwnerSalesCorrections(ownerSalesCorrections, { productMeta, campaignMeta, whs }, correctionContext);
    const nextCorrections = mergeOwnerSalesCorrections(retainedCorrections, parsedCorrections, correctionContext);
    // Validate correction identity/scope before any imported state is replaced.
    setOwnerInventoryDecisions(nextInventoryDecisions);
    setOwnerSalesCorrections(nextCorrections);
    setLocalOwnerSalesHistory(true);
    if (productRows.length || totalWarehouseRows.length) setProductMeta(productMetaPatch);
    if (campaignRows.length) setCampaignMeta(campaignMetaPatch);
    const hasWarehouseRows = storeRows.length || salesRows.length || inlineInventoryHasStore;
    const hasTotalRows = dailyInlineRows.length || allOnlineRows.length || onlineInventoryRows.length;
    if (replace && hasWarehouseRows) {
      setSales([]);
      setProdSales([]);
      setWarehouseDailySales([]);
      setWorkbookSales(emptyWorkbookSales);
      setFootnotes(prev => prev.filter(note => !isImportedFootnote(note)));
    }
    if (replace && hasTotalRows) {
      setInlineTotalSales(prev => dailyInlineRows.length ? [] : prev);
      setOnlineSales(prev => (allOnlineRows.length || onlineInventoryRows.length) ? [] : prev);
    }
    if (replace && videoRows.length && !videoSnapshotDate) {
      setVideos([]);
      setVideoMetrics([]);
    }
    if (videoRows.length) {
      setVideoSelPid("");
      setVideoPlatform("");
      setVideoType("");
    }
    setSelId(null);
    setSelVid(null);
    if (mergedStores.changed) setWhs(mergedStores.whs);
    const importMeta = { productMeta:productMetaPatch, campaignMeta:campaignMetaPatch };
    const processingStartedAt = performance.now();
    await progress("Building warehouse sales rows...");
    const salesCount = salesRows.length ? processCsvData(salesRows, `${file.name} / ${salesSheetNames.join(", ")}`, mergedStores.whs, { replace, ...importMeta }) : 0;
    await progress("Building Costco daily totals...");
    const inlineTotalCount = dailyInlineRows.length ? processInlineTotalSalesRows(dailyInlineRows, `${file.name} / ${inlineTotalSheetName || "Inline totals"}`, { replace, ...importMeta }) : 0;
    await progress("Building online sales rows...");
    const onlineCount = allOnlineRows.length ? processOnlineSalesRows(allOnlineRows, `${file.name} / Online_Sales_Raw`, { replace, ...importMeta }) : 0;
    await progress("Building inventory rows...");
    const inlineInventoryCount = inlineInventoryHasStore ? processInlineInventoryRows(inlineInventoryRows, `${file.name} / Inline_Inventory_Raw`, mergedStores.whs, importMeta) : 0;
    const onlineInventoryCount = onlineInventoryRows.length ? processOnlineSalesRows(onlineInventoryRows, `${file.name} / Online_Inventory_Raw`, importMeta) : 0;
    await progress("Building calendar events...");
    const eventCount = eventRows.length ? processCalendarRows(eventRows, `${file.name} / Calendar_Events`, mergedStores.whs, { replace, ...importMeta }) : 0;
    await progress("Building video metrics...");
    const videoRes = videoRows.length ? processVideoCsvData(videoRows, "", { replace:replace && !videoSnapshotDate, snapshotDate:videoSnapshotDate, ...importMeta }) : { newVideos:0, snapshots:0 };
    await progress("Building paid-media rows...");
    const combinedPpcCampaignRows = ppcCampaignRows.concat(programmaticPacing?.campaignRows || []);
    const combinedPpcLineItemRows = ppcLineItemRows.concat(programmaticPacing?.lineItemRows || []);
    const ppcPeriodRows = programmaticPacing?.periodRows || [];
    const ppcInputRows = combinedPpcCampaignRows.length + combinedPpcLineItemRows.length + ppcSkuRows.length + ppcCapoutRows.length + ppcShareRows.length + ppcPeriodRows.length;
    const ppcCount = ppcInputRows ? processPpcData({
      campaignRows:combinedPpcCampaignRows,
      lineItemRows:combinedPpcLineItemRows,
      skuRows:ppcSkuRows,
      capoutRows:ppcCapoutRows,
      impressionRows:ppcShareRows,
      periodRows:ppcPeriodRows,
      mapRows:ppcMapRows,
    }, file.name, { replace, ...importMeta }) : 0;
    const processingMs = performance.now() - processingStartedAt;
    const elapsedMs = performance.now() - startedAt;
    // A renamed or missing core worksheet used to import silently as an empty lane, which
    // reads as "zero sales" on the dashboard. Missing data is not zero: name the gap.
    const missingSheets = missingCoreWorkbookSheets(workbook, { salesSheetNames, inlineTotalSheetName });
    await progress(`Workbook import complete in ${fmtDuration(elapsedMs)}.`);
    return {
      mode:replace ? "replace" : "daily-update",
      missingSheets,
      elapsedMs,
      workbookReadMs,
      processingMs,
      stores:mergedStores.changed,
      products:productRows.filter(row => String(cellValue(row, ["Product"])).trim()).length,
      campaigns:campaignCatalog(campaignMetaPatch, productMetaPatch).length,
      totalWarehouses:productMetaWarehouseCount(productMetaPatch),
      sales:salesCount,
      inlineTotal:inlineTotalCount,
      online:onlineCount,
      inventory:importedInventoryRows,
      ownerSalesCorrections:parsedCorrections.length,
      inlineInventory:inlineInventoryCount,
      onlineInventory:onlineInventoryCount,
      events:eventCount,
      ppc:ppcCount,
      videos:videoRes.newVideos,
      snapshots:videoRes.snapshots,
      skipped:videoRes.skipped || 0,
      videoSnapshotDate,
    };
  }, [whs, productMeta, campaignMeta, ownerSalesCorrections, processCsvData, processInlineTotalSalesRows, processOnlineSalesRows, processInlineInventoryRows, processCalendarRows, processVideoCsvData, processPpcData, invalidateRuntimeModelsForLocalData]);

  const handleCriteoFile = useCallback(async e => {
    const file = e.target.files[0]; if (!file) return;
    const setImportMessage = message => setImportStatus({ state:"loading", message });
    setImportBusy(true);
    await waitForUiTick();
    try {
      if (/\.(xls)$/i.test(file.name)) throw new Error("Legacy .xls files are blocked for security. Save the file as .xlsx or upload CSV.");
      if (/\.(xlsx|xlsm)$/i.test(file.name)) {
        setImportMessage(`Reading paid-media report ${file.name} (${fmtBytes(file.size)})...`);
        await waitForUiTick();
        const workbook = await readWorkbook(file);
        const readSheet = (names) => sheetRows(workbook, names);
        const ppcMapRows = readSheet(["PPC_Product_Map","PPC Product Map","Criteo_Product_Map","Criteo Product Map"]);
        const ppcCampaignRows = readSheet(["PPC_Campaign_Snapshots","PPC Campaign Snapshots","Criteo_Campaign_Snapshots","Criteo Campaign Snapshots","Campaign Reporting","Meta_Ads_Snapshots","Meta Ads Snapshots","Meta Ads Export","Meta Campaign Reporting"]);
        const ppcLineItemRows = readSheet(["PPC_Line_Item_Snapshots","PPC Line Item Snapshots","Criteo_Line_Item_Snapshots","Criteo Line Item Snapshots","Line Item Reporting"]);
        const ppcSkuRows = readSheet(["PPC_SKU_Snapshots","PPC SKU Snapshots","Criteo_SKU_Snapshots","Criteo SKU Snapshots","SKU Reporting"]);
        const ppcCapoutRows = readSheet(["PPC_Capout_Snapshots","PPC Capout Snapshots","Criteo_Capout_Snapshots","Criteo Capout Snapshots","Capout Reporting"]);
        const ppcShareRows = readSheet(["PPC_Impression_Share_Snapshots","PPC Impression Share Snapshots","Criteo_Impression_Share_Snapshots","Criteo Impression Share Snapshots","Impressions Share Reporting"]);
        const programmaticPacing = programmaticPacingSourcesFromWorkbook(workbook, file.name);
        const combinedPpcCampaignRows = ppcCampaignRows.concat(programmaticPacing?.campaignRows || []);
        const combinedPpcLineItemRows = ppcLineItemRows.concat(programmaticPacing?.lineItemRows || []);
        const ppcPeriodRows = programmaticPacing?.periodRows || [];
        const inputRows = combinedPpcCampaignRows.length + combinedPpcLineItemRows.length + ppcSkuRows.length + ppcCapoutRows.length + ppcShareRows.length + ppcPeriodRows.length;
        if (!inputRows) throw new Error("No paid-media report sheets were found. Expected Criteo PPC sheets, Meta_Ads_Snapshots, or a programmatic pacing report.");
        const n = processPpcData({
          campaignRows:combinedPpcCampaignRows,
          lineItemRows:combinedPpcLineItemRows,
          skuRows:ppcSkuRows,
          capoutRows:ppcCapoutRows,
          impressionRows:ppcShareRows,
          periodRows:ppcPeriodRows,
          mapRows:ppcMapRows,
        }, file.name);
        const reportLabel = programmaticPacing ? `${programmaticPacing.report.product} / ${programmaticPacing.report.audience}` : "paid-media report";
        const message = `${importModeLabel("paidMedia")}: ${reportLabel} loaded with ${n.toLocaleString()} rows. Publish Current to share it with the team.`;
        setImportStatus({ state:"loaded", message });
        showToast(message);
      } else {
        setImportMessage(`Parsing paid-media CSV ${file.name} (${fmtBytes(file.size)})...`);
        const data = await parseCsvRows(file, { preferWorker:false });
        if (!looksLikePaidMediaRows(data)) {
          throw new Error(`This CSV does not look like a paid-media report. ${paidMediaCsvShapeSummary(data)} Expected Meta Ads columns like Campaign name and Amount spent (USD), or Criteo/PPC snapshot columns.`);
        }
        const n = processPpcData(ppcSourcesFromCsvData(data), file.name);
        if (!n) throw new Error("The paid-media CSV was recognized, but no usable paid-media rows were found.");
        const message = `${importModeLabel("paidMedia")}: paid-media CSV loaded with ${n.toLocaleString()} rows. Publish Current to share it with the team.`;
        setImportStatus({ state:"loaded", message });
        showToast(message);
      }
    } catch (err) {
      const message = `Paid-media import failed: ${err?.message || "Could not read file"}`;
      setImportStatus({ state:"error", message });
      showToast(message);
    }
    setImportBusy(false);
    e.target.value = "";
  }, [processPpcData, showToast]);

  const handleFile = useCallback(async e => {
    const file = e.target.files[0]; if (!file) return;
    const setImportMessage = message => setImportStatus({ state:"loading", message });
    setImportBusy(true);
    await waitForUiTick();
    try {
      if (/\.(xls)$/i.test(file.name)) throw new Error("Legacy .xls files are blocked for security. Save the file as .xlsx or upload CSV.");
      if (/\.(xlsx|xlsm)$/i.test(file.name)) {
        setImportMessage(`Loading workbook ${file.name} (${fmtBytes(file.size)})...`);
        showToast("Loading workbook...");
        const res = await processWorkbookFile(file, setImportMessage);
        detailLoadedRef.current = true;
        setDetailDatasetLoaded(true);
        setPublishedActiveWarehouseIds([]);
        setDetailDatasetStatus({ state:"loaded", message:"Full warehouse detail is available from the imported workbook." });
        const missingNote = res.missingSheets?.length
          ? ` Warning: worksheet${res.missingSheets.length === 1 ? "" : "s"} ${res.missingSheets.join(", ")} not found in this workbook, so ${res.missingSheets.length === 1 ? "that lane" : "those lanes"} imported as missing (not zero).`
          : "";
        const message = `${importModeLabel("workbook")}: workbook loaded with ${res.sales} warehouse rows, ${res.inlineTotal} inline total, ${res.online} online, ${res.ppc || 0} paid-media rows, ${res.inventory || 0} inventory rows, ${res.totalWarehouses || 0} Products_Master warehouse counts, ${res.campaigns || 0} campaigns, ${res.events} events, ${res.snapshots} video rows${res.videoSnapshotDate ? ` as of ${res.videoSnapshotDate}` : ""}${videoImportStatusSuffix(res)} in ${fmtDuration(res.elapsedMs)}.${missingNote}`;
        setImportStatus({ state:"loaded", message });
        showToast(missingNote ? `Workbook loaded with missing worksheets: ${res.missingSheets.join(", ")}` : message);
      } else {
        if (!detailLoadedRef.current) {
          const loaded = await loadDetailDataset({ reason:"CSV update" });
          if (!loaded) throw new Error("Warehouse detail is required before a CSV update can be applied.");
          throw new Error("Warehouse detail is ready. Select the CSV one more time to apply it safely.");
        }
        setImportMessage(`Parsing CSV ${file.name} (${fmtBytes(file.size)})...`);
        const data = await parseCsvRows(file);
        setImportMessage(`Processing ${data.length.toLocaleString()} CSV rows...`);
        await waitForUiTick();
        const kind = detectImportKind(data);
        let message = "";
        if (kind === "videos") {
          const res = processVideoCsvData(data, file.name);
          message = `${importModeLabel("videos")}: videos loaded with ${res.newVideos} new videos and ${res.snapshots} snapshots${videoImportStatusSuffix(res)}`;
        } else if (kind === "ppc") {
          const n = processPpcData(ppcSourcesFromCsvData(data), file.name);
          message = `${importModeLabel("paidMedia")}: paid media loaded with ${n} rows from ${file.name}`;
        } else if (kind === "events") {
          const n = processCalendarRows(data, file.name);
          message = `${importModeLabel("csv")}: calendar loaded with ${n} events from ${file.name}`;
        } else if (kind === "inline_total") {
          const n = processInlineTotalSalesRows(data, file.name);
          message = `${importModeLabel("csv")}: inline totals loaded with ${n} rows from ${file.name}`;
        } else if (kind === "online") {
          if (looksLikeInlineTotalSource(data, file.name)) {
            const n = processInlineTotalSalesRows(data, file.name);
            message = `${importModeLabel("csv")}: inline totals loaded with ${n} rows from ${file.name}`;
          } else {
            const n = processOnlineSalesRows(data, file.name);
            message = `${importModeLabel("csv")}: online sales loaded with ${n} rows from ${file.name}`;
          }
        } else if (kind === "inline_inventory") {
          const n = processInlineInventoryRows(data, file.name);
          message = `${importModeLabel("csv")}: inline inventory loaded with ${n} rows from ${file.name}`;
        } else {
          const n = processCsvData(data, file.name);
          message = `${importModeLabel("csv")}: sales loaded with ${n} rows from ${file.name}`;
        }
        setImportStatus({ state:"loaded", message });
        showToast(message);
      }
    } catch (err) {
      const message = `Import failed: ${err?.message||"Could not read file"}`;
      setImportStatus({ state:"error", message });
      showToast(message);
    }
    setImportBusy(false);
    e.target.value = "";
  }, [processWorkbookFile, processCsvData, processInlineTotalSalesRows, processOnlineSalesRows, processInlineInventoryRows, processCalendarRows, processVideoCsvData, processPpcData, looksLikeInlineTotalSource, showToast, loadDetailDataset]);

  const handleDailyUpdateFile = useCallback(async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) {
      const message = "Daily Update requires the validated compact .xlsx workbook.";
      setImportStatus({ state:"error", message });
      showToast(message);
      e.target.value = "";
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      const message = "Daily Update is larger than the 10 MB compact-upload limit.";
      setImportStatus({ state:"error", message });
      showToast(message);
      e.target.value = "";
      return;
    }
    pendingDailyUpdateRef.current = file;
    setPublishAction("dailyUpdate");
    setPublishToken("");
    setImportStatus({ state:"loading", message:`Compact daily update selected (${fmtBytes(file.size)}). Enter the admin token to validate and publish it securely on the server.` });
    setPublishModalOpen(true);
    e.target.value = "";
  }, [showToast]);
  const handleVideoFile = useCallback(async e => {
    const input = e.target;
    const file = input.files[0]; if (!file) return;
    input.value = "";
    try {
      const Papa = await loadPapa();
      await new Promise((resolve, reject) => Papa.parse(file, { header:true, skipEmptyLines:true, complete:({ data }) => {
      const res = processVideoCsvData(data, file.name);
      const message = `${importModeLabel("videos")}: videos loaded with ${res.newVideos} new videos and ${res.snapshots} snapshots${videoImportStatusSuffix(res)}`;
      setImportStatus({ state:"loaded", message });
      showToast(message);
        resolve();
      }, error:reject }));
    } catch (error) {
      const message = `Video import failed: ${error?.message || "Could not read file"}`;
      setImportStatus({ state:"error", message });
      showToast(message);
    }
  }, [processVideoCsvData, showToast]);

  const dlVideoTemplate = () => {
    const csv = "Type,video_url,title_caption,collection,creator,platform,Product_ID,Product,Campaign_ID,Campaign,Rate,published_at,collected_at,Views,Likes,Comments,Saves,Shares\n";
    const a = Object.assign(document.createElement("a"), { href:URL.createObjectURL(new Blob([csv],{type:"text/csv"})), download:"byou_video_template.csv" });
    a.click();
  };

  const fetchLive = useCallback(async () => {
    if (!liveUrl) return;
    showToast("⟳ Fetching…");
    try {
      const url = safeLiveCsvUrl(liveUrl);
      if (!url) throw new Error("Live URL must be a published HTTPS Google Sheets CSV link.");
      const res = await fetch(url, { cache:"no-store" });
      if (!res.ok) throw new Error("Could not fetch live CSV.");
      const text = await res.text();
      const Papa = await loadPapa();
      const rows = await new Promise((resolve, reject) => Papa.parse(text, {
        header:true,
        skipEmptyLines:true,
        complete:({ data }) => resolve(usableObjectRows(data)),
        error:reject,
      }));
      const kind = detectImportKind(rows);
      const n = kind === "events" ? processCalendarRows(rows, "live URL") : kind === "ppc" ? processPpcData(ppcSourcesFromCsvData(rows), url) : kind === "inline_total" ? processInlineTotalSalesRows(rows, "live URL") : kind === "online" ? (looksLikeInlineTotalSource(rows, url) ? processInlineTotalSalesRows(rows, "live URL") : processOnlineSalesRows(rows, "live URL")) : kind === "inline_inventory" ? processInlineInventoryRows(rows, "live URL") : processCsvData(rows, "live URL");
      setLastRefresh(new Date());
      showToast(`✓ Live: ${n} new rows`);
    } catch (_) { showToast("⚠ Fetch failed — check URL"); }
  }, [liveUrl, processCsvData, processInlineTotalSalesRows, processOnlineSalesRows, processInlineInventoryRows, processCalendarRows, processPpcData, looksLikeInlineTotalSource, showToast, loadDetailDataset]);

  useEffect(() => {
    if (!liveUrl) return;
    fetchLive();
    const id = setInterval(fetchLive, 30*60*1000);
    return () => clearInterval(id);
  }, [liveUrl, fetchLive]);

  const dlTemplate = async () => {
    const fallbackCsv = "Date,Store,City,State,Lat,Lng,Product,Revenue,Units,Event\n";
    try {
      const writeExcelFile = await loadSpreadsheetExporter();
      const sheets = [];
      const addSheet = (name, rows) => sheets.push(templateSheet(name, rows));
      const blank = cols => Object.fromEntries(cols.map(col => [col, ""]));
      addSheet("Products_Master", PRODUCTS.map(p => ({ Product:p.name, "Short Name":p.short, Product_ID:p.name, Category:"", "Brand Color":p.col, Active:"Yes", "Online/In-Line":"Both", "Total Warehouses":"" })));
      addSheet("Campaigns_Master", [
        blank(["Campaign_ID","Campaign","Product_ID","Product","Start Date","End Date","Channel","Campaign Type","Status","Campaign Color","Notes"]),
      ]);
      addSheet("Stores_Master", [
        blank(["Store","City","State","Region","Latitude","Longitude","Active"]),
      ]);
      addSheet("Sales_Raw", [
        blank(["Date","Store","City","State","Region","Product_ID","Product","Campaign_ID","Campaign","Revenue","Units","Inventory On Hand","Event"]),
      ]);
      addSheet("Costco_Daily_Totals", [
        blank(["Date","Product_ID","Product","Campaign_ID","Campaign","Venue","Number of Warehouses","Warehouses Selling","Revenue","Units","Refund Dollars","Refund Units","Inventory"]),
      ]);
      addSheet("Costco_Source_Paste", [
        blank(["Product_ID","Product","Campaign_ID","Campaign","Time","Venue","Number of Warehouses","Warehouses Selling","Dollar Sales","Unit Sales","Promoted Dollars","Promoted Units","Refund Dollars","Refund Units","Inventory On Hand","Product Notes"]),
      ]);
      addSheet("Inline_Inventory_Raw", [
        blank(["Date","Store","City","State","Region","Product_ID","Product","Campaign_ID","Campaign","Inventory","Units"]),
      ]);
      addSheet("Online_Sales_Raw", [
        blank(["Date","Product_ID","Product","Campaign_ID","Campaign","Channel","Revenue","Units","Sessions","Ad Spend","Inventory","Notes"]),
      ]);
      addSheet("Online_Inventory_Raw", [
        blank(["Date","Product_ID","Product","Campaign_ID","Campaign","Channel","Inventory","Units","Orders"]),
      ]);
      addSheet("PPC_Product_Map", [
        blank(["Partner","External Campaign ID","SKU ID","Criteo Product","Product_ID","Product","Campaign_ID","Campaign","Notes"]),
      ]);
      addSheet("PPC_Campaign_Snapshots", [
        blank(["Partner","Snapshot Start","Snapshot End","External Campaign ID","Campaign Name","Campaign Type","Campaign_ID","Product_ID","Spend","Attributed Sales","Attributed Units","Clicks","Impressions","CTR","CPC","ROAS","Budget Remaining","Lifetime Spend","Lifetime Sales","Lifetime Units"]),
      ]);
      addSheet("Meta_Ads_Snapshots", [
        blank(["Campaign name","Ad set name","Ad name","Ads","Objective","Day","Reach","Impressions","Frequency","Amount spent (USD)","Attribution setting","Result type","Results","Cost per result","CTR (all)","CPM (cost per 1,000 impressions)","CPC (cost per link click)","Link clicks","Views","Video plays at 50%","Video plays at 75%","Video plays at 100%","Video plays","CTR (link click-through rate)","Landing page views","ThruPlays","3-second video plays","Outbound CTR (click-through rate)","Outbound clicks","Reporting starts","Reporting ends","Product_ID","Campaign_ID"]),
      ]);
      addSheet("PPC_SKU_Snapshots", [
        blank(["Partner","Snapshot Start","Snapshot End","External Campaign ID","SKU ID","Product_ID","Product","Campaign_ID","Spend","Attributed Sales","Attributed Units","Clicks","Impressions","CTR","CPC","ROAS","Lifetime Spend","Lifetime Sales","Lifetime Units"]),
      ]);
      addSheet("PPC_Capout_Snapshots", [
        blank(["Partner","Snapshot Start","Snapshot End","External Campaign ID","Campaign_ID","Product_ID","Product","Avg Capout Hour","Missed Traffic","Missed Clicks","Missed Spend","Missed Sales","Capout Status"]),
      ]);
      addSheet("PPC_Impression_Share_Snapshots", [
        blank(["Partner","Snapshot Start","Snapshot End","External Campaign ID","Campaign_ID","Product_ID","Product","Impression Share","Clicks","Impressions","Spend","Attributed Sales"]),
      ]);
      addSheet("Calendar_Events", [
        blank(["Date","Type","Product_ID","Product","Campaign_ID","Campaign","Store","Region","State","Title","Notes"]),
      ]);
      addSheet("Paid_Videos_Raw", [
        blank(["Type","video_url","title_caption","collection","creator","platform","Product_ID","Product","Campaign_ID","Campaign","Rate","published_at","collected_at","Views","Likes","Comments","Saves","Shares"]),
      ]);
      addSheet("Seeding_Videos_Raw", [
        blank(["Type","video_url","title_caption","collection","creator","platform","Product_ID","Product","Campaign_ID","Campaign","Rate","published_at","collected_at","Views","Likes","Comments","Saves","Shares"]),
      ]);
      addSheet("Videos_Raw", [
        blank(["Type","video_url","title_caption","collection","creator","platform","Product_ID","Product","Campaign_ID","Campaign","Rate","published_at","collected_at","Views","Likes","Comments","Saves","Shares"]),
      ]);
      addSheet("Upload_Checks", [
        { Check:"Products_Master has Total Warehouses", Status:"Required", Notes:"This supplies the separate Total Warehouses campaign-footprint KPI. Revenue/Door does not use this projected count." },
        { Check:"Warehouse sales identify real selling stores", Status:"Required", Notes:"Revenue/Door counts unique verified selling stores and excludes RCTR/DCTR, Dry, Wet, ecommerce, holding, distribution, inventory-only, and refund/return proxy locations." },
        { Check:"Campaigns_Master has Product_ID + Campaign_ID", Status:"Recommended", Notes:"Use the product name as Product_ID, then use Campaign_ID to split one product into multiple Costco campaigns/programs." },
        { Check:"Costco_Daily_Totals has Date + Product + Revenue/Units", Status:"OK", Notes:"Use this for Costco-provided total inline sales and inventory." },
        { Check:"Online_Sales_Raw has no Store column", Status:"OK", Notes:"Use Channel for Costco.com, Amazon, DTC, TikTok Shop, or another online storefront." },
        { Check:"Paid-media snapshots are separate from Costco sales", Status:"Recommended", Notes:"Use PPC_* tabs for Criteo or Meta_Ads_Snapshots for Meta exports. Paid-media totals do not replace Costco_Daily_Totals." },
        { Check:"Inline_Inventory_Raw has Store + Product + Inventory", Status:"OK", Notes:"Use this for warehouse inventory snapshots when inventory is not in Sales_Raw." },
        { Check:"Online_Inventory_Raw has Product + Channel + Inventory", Status:"OK", Notes:"Use this for ecommerce inventory snapshots without store fields." },
        { Check:"Dates use YYYY-MM-DD", Status:"Recommended", Notes:"The dashboard also accepts most Excel dates." },
      ]);
      addSheet("README", [
        { Section:"Product Master", Detail:"Add Total Warehouses for each product in Products_Master so the campaign footprint KPI shows the supplied projected amount. Revenue/Door separately uses unique verified selling stores in the selected scope." },
        { Section:"Campaign Master", Detail:"Use Campaigns_Master for Costco campaign/program definitions. Product_ID should be the product name from Products_Master, such as Lumen Grove Daily Cream. Each row has Campaign_ID, Campaign, Start Date, End Date, Channel, Status, and optional Campaign Color. Raw rows can include Campaign_ID; if omitted, the app infers a campaign from Product_ID + Date when exactly one matching campaign window exists." },
        { Section:"Costco Total Sales", Detail:"Use Costco_Daily_Totals for total inline sales/inventory by product or region. Required: Date, Product, Revenue or Units. The dashboard uses this for total-picture Sales and Inventory Flow when no warehouse filter is active." },
        { Section:"Costco Source Paste", Detail:"Costco_Source_Paste is optional scratch space for the raw Costco export. Copy cleaned rows into Costco_Daily_Totals before uploading to the app." },
        { Section:"Online Sales", Detail:"Use Online_Sales_Raw for ecommerce rows. Required: Date, Product, Channel, Revenue. Helpful: Units, Sessions, Ad Spend, Notes." },
        { Section:"Paid Media / Criteo + Meta", Detail:"Use PPC_Campaign_Snapshots, PPC_SKU_Snapshots, PPC_Capout_Snapshots, and PPC_Impression_Share_Snapshots for Criteo. Use Meta_Ads_Snapshots or upload a Meta Ads Manager CSV export for Meta. Use Product_ID and Campaign_ID columns, or PPC_Product_Map, when paid-media names need to map to BYOU products or Costco campaigns." },
        { Section:"Videos / Trackify", Detail:"Use Videos_Raw or Trackify sheets for video metrics. Product_ID and Campaign_ID are best, but collection, campaign, title, and caption text can infer the closest active Campaigns_Master row using the posted date first." },
        { Section:"Store Sales", Detail:"Use Sales_Raw for Costco warehouse rows. Required: Date, Store, Product, Revenue." },
        { Section:"Inventory", Detail:"Use Inline_Inventory_Raw for store inventory and Online_Inventory_Raw for ecommerce inventory. Required: Date, Product, Inventory. Add Store for inline or Channel for online. Helpful: Units." },
      ]);
      await writeExcelFile(sheets).toFile("BYOU_INTEL_Upload_Template.xlsx");
    } catch (_) {
      const a = Object.assign(document.createElement("a"), { href:URL.createObjectURL(new Blob([fallbackCsv],{type:"text/csv"})), download:"byou_template.csv" });
      a.click();
    }
  };

  const mapOfficialRows = useMemo(() => {
    if (tab !== "map") return [];
    return [
      ...inlineTotalSales.map(r => ({ ...r, sourceType:"Inline" })),
      ...onlineSales.map(r => ({ ...r, sourceType:"Online" })),
    ].filter(r => r.date >= campaignDR.start && r.date <= campaignDR.end && mapRowInProductScope(r) && (Number(r.rev || 0) > 0 || Number(r.units || 0) > 0));
  }, [tab, inlineTotalSales, onlineSales, campaignDR, mapRowInProductScope]);
  const mapOfficialInlineRows = useMemo(() => (
    mapOfficialRows.filter(r => r.sourceType !== "Online")
  ), [mapOfficialRows]);
  const sidebarWidth = 238;
  const sidebarRows = tab === "analytics" ? salesSidebarRanked : tab === "calendar" ? calendarSidebarRanked : tab === "inventory" ? inventorySidebarRanked : tab === "map" ? mapRanked : ranked;
  const storeQuery = storeSearch.trim();
  const searchedSidebarRows = useMemo(() => (
    filterWarehouseMatches(sidebarRows, storeQuery)
  ), [sidebarRows, storeQuery]);
  const searchedStoreIds = useMemo(() => new Set(searchedSidebarRows.map(row => row.id).filter(Boolean)), [searchedSidebarRows]);
  const visibleMapRanked = useMemo(() => (
    tab === "map" ? scopeRowsToWarehouseMatches(mapRanked, searchedSidebarRows, storeQuery) : mapRanked
  ), [tab, mapRanked, searchedSidebarRows, storeQuery]);
  const visibleMapSales = useMemo(() => (
    tab === "map" ? scopeRowsToWarehouseMatches(mapSales, searchedSidebarRows, storeQuery) : mapSales
  ), [tab, mapSales, searchedSidebarRows, storeQuery]);
  const visibleMapStoreIds = useMemo(() => new Set(visibleMapRanked.map(row => row.id).filter(Boolean)), [visibleMapRanked]);
  const visibleActiveWhs = useMemo(() => (
    storeQuery ? activeWhs.filter(warehouse => searchedStoreIds.has(warehouse.id)) : activeWhs
  ), [activeWhs, searchedStoreIds, storeQuery]);
  const visibleInventoryWhs = useMemo(() => (
    storeQuery ? inventoryWhs.filter(warehouse => searchedStoreIds.has(warehouse.id)) : inventoryWhs
  ), [inventoryWhs, searchedStoreIds, storeQuery]);
  const visibleCalendarProdSales = useMemo(() => (
    storeQuery ? channelData.prodSales.filter(row => searchedStoreIds.has(row.wid)) : channelData.prodSales
  ), [channelData.prodSales, searchedStoreIds, storeQuery]);
  const visibleCalendarFootnotes = useMemo(() => (
    storeQuery ? channelData.footnotes.filter(note => !note.wid || searchedStoreIds.has(note.wid)) : channelData.footnotes
  ), [channelData.footnotes, searchedStoreIds, storeQuery]);
  const visibleMapFootnotes = useMemo(() => (
    tab !== "map" ? [] : storeQuery ? footnotes.filter(note => !note.wid || searchedStoreIds.has(note.wid)) : footnotes
  ), [tab, footnotes, searchedStoreIds, storeQuery]);
  const mapCoverageStats = useMemo(() => {
    if (tab !== "map") return EMPTY_MAP_COVERAGE;
    const rows = consumerProdSales.filter(r =>
      r.date >= campaignDR.start &&
      r.date <= campaignDR.end &&
      mapAllowedStoreIds.has(r.wid) &&
      visibleMapStoreIds.has(r.wid) &&
      mapRowInProductScope(r) &&
      (Number(r.rev || 0) > 0 || Number(r.units || 0) > 0)
    );
    const unionStoreIds = new Set(rows.map(r => r.wid).filter(Boolean));
    const rowsByStore = _.groupBy(rows, "wid");
    const rowsByProduct = _.groupBy(rows, mapProductKeyForRow);
    const sharedStoreIds = mapScopes.length > 1
      ? [...unionStoreIds].filter(wid => mapScopes.every(scope => (rowsByStore[wid] || []).some(row => mapRowMatchesScope(row, scope))))
      : [...unionStoreIds];
    const productStats = mapScopes.length
      ? mapScopes.map(scope => {
          const scopeRows = rows.filter(row => mapRowMatchesScope(row, scope));
          return {
            key:scope.key,
            pid:scope.pid,
            cid:scope.cid,
            product:scope.label,
            col:scope.col,
            stores:new Set(scopeRows.map(row => row.wid).filter(Boolean)).size,
            rev:_.sumBy(scopeRows, "rev"),
            units:_.sumBy(scopeRows, "units"),
          };
        })
      : productOptions.map(product => {
          const productRows = rowsByProduct[product.id] || [];
          return {
            key:product.id,
            pid:product.id,
            product:product.short || product.id || "Product",
            col:product.col || C.blue,
            stores:new Set(productRows.map(row => row.wid).filter(Boolean)).size,
            rev:_.sumBy(productRows, "rev"),
            units:_.sumBy(productRows, "units"),
          };
        }).filter(product => product.stores > 0);
    return {
      selectedCount:mapScopes.length,
      unionStores:unionStoreIds.size,
      sharedStores:sharedStoreIds.length,
      partialStores:Math.max(0, unionStoreIds.size - sharedStoreIds.length),
      productStats,
    };
  }, [tab, consumerProdSales, campaignDR, mapAllowedStoreIds, visibleMapStoreIds, mapScopes, mapRowInProductScope, mapRowMatchesScope, mapProductKeyForRow, productOptions]);
  const mapSelectedProducts = useMemo(() => mapScopes.map(scope => ({ ...scope, product:scope.label })), [mapScopes]);
  const mapWarehouseScoped = !!(mapRegion || mapState || storeQuery);
  const mapUseOfficialTotals = !mapComparisonMode && !mapWarehouseScoped && mapOfficialInlineRows.length > 0;
  const mapWarehouseRev = _.sumBy(visibleMapRanked, "total");
  const mapTotalRev = mapUseOfficialTotals ? _.sumBy(mapOfficialInlineRows, "rev") : mapWarehouseRev;
  const mapRevenueDoorProductIds = useMemo(() => {
    if (tab !== "map") return [];
    if (mapPids.length) return _.uniq(mapPids);
    const rows = mapUseOfficialTotals ? mapOfficialInlineRows : visibleMapSales;
    return productIdsFromRows(rows.filter(r => Number(r.rev || 0) > 0));
  }, [tab, mapPids, mapUseOfficialTotals, mapOfficialInlineRows, visibleMapSales]);
  const mapDoorStats = useMemo(() => {
    if (tab !== "map") return EMPTY_REVENUE_DOOR_STATS;
    return totalRevenueDoorStats(mapUseOfficialTotals ? mapOfficialInlineRows : visibleMapSales, productMeta, mapRevenueDoorProductIds, { denominatorRows:visibleMapSales, warehouses:activeWhs, start:campaignDR.start, end:campaignDR.end });
  }, [tab, mapUseOfficialTotals, mapOfficialInlineRows, visibleMapSales, activeWhs, productMeta, mapRevenueDoorProductIds, campaignDR.start, campaignDR.end]);
  const mapRevenuePerStore = mapDoorStats.revenuePerDoor;
  const mapBest = visibleMapRanked[0], mapWorst = visibleMapRanked[visibleMapRanked.length - 1];
  const mapMinT = mapWorst?.total || 0, mapMaxT = mapBest?.total || 1;
  useEffect(() => {
    if (selId && tab !== "rankings" && tab !== "videos" && !searchedSidebarRows.some(w => w.id === selId)) setSelId(null);
  }, [selId, tab, searchedSidebarRows]);
  const handleDashboardWheel = useCallback(e => {
    if (!e.deltaY) return;
    const unit = e.deltaMode === 1 ? 36 : e.deltaMode === 2 ? window.innerHeight : 1;
    const dy = e.deltaY * unit;
    let el = e.target;
    while (el && el !== e.currentTarget) {
      if (el instanceof HTMLElement) {
        const style = window.getComputedStyle(el);
        const canScrollY = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
        if (canScrollY) {
          const atTop = el.scrollTop <= 0;
          const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
          if ((dy < 0 && !atTop) || (dy > 0 && !atBottom)) return;
        }
      }
      el = el?.parentElement;
    }
    const scroller = document.scrollingElement || document.documentElement;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    if (maxScroll <= 0) return;
    const next = Math.max(0, Math.min(maxScroll, scroller.scrollTop + dy));
    if (next !== scroller.scrollTop) {
      e.preventDefault();
      scroller.scrollTop = next;
    }
  }, []);

  const selectedStore = selId ? (whs.find(w => w.id === selId) || activeWhs.find(w => w.id === selId)) : null;
  const currentProductId = tab === "rankings" && analysisSection === "warehouses"
    ? analysisOptions.warehousePid
    : tab === "campaign" || tab === "rankings" ? campaignPid : tab === "calendar" ? calendarPid : tab === "inventory" ? inventoryPid : tab === "videos" ? videoSelPid : tab === "analytics" ? selPid : "";
  const runtimeScopeLabel = `${currentProductId ? productLabelForValue(currentProductId, productMeta) : t("filter.allProducts", "All Products")} ${uiLang === "ko" ? (tab === "inventory" ? "재고" : "데이터") : (tab === "inventory" ? "inventory" : tab === "analytics" ? "sales" : "data")}`;
  const effectiveAnalysisViewModel = analysisViewModel;
  const compactViewDiagnostics = tab === "rankings" ? effectiveAnalysisViewModel : tab === "inventory" ? inventoryViewModel : tab === "analytics" ? salesViewModel : null;
  const activeAnalysisModel = effectiveAnalysisViewModel?.section === analysisSection ? effectiveAnalysisViewModel.result || null : null;
  const currentDateRange = tab === "rankings" && analysisSection === "warehouses"
    ? {
      start:analysisOptions.warehouseFrom || startupBoundsRef.current.start || campaignDR.start,
      end:analysisOptions.warehouseTo || startupBoundsRef.current.end || campaignDR.end,
    }
    : tab === "videos" ? videoDateRange : tab === "calendar" ? calendarDR : tab === "inventory" ? inventoryDR : tab === "analytics" ? analyticsDR : campaignDR;
  const currentDateBounds = tab === "videos" ? videoDateBounds : tab === "calendar" ? calendarDateBounds : salesDateBounds;
  const visibleSidebarCampaignOptions = useMemo(() => dateAwareCampaignOptions(
    sidebarCampaignOptions,
    currentDateRange.end,
    [activeCampaignId],
  ), [sidebarCampaignOptions, currentDateRange.end, activeCampaignId]);
  const visibleMapCampaignOptions = useMemo(() => tab === "map" ? mapCampaignOptions.map((options, index) => dateAwareCampaignOptions(
    options,
    currentDateRange.end,
    [mapSelections[index]?.cid],
  )) : [[], []], [tab, mapCampaignOptions, currentDateRange.end, mapSelections]);
  const warehouseSelectedCampaign = tab === "rankings" && analysisSection === "warehouses" && analysisOptions.warehouseCid
    ? campaignWithMeta(analysisOptions.warehouseCid, campaignMeta, productMeta)
    : null;
  const selectedCampaignLabel = warehouseSelectedCampaign?.short || (tab === "rankings" && analysisSection === "warehouses" ? analysisOptions.warehouseCid : activeCampaign?.short || (activeCampaignId ? activeCampaignId : ""));
  const activeFilterChips = [
    { key:"date", label:"Date", value:shortDateRangeLabel(currentDateRange) },
    tab !== "map" ? (currentProductId ? { key:"product", label:"Product", value:productLabelForValue(currentProductId, productMeta), strong:true, onClear:() => setProductForCurrentTab("") } : { key:"product", label:"Product", value:t("filter.allProducts", "All Products") }) : null,
    tab === "rankings" || (tab === "inventory" && activeCampaignId) ? (selectedCampaignLabel ? { key:"campaign", label:"Campaign", value:selectedCampaignLabel, strong:true, onClear:() => tab === "rankings" && analysisSection === "warehouses" ? setAnalysisOptions(previous => ({ ...previous, warehouseCid:"" })) : (setActiveCampaignId(""), setCampaignCid("")) } : null) : tab !== "map" ? { key:"campaign", label:"Campaign", value:campaignChannel === "online" ? t("filter.online", "Online") : t("filter.inline", "Inline"), strong:true } : null,
    ...(tab === "map" ? mapScopes.map(scope => ({
      key:`map-scope-${scope.index}`,
      label:scope.index === 0 ? t("filter.baselineCampaign", "Baseline Campaign") : t("filter.comparisonCampaign", "Comparison Campaign"),
      value:scope.label,
      strong:true,
      onClear:() => setMapSelections(previous => scope.index === 0
        ? [{ pid:"", cid:"" }, { pid:"", cid:"" }]
        : [previous[0] || { pid:"", cid:"" }, { pid:"", cid:"" }]),
    })) : []),
    storeQuery ? { key:"store-search", label:"Store Search", value:storeQuery, strong:true, onClear:() => setStoreSearch("") } : null,
    selectedStore ? { key:"store", label:"Store", value:selectedStore.name, strong:true, onClear:() => setSelId(null) } : null,
    tab === "analytics" && salesRegion ? { key:"sales-region", label:"Region", value:salesRegion, strong:true, onClear:() => setSalesRegion("") } : null,
    tab === "analytics" && salesState ? { key:"sales-state", label:"State", value:salesState, strong:true, onClear:() => setSalesState("") } : null,
    tab === "map" && mapRegion ? { key:"map-region", label:"Region", value:mapRegion, strong:true, onClear:() => setMapRegion("") } : null,
    tab === "map" && mapState ? { key:"map-state", label:"State", value:mapState, strong:true, onClear:() => setMapState("") } : null,
    tab === "inventory" && inventoryRegion ? { key:"inventory-region", label:"Region", value:inventoryRegion, strong:true, onClear:() => setInventoryRegion("") } : null,
    tab === "inventory" && inventoryState ? { key:"inventory-state", label:"State", value:inventoryState, strong:true, onClear:() => setInventoryState("") } : null,
    tab === "rankings" && analysisSection === "warehouses" && analysisOptions.warehouseRegion ? { key:"warehouse-region", label:"Region", value:analysisOptions.warehouseRegion, strong:true, onClear:() => setAnalysisOptions(previous => ({ ...previous, warehouseRegion:"", warehouseState:"" })) } : null,
    tab === "rankings" && analysisSection === "warehouses" && analysisOptions.warehouseState ? { key:"warehouse-state", label:"State", value:analysisOptions.warehouseState, strong:true, onClear:() => setAnalysisOptions(previous => ({ ...previous, warehouseState:"" })) } : null,
    tab === "videos" && videoType ? { key:"video-type", label:"Video Type", value:videoType, strong:true, onClear:() => setVideoType("") } : null,
    tab === "videos" && videoPlatform ? { key:"video-platform", label:"Platform", value:videoPlatform, strong:true, onClear:() => setVideoPlatform("") } : null,
  ].filter(Boolean);
  const hasClearableFilters = activeFilterChips.some(chip => chip.onClear);
  const clearAllActiveFilters = useCallback(() => {
    setSelId(null);
    setCampaignPid("");
    setCampaignCid("");
    setActiveCampaignId("");
    setCalendarPid("");
    setInventoryPid("");
    setSelPid("");
    setVideoSelPid("");
    setMapSelections([{ pid:"", cid:"" }, { pid:"", cid:"" }]);
    setSalesRegion("");
    setSalesState("");
    setMapRegion("");
    setMapState("");
    setInventoryRegion("");
    setInventoryState("");
    setVideoType("");
    setVideoPlatform("");
    setStoreSearch("");
    setAnalysisOptions(previous => ({
      ...previous,
      warehousePid:"",
      warehouseCid:"",
      warehouseFrom:"",
      warehouseTo:"",
      warehouseRegion:"",
      warehouseState:"",
    }));
  }, []);

  const mapStoreVelocity = tab !== "map" ? 0 : (() => {
    const activeRows = visibleMapSales.filter(r => Number(r.rev || 0) > 0 || Number(r.units || 0) > 0);
    const activeStores = new Set(activeRows.map(r => r.wid)).size;
    const activeDays = new Set(activeRows.map(r => r.date)).size;
    return activeStores && activeDays ? _.sumBy(activeRows, "units") / activeStores / activeDays : 0;
  })();
  const mapKpis = tab === "map" ? [
    { label:"Total Revenue", val:fmtCompactMoney(mapTotalRev), exact:fmtCurrency(mapTotalRev), c:C.green },
    ...(mapScopes.length > 1
      ? [{ label:"Matched Coverage", val:mapCoverageStats.sharedStores.toLocaleString(), sub:`${mapCoverageStats.unionStores} total selected reach`, c:C.green }]
      : [{ label:"Top Performer", val:mapBest?.name||"—", sub:fmtCompactMoney(mapBest?.total||0), c:C.green }]),
    { label:"Revenue / Door", val:mapDoorStats.activeDoors ? fmtCompactMoney(mapRevenuePerStore) : t("common.notAvailable", "N/A"), exact:mapDoorStats.activeDoors ? fmtCurrency(mapRevenuePerStore) : "", sub:mapDoorStats.activeDoors ? `Avg ${mapDoorStats.weeklyPeriodCount.toLocaleString()} weekly period${mapDoorStats.weeklyPeriodCount===1 ? "" : "s"} · ${mapDoorStats.activeDoors.toLocaleString()} verified stores` : "No verified weekly selling stores", c:C.blue },
    { label:"Store Velocity", val:`${mapStoreVelocity.toFixed(1)} ${t("common.units", "units")}`, exact:t("map.velocityHint", "Average units sold per active store per active day in the current map scope"), c:C.accent },
  ] : [];
  const reportNavItems = [
    ["campaign", t("nav.campaign","Campaign")],
    ["map", t("nav.map","Map")],

    ["analytics", t("nav.sales","Sales")],
    ["inventory", t("nav.inventory","Inventory")],
    ["rankings", t("nav.analysis","Analysis")],
    ["pnl", t("nav.pnl","P&L")],
    ["videos", t("nav.videos","Videos")],
  ];
  const switchReport = useCallback(nextTab => {
    if (!nextTab || nextTab === tab) return;
    reportPaintRef.current = { startedAt:performance.now(), tab:nextTab };
    setViewReadyMs(null);
    setViewReadyKey("");
    setSelId(null);
    setSelVid(null);
    setStoreSearch("");
    setCampaignPid("");
    setCampaignCid("");
    setActiveCampaignId("");
    setCalendarPid("");
    setInventoryPid("");
    setSelPid("");
    setVideoSelPid("");
    setMapSelections([{ pid:"", cid:"" }, { pid:"", cid:"" }]);
    setSalesRegion("");
    setSalesState("");
    setMapRegion("");
    setMapState("");
    setInventoryRegion("");
    setInventoryState("");
    setVideoType("");
    setVideoPlatform("");

    const salesRange = fullDateRange(salesDateBounds);
    if (nextTab === "videos") {
      videoDateAutoRef.current = false;
      setVideoDateRange(fullDateRange(videoDateBounds));
    } else if (nextTab === "calendar") {
      calendarDateAutoRef.current = false;
      setCalendarDR(fullDateRange(calendarDateBounds));
    } else if (nextTab === "inventory") {
      inventoryDateAutoRef.current = true;
      setInventoryDR(salesRange);
    } else if (nextTab === "analytics") {
      analyticsDateAutoRef.current = true;
      setAnalyticsDR(salesRange);
    } else {
      campaignDateAutoRef.current = true;
      setCampaignDR(campaignAutomaticRange);
    }
    if (nextTab === "rankings") {
      analysisPaintRef.current = { startedAt:performance.now() };
      try { performance.mark("byou-analysis-open-start"); } catch {}
    }
    setTab(nextTab);
  }, [tab, salesDateBounds, videoDateBounds, calendarDateBounds, campaignAutomaticRange]);
  useEffect(() => {
    if (tab === "rankings" || reportRuntimeKeyRef.current === runtimeRequestKey) return;
    reportRuntimeKeyRef.current = runtimeRequestKey;
    const existing = reportPaintRef.current;
    reportPaintRef.current = existing?.tab === tab
      ? { ...existing, requestKey:runtimeRequestKey }
      : { startedAt:performance.now(), tab, requestKey:runtimeRequestKey };
    setViewReadyMs(null);
    setViewReadyKey("");
  }, [tab, runtimeRequestKey]);
  useEffect(() => {
    const paint = reportPaintRef.current;
    if (!paint || paint.tab !== tab || tab === "rankings" || runtimeState !== "ready") return undefined;
    if (paint.requestKey && paint.requestKey !== runtimeRequestKey) return undefined;
    if (tab === "map" && !mapFeaturesInitialized) return undefined;
    if (["map", "videos"].includes(tab) && lazyTabReadyKey !== `${tab}|${runtimeRequestKey}`) return undefined;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (reportPaintRef.current !== paint || paint.tab !== tab) return;
        const readyMs = Math.round(performance.now() - paint.startedAt);
        setViewReadyMs(readyMs);
        setViewReadyKey(runtimeRequestKey);
        window.dispatchEvent(new CustomEvent("byou:view-ready", { detail:{ tab, requestKey:runtimeRequestKey, readyMs } }));
        if (reloadBenchmarkEnabled && reloadInteraction.navigationType === "reload" && !reloadInteractionStartedRef.current) {
          reloadInteractionStartedRef.current = true;
          void waitForReloadInteractionReady({
            state:reloadInteractionRef.current,
            maxWaitMs:RELOAD_BENCHMARK_INPUT_WINDOW_MS,
            detail:{ tab, requestKey:runtimeRequestKey },
          }).then(snapshot => {
            setReloadInteraction(snapshot);
            if (snapshot.status === "ready") {
              window.dispatchEvent(new CustomEvent("byou:interaction-ready", { detail:snapshot }));
            }
            const main = document.querySelector(".bi-main");
            const releaseAssets = Array.from(document.scripts || [])
              .filter(script => script.type === "module" && script.src)
              .map(script => String(script.src || "").split("/").pop() || "");
            const releaseAsset = releaseAssets.find(name => /^index-[A-Za-z0-9_-]+\.js$/.test(name)) || releaseAssets[0] || "";
            const numberFromDataset = key => {
              const value = main?.dataset?.[key];
              return value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
            };
            const booleanFromDataset = key => {
              const value = main?.dataset?.[key];
              return value === "true" ? true : value === "false" ? false : null;
            };
            const measuredSnapshot = {
              ...snapshot,
              serverQueryMs:numberFromDataset("serverQueryMs"),
              runtime:{
                viewReadyMs:numberFromDataset("viewReadyMs"),
                downloadMs:numberFromDataset("downloadMs"),
                parseMs:numberFromDataset("parseMs"),
                serverQueryMs:numberFromDataset("serverQueryMs"),
                serverDbMs:numberFromDataset("serverDbMs"),
                serverRuntimeMs:numberFromDataset("serverRuntimeMs"),
                serverModelMs:numberFromDataset("serverModelMs"),
                responseBytes:numberFromDataset("responseBytes"),
                transferBytes:numberFromDataset("transferBytes"),
                contentEncoding:String(main?.dataset?.contentEncoding || ""),
                serverCached:booleanFromDataset("serverCached"),
                browserCached:booleanFromDataset("browserCached"),
              },
            };
            const result = appendReloadBenchmarkSample(window.sessionStorage, measuredSnapshot, {
              runId:String(performance.timeOrigin || ""),
              recordedAt:new Date().toISOString(),
              visibility:document.visibilityState,
              tab:String(main?.dataset?.activeView || ""),
              requestKey:String(main?.dataset?.viewRequestKey || ""),
              readyKey:String(main?.dataset?.viewReadyKey || ""),
              publication:publishedAtRef.current,
              build:releaseAsset,
            });
            setReloadBenchmarkSession(result.session);
            setReloadBenchmarkResult(result);
            if (result.accepted && !result.duplicate && !result.summary.complete) {
              window.setTimeout(() => window.location.reload(), 900);
            }
          });
        }
        reportPaintRef.current = null;
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [tab, runtimeState, runtimeRequestKey, mapFeaturesInitialized, lazyTabReadyKey, reloadBenchmarkEnabled, reloadInteraction.navigationType]);

  const startReloadBenchmark = useCallback((fresh = false) => {
    if (!reloadBenchmarkEnabled) return;
    if (fresh) resetReloadBenchmarkSession(window.sessionStorage);
    window.location.reload();
  }, [reloadBenchmarkEnabled]);

  const downloadReloadBenchmark = useCallback(() => {
    if (!reloadBenchmarkEnabled) return;
    const session = readReloadBenchmarkSession(window.sessionStorage);
    const report = { ...session, summary:summarizeReloadBenchmark(session) };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type:"application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `byou-trusted-reload-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
  }, [reloadBenchmarkEnabled]);

  const resetAndReloadBenchmark = useCallback(() => {
    if (!reloadBenchmarkEnabled) return;
    resetReloadBenchmarkSession(window.sessionStorage);
    window.location.reload();
  }, [reloadBenchmarkEnabled]);
  const markAnalysisReady = useCallback((ready = {}) => {
    if (!analysisPaintRef.current) return;
    if (tab !== "rankings" || runtimeState !== "ready" || !activeAnalysisModel) return;
    if (ready.section && ready.section !== analysisSection) return;
    if (!ready.requestKey || ready.requestKey !== runtimeRequestKey) return;
    if (analysisPaintRef.current.requestKey !== runtimeRequestKey) return;
    const readyMs = Math.round(performance.now() - analysisPaintRef.current.startedAt);
    const detail = {
      section:analysisPaintRef.current.section || analysisSection,
      requestKey:analysisPaintRef.current.requestKey || runtimeRequestKey,
      readyMs,
    };
    setDatasetTimings(previous => ({ ...previous, analysisReadyMs:readyMs }));
    setViewReadyMs(readyMs);
    setViewReadyKey(runtimeRequestKey);
    try {
      performance.mark("byou-analysis-ready");
      performance.measure("byou-analysis-ready-time", "byou-analysis-open-start", "byou-analysis-ready");
    } catch {}
    window.dispatchEvent(new CustomEvent("byou:analysis-ready", { detail }));
    analysisPaintRef.current = null;
  }, [tab, runtimeState, activeAnalysisModel, analysisSection, runtimeRequestKey]);
  const selectAnalysisSection = useCallback(nextSection => {
    if (nextSection === analysisSection) return;
    analysisPaintRef.current = { startedAt:performance.now(), section:nextSection, requestKey:"" };
    setAnalysisViewModel(null);
    setAnalysisSection(nextSection);
  }, [analysisSection]);
  const topProductValue = productOptionIdForValue(currentProductId, productOptions, productMeta);
  const updateTopProduct = useCallback(pid => {
    setProductForCurrentTab(pid);
  }, [setProductForCurrentTab]);
  const updateMapProductAt = useCallback((index, pid) => {
    campaignDateAutoRef.current = false;
    setActiveCampaignId("");
    setCampaignCid("");
    setMapSelections(previous => {
      const next = [
        previous[0] || { pid:"", cid:"" },
        previous[1] || { pid:"", cid:"" },
      ];
      if (index === 0 && !pid) return [{ pid:"", cid:"" }, { pid:"", cid:"" }];
      if (index === 1 && !pid) return [next[0], { pid:"", cid:"" }];
      next[index] = { pid, cid:"" };
      if (!next[0].pid) return [{ pid, cid:"" }, { pid:"", cid:"" }];
      return next;
    });
  }, []);
  const updateMapCampaignAt = useCallback((index, cid) => {
    campaignDateAutoRef.current = false;
    setActiveCampaignId("");
    setCampaignCid("");
    setMapSelections(previous => previous.map((selection, selectionIndex) => (
      selectionIndex === index ? { ...selection, cid:selection.pid ? cid : "" } : selection
    )));
  }, []);
  const updateCurrentDateRange = useCallback(patch => {
    const next = { ...currentDateRange, ...patch };
    if (!next.start || !next.end || next.start > next.end) return;
    if (next.start === currentDateRange.start && next.end === currentDateRange.end) return;
    if (tab === "videos") setVideoDateRangeFromUser(next);
    else if (tab === "calendar") setCalendarDateRangeFromUser(next);
    else if (tab === "inventory") {
      inventoryDateAutoRef.current = false;
      setInventoryDR(next);
    }
    else if (tab === "analytics") {
      analyticsDateAutoRef.current = false;
      setAnalyticsDR(next);
    }
    else if (tab === "rankings" && analysisSection === "warehouses") {
      setAnalysisOptions(previous => ({
        ...previous,
        warehouseFrom:next.start,
        warehouseTo:next.end,
      }));
    }
    else {
      campaignDateAutoRef.current = false;
      setCampaignDR(next);
    }
  }, [tab, analysisSection, currentDateRange, setVideoDateRangeFromUser, setCalendarDateRangeFromUser]);
  const currentDatePresets = useMemo(() => ([
    { key:"lastWeek", label:t("filter.lastWeek", "Last Week"), range:rollingDatePreset("lastWeek", currentDateRange.end || currentDateBounds.end, currentDateBounds.start) },
    { key:"lastMonth", label:t("filter.lastMonth", "Last Month"), range:rollingDatePreset("lastMonth", currentDateRange.end || currentDateBounds.end, currentDateBounds.start) },
  ]), [currentDateRange.end, currentDateBounds.start, currentDateBounds.end, t]);
  const applyCurrentDatePreset = useCallback(preset => {
    updateCurrentDateRange(preset.range);
  }, [updateCurrentDateRange]);
  const topRegionValue = tab === "map" ? mapRegion : tab === "analytics" ? salesRegion : tab === "inventory" ? inventoryRegion : "";
  const topStateValue = tab === "map" ? mapState : tab === "analytics" ? salesState : tab === "inventory" ? inventoryState : "";
  const topRegionOptions = tab === "map" ? mapRegions : tab === "analytics" && campaignChannel !== "online" ? salesRegions : tab === "inventory" && inventoryType !== "online" ? inventoryRegions : [];
  const topStateOptions = tab === "map" ? mapStates : tab === "analytics" && campaignChannel !== "online" ? salesStates : tab === "inventory" && inventoryType !== "online" ? inventoryStates : [];
  const showSidebarStoreList = (
    tab === "rankings" && analysisSection === "affinity"
  ) || (
    tab !== "campaign" && tab !== "rankings" && tab !== "videos" && !(["analytics", "inventory", "calendar"].includes(tab) && campaignChannel === "online")
  );
  const setTopRegion = value => {
    if (tab === "map") setMapRegion(value);
    else if (tab === "analytics") setSalesRegion(value);
    else if (tab === "inventory") setInventoryRegion(value);
  };
  const setTopState = value => {
    if (tab === "map") setMapState(value);
    else if (tab === "analytics") setSalesState(value);
    else if (tab === "inventory") setInventoryState(value);
  };
  const sidebarFilterFieldStyle = { display:"flex", flexDirection:"column", gap:5, minWidth:0 };
  const sidebarFilterLabelStyle = { fontSize:9, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:0.7, lineHeight:1.15 };
  const sidebarFilterInputStyle = { ...SELECT, width:"100%", height:34, padding:"7px 8px", borderRadius:4, fontSize:11, minWidth:0 };
  const sidebarHeight = `calc(100vh - ${sidebarViewportOffset}px)`;

  return (
    <LanguageContext.Provider value={languageContext}>
    <div onWheelCapture={handleDashboardWheel} style={{ ...SANS, background:C.bg, color:C.text, minHeight:"100vh", display:"flex", flexDirection:"column", fontSize:13, overscrollBehavior:"auto" }}>

      {/* NAV */}
      <button className="bi-filters-toggle" onClick={() => setSidebarOpen(o => !o)} aria-expanded={sidebarOpen} style={{position:"fixed",bottom:12,left:12,zIndex:30,padding:"8px 12px"}}>{t("nav.filters", "Sections")}</button>

      {/* SETTINGS DRAWER */}
      {showSettings && <div onClick={() => setShowSettings(false)} style={{ position:"fixed", inset:0, background:"rgba(4,26,44,0.4)", zIndex:1240 }}/>}
      {showSettings && (
        <div role="dialog" aria-label={t("data.title", "Data Sources")} style={{ position:"fixed", top:0, right:0, height:"100vh", width:"min(640px, 100vw)", overflowY:"auto", background:"#FFFFFF", borderLeft:`1px solid ${C.border}`, padding:"16px 22px 30px", boxShadow:"-18px 0 50px rgba(15,23,42,0.18)", zIndex:1245 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:12, marginBottom:12 }}>
            <div>
              <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:3 }}>{t("data.title", "Data Sources")}</div>
              <div style={{ fontSize:12, color:C.text, fontWeight:500 }}>{t("data.subtitle", "Upload, refresh, or publish the team dataset")}</div>
            </div>
            <button onClick={() => setShowSettings(false)} aria-label={t("data.close", "Close data sources")} style={{ width:32, height:32, borderRadius:8, border:`1px solid ${C.border}`, background:C.card, color:C.muted, cursor:"pointer", fontSize:16, lineHeight:"30px" }}>x</button>
          </div>
          <div style={{ display:"flex", alignItems:"flex-start", gap:20, flexWrap:"wrap" }}>
            <div style={{ flex:"2 1 300px", minWidth:0 }}>
              <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>{t("data.liveUrl", "Live Data URL — Google Sheets CSV")}</div>
              <div style={{ display:"flex", gap:8, marginBottom:8 }}>
                <input value={liveUrl} onChange={e=>setLiveUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/YOUR_ID/pub?output=csv" style={{ flex:1, ...INP }}/>
                <SmBtn onClick={fetchLive} disabled={!liveUrl} active={!!liveUrl}>{t("data.refresh", "Refresh")}</SmBtn>
              </div>
              {lastRefresh && <div style={{ fontSize:10, color:C.muted, marginBottom:6 }}>{t("data.lastRefreshed", "Last refreshed")}: {lastRefresh.toLocaleTimeString()} · {t("data.autoRefresh", "Auto-refreshes every 30 min")}</div>}
              <div style={{ fontSize:10, color:C.muted, lineHeight:1.7, background:C.bg, borderRadius:9, padding:"9px 11px", border:`1px solid ${C.border}` }}>
                <span style={{ color:C.accent, fontWeight:500 }}>{t("data.setupLabel", "Setup")}:</span> {t("data.setupText", "Upload the BYOU workbook directly, or publish a raw tab as CSV. Products_Master defines products, Campaigns_Master defines Costco campaigns under products, Sales_Raw feeds store sales, Costco_Daily_Totals feeds official inline totals, PPC/Meta exports feed paid-media context, Paid_Videos_Raw / Seeding_Videos_Raw feed Videos.")}
              </div>
            </div>
            <div style={{ flex:"1 1 260px", minWidth:0 }}>
              <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>{t("data.imports", "Imports & Templates")}</div>
              <input ref={fileRef} type="file" accept=".csv,.xlsx,.xlsm" onChange={handleFile} style={{ display:"none" }}/>
              <input ref={dailyFileRef} type="file" accept=".xlsx" onChange={handleDailyUpdateFile} style={{ display:"none" }}/>
              <input ref={criteoFileRef} type="file" accept=".csv,.xlsx,.xlsm" onChange={handleCriteoFile} style={{ display:"none" }}/>
              <input ref={videoFileRef} type="file" accept=".csv" onChange={handleVideoFile} style={{ display:"none" }}/>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(2,minmax(0,1fr))", gap:8 }}>
                <SmBtn onClick={() => fileRef.current?.click()} disabled={importBusy} style={{ padding:"7px 10px", border:`1px solid ${C.accent}55`, background:C.accentFade, color:C.accent, fontWeight:500 }}>{t("data.uploadWorkbook", "Upload Workbook / CSV")}</SmBtn>
                <SmBtn onClick={openDailyUpdatePicker} disabled={importBusy} style={{ padding:"7px 10px", border:`1px solid ${C.green}55`, background:"rgba(45,212,160,0.1)", color:C.green, fontWeight:500 }}>{t("data.applyDailyUpdate", "Apply Daily Update")}</SmBtn>
                <SmBtn onClick={dlTemplate} style={{ padding:"7px 10px" }}>{t("data.workbookTemplate", "Workbook Template")}</SmBtn>
                <SmBtn onClick={() => criteoFileRef.current?.click()} style={{ padding:"7px 10px", border:`1px solid ${C.blue}55`, background:"rgba(106,171,247,0.1)", color:C.blue, fontWeight:500 }}>{t("data.uploadCriteo", "Upload Paid Media")}</SmBtn>
                <SmBtn onClick={() => videoFileRef.current?.click()} style={{ padding:"7px 10px", border:`1px solid ${C.blue}55`, background:"rgba(106,171,247,0.1)", color:C.blue, fontWeight:500 }}>{t("data.uploadVideos", "Upload Videos")}</SmBtn>
                <SmBtn onClick={dlVideoTemplate} style={{ padding:"7px 10px" }}>{t("data.videoTemplate", "Video Template")}</SmBtn>
              </div>
              <div style={{ marginTop:10, border:`1px solid ${C.border}`, borderRadius:8, overflow:"hidden", background:C.bg }}>
                {["workbook","dailyUpdate","paidMedia","videos","publish"].map((modeKey, idx) => {
                  const info = IMPORT_MODE_COPY[modeKey];
                  return (
                    <div key={modeKey} style={{ padding:"8px 9px", borderTop:idx ? `1px solid ${C.border}` : "none" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", gap:8, alignItems:"center" }}>
                        <span style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:0.8 }}>{info.title}</span>
                        <span style={{ fontSize:10, color:modeKey === "workbook" || modeKey === "publish" ? C.accent : modeKey === "dailyUpdate" ? C.green : C.blue, fontWeight:500, whiteSpace:"nowrap" }}>{info.mode}</span>
                      </div>
                      <div style={{ fontSize:10, color:C.muted, lineHeight:1.45, marginTop:4 }}>{info.detail}</div>
                    </div>
                  );
                })}
              </div>
              {importStatus.message && (
                <div style={{ marginTop:8, fontSize:10, color:importStatus.state === "error" ? C.red : importStatus.state === "loaded" ? C.green : C.muted, lineHeight:1.5, background:C.bg, border:`1px solid ${C.border}`, borderRadius:7, padding:"7px 9px" }}>
                  {importStatus.message}
                </div>
              )}
              <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, margin:"14px 0 6px" }}>{t("data.sharedDataset", "Shared Team Dataset")}</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(2,minmax(0,1fr))", gap:8 }}>
                <SmBtn onClick={() => loadSharedDataset({ manual:true })} style={{ padding:"7px 10px" }}>{t("data.loadShared", "Load Shared")}</SmBtn>
                <SmBtn onClick={openPublishModal} disabled={detailDatasetStatus.state === "loading"} style={{ padding:"7px 10px", border:`1px solid ${C.green}55`, background:"rgba(45,212,160,0.1)", color:C.green, fontWeight:500 }}>{t("data.publishCurrent", "Publish Current")}</SmBtn>
              </div>
              {sharedDatasetStatus.message && (
                <div style={{ marginTop:8, fontSize:10, color:sharedDatasetStatus.state === "error" ? C.red : C.muted, lineHeight:1.5, background:C.bg, border:`1px solid ${C.border}`, borderRadius:7, padding:"7px 9px" }}>
                  {sharedDatasetStatus.message}
                </div>
              )}
            </div>
            <div style={{ flex:"0 0 160px" }}>
              <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>{t("data.stats", "Data Stats")}</div>
              {[[t("data.loadedStores","Loaded stores"),whs.length],[t("data.activeStores","Active stores"),activeWhs.length],[t("data.products","Products"),productOptions.length],[t("data.campaigns","Campaigns"),campaignFilterCatalog(campaignMeta, productMeta).length],[t("data.salesRows","Sales rows"),sales.length.toLocaleString()],[t("data.inlineTotalRows","Inline total rows"),inlineTotalSales.length.toLocaleString()],[t("data.onlineRows","Online rows"),onlineSales.length.toLocaleString()],[t("data.ppcRows","Paid media rows"),ppcRows.length.toLocaleString()],[t("data.sourceRows","Source rows"),workbookSales.meta.rows.toLocaleString()],[t("data.productRows","Product rows"),prodSales.length.toLocaleString()],[t("common.videos","Videos"),videos.length],[t("data.videoRows","Video rows"),videoMetrics.length.toLocaleString()],[t("data.footnotes","Footnotes"),footnotes.length]].map(([k,v]) => (
                <div key={k} style={{ fontSize:11, color:C.muted, lineHeight:2.2 }}>{k}: <span style={{ color:C.text, ...MONO }}>{v}</span></div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* BODY */}
      <div style={{ display:"flex", flex:"1 0 auto", alignItems:"stretch" }}>

        {/* SIDEBAR — tab-aware, hidden on Rankings */}
        {sidebarOpen && <div className="bi-sidebar-backdrop" onClick={() => setSidebarOpen(false)}/>}
        {(
          <div className={`bi-sidebar${sidebarOpen ? " bi-open" : ""}`} style={{ width:sidebarWidth, borderRight:`1px solid ${C.border}`, background:C.sidebar, display:"flex", flexDirection:"column", flexShrink:0, boxShadow:"inset -1px 0 0 rgba(255,255,255,0.55)", position:"sticky", top:0, alignSelf:"flex-start", height:sidebarHeight, maxHeight:sidebarHeight, overflowY:"auto", zIndex:12 }}>

            <div style={{ padding:"12px 12px 12px", borderBottom:`1px solid ${C.border}`, background:C.sidebar, flexShrink:0, display:"flex", flexDirection:"column" }}>
              <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:0.8, marginBottom:9, flexShrink:0 }}>{t("common.reports", "Reports")}</div>
              <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                {reportNavItems.map(([key, label]) => {
                  const active = tab === key;
                  return (
                    <button key={key} className="bi-navbtn" data-report-tab={key} aria-current={active ? "page" : undefined} onClick={() => switchReport(key)} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, width:"100%", minHeight:0, border:`1px solid ${active ? C.accent : "transparent"}`, background:active ? C.card : "transparent", color:active ? C.text : C.muted, borderRadius:5, padding:"7px 8px", cursor:"pointer", fontSize:12, ...REPORT_NAV_FONT, fontWeight:400, textAlign:"left" }}>
                      <span>{label}</span>
                      {active && <span style={{ width:6, height:6, borderRadius:6, background:C.accent, flexShrink:0 }}/>}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ padding:"14px 12px 16px", borderBottom:`1px solid ${C.border}`, background:C.sidebar, flexShrink:0, minHeight:0, display:"flex", flexDirection:"column" }}>
              <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:0.8, marginBottom:11, flexShrink:0 }}>{t("common.filters", "Filters")}</div>
              <div style={{ display:"flex", flexDirection:"column", gap:13, paddingRight:2 }}>
                {tab === "pnl" ? (
                  <div style={{ fontSize:11, color:C.muted, lineHeight:1.55 }}>
                    {uiLang === "ko" ? "손익 탭 안의 기준일과 캠페인 표를 사용하세요. 재무 데이터는 Costco 고객 매출 필터와 분리됩니다." : "Use the as-of date and campaign table inside P&L. Financial records stay separate from Costco shopper-sales filters."}
                  </div>
                ) : tab === "map" ? (
                  <>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>{t("filter.baselineProduct", "Baseline Product")}</span>
                      <select value={mapSelections[0]?.pid || ""} onChange={e => updateMapProductAt(0, e.target.value)} style={sidebarFilterInputStyle}>
                        <option value="">{t("filter.allProducts", "All Products")}</option>
                        {productOptions.map(p => <option key={p.id} value={p.id}>{p.short}</option>)}
                      </select>
                    </label>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>{t("filter.baselineCampaign", "Baseline Campaign")}</span>
                      <select value={mapSelections[0]?.cid || ""} onChange={e => updateMapCampaignAt(0, e.target.value)} disabled={!mapSelections[0]?.pid} style={{ ...sidebarFilterInputStyle, opacity:mapSelections[0]?.pid ? 1 : 0.5 }}>
                        <option value="">{t("filter.allCampaigns", "All Campaigns")}</option>
                        {(visibleMapCampaignOptions[0] || []).map(campaign => <option key={campaign.id} value={campaign.id}>{[campaign.short || campaign.name, campaignDateWindowLabel(campaign)].filter(Boolean).join(" / ")}</option>)}
                      </select>
                    </label>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>{t("filter.comparisonProduct", "Comparison Product")}</span>
                      <select value={mapSelections[1]?.pid || ""} onChange={e => updateMapProductAt(1, e.target.value)} disabled={!mapSelections[0]?.pid} style={{ ...sidebarFilterInputStyle, opacity:mapSelections[0]?.pid ? 1 : 0.5 }}>
                        <option value="">{t("filter.noComparison", "No comparison")}</option>
                        {productOptions.map(p => <option key={p.id} value={p.id}>{p.short}</option>)}
                      </select>
                    </label>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>{t("filter.comparisonCampaign", "Comparison Campaign")}</span>
                      <select value={mapSelections[1]?.cid || ""} onChange={e => updateMapCampaignAt(1, e.target.value)} disabled={!mapSelections[1]?.pid} style={{ ...sidebarFilterInputStyle, opacity:mapSelections[1]?.pid ? 1 : 0.5 }}>
                        <option value="">{t("filter.allCampaigns", "All Campaigns")}</option>
                        {(visibleMapCampaignOptions[1] || []).map(campaign => <option key={campaign.id} value={campaign.id}>{[campaign.short || campaign.name, campaignDateWindowLabel(campaign)].filter(Boolean).join(" / ")}</option>)}
                      </select>
                    </label>
                  </>
                ) : tab === "rankings" && analysisSection === "warehouses" ? (
                  <div style={{ fontSize:11, color:C.muted, lineHeight:1.55 }}>
                    {uiLang === "ko"
                      ? "제품, 캠페인, 기간, 지역 및 웨어하우스 검색 필터는 리더보드 상단에서 설정하세요. 전국 백분위는 지역 필터를 적용해도 유지됩니다."
                      : "Use the controls above the leaderboard for product, campaign, dates, geography, and warehouse search. National percentiles remain unchanged when geography narrows the list."}
                  </div>
                ) : tab === "rankings" && analysisSection === "pacing" ? (
                  <>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>Baseline Product</span>
                      <select value={topProductValue} onChange={e => updateTopProduct(e.target.value)} style={sidebarFilterInputStyle}>
                        <option value="">{t("filter.allProducts", "All Products")}</option>
                        {productOptions.map(p => <option key={p.id} value={p.id}>{p.short}</option>)}
                      </select>
                    </label>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>Baseline Campaign</span>
                      <select value={activeCampaignId} onChange={e => handleCampaignFilterChange(e.target.value)} style={sidebarFilterInputStyle}>
                        <option value="">{t("filter.allCampaigns", "All Campaigns")}</option>
                        {pacingBaselineCampaignOptions.map(c => <option key={c.id} value={c.id}>{[productLabelForValue(c.pid, productMeta), c.short, campaignDateWindowLabel(c)].filter(Boolean).join(" / ")}</option>)}
                      </select>
                    </label>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>Comparison Product</span>
                      <select value={pacingCompPid} onChange={e => { setPacingCompPid(e.target.value); setPacingCompCid(""); }} style={sidebarFilterInputStyle}>
                        <option value="">None</option>
                        {productOptions.map(p => <option key={p.id} value={p.id}>{p.short}</option>)}
                      </select>
                    </label>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>Comparison Campaign</span>
                      <select value={pacingCompCid} onChange={e => setPacingCompCid(e.target.value)} disabled={!pacingCompCampaignOptions.length} style={{ ...sidebarFilterInputStyle, opacity:pacingCompCampaignOptions.length ? 1 : 0.5 }}>
                        <option value="">None</option>
                        {pacingCompCampaignOptions.map(c => <option key={c.id} value={c.id}>{c.short || c.name}{c.start ? ` / ${c.start}` : ""}</option>)}
                      </select>
                    </label>
                  </>
                ) : tab === "rankings" && analysisSection === "comparison" ? (
                  <>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>Baseline Product</span>
                      <select value={effectiveCompareA} onChange={e => { setCompareA(e.target.value); setCompareCampaignA(""); }} style={sidebarFilterInputStyle}>
                        {comparisonProductOptions.map(p => <option key={p.id} value={p.id}>{p.short}</option>)}
                      </select>
                    </label>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>Baseline Campaign</span>
                      <select value={compareCampaignA} onChange={e => setCompareCampaignA(e.target.value)} disabled={!comparisonCampaignOptions.a.length} style={{ ...sidebarFilterInputStyle, opacity:comparisonCampaignOptions.a.length ? 1 : 0.5 }}>
                        <option value="">All</option>
                        {comparisonCampaignOptions.a.map(c => <option key={c.id} value={c.id}>{c.short || c.name}{c.start ? ` / ${c.start}` : ""}</option>)}
                      </select>
                    </label>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>Compare Against</span>
                      <select value={effectiveCompareB} onChange={e => { setCompareB(e.target.value); setCompareCampaignB(""); }} style={sidebarFilterInputStyle}>
                        {comparisonProductOptions.map(p => <option key={p.id} value={p.id}>{p.short}</option>)}
                      </select>
                    </label>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>Comparison Campaign</span>
                      <select value={compareCampaignB} onChange={e => setCompareCampaignB(e.target.value)} disabled={!comparisonCampaignOptions.b.length} style={{ ...sidebarFilterInputStyle, opacity:comparisonCampaignOptions.b.length ? 1 : 0.5 }}>
                        <option value="">All</option>
                        {comparisonCampaignOptions.b.map(c => <option key={c.id} value={c.id}>{c.short || c.name}{c.start ? ` / ${c.start}` : ""}</option>)}
                      </select>
                    </label>
                  </>
                ) : (
                  <>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>{t("filter.product", "Product")}</span>
                      <select value={topProductValue} onChange={e => updateTopProduct(e.target.value)} style={sidebarFilterInputStyle}>
                        <option value="">{t("filter.allProducts", "All Products")}</option>
                        {productOptions.map(p => <option key={p.id} value={p.id}>{p.short}</option>)}
                      </select>
                    </label>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>{t("filter.campaign", "Campaign")}</span>
                      {tab === "rankings" ? <select value={activeCampaignId} onChange={e => handleCampaignFilterChange(e.target.value)} style={sidebarFilterInputStyle}>
                        <option value="">{t("filter.allCampaigns", "All Campaigns")}</option>
                        {visibleSidebarCampaignOptions.map(c => <option key={c.id} value={c.id}>{[productLabelForValue(c.pid, productMeta), c.short, campaignDateWindowLabel(c)].filter(Boolean).join(" / ")}</option>)}
                      </select> : tab === "inventory" ? <InventoryCampaignSelect channel={campaignChannel} campaignId={activeCampaignId} campaigns={inventoryCampaignOptions} productMeta={productMeta} onChangeChannel={handleChannelFilterChange} onChangeCampaign={handleInventoryCampaignFilterChange} style={sidebarFilterInputStyle}/> : <CampaignChannelSelect value={campaignChannel} onChange={handleChannelFilterChange} style={sidebarFilterInputStyle}/>}
                    </label>
                  </>
                )}
                {tab !== "pnl" && !(tab === "rankings" && analysisSection === "warehouses") && <>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(2,minmax(0,1fr))", gap:6 }}>
                  {currentDatePresets.map(preset => {
                    const active = currentDateRange.start === preset.range.start && currentDateRange.end === preset.range.end;
                    return (
                      <button key={preset.key} type="button" onClick={() => applyCurrentDatePreset(preset)} title={`${preset.range.start} to ${preset.range.end}`} style={{ height:30, padding:"5px 8px", borderRadius:5, border:`1px solid ${active ? C.accent+"66" : C.border}`, background:active ? C.accentFade : C.card, color:active ? C.accent : C.muted, cursor:"pointer", fontSize:10, ...SANS, fontWeight:active ? 600 : 400 }}>
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(2,minmax(0,1fr))", gap:8 }}>
                  <label style={sidebarFilterFieldStyle}>
                    <span style={sidebarFilterLabelStyle}>{t("filter.startDate", "Start Date")}</span>
                    <input type="date" value={currentDateRange.start || ""} onInput={e => updateCurrentDateRange({ start:e.currentTarget.value })} onChange={e => updateCurrentDateRange({ start:e.target.value })} style={sidebarFilterInputStyle}/>
                  </label>
                  <label style={sidebarFilterFieldStyle}>
                    <span style={sidebarFilterLabelStyle}>{t("filter.endDate", "End Date")}</span>
                    <input type="date" value={currentDateRange.end || ""} onInput={e => updateCurrentDateRange({ end:e.currentTarget.value })} onChange={e => updateCurrentDateRange({ end:e.target.value })} style={sidebarFilterInputStyle}/>
                  </label>
                </div>
                {tab === "videos" && (
                  <>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>{t("filter.type", "Type")}</span>
                      <select value={videoType} onChange={e => setVideoType(e.target.value)} style={sidebarFilterInputStyle}>
                        <option value="">{t("filter.allVideos", "All Videos")}</option>
                        {VIDEO_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
                      </select>
                    </label>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>{t("filter.platform", "Platform")}</span>
                      <select value={videoPlatform} onChange={e => setVideoPlatform(e.target.value)} style={sidebarFilterInputStyle}>
                        <option value="">{t("filter.allPlatforms", "All Platforms")}</option>
                        {PLATFORMS.map(platform => <option key={platform} value={platform}>{platform}</option>)}
                      </select>
                    </label>
                    <label style={sidebarFilterFieldStyle}>
                      <span style={sidebarFilterLabelStyle}>{t("filter.metrics", "Metrics")}</span>
                      <select value={selVideoMetric} onChange={e => setSelVideoMetric(e.target.value)} style={sidebarFilterInputStyle}>
                        {VIDEO_METRICS.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
                      </select>
                    </label>
                  </>
                )}
                {!!topRegionOptions.length && (
                  <label style={sidebarFilterFieldStyle}>
                    <span style={sidebarFilterLabelStyle}>{t("filters.region", "Region")}</span>
                    <select value={topRegionValue} onChange={e => setTopRegion(e.target.value)} style={sidebarFilterInputStyle}>
                      <option value="">{t("filter.allRegions", "All Regions")}</option>
                      {topRegionOptions.map(region => <option key={region} value={region}>{region}</option>)}
                    </select>
                  </label>
                )}
                {!!topStateOptions.length && (
                  <label style={sidebarFilterFieldStyle}>
                    <span style={sidebarFilterLabelStyle}>{t("filters.state", "State")}</span>
                    <select value={topStateValue} onChange={e => setTopState(e.target.value)} style={sidebarFilterInputStyle}>
                      <option value="">{t("filter.allStates", "All States")}</option>
                      {topStateOptions.map(state => <option key={state} value={state}>{state}</option>)}
                    </select>
                  </label>
                )}
                {showSidebarStoreList && (
                  <div style={{ borderTop:`1px solid ${C.border}`, paddingTop:10, marginTop:2 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8, marginBottom:6 }}>
                      <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1 }}>{uiLabel("Stores")}</div>
                      {runtimeState === "ready" && <div style={{ fontSize:10, color:C.muted }}>{uiLang === "ko" ? `${searchedSidebarRows.length} ${t("common.matches", "matches")}` : `${searchedSidebarRows.length} match${searchedSidebarRows.length===1?"":"es"}`}</div>}
                    </div>
                    <input type="search" value={storeSearch} onChange={e=>setStoreSearch(e.target.value)} placeholder={t("common.searchStores", "Search stores")} style={{ ...SELECT, marginBottom:6, textTransform:"none", letterSpacing:0 }}/>
                    {runtimeState !== "ready" && <div role="status" style={{padding:"4px 0",color:C.muted,fontSize:11}}>{uiLang === "ko" ? "검색 결과를 업데이트하는 중..." : "Updating store results…"}</div>}
                    {runtimeState === "ready" && searchedSidebarRows.length === 0 && (
                      <div style={{ padding:"8px 0 0", fontSize:11, color:C.muted, lineHeight:1.5 }}>{t("common.noStoreMatches", "No stores match this search or product filter.")}</div>
                    )}
                    {runtimeState === "ready" && searchedSidebarRows.length > 0 && (
                      <div style={{ display:"flex", flexDirection:"column", gap:4, maxHeight:300, overflowY:"auto", paddingRight:2 }}>
                        {searchedSidebarRows.slice(0, 80).map((w, i) => {
                          const active = selId === w.id;
                          const maxVal = Number(searchedSidebarRows[0]?.total || 0) || 1;
                          return (
                            <button key={w.id} onClick={() => setSelId(active ? null : w.id)} title={`${w.name}${warehouseLocationLabel(w) ? ` - ${warehouseLocationLabel(w)}` : ""}`} style={{ display:"block", width:"100%", textAlign:"left", border:`1px solid ${active ? C.accent+"66" : C.border}`, background:active ? C.accentFade : C.card, borderRadius:7, padding:"6px 8px", cursor:"pointer", ...SANS }}>
                              <span style={{ display:"flex", justifyContent:"space-between", gap:6, fontSize:10, color:C.text }}>
                                <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", fontWeight:active ? 500 : 400 }}>{i + 1}. {w.name}</span>
                                <span style={{ ...MONO, color:active ? C.accent : C.muted, flexShrink:0 }}>{tab === "inventory" ? fmtUnits(w.total) : fmtCompactMoney(w.total)}</span>
                              </span>
                              <span style={{ display:"block", height:3, background:C.subtle, borderRadius:2, marginTop:4, overflow:"hidden" }}>
                                <span style={{ display:"block", height:"100%", width:`${Math.max(3, (Number(w.total || 0) / maxVal) * 100)}%`, background:active ? C.accent : "#C3CFDB" }}/>
                              </span>
                            </button>
                          );
                        })}
                        {searchedSidebarRows.length > 80 && <div style={{ fontSize:10, color:C.muted, padding:"4px 2px" }}>+{searchedSidebarRows.length - 80} more - refine the search</div>}
                      </div>
                    )}
                    {selId && <button onClick={() => setSelId(null)} style={{ marginTop:6, width:"100%", padding:"5px 8px", borderRadius:5, border:`1px solid ${C.accent}44`, background:C.accentFade, color:C.accent, cursor:"pointer", fontSize:10, ...SANS }}>{t("common.clearStore", "Clear store selection")}</button>}
                  </div>
                )}
                {hasClearableFilters && (
                  <button onClick={clearAllActiveFilters} style={{ marginTop:2, width:"100%", border:`1px solid ${C.border}`, background:C.bg, color:C.muted, borderRadius:5, padding:"6px 8px", cursor:"pointer", fontSize:10, ...SANS }}>
                    {t("filters.clearAll", "Clear filters")}
                  </button>
                )}
                </>}
              </div>
            </div>

            <div style={{ marginTop:"auto", padding:"12px", background:C.sidebar, display:"flex", flexDirection:"column", gap:5, flexShrink:0 }}>
              <LanguageToggle lang={uiLang} setLang={setUiLang} muted style={{ width:"100%", justifyContent:"stretch" }}/>
              <button onClick={() => setShowSettings(s=>!s)} className="bi-navbtn" style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, width:"100%", border:`1px solid ${showSettings ? C.accent : "transparent"}`, background:showSettings ? C.card : "transparent", color:showSettings ? C.text : C.muted, borderRadius:5, padding:"7px 8px", cursor:"pointer", fontSize:12, ...REPORT_NAV_FONT, fontWeight:400, textAlign:"left" }}>
                <span>{t("nav.dataSources", "Data Sources")}</span>
              </button>
              <button onClick={logoutAndReload} className="bi-navbtn" style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, width:"100%", border:"1px solid transparent", background:"transparent", color:C.muted, borderRadius:5, padding:"7px 8px", cursor:"pointer", fontSize:12, ...REPORT_NAV_FONT, fontWeight:400, textAlign:"left" }}>
                <span>{t("nav.logout", "Log Out")}</span>
              </button>
            </div>
          </div>
        )}

        {/* MAIN CONTENT */}
        <div
          className="bi-main"
          data-active-view={tab}
          data-view-ready-ms={viewReadyMs ?? undefined}
          data-view-ready-key={viewReadyKey || undefined}
          data-view-request-key={runtimeRequestKey}
          data-view-status={runtimeState}
          data-download-ms={runtimeRequestState.downloadMs}
          data-parse-ms={runtimeRequestState.parseMs}
          data-analysis-section={tab === "rankings" ? analysisSection : undefined}
          data-analysis-status={tab === "rankings" ? runtimeState : undefined}
          data-analysis-request-key={tab === "rankings" ? runtimeRequestKey : undefined}
          data-analysis-ready-ms={tab === "rankings" ? datasetTimings.analysisReadyMs : undefined}
          data-server-query-ms={runtimeRequestState.browserCached ? 0 : compactViewDiagnostics ? Number(compactViewDiagnostics.queryMs || 0) : runtimeRequestState.queryMs}
          data-server-db-ms={compactViewDiagnostics ? Number(compactViewDiagnostics.dbMs || 0) : undefined}
          data-server-runtime-ms={compactViewDiagnostics ? Number(compactViewDiagnostics.runtimeMs || 0) : undefined}
          data-server-reference-ms={compactViewDiagnostics ? Number(compactViewDiagnostics.referenceMs || 0) : undefined}
          data-server-model-ms={compactViewDiagnostics ? Number(compactViewDiagnostics.modelMs || 0) : undefined}
          data-response-bytes={runtimeRequestState.responseBytes === undefined ? undefined : Number(runtimeRequestState.responseBytes || 0)}
          data-transfer-bytes={runtimeRequestState.transferBytes === undefined ? undefined : Number(runtimeRequestState.transferBytes || 0)}
          data-content-encoding={runtimeRequestState.contentEncoding === undefined ? undefined : String(runtimeRequestState.contentEncoding || "")}
          data-server-cached={runtimeRequestState.browserCached ? undefined : compactViewDiagnostics ? String(!!compactViewDiagnostics.serverCached) : runtimeRequestState.serverCached === undefined ? undefined : String(!!runtimeRequestState.serverCached)}
          data-browser-cached={runtimeRequestState.browserCached === undefined ? undefined : String(!!runtimeRequestState.browserCached)}
          data-view-model-version={compactViewDiagnostics?.modelVersion || undefined}
          data-analysis-model-version={tab === "rankings" ? effectiveAnalysisViewModel?.modelVersion || "" : undefined}
          data-map-features-status={tab === "map" ? (!mapFeaturesInitialized ? "loading" : mapFeaturesError ? "error" : "ready") : undefined}
          data-reload-interactive-status={reloadInteraction.status || undefined}
          data-reload-navigation-type={reloadInteraction.navigationType || undefined}
          data-reload-interactive-ms={reloadInteraction.interactiveMs ?? undefined}
          data-reload-long-task-count={reloadInteraction.longTaskCount}
          data-reload-long-task-total-ms={reloadInteraction.longTaskTotalMs}
          data-reload-long-task-max-ms={reloadInteraction.longTaskMaxMs}
          data-reload-input-delay-ms={reloadInteraction.inputDelayMs ?? undefined}
          data-reload-input-duration-ms={reloadInteraction.inpMs ?? undefined}
          data-reload-inp-ms={reloadInteraction.inpMs ?? undefined}
          data-reload-first-input-ms={reloadInteraction.firstTrustedInputMs ?? undefined}
          data-reload-input-after-candidate-ms={reloadInteraction.inputAfterCandidateMs ?? undefined}
          data-reload-input-count={reloadInteraction.inputCount}
          data-reload-page-activation-count={reloadInteraction.pageActivationCount}
          data-reload-benchmark-activation-count={reloadInteraction.benchmarkActivationCount}
          data-reload-probe-delay-ms={reloadInteraction.probeDelayMaxMs}
          data-reload-post-commit-quiet-ms={reloadInteraction.postCommitQuietMs ?? undefined}
          data-reload-benchmark-count={reloadBenchmarkEnabled ? reloadBenchmarkSummary?.acceptedCount : undefined}
          style={{ flex:1, padding:"22px 24px 28px", minWidth:0, background:C.bg }}
        >
          {tab === "pnl" ? <React.Suspense fallback={<div style={{ padding:"28px", color:C.muted, textAlign:"center" }}>Loading P&L...</div>}><LazyPnlView lang={uiLang} productOptions={productOptions} campaignOptions={sidebarCampaignOptions}/></React.Suspense> : <RuntimeViewBoundary state={runtimeState} label={runtimeScopeLabel} lang={uiLang} onRetry={retryRuntimeView} resetKey={runtimeRequestKey}>
          {tab==="campaign"  && <CampaignView salesChannel={campaignChannel} prodSales={channelData.prodSales} portfolioSales={channelData.sales} inlineTotalSales={channelData.inlineTotalSales} warehouseDailySales={channelData.warehouseDailySales} onlineSales={channelData.onlineSales} ppcRows={channelData.ppcRows} whs={activeWhs} footnotes={PORTFOLIO_CALENDAR_NOTES} videos={channelData.videos} videoMetrics={videoMetrics} dateRange={campaignDR} campaignPid={campaignPid} campaignCid={campaignCid || activeCampaignId} subtab={campaignSubtab} setSubtab={setCampaignSubtab} productMeta={productMeta} campaignMeta={campaignMeta} comparisonData={channelComparison} precomputedRevenueDoor={!runtimeQueryEnabled ? (campaignDateAutoRef.current ? campaignAutomaticRevenueDoorSummary || campaignRevenueDoorSummary : campaignRevenueDoorSummary) : null}/>}
          {tab==="map"       && <React.Suspense fallback={<div role="status">{t("app.loading", "Loading BYOU Intel...")}</div>}><TabReady requestKey={`${tab}|${runtimeRequestKey}`} onReady={setLazyTabReadyKey}><LazyMapView      ranked={visibleMapRanked} selId={selId} setSelId={setSelId} minT={mapMinT} maxT={mapMaxT} mapFeatures={mapFeatures} d3Module={mapProjectionLibrary} mapError={mapFeaturesError} onRetryMap={retryMapFeatures} footnotes={PORTFOLIO_CALENDAR_NOTES} sales={visibleMapSales} comparisonStats={mapCoverageStats} selectedProductIds={mapPids} selectedProducts={mapSelectedProducts} kpis={mapKpis}/></TabReady></React.Suspense>}
          {tab==="analytics" && <><AnalyticsView compactModel={salesViewModel} salesChannel={campaignChannel} sales={channelData.sales} prodSales={channelData.prodSales} inlineTotalSales={channelData.inlineTotalSales} onlineSales={channelData.onlineSales} ppcRows={channelData.ppcRows} whs={visibleActiveWhs} ranked={searchedSidebarRows} selId={selId} footnotes={PORTFOLIO_CALENDAR_NOTES} dateRange={analyticsDR} selPid={selPid} salesRegion={salesRegion} salesState={salesState} productMeta={productMeta} campaignMeta={campaignMeta} campaignId={activeCampaignId} storeSearchActive={!!storeQuery} analysisSummaries={analysisSummaries}/></>}
          {tab==="inventory" && <InventoryView compactModel={inventoryViewModel} ownerSalesHistory={effectiveOwnerSalesHistory} ownerInventoryDecisions={ownerInventoryDecisions} prodSales={prodSales} inlineTotalSales={inlineTotalSales} onlineSales={onlineSales} inventoryApprovals={effectiveInventoryApprovals} inventoryReviewDispositions={inventoryReviewDispositions} whs={visibleInventoryWhs} selId={selId} dateRange={inventoryDR} selPid={inventoryPid} inventoryType={inventoryType} inventoryRegion={inventoryRegion} inventoryState={inventoryState} productMeta={productMeta} campaignMeta={campaignMeta} campaignId={activeCampaignId} storeSearchActive={!!storeQuery} approvalEvaluationDate={inventoryApprovalEvaluationDate} onApproveInventory={inventoryApprovalEnabled ? approveInventoryOnHand : null} onRevokeInventory={inventoryApprovalEnabled ? revokeInventoryOnHand : null}/>}
          {tab==="rankings"  && <React.Suspense fallback={<div style={{ padding:"28px", color:C.muted, textAlign:"center" }}>Loading Analysis...</div>}><LazyRankingsView onReady={markAnalysisReady} compactRequestKey={runtimeRequestKey} model={activeAnalysisModel} ranked={ranked} whs={analysisSection === "warehouses" ? whs : activeWhs} setSelId={setSelId} selId={analysisSection === "demographics" ? demographicsWarehouseId : selId} dateRange={campaignDR} campaignPid={campaignPid} campaignCid={campaignCid || activeCampaignId} productMeta={productMeta} campaignMeta={campaignMeta} productOptions={productOptions} analysisSection={analysisSection} setAnalysisSection={selectAnalysisSection} analysisOptions={analysisOptions} setAnalysisOptions={setAnalysisOptions} compareA={effectiveCompareA} setCompareA={setCompareA} compareB={effectiveCompareB} setCompareB={setCompareB} compareCampaignA={compareCampaignA} setCompareCampaignA={setCompareCampaignA} compareCampaignB={compareCampaignB} setCompareCampaignB={setCompareCampaignB} comparisonCampaignOptions={comparisonCampaignOptions} pacingCompPid={pacingCompPid} setPacingCompPid={setPacingCompPid} pacingCompCid={pacingCompCid} setPacingCompCid={setPacingCompCid} warehouseProfileQuery={analysisSection === "warehouses" ? runtimeQuery : null} warehouseProfileProductKey={analysisSection === "warehouses" ? runtimeProductKey : ""} onWarehousePublicationStale={refreshPublishedAnalysis}/></React.Suspense>}
          {tab==="videos"    && <React.Suspense fallback={<div role="status">{t("app.loading", "Loading BYOU Intel...")}</div>}><TabReady requestKey={`${tab}|${runtimeRequestKey}`} onReady={setLazyTabReadyKey}><LazyVideosView    videos={channelData.videos} videoMetrics={videoMetrics} selPid={videoSelPid} selPlatform={videoPlatform} selType={videoType} dateRange={videoDateRange} selVid={selVid} setSelVid={setSelVid} selMetric={selVideoMetric} setSelMetric={setSelVideoMetric} productMeta={productMeta} campaignId={activeCampaignId}/></TabReady></React.Suspense>}
          </RuntimeViewBoundary>}
        </div>
      </div>

      {reloadBenchmarkEnabled && (
        <ReloadBenchmarkPanel
          telemetry={reloadInteractionRef.current}
          summary={reloadBenchmarkSummary}
          result={reloadBenchmarkResult}
          onStart={startReloadBenchmark}
          onDownload={downloadReloadBenchmark}
          onReset={resetAndReloadBenchmark}
        />
      )}

      {tab !== "pnl" && toast && (
        <div role="status" style={{ position:"fixed", bottom:88, right:20, background:toast.startsWith("⚠")||/failed|unavailable/i.test(toast)?C.red:C.green, color:"#FFFFFF", padding:"9px 16px", borderRadius:8, fontSize:12, fontWeight:500, ...SANS, zIndex:1300, boxShadow:"0 12px 30px rgba(15,23,42,0.25)", maxWidth:380 }}>
          {toast}
        </div>
      )}
      {tab !== "pnl" && publishedStatusToast && (
        <div key={publishedStatusToast.id} className="bi-published-toast" role="status" aria-live="polite" aria-atomic="true">
          {publishedStatusToast.message}
        </div>
      )}
      {publishModalOpen && (
        <div style={{ position:"fixed", inset:0, background:"rgba(4,26,44,0.45)", zIndex:1400, display:"grid", placeItems:"center", ...SANS }}>
          <div role="dialog" aria-modal="true" style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:"20px 22px", width:"min(440px, calc(100vw - 32px))", boxShadow:"0 24px 70px rgba(15,23,42,0.3)" }}>
            <div style={{ fontSize:14, fontWeight:500, color:C.text, marginBottom:8 }}>{publishAction === "dailyUpdate" ? "Validate and publish this daily update?" : t("data.publishTitle", "Publish for the whole team?")}</div>
            <div style={{ fontSize:11, color:C.muted, lineHeight:1.6, marginBottom:10 }}>
              {publishAction === "dailyUpdate" ? "The server will validate the compact workbook, append only non-conflicting daily rows, and atomically publish the new shared revision. The raw workbook is not retained on the server." : t("data.publishBody", "This overwrites the shared team dataset that everyone loads, including shared report data.")}
              {sharedDatasetStatus.publishedAt ? ` ${t("data.lastPublished", "Last published")}: ${new Date(sharedDatasetStatus.publishedAt).toLocaleString()}.` : ""}
            </div>
            <label style={{ display:"block", fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>{t("data.publishToken", "Admin publish token")}</label>
            <input type="password" value={publishToken} onChange={e => setPublishToken(e.target.value)} autoFocus style={{ ...INP, fontSize:12, padding:"9px 11px", marginBottom:12 }}/>
            <div style={{ display:"flex", justifyContent:"flex-end", gap:8 }}>
              <SmBtn onClick={cancelPublishAction}>{t("common.cancel", "Cancel")}</SmBtn>
              <button disabled={!publishToken.trim()} onClick={confirmPublishAction} style={{ padding:"6px 14px", borderRadius:8, border:"none", background:publishToken.trim() ? C.green : C.border, color:"#FFFFFF", fontWeight:500, fontSize:12, cursor:publishToken.trim() ? "pointer" : "default", ...SANS }}>{publishAction === "dailyUpdate" ? "Validate & Publish" : t("data.publishConfirm", "Publish")}</button>
            </div>
          </div>
        </div>
      )}
      {importBusy && (
        <div style={{ position:"fixed", inset:0, background:"rgba(4,26,44,0.45)", zIndex:1400, display:"grid", placeItems:"center", ...SANS }} aria-live="polite">
          <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:"22px 26px", boxShadow:"0 24px 70px rgba(15,23,42,0.3)", display:"flex", alignItems:"center", gap:12, maxWidth:420 }}>
            <span style={{ width:10, height:10, borderRadius:"50%", background:C.accent, boxShadow:`0 0 0 5px ${C.accentFade}`, flexShrink:0 }}/>
            <div style={{ minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:500, color:C.text }}>{t("data.parsing", "Parsing upload...")}</div>
              <div style={{ fontSize:11, color:C.muted, marginTop:3, lineHeight:1.5 }}>{importStatus.message || t("data.parsingHint", "Large workbooks can take a moment. Keep this tab open.")}</div>
            </div>
          </div>
        </div>
      )}
    </div>
    </LanguageContext.Provider>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAP VIEW
// ═══════════════════════════════════════════════════════════════

export {
  ANALYSIS_MIN_SELLING_UNITS,
  ANALYSIS_MIN_SELLING_UNIT_OPTIONS,
  C,
  CampaignView,
  CalendarView,
  AnalyticsView,
  CampaignChannelSelect,
  DashboardApp,
  InventoryView,
  DATA_END,
  DATA_START,
  FN_TYPES,
  IMPACT_EVENT_TYPES,
  INP,
  MONO,
  Panel,
  SANS,
  SELECT,
  SmBtn,
  StatusChip,
  analysisWarehouseStats,
  buildEventSalesIndex,
  campaignHealth,
  campaignWithMeta,
  dateBoundsFromRows,
  downloadRowsCsv,
  fmtCompactMoney,
  fmtCurrency,
  fmtGrowth,
  inclusiveDays,
  isNonStoreInventoryLocation,
  meaningfulSalesStartDate,
  normalizeStoreText,
  normalizedProductKey,
  offsetDate,
  pctChange,
  productCatalog,
  productIdForMetricRow,
  productLabelForValue,
  productOptionIdForValue,
  productValuesMatch,
  productWithMeta,
  rowMatchesCampaignScopeWithInference,
  sumEventSalesWindow,
  totalRevenueDoorStats,
  useUiText,
  warehouseNumberFromText,
};
export default function App() {
  return (
    <AuthGate>
      <DashboardApp/>
    </AuthGate>
  );
}

function CampaignView({ prodSales, portfolioSales = [], inlineTotalSales, warehouseDailySales = [], onlineSales = [], ppcRows = [], whs, footnotes, videos, videoMetrics, dateRange, campaignPid, campaignCid = "", subtab, setSubtab, productMeta, campaignMeta = {}, comparisonData = null, viewMode = "campaign", pacingCompPid = "", pacingCompCid = "", precomputedRevenueDoor = null, salesChannel = "" }) {
  const { lang, t, label:uiLabel } = useUiText();
  const analysisPlanningMode = viewMode === "analysisPlanning";
  const activeSubtab = analysisPlanningMode ? "analysis_planning" : ["overview","report"].includes(subtab) ? subtab : "overview";
  const showAnalysisView = analysisPlanningMode || activeSubtab === "analysis";
  const showPlanningView = analysisPlanningMode || activeSubtab === "planning";
  const showReportView = !analysisPlanningMode && activeSubtab === "report";
  const showOverviewView = !showAnalysisView && !showPlanningView && !showReportView;
  const needsBenchmarkModels = showAnalysisView || showPlanningView;
  const [showAllWarehouseRows, setShowAllWarehouseRows] = useState(false);
  const [warehouseSearch, setWarehouseSearch] = useState("");
  const [warehouseSort, setWarehouseSort] = useState({ key:"rev", dir:"desc" });
  const [expandedReportGroups, setExpandedReportGroups] = useState({});
  const [benchmarkMode, setBenchmarkMode] = useState("all");
  const [benchmarkCampaignIds, setBenchmarkCampaignIds] = useState([]);
  const [benchmarkProductIds, setBenchmarkProductIds] = useState([]);
  const [benchmarkCategory, setBenchmarkCategory] = useState("");
  const product = campaignPid ? productWithMeta(campaignPid, productMeta) : null;
  const selectedCampaign = campaignWithMeta(campaignCid, campaignMeta, productMeta);
  const campaignName = salesChannel
    ? `${product?.short || t("filter.allProducts", "All Products")} / ${salesChannel === "online" ? t("filter.online", "Online") : t("filter.inline", "Inline")}`
    : selectedCampaign?.short || product?.short || "All Campaigns";
  const selectedBenchmarkProductId = campaignPid || selectedCampaign?.pid || "";
  const selectedBenchmarkCampaignId = campaignCid || selectedCampaign?.id || "";
  const benchmarkProductOptions = useMemo(() => needsBenchmarkModels ? productCatalog(productMeta) : [], [needsBenchmarkModels, productMeta]);
  const benchmarkCampaignOptions = useMemo(() => needsBenchmarkModels ? _.orderBy(
    campaignFilterCatalog(campaignMeta, productMeta).filter(c => c.pid),
    [c => c.active ? 1 : 0, c => c.start || "", c => c.short || c.name || c.id],
    ["desc", "desc", "asc"]
  ) : [], [needsBenchmarkModels, campaignMeta, productMeta]);
  const productCategoryFor = useCallback(pid => {
    const prod = productWithMeta(pid, productMeta);
    return productDisplayName(prod?.category || productMetaForProduct(pid, productMeta)?.category || "");
  }, [productMeta]);
  const benchmarkCategories = useMemo(() => _.sortBy([...new Set(benchmarkProductOptions.map(p => productCategoryFor(p.id)).filter(Boolean))]), [benchmarkProductOptions, productCategoryFor]);
  const selectedBenchmarkCategory = selectedBenchmarkProductId ? productCategoryFor(selectedBenchmarkProductId) : "";
  const activeBenchmarkCategory = benchmarkCategory || selectedBenchmarkCategory || benchmarkCategories[0] || "";
  const activeBenchmarkProductIds = useMemo(() => {
    const validIds = new Set(benchmarkProductOptions.map(p => p.id));
    const selected = benchmarkProductIds.filter(pid => validIds.has(pid));
    if (selected.length) return selected;
    return benchmarkProductOptions.map(p => p.id);
  }, [benchmarkProductIds, benchmarkProductOptions, selectedBenchmarkProductId]);
  const activeBenchmarkCampaignIds = useMemo(() => {
    const validIds = new Set(benchmarkCampaignOptions.map(c => c.id));
    const selected = benchmarkCampaignIds.filter(cid => validIds.has(cid));
    if (selected.length) return selected;
    if (selectedBenchmarkCampaignId && validIds.has(selectedBenchmarkCampaignId)) return [selectedBenchmarkCampaignId];
    if (selectedBenchmarkProductId) {
      const latestForProduct = benchmarkCampaignOptions.find(c => c.pid === selectedBenchmarkProductId);
      if (latestForProduct) return [latestForProduct.id];
    }
    return benchmarkCampaignOptions[0]?.id ? [benchmarkCampaignOptions[0].id] : [];
  }, [benchmarkCampaignIds, benchmarkCampaignOptions, selectedBenchmarkCampaignId, selectedBenchmarkProductId]);
  const rowInCampaign = useCallback(row => (
    rowMatchesCampaignScopeWithInference(row, campaignCid, campaignMeta, productMeta, campaignPid || selectedCampaign?.pid || "")
  ), [campaignCid, campaignMeta, productMeta, campaignPid, selectedCampaign?.pid]);
  const campaignProductIds = useMemo(() => {
    if (campaignPid) return [campaignPid];
    if (selectedCampaign?.pid) return [selectedCampaign.pid];
    return [];
  }, [campaignPid, selectedCampaign]);
  const whById = useMemo(() => new Map(whs.map(w => [w.id, w])), [whs]);
  const endDate = dateRange.end || DATA_END;
  const recentVideoStart = offsetDate(endDate, -13);
  const upcomingEnd = offsetDate(endDate, 30);

  useEffect(() => {
    setShowAllWarehouseRows(false);
    setExpandedReportGroups({});
  }, [campaignPid, campaignCid, dateRange.start, dateRange.end]);

  useEffect(() => {
    setBenchmarkProductIds(prev => {
      const validIds = new Set(benchmarkProductOptions.map(p => p.id));
      const next = prev.filter(pid => validIds.has(pid));
      if (next.length) return next.length === prev.length ? prev : next;
      return next;
    });
  }, [benchmarkProductOptions, selectedBenchmarkProductId]);

  useEffect(() => {
    setBenchmarkCampaignIds(prev => {
      const validIds = new Set(benchmarkCampaignOptions.map(c => c.id));
      const next = prev.filter(cid => validIds.has(cid));
      if (next.length) return next.length === prev.length ? prev : next;
      return next;
    });
  }, [benchmarkCampaignOptions, selectedBenchmarkCampaignId]);

  useEffect(() => {
    if (!benchmarkCategories.length) {
      if (benchmarkCategory) setBenchmarkCategory("");
      return;
    }
    if (!benchmarkCategory && selectedBenchmarkCategory) {
      setBenchmarkCategory(selectedBenchmarkCategory);
      return;
    }
    if (benchmarkCategory && !benchmarkCategories.includes(benchmarkCategory)) setBenchmarkCategory(benchmarkCategories[0]);
  }, [benchmarkCategories, benchmarkCategory, selectedBenchmarkCategory]);

  const scopedInlineRows = useMemo(() => (
    inlineTotalSales.map(r => ({ ...r, sourceType:"Inline" }))
      .filter(r => r.date >= dateRange.start && r.date <= dateRange.end && (!campaignPid || productValuesMatch(r.pid, campaignPid, productMeta)) && rowInCampaign(r))
  ), [inlineTotalSales, dateRange, campaignPid, rowInCampaign]);
  const inlineRows = useMemo(() => (
    scopedInlineRows.filter(r => Number(r.rev || 0) > 0 || Number(r.units || 0) > 0 || Number(r.inv || 0) > 0)
  ), [scopedInlineRows]);
  const scopedWarehouseDailyRows = useMemo(() => (
    warehouseDailySales.map(r => ({ ...r, sourceType:"WarehouseDerived" }))
      .filter(r => r.date >= dateRange.start && r.date <= dateRange.end && (!campaignPid || productValuesMatch(r.pid, campaignPid, productMeta)) && rowInCampaign(r))
  ), [warehouseDailySales, dateRange, campaignPid, rowInCampaign]);
  const onlineRows = useMemo(() => (
    onlineSales.map(r => ({ ...r, sourceType:"Online" }))
      .filter(r => r.date >= dateRange.start && r.date <= dateRange.end && (!campaignPid || productValuesMatch(r.pid, campaignPid, productMeta)) && rowInCampaign(r) && (
        Number(r.rev || 0) > 0 ||
        Number(r.units || 0) > 0 ||
        Number(r.orders || 0) > 0 ||
        Number(r.inv || 0) > 0 ||
        Number(r.inbound || 0) > 0 ||
        Number(r.reserved || 0) > 0
      ))
  ), [onlineSales, dateRange, campaignPid, rowInCampaign]);
  const revenueDoorDenominatorSources = useMemo(() => (
    campaignRevenueDoorDenominatorSources(portfolioSales, prodSales, { campaignPid, campaignCid })
  ), [portfolioSales, prodSales, campaignPid, campaignCid]);
  const warehouseDenominatorSourceRows = revenueDoorDenominatorSources.overallRows;
  const warehouseDenominatorRows = useMemo(() => (
    warehouseDenominatorSourceRows.filter(r => r.date >= dateRange.start && r.date <= dateRange.end && (!campaignPid || productValuesMatch(r.pid, campaignPid, productMeta)) && rowInCampaign(r))
  ), [warehouseDenominatorSourceRows, dateRange, campaignPid, rowInCampaign]);
  const productWarehouseDenominatorRows = useMemo(() => (
    revenueDoorDenominatorSources.productRows.filter(r => r.date >= dateRange.start && r.date <= dateRange.end && (!campaignPid || productValuesMatch(r.pid, campaignPid, productMeta)) && rowInCampaign(r))
  ), [revenueDoorDenominatorSources, dateRange, campaignPid, rowInCampaign]);
  const warehouseRows = useMemo(() => (
    warehouseDenominatorRows.filter(r => Number(r.rev || 0) > 0 || Number(r.units || 0) > 0 || Number(r.inv || 0) > 0)
  ), [warehouseDenominatorRows]);
  const campaignPpcRows = useMemo(() => (
    ppcRows.filter(row => ppcRowInDateRange(row, dateRange) && ppcRowMatchesProduct(row, campaignPid, productMeta) && rowInCampaign(row))
  ), [ppcRows, dateRange, campaignPid, rowInCampaign]);
  const campaignPpcTotals = useMemo(() => sumPpcRows(campaignPpcRows), [campaignPpcRows]);
  const campaignMetaRows = useMemo(() => campaignPpcRows.filter(isMetaPpcRow), [campaignPpcRows]);
  const campaignNonMetaPpcRows = useMemo(() => campaignPpcRows.filter(row => !isMetaPpcRow(row)), [campaignPpcRows]);
  const campaignMetaStartEvents = useMemo(() => showReportView ? metaCampaignStartEvents(campaignMetaRows) : [], [showReportView, campaignMetaRows]);

  const useInlineTotalRows = inlineRows.some(r => Number(r.rev || 0) > 0 || Number(r.units || 0) > 0);
  const useOnlineRows = onlineRows.some(r => Number(r.rev || 0) > 0 || Number(r.units || 0) > 0 || Number(r.orders || 0) > 0);
  const focusedCampaignSelection = !!(campaignPid || campaignCid || selectedCampaign?.pid);
  const campaignSalesMode = salesChannel || (focusedCampaignSelection && !useInlineTotalRows && useOnlineRows ? "online" : "inline");
  const usesOnlineSales = campaignSalesMode === "online";
  const officialInlineTotalsMissing = !usesOnlineSales && !useInlineTotalRows;
  const inlineMetricRows = inlineRows;
  const onlineMetricRows = onlineRows;
  const metricRows = usesOnlineSales ? onlineMetricRows : inlineMetricRows;
  const effectiveInlineMetricRows = useMemo(() => (
    effectiveInlineSalesRows(scopedInlineRows, scopedWarehouseDailyRows)
      .filter(r => Number(r.rev || 0) !== 0 || Number(r.units || 0) !== 0)
  ), [scopedInlineRows, scopedWarehouseDailyRows]);
  const salesTrendRows = usesOnlineSales ? onlineMetricRows : effectiveInlineMetricRows;
  const inlineRev = _.sumBy(inlineMetricRows, "rev");
  const inlineUnits = _.sumBy(inlineMetricRows, "units");
  const onlineRev = _.sumBy(onlineMetricRows, "rev");
  const onlineUnits = _.sumBy(onlineMetricRows, "units");
  const onlineOrders = _.sumBy(onlineMetricRows, "orders");
  const onlineUsesOrdersAsUnits = usesOnlineSales && onlineUnits <= 0 && onlineOrders > 0;
  const selectedSalesRev = usesOnlineSales ? onlineRev : inlineRev;
  const selectedSalesUnits = usesOnlineSales ? (onlineUsesOrdersAsUnits ? onlineOrders : onlineUnits) : inlineUnits;
  const salesSeriesLabel = usesOnlineSales ? "Online Sales" : "Inline Sales";
  const unitSeriesLabel = usesOnlineSales ? (onlineUsesOrdersAsUnits ? "Online Orders" : "Online Units") : "Inline Units";
  const salesTrendTitle = usesOnlineSales ? "Daily Online Sales Trend" : "Inline Sales Trend";
  const onlineInventoryAvailable = onlineRows.some(r => r.invKnown || r.inboundKnown || r.reservedKnown || Number(r.inv || 0) > 0 || Number(r.inbound || 0) > 0 || Number(r.reserved || 0) > 0);
  const inventoryFlowTitle = usesOnlineSales ? (onlineInventoryAvailable ? "Online Inventory Flow" : "Online Sales Flow") : "Inline Inventory Flow";
  const inventoryFlowLabel = usesOnlineSales ? (onlineInventoryAvailable ? "Online Inventory" : unitSeriesLabel) : "Inline Inventory";
  const inventoryFlowSubLabel = usesOnlineSales ? (onlineInventoryAvailable ? t("common.unitsOnHand", "units on hand") : "sold in period") : t("common.unitsOnHand", "units on hand");
  const onlineChannelCount = usesOnlineSales ? new Set(onlineMetricRows.map(r => r.channel || r.source || "Online").filter(Boolean)).size : 0;
  const revenueDoorProductIds = useMemo(() => (
    campaignProductIds.length ? campaignProductIds : productIdsFromRows(inlineMetricRows.filter(r => Number(r.rev || 0) > 0))
  ), [campaignProductIds, inlineMetricRows]);
  const calculatedDoorStats = useMemo(() => (
    totalRevenueDoorStats(inlineMetricRows, productMeta, revenueDoorProductIds, { denominatorRows:warehouseDenominatorRows, warehouses:whs, start:dateRange.start, end:dateRange.end })
  ), [inlineMetricRows, warehouseDenominatorRows, whs, productMeta, revenueDoorProductIds, dateRange.start, dateRange.end]);
  const publishedPortfolioDoorStats = !usesOnlineSales && !campaignPid && !campaignCid && precomputedRevenueDoor?.portfolio?.weeklyPeriodCount
    ? precomputedRevenueDoor.portfolio
    : null;
  const doorStats = publishedPortfolioDoorStats
    ? {
      ...calculatedDoorStats,
      ...publishedPortfolioDoorStats,
      formulaLabel:`Average of ${publishedPortfolioDoorStats.weeklyPeriodCount.toLocaleString()} weekly Revenue / Door period${publishedPortfolioDoorStats.weeklyPeriodCount === 1 ? "" : "s"}`,
      source:"Precomputed Average Weekly Revenue / Verified Selling Stores",
    }
    : calculatedDoorStats;

  const storeRows = useMemo(() => {
    const byWid = _.groupBy(warehouseRows, "wid");
    return _.orderBy(Object.entries(byWid).map(([wid, rows]) => {
      const wh = whById.get(wid);
      const analysisStats = warehouseDisplayStats(rows, wh);
      if (!analysisStats.eligible) return null;
      const movementRows = rows.filter(r => Number(r.rev || 0) > 0 || Number(r.units || 0) > 0);
      const rev = _.sumBy(movementRows, "rev");
      const units = _.sumBy(movementRows, "units");
      const revenuePerDoor = averageWeeklyRevenueDoorStats(movementRows, movementRows, [wh], { start:dateRange.start, end:dateRange.end }).revenuePerDoor;
      const health = campaignHealth(revenuePerDoor, 1);
      return {
        wid,
        name:wh?.name || wid,
        location:warehouseLocationLabel(wh),
        region:wh?.region || "",
        rev,
        units,
        revenuePerDoor,
        health,
        statusLabel:health.label,
        share:inlineRev > 0 ? (rev / inlineRev) * 100 : 0,
        maxInventory:analysisStats.maxInventory,
        initialInventory:analysisStats.initialInventory,
        positiveUnits:analysisStats.positiveUnits,
        positiveRev:analysisStats.positiveRev,
      };
    }).filter(Boolean), "rev", "desc");
  }, [warehouseRows, whById, inlineRev, dateRange.start, dateRange.end]);

  const activeDoors = doorStats.activeDoors;
  const totalWarehouses = doorStats.totalWarehouses;
  const revenuePerDoor = doorStats.revenuePerDoor;
  const health = campaignHealth(revenuePerDoor, activeDoors);
  const portfolioRows = useMemo(() => {
    if (!showOverviewView) return [];
    const activeMetricRows = metricRows.filter(r => Number(r.rev || 0) > 0 && productIsActive(productIdForMetricRow(r), productMeta));
    if (campaignPid && !campaignCid && campaignFilterCatalog(campaignMeta, productMeta, campaignPid).length) {
      const metricByCampaign = _.groupBy(activeMetricRows, r => r.cid || "uncampaigned");
      return _.orderBy(Object.entries(metricByCampaign).map(([key, rows]) => {
        const camp = campaignWithMeta(key, campaignMeta, productMeta);
        const prod = productWithMeta(campaignPid, productMeta);
        const rev = _.sumBy(rows, "rev");
        const units = _.sumBy(rows, "units");
        const denominatorRows = warehouseDenominatorRows.filter(row => (rowCampaignId(row) || "uncampaigned") === key);
        const productDoorStats = totalRevenueDoorStats(rows.filter(r => r.sourceType !== "Online"), productMeta, [campaignPid], { denominatorRows, warehouses:whs, start:dateRange.start, end:dateRange.end });
        return {
          key,
          name:camp?.short || rows[0]?.campaign || "Unassigned Campaign",
          col:camp?.col || prod?.col || C.blue,
          rev,
          units,
          doors:productDoorStats.totalWarehouses,
          verifiedDoors:productDoorStats.activeDoors,
          revenuePerDoor:productDoorStats.revenuePerDoor,
          weeklyPeriodCount:productDoorStats.weeklyPeriodCount,
          health:campaignHealth(productDoorStats.revenuePerDoor, productDoorStats.activeDoors),
        };
      }), "rev", "desc");
    }
    const metricByProduct = _.groupBy(activeMetricRows, r => r.pid || productDisplayName(r.product) || "unassigned");
    return _.orderBy(Object.entries(metricByProduct).map(([key, rows]) => {
      const prod = productWithMeta(key, productMeta) || productWithMeta(rows[0]?.product, productMeta);
      const meta = productMetaForProduct(prod?.id || rows[0]?.product || key, productMeta);
      const rev = _.sumBy(rows, "rev");
      const units = _.sumBy(rows, "units");
      const inlineProductRows = rows.filter(r => r.sourceType !== "Online");
      const denominatorRows = productWarehouseDenominatorRows.filter(row => productValuesMatch(productIdForMetricRow(row), prod?.id || key, productMeta));
      const calculatedProductDoorStats = totalRevenueDoorStats(inlineProductRows, productMeta, [prod?.id || key].filter(Boolean), { denominatorRows, warehouses:whs, start:dateRange.start, end:dateRange.end });
      const publishedProductDoorStats = !usesOnlineSales && (precomputedRevenueDoor?.products || []).find(summary => productValuesMatch(summary.pid, prod?.id || key, productMeta));
      const productDoorStats = publishedProductDoorStats?.weeklyPeriodCount
        ? { ...calculatedProductDoorStats, ...publishedProductDoorStats }
        : calculatedProductDoorStats;
      return {
        key,
        name:productDisplayName(prod?.short || meta.short || meta.name || rows[0]?.product || key || "Unassigned"),
        col:prod?.col || meta.col || C.blue,
        rev,
        units,
        doors:productDoorStats.totalWarehouses,
        verifiedDoors:productDoorStats.activeDoors,
        revenuePerDoor:productDoorStats.revenuePerDoor,
        weeklyPeriodCount:productDoorStats.weeklyPeriodCount,
        health:campaignHealth(productDoorStats.revenuePerDoor, productDoorStats.activeDoors),
      };
    }), "rev", "desc");
  }, [showOverviewView, metricRows, warehouseDenominatorRows, productWarehouseDenominatorRows, whs, productMeta, campaignMeta, campaignPid, campaignCid, dateRange.start, dateRange.end, precomputedRevenueDoor, usesOnlineSales]);

  const chartData = useMemo(() => {
    if (!showOverviewView && !showPlanningView) return [];
    const byDate = new Map();
    for (const row of salesTrendRows) {
      if (!row.date) continue;
      const current = byDate.get(row.date) || { date:row.date, sales:0, units:0, rev:0 };
      const revenue = Number(row.rev || 0);
      current.sales += revenue;
      current.rev += revenue;
      current.units += onlineUsesOrdersAsUnits ? Number(row.orders || 0) : Number(row.units || 0);
      byDate.set(row.date, current);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).map(row => ({
      ...row,
      timestamp:Date.parse(`${row.date}T00:00:00Z`),
      label:salesTrendDateLabel(row.date),
    }));
  }, [showOverviewView, showPlanningView, salesTrendRows, onlineUsesOrdersAsUnits]);
  const salesTrendDomain = useMemo(() => chartDateDomain(dateRange, chartData, { fitToRows:focusedCampaignSelection }), [dateRange.start, dateRange.end, chartData, focusedCampaignSelection]);
  const salesTrendSpansYears = String(chartData[0]?.date || dateRange.start || "").slice(0, 4) !== String(chartData[chartData.length - 1]?.date || dateRange.end || "").slice(0, 4);

  const inventoryData = useMemo(() => {
    if (!showOverviewView && !showPlanningView) return [];
    const sourceRows = usesOnlineSales
      ? onlineRows
      : inlineTotalSales.filter(r => r.date >= dateRange.start && r.date <= dateRange.end && (!campaignPid || productValuesMatch(r.pid, campaignPid, productMeta)) && rowInCampaign(r));
    const byDate = new Map();
    for (const row of sourceRows) {
      if (!row.date) continue;
      const current = byDate.get(row.date) || { date:row.date, inventory:0, inventoryKnown:false };
      current.inventory += usesOnlineSales && !onlineInventoryAvailable
        ? onlineUsesOrdersAsUnits ? Number(row.orders || 0) : Number(row.units || 0)
        : Number(row.inv || 0);
      current.inventoryKnown = current.inventoryKnown || (usesOnlineSales
        ? onlineInventoryAvailable || Number(row.units || 0) > 0 || Number(row.orders || 0) > 0
        : !!row.invKnown || Number(row.inv || 0) > 0);
      byDate.set(row.date, current);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).map(row => ({ ...row, label:salesTrendDateLabel(row.date) }));
  }, [showOverviewView, showPlanningView, usesOnlineSales, onlineRows, inlineTotalSales, dateRange, campaignPid, rowInCampaign, onlineInventoryAvailable, onlineUsesOrdersAsUnits]);

  const firstSnapshotByVid = useMemo(() => {
    const map = new Map();
    videoMetrics.forEach(m => {
      if (!m.vid || !m.date) return;
      const prev = map.get(m.vid);
      if (!prev || m.date < prev.date) map.set(m.vid, m);
    });
    return map;
  }, [videoMetrics]);

  const videosWithActivity = useMemo(() => (
    videos.map(v => ({ ...v, first:firstSnapshotByVid.get(v.id), prod:productWithMeta(v.pid, productMeta), camp:campaignWithMeta(v.cid, campaignMeta, productMeta), activityDate:v.postedDate || "" }))
  ), [videos, firstSnapshotByVid, productMeta, campaignMeta]);

  const campaignVideos = useMemo(() => (
    videosWithActivity
      .filter(v => (!campaignPid || productValuesMatch(v.pid, campaignPid, productMeta)) && rowInCampaign(v) && v.activityDate && v.activityDate >= dateRange.start && v.activityDate <= dateRange.end)
  ), [videosWithActivity, campaignPid, rowInCampaign, dateRange]);
  const campaignVideoMix = useMemo(() => ({
    paid:campaignVideos.filter(v => v.type === "Paid").length,
    seeding:campaignVideos.filter(v => v.type === "Seeding").length,
    total:campaignVideos.length,
  }), [campaignVideos]);

  const recentVideos = useMemo(() => (
    videosWithActivity
      .filter(v => (!campaignPid || productValuesMatch(v.pid, campaignPid, productMeta)) && rowInCampaign(v) && v.activityDate && v.activityDate >= recentVideoStart && v.activityDate <= endDate)
  ), [videosWithActivity, campaignPid, rowInCampaign, recentVideoStart, endDate]);

  const campaignEvents = useMemo(() => (
    footnotes.filter(fn => (!campaignPid || !fn.pid || productValuesMatch(fn.pid, campaignPid, productMeta)) && rowInCampaign(fn) && fn.date >= dateRange.start && fn.date <= dateRange.end)
  ), [footnotes, campaignPid, rowInCampaign, dateRange]);

  const recentActivityCount = useMemo(() => showReportView ? (
    [
      ...campaignVideos.map(v => v.activityDate),
      ...campaignEvents.map(fn => fn.date),
      ...campaignMetaStartEvents.map(event => event.date),
      ...campaignPpcRows.map(row => ppcSnapshotDate(row)),
    ].filter(date => date && date >= recentVideoStart && date <= endDate).length
  ) : 0, [showReportView, campaignVideos, campaignEvents, campaignMetaStartEvents, campaignPpcRows, recentVideoStart, endDate]);

  const liveUpcomingEvents = useMemo(() => (
    footnotes.filter(fn => (!campaignPid || !fn.pid || productValuesMatch(fn.pid, campaignPid, productMeta)) && rowInCampaign(fn) && ["tpd","markdown"].includes(fn.type) && fn.date >= dateRange.start && fn.date <= upcomingEnd)
      .sort((a,b) => a.date.localeCompare(b.date))
  ), [footnotes, campaignPid, rowInCampaign, dateRange.start, upcomingEnd]);

  const inventoryRisks = useMemo(() => {
    return Object.entries(_.groupBy(warehouseRows, r => `${r.wid}|${r.pid}`)).map(([key, rows]) => {
      const sorted = _.sortBy(rows, "date");
      const latest = sorted[sorted.length - 1] || {};
      const wh = whById.get(latest.wid);
      const prod = productWithMeta(latest.pid, productMeta);
      const onHand = Number(latest.inv || 0);
      const units = _.sumBy(sorted, r => Math.max(0, Number(r.units || 0)));
      const rev = _.sumBy(sorted, "rev");
      if (shouldExcludeInventoryCoverage(wh, { onHand, totalUnits:units, revenue:rev })) return null;
      const sellThrough = units + onHand > 0 ? (units / (units + onHand)) * 100 : 0;
      if (onHand > 0 && units <= 0) return { key, severity:"red", col:C.red, title:"No movement inventory", metric:`${wh?.name || latest.wid} / ${prod?.short || latest.pid}: ${fmtUnits(onHand)} units on hand`, action:"Confirm field support, demo timing, or markdown review for this door." };
      if (onHand > 0 && sellThrough < 25) return { key, severity:"red", col:C.red, title:"Critical sell-through", metric:`${wh?.name || latest.wid} / ${prod?.short || latest.pid}: ${sellThrough.toFixed(1)}% sell-through`, action:"Prioritize this door for field follow-up or markdown review." };
      if (onHand > 0 && sellThrough < 40) return { key, severity:"orange", col:C.warn, title:"Watch sell-through", metric:`${wh?.name || latest.wid} / ${prod?.short || latest.pid}: ${sellThrough.toFixed(1)}% sell-through`, action:"Monitor the next sales update before changing field support or markdown timing." };
      return null;
    }).filter(Boolean).sort((a,b) => ({red:0,orange:1,green:2,info:3}[a.severity] - {red:0,orange:1,green:2,info:3}[b.severity]));
  }, [warehouseRows, whById, productMeta]);

  const reportItems = useMemo(() => {
    const items = [];
    const add = item => items.push(item);
    if (officialInlineTotalsMissing) add({ severity:"info", col:C.blue, title:"Costco Daily Totals missing", metric:"No Costco_Daily_Totals rows matched this campaign/date range", action:"Upload or correct Costco_Daily_Totals for the official campaign sales total." });
    if (!usesOnlineSales && !storeRows.length) add({ severity:"info", col:C.blue, title:"Qualified door detail missing", metric:"No warehouse rows cleared the analysis-door screen", action:"Upload or check store-level rows with real inventory and sell-through movement." });
    if (!videos.length) add({ severity:"info", col:C.blue, title:"Video tracker missing", metric:"No uploaded video rows", action:"Upload Paid or Seeding video data to connect campaign activity." });
    else if (!campaignVideos.length) add({ severity:"info", col:C.blue, title:"No campaign videos in range", metric:`${campaignName}: 0 videos from ${dateRange.start} to ${dateRange.end}`, action:"Check whether influencer activity should be added for this campaign window." });
    if (campaignPpcTotals.rows && campaignPpcTotals.totalSpend > 0 && campaignPpcTotals.totalRoas > 0 && campaignPpcTotals.totalRoas < 2) add({ severity:"orange", col:C.warn, title:"Paid-media ROAS watch", metric:`${formatRoas(campaignPpcTotals.totalRoas)} on ${fmtCompactMoney(campaignPpcTotals.totalSpend)} spend`, action:`Review paid-media targeting, bid pressure, and whether the media window lines up with ${usesOnlineSales ? "online" : "inline"} sales movement.` });
    if (campaignPpcTotals.missedSales > 0 || campaignPpcTotals.missedSpend > 0) add({ severity:"orange", col:C.warn, title:"Paid-media missed opportunity", metric:`${fmtCompactMoney(campaignPpcTotals.missedSales)} missed sales / ${fmtCompactMoney(campaignPpcTotals.missedSpend)} missed spend`, action:"Check paid-media capout, pacing, or budget constraints before the next media window." });
    if (!usesOnlineSales && !totalWarehouses) add({ severity:"info", col:C.blue, title:"Total Warehouses missing", metric:"Products_Master has no Total Warehouses value for this campaign", action:"Add Total Warehouses in Products_Master so the campaign footprint remains visible." });
    if (!usesOnlineSales && !officialInlineTotalsMissing && !activeDoors) add({ severity:"info", col:C.blue, title:"No verified weekly selling stores", metric:"No weekly period has both official revenue and a qualified selling warehouse", action:"Check warehouse-level sales coverage before interpreting Revenue / Door." });
    if (!usesOnlineSales && !officialInlineTotalsMissing && activeDoors && health.severity > 0) add({ severity:health.severity === 2 ? "red" : "orange", col:health.col, title:"Campaign under weekly revenue-per-door target", metric:`${fmtCompactMoney(revenuePerDoor)} average weekly per door`, action:"Review qualified underperforming doors first, then check whether upcoming TPDs or videos are enough to close the gap." });
    _.orderBy(storeRows.filter(r => r.revenuePerDoor <= 500), "revenuePerDoor", "asc").forEach(row => add({ severity:"red", col:C.red, title:"Underperforming door", metric:`${row.name}: ${fmtCompactMoney(row.revenuePerDoor)} average weekly per door`, action:"Prioritize store-level follow-up, demo support, or markdown timing." }));
    _.orderBy(storeRows.filter(r => r.revenuePerDoor >= 1000), "revenuePerDoor", "desc").forEach(row => add({ severity:"green", col:C.green, title:"Strong door", metric:`${row.name}: ${fmtCompactMoney(row.revenuePerDoor)} average weekly per door`, action:"Use this warehouse as the benchmark for campaign execution." }));
    recentVideos.forEach(v => add({ severity:"info", col:v.prod?.col || C.blue, title:"Recent video posted", metric:`${v.activityDate}: ${videoDisplayName(v)} / ${v.prod?.short || "All Campaigns"}`, action:"Check whether sales or traffic lifted after this post." }));
    inventoryRisks.forEach(r => add(r));
    if (!items.length) add({ severity:"green", col:C.green, title:"No immediate campaign flags", metric:`${campaignName} is clear for the selected range`, action:"Keep monitoring revenue per door, store spread, and upcoming notes." });
    return items;
  }, [officialInlineTotalsMissing, usesOnlineSales, warehouseRows, videos.length, footnotes.length, campaignVideos.length, campaignEvents.length, campaignPpcTotals, activeDoors, totalWarehouses, health, revenuePerDoor, storeRows, recentVideos, liveUpcomingEvents, inventoryRisks, campaignName, dateRange.start, dateRange.end, endDate]);

  const topPortfolioRev = Math.max(1, ...portfolioRows.map(r => r.rev));
  const filteredStoreRows = useMemo(() => {
    if (!showOverviewView) return [];
    const query = warehouseSearch.trim().toLowerCase();
    const filtered = query ? storeRows.filter(row => [row.name, row.location, row.region].some(value => String(value || "").toLowerCase().includes(query))) : storeRows;
    return sortedRows(filtered, warehouseSort.key, warehouseSort.dir);
  }, [showOverviewView, storeRows, warehouseSearch, warehouseSort]);
  const visibleStores = showAllWarehouseRows ? filteredStoreRows : filteredStoreRows.slice(0, 24);
  const setWarehouseTableSort = key => setWarehouseSort(prev => ({ key, dir:prev.key === key && prev.dir === "desc" ? "asc" : "desc" }));
  const reportOrder = { red:0, orange:1, green:2, info:3 };
  const sortedReportItems = useMemo(() => (
    [...reportItems].sort((a,b) => reportOrder[a.severity] - reportOrder[b.severity])
  ), [reportItems]);
  const reportGroups = useMemo(() => {
    const byKey = new Map();
    sortedReportItems.forEach((item, i) => {
      const key = `${item.severity}|${item.title}|${item.action}`;
      if (!byKey.has(key)) byKey.set(key, { ...item, key, firstIndex:i, items:[] });
      byKey.get(key).items.push(item);
    });
    return [...byKey.values()].sort((a,b) => reportOrder[a.severity] - reportOrder[b.severity] || a.firstIndex - b.firstIndex);
  }, [sortedReportItems]);
  const reportParagraphs = useMemo(() => {
    if (activeSubtab !== "report") return [];
    const selectedLabel = [product?.short, selectedCampaign?.short && selectedCampaign.short !== product?.short ? selectedCampaign.short : ""].filter(Boolean).join(" / ") || campaignName;
    const rangeLabel = `${dateRange.start} to ${dateRange.end}`;
    const strongDoors = storeRows.filter(r => r.revenuePerDoor >= 1000).length;
    const weakDoors = storeRows.filter(r => r.revenuePerDoor <= 500).length;
    const topDoor = storeRows[0];
    const topDoorText = topDoor
      ? `${topDoor.name} is the leading door at ${fmtCompactMoney(topDoor.rev)} in sales${topDoor.share ? `, or ${topDoor.share.toFixed(1)}% of tracked warehouse revenue` : ""}.`
      : "No warehouse-level leader is available for this range yet.";
    const performanceText = officialInlineTotalsMissing
      ? `${selectedLabel} has no matching Costco Daily Totals rows for ${rangeLabel}, so the official inline sales read is still missing for this report.`
      : usesOnlineSales
        ? `${selectedLabel} generated ${fmtCompactMoney(selectedSalesRev)} in online sales and ${selectedSalesUnits.toLocaleString()} ${onlineUsesOrdersAsUnits ? "orders" : "units"} from ${rangeLabel}. This is being treated as an online-only read because matching inline Costco Daily Totals were not found for the selected product or campaign.`
        : `${selectedLabel} generated ${fmtCompactMoney(inlineRev)} in inline sales and ${inlineUnits.toLocaleString()} units from ${rangeLabel}. ${activeDoors ? `Average weekly Revenue/Door is ${fmtCompactMoney(revenuePerDoor)} across ${doorStats.weeklyPeriodCount.toLocaleString()} calculable weekly period${doorStats.weeklyPeriodCount===1 ? "" : "s"}, which currently reads ${health.label.toLowerCase()}.` : "No weekly period has both official revenue and verified selling stores, so Revenue / Door cannot be calculated."}`;
    const doorText = usesOnlineSales
      ? `Warehouse door detail is not expected for this online-only view. The command center is using ${onlineChannelCount.toLocaleString()} online channel${onlineChannelCount===1 ? "" : "s"} and the online sales flow instead of forcing Costco warehouse denominators into this read.`
      : storeRows.length
      ? `Warehouse detail shows ${storeRows.length.toLocaleString()} qualified selling door${storeRows.length===1 ? "" : "s"} in the selected range. ${topDoorText} There are ${strongDoors.toLocaleString()} strong door${strongDoors===1 ? "" : "s"} above $1K per door and ${weakDoors.toLocaleString()} weak door${weakDoors===1 ? "" : "s"} at or below $500, so the day-to-day upkeep should stay focused on the bottom doors unless the next sales file shows a clear turn.`
      : "Qualified warehouse detail is not available for the selected range, so this report cannot yet separate strong doors from weak doors. Uploading warehouse-level master rows with real inventory and sell-through movement will make the daily upkeep read more actionable.";
    const activityText = (() => {
      const liveEvents = liveUpcomingEvents.filter(fn => fn.date <= endDate).length;
      const upcomingEvents = liveUpcomingEvents.length - liveEvents;
      if (!campaignVideos.length && !campaignEvents.length && !liveUpcomingEvents.length) {
        return "There are no matched videos tied to this selection.";
      }
      return `Activity context includes ${campaignVideos.length.toLocaleString()} videos.`;
    })();
    const attentionItems = reportGroups
      .filter(group => group.severity === "red" || group.severity === "orange")
      .slice(0, 3)
      .map(group => `${group.title.toLowerCase()} (${group.items.length > 1 ? `${group.items.length} findings` : group.metric})`);
    const inventoryText = inventoryRisks.length
      ? `${inventoryRisks.length.toLocaleString()} stalled-inventory or weak sell-through flag${inventoryRisks.length===1 ? "" : "s"} need attention.`
      : "No stalled-inventory or weak sell-through issue is currently flagged from the matched warehouse rows.";
    const focusText = attentionItems.length
      ? `The main upkeep focus is ${attentionItems.join(", ")}. ${inventoryText} For the next daily check, compare the newest sales file against these same weak doors and any live activity dates before deciding whether the campaign needs field follow-up, markdown support, or more content coverage.`
      : `There are no red or watch-level campaign issues in this selection. ${inventoryText} The next daily check should confirm that sales pace, activity timing, and inventory movement are still aligned before changing the campaign plan.`;
    if (lang === "ko" && !usesOnlineSales) {
      const liveEventsKo = liveUpcomingEvents.filter(fn => fn.date <= endDate).length;
      const upcomingEventsKo = liveUpcomingEvents.length - liveEventsKo;
      const perfKo = officialInlineTotalsMissing
        ? `${selectedLabel}: ${rangeLabel} 기간과 일치하는 Costco Daily Totals 행이 없어 공식 인라인 매출 수치가 아직 없습니다.`
        : `${selectedLabel}은(는) ${rangeLabel} 동안 인라인 매출 ${fmtCompactMoney(inlineRev)} / ${inlineUnits.toLocaleString()} 유닛을 기록했습니다. ${activeDoors ? `평균 주간 Revenue/Door는 계산 가능한 주간 ${doorStats.weeklyPeriodCount.toLocaleString()}개 기준 ${fmtCompactMoney(revenuePerDoor)}이며, 현재 '${translateLabel("ko", health.label)}' 상태입니다.` : "공식 매출과 검증된 판매 매장이 모두 있는 주간이 없어 Revenue/Door를 계산할 수 없습니다."}`;
      const doorKo = storeRows.length
        ? `웨어하우스 상세 기준으로 선택 기간에 적격 판매 매장이 ${storeRows.length.toLocaleString()}개 있습니다. ${topDoor ? `${topDoor.name}이(가) ${fmtCompactMoney(topDoor.rev)} 매출로 선두입니다${topDoor.share ? ` (추적 웨어하우스 매출의 ${topDoor.share.toFixed(1)}%)` : ""}.` : "이 기간의 매장별 선두 데이터가 아직 없습니다."} 매장당 $1K 이상 강한 매장 ${strongDoors.toLocaleString()}개, $500 이하 약한 매장 ${weakDoors.toLocaleString()}개입니다. 다음 매출 파일에서 뚜렷한 반전이 없다면 하위 매장 관리에 집중하세요.`
        : "선택 기간의 적격 웨어하우스 상세가 없어 강한 매장과 약한 매장을 아직 구분할 수 없습니다. 실재고와 판매 움직임이 있는 매장 단위 행을 업로드하면 일일 관리 판단이 쉬워집니다.";
      const activityKo = `선택한 영상 ${campaignVideos.length.toLocaleString()}개를 확인할 수 있습니다.`;
      const invKo = inventoryRisks.length
        ? `${inventoryRisks.length.toLocaleString()}건의 재고 정체 또는 낮은 sell-through 플래그가 주의가 필요합니다.`
        : "현재 일치하는 웨어하우스 행에서 재고 정체나 낮은 sell-through 이슈가 없습니다.";
      const focusKo = attentionItems.length
        ? `주요 관리 포인트: ${attentionItems.join(", ")}. ${invKo} 다음 일일 점검에서는 최신 매출 파일을 동일한 약한 매장과 진행 중 활동 일정에 비교한 뒤 현장 지원, 마크다운, 콘텐츠 보강 여부를 결정하세요.`
        : `현재 적색 또는 주의 수준의 캠페인 이슈가 없습니다. ${invKo} 다음 일일 점검에서는 캠페인 계획을 바꾸기 전에 매출 페이스, 활동 일정, 재고 움직임이 여전히 정렬되어 있는지 확인하세요.`;
      return [perfKo, doorKo, activityKo, focusKo];
    }
    return [performanceText, doorText, activityText, focusText];
  }, [activeSubtab, lang, product, selectedCampaign, campaignName, dateRange.start, dateRange.end, storeRows, officialInlineTotalsMissing, usesOnlineSales, selectedSalesRev, selectedSalesUnits, onlineUsesOrdersAsUnits, onlineChannelCount, inlineRev, inlineUnits, activeDoors, revenuePerDoor, health.label, campaignVideos.length, campaignEvents.length, liveUpcomingEvents, endDate, recentActivityCount, reportGroups, inventoryRisks.length]);

  const campaignBenchmarkRows = useMemo(() => {
    if (!analysisPlanningMode && activeSubtab !== "analysis" && activeSubtab !== "planning") return [];
    const selectedProductId = campaignPid || selectedCampaign?.pid || "";
    const selectedCampaignId = campaignCid || selectedCampaign?.id || "";
    const campaigns = campaignFilterCatalog(campaignMeta, productMeta)
      .filter(c => c.pid);
    if (!campaigns.length) return [];
    const campaignById = new Map(campaigns.map(camp => [camp.id, camp]));
    const campaignsByProduct = _.mapValues(_.groupBy(campaigns, "pid"), rows => _.sortBy(rows, c => c.start || ""));
    const selectedWindowCampaign = selectedProductId ? _.orderBy(
      (campaignsByProduct[selectedProductId] || []).filter(camp => (!camp.start || camp.start <= dateRange.end) && (!camp.end || camp.end >= dateRange.start)),
      [camp => camp.start || ""],
      ["desc"]
    )[0] : null;
    const focusCampaignId = selectedCampaignId || selectedWindowCampaign?.id || "";
    const campaignIdForBenchmarkRow = row => {
      const explicit = rowCampaignId(row);
      if (explicit && campaignById.has(explicit)) return explicit;
      const pid = productIdForMetricRow(row);
      const date = row.date;
      if (!pid || !date) return "";
      const matches = (campaignsByProduct[pid] || []).filter(camp => campaignMatchesDate(camp, date));
      return matches.length === 1 ? matches[0].id : "";
    };
    const createSummaryMap = () => new Map(campaigns.map(camp => [camp.id, {
      daily:new Map(),
      dates:new Set(),
      rev:0,
      units:0,
      inv:0,
    }]));
    const totalSummaryByCampaign = createSummaryMap();
    const warehouseSummaryByCampaign = createSummaryMap();
    const scanRowsIntoSummaries = (rows, summaries) => {
      rows.forEach(row => {
        const cid = campaignIdForBenchmarkRow(row);
        const camp = campaignById.get(cid);
        if (!camp) return;
        const rowPid = productIdForMetricRow(row);
        if (camp.pid && rowPid !== camp.pid) return;
        const date = String(row.date || "");
        if (!date) return;
        const rev = Number(row.rev || 0);
        const units = Number(row.units || 0);
        const inv = Number(row.inv || 0);
        if (!rev && !units && !inv) return;
        const summary = summaries.get(cid);
        if (!summary) return;
        summary.rev += rev;
        summary.units += units;
        summary.inv += inv;
        summary.dates.add(date);
        const day = summary.daily.get(date) || { date, rev:0, units:0, inv:0 };
        day.rev += rev;
        day.units += units;
        day.inv += inv;
        summary.daily.set(date, day);
      });
    };
    scanRowsIntoSummaries(inlineTotalSales, totalSummaryByCampaign);
    scanRowsIntoSummaries(prodSales, warehouseSummaryByCampaign);
    const summaries = campaigns.map(camp => {
      const totalSummary = totalSummaryByCampaign.get(camp.id) || { daily:new Map(), dates:new Set(), rev:0, units:0, inv:0 };
      const warehouseSummary = warehouseSummaryByCampaign.get(camp.id) || { daily:new Map(), dates:new Set(), rev:0, units:0, inv:0 };
      const totalDateCount = totalSummary.dates.size;
      const warehouseDateCount = warehouseSummary.dates.size;
      const officialTotalsComplete = totalDateCount > 0 && (!warehouseDateCount || totalDateCount >= warehouseDateCount * 0.8);
      const summary = officialTotalsComplete ? totalSummary : warehouseDateCount ? warehouseSummary : totalSummary;
      const dailyMap = summary.daily;
      const dates = _.sortBy([...dailyMap.keys()]);
      const firstDate = dates[0] || camp.start || "";
      const lastDate = dates[dates.length - 1] || camp.end || firstDate;
      const rawDailyRows = dates.map(date => {
        const row = dailyMap.get(date) || { date, rev:0, units:0, inv:0 };
        return {
          date,
          rev:row.rev,
          units:row.units,
          inv:row.inv,
        };
      });
      const firstSalesDate = rawDailyRows.find(row => Number(row.rev || 0) > 0 || Number(row.units || 0) > 0)?.date || "";
      const meaningfulStartDate = meaningfulSalesStartDate(rawDailyRows);
      const analysisStart = meaningfulStartDate || firstSalesDate || firstDate || camp.start || "";
      const campaignStart = camp.start || firstDate;
      const doors = totalWarehousesForProductIds([camp.pid], productMeta);
      const scopedDates = analysisStart ? dates.filter(date => date >= analysisStart) : dates;
      const dailyRows = (scopedDates.length ? scopedDates : dates).map((date, i) => {
        const row = dailyMap.get(date) || { date, rev:0, units:0, inv:0 };
        const day = analysisStart ? Math.max(1, daysBetweenISO(analysisStart, date) + 1) : i + 1;
        return {
          date,
          day,
          rev:row.rev,
          units:row.units,
          inv:row.inv,
        };
      }).sort((a,b) => a.day - b.day || a.date.localeCompare(b.date));
      let cumulativeRev = 0;
      let cumulativeUnits = 0;
      const pacingRows = dailyRows.map(row => {
        cumulativeRev += row.rev;
        cumulativeUnits += row.units;
        return { ...row, cumulativeRev, cumulativeUnits };
      });
      const campaignWarehouseRows = prodSales.filter(row =>
        productValuesMatch(productIdForMetricRow(row), camp.pid, productMeta) &&
        rowMatchesCampaignScopeWithInference(row, camp.id, campaignMeta, productMeta, camp.pid) &&
        (!analysisStart || row.date >= analysisStart) &&
        (!lastDate || row.date <= lastDate)
      );
      const revenueDoorStats = totalRevenueDoorStats(dailyRows, productMeta, [camp.pid], { denominatorRows:campaignWarehouseRows, warehouses:whs, start:analysisStart || firstDate, end:lastDate });
      const sellingDays = dailyRows.filter(r => r.rev > 0 || r.units > 0).length;
      const analysisRev = _.sumBy(dailyRows, "rev");
      const analysisUnits = _.sumBy(dailyRows, "units");
      const first7Rev = _.sumBy(dailyRows.filter(r => r.day <= 7), "rev");
      const first14Rev = _.sumBy(dailyRows.filter(r => r.day <= 14), "rev");
      const first30Rev = _.sumBy(dailyRows.filter(r => r.day <= 30), "rev");
      const peak = _.maxBy(dailyRows, "rev");
      const videoRowsInCampaign = videosWithActivity.filter(v => v.cid === camp.id || (v.pid === camp.pid && v.activityDate && campaignMatchesDate(camp, v.activityDate)));
      const paidVideosInCampaign = videoRowsInCampaign.filter(v => v.type === "Paid").length;
      const seedingVideosInCampaign = videoRowsInCampaign.filter(v => v.type === "Seeding").length;
      const videosInCampaign = videoRowsInCampaign.length;
      const eventsInCampaign = footnotes.filter(fn => rowCampaignId(fn) === camp.id || (fn.pid === camp.pid && fn.date && campaignMatchesDate(camp, fn.date))).length;
      return {
        ...camp,
        productLabel:productLabelForValue(camp.pid, productMeta),
        category:productCategoryFor(camp.pid),
        firstDate,
        firstSalesDate,
        meaningfulStartDate,
        analysisStart,
        campaignStart,
        lastDate,
        elapsedDays:analysisStart && lastDate ? inclusiveDays(analysisStart, lastDate) : firstDate && lastDate ? inclusiveDays(firstDate, lastDate) : 0,
        preSalesDays:campaignStart && analysisStart ? Math.max(0, daysBetweenISO(campaignStart, analysisStart)) : 0,
        sellingDays,
        rev:summary.rev,
        units:summary.units,
        doors,
        verifiedDoors:revenueDoorStats.activeDoors,
        revenuePerDoor:revenueDoorStats.revenuePerDoor,
        weeklyRevenueDoorRows:averageSevenDayRevenueDoorStats(dailyRows, productMeta, [camp.pid], { start:analysisStart || firstDate, end:lastDate, denominatorRows:campaignWarehouseRows, warehouses:whs }).weekly,
        weeklyRevenueDoorPeriodCount:revenueDoorStats.weeklyPeriodCount,
        avgDailyRev:sellingDays ? analysisRev / sellingDays : 0,
        avgDailyUnits:sellingDays ? analysisUnits / sellingDays : 0,
        first7Rev,
        first14Rev,
        first30Rev,
        peakDate:peak?.date || "",
        peakRev:peak?.rev || 0,
        videos:videosInCampaign,
        paidVideos:paidVideosInCampaign,
        seedingVideos:seedingVideosInCampaign,
        events:eventsInCampaign,
        dailyRows,
        pacingRows,
      };
    }).filter(row => row.dailyRows.length || row.rev || row.units);
    let scoped = summaries;
    if (benchmarkMode === "campaigns") {
      const selectedCampaignSet = new Set(activeBenchmarkCampaignIds);
      scoped = selectedCampaignSet.size ? summaries.filter(row => selectedCampaignSet.has(row.id)) : [];
    } else if (benchmarkMode === "products") {
      const selectedProductSet = new Set(activeBenchmarkProductIds);
      scoped = selectedProductSet.size ? summaries.filter(row => selectedProductSet.has(row.pid)) : [];
    } else if (benchmarkMode === "category") {
      scoped = activeBenchmarkCategory ? summaries.filter(row => row.category === activeBenchmarkCategory) : [];
    }
    return scoped.sort((a,b) => productLabelForValue(a.pid, productMeta).localeCompare(productLabelForValue(b.pid, productMeta)) || (a.start || a.firstDate || "").localeCompare(b.start || b.firstDate || ""));
  }, [analysisPlanningMode, activeSubtab, benchmarkMode, activeBenchmarkCampaignIds, activeBenchmarkProductIds, activeBenchmarkCategory, campaignMeta, productMeta, campaignPid, campaignCid, selectedCampaign?.pid, selectedCampaign?.id, dateRange.start, dateRange.end, inlineTotalSales, prodSales, whs, videosWithActivity, footnotes, productCategoryFor]);

  const selectedCampaignStats = useMemo(() => {
    if (campaignCid) {
      const exact = campaignBenchmarkRows.find(c => c.id === campaignCid);
      if (exact) return exact;
    }
    if (campaignPid) {
      return campaignBenchmarkRows.find(c => c.pid === campaignPid && (!c.start || c.start <= dateRange.end) && (!c.end || c.end >= dateRange.start))
        || campaignBenchmarkRows.find(c => c.pid === campaignPid)
        || campaignBenchmarkRows[0]
        || null;
    }
    return campaignBenchmarkRows[0] || null;
  }, [campaignBenchmarkRows, campaignCid, campaignPid, dateRange.start, dateRange.end]);

  const pacingCampaigns = useMemo(() => {
    return selectPacingCampaignRows(campaignBenchmarkRows, {
      baselineCid:selectedCampaignStats?.id || campaignCid,
      baselinePid:campaignPid,
      comparisonCid:pacingCompCid,
      comparisonPid:pacingCompPid,
    });
  }, [campaignBenchmarkRows, selectedCampaignStats, campaignCid, campaignPid, pacingCompCid, pacingCompPid]);

  const pacingChartData = useMemo(() => {
    let maxDay = 0;
    pacingCampaigns.forEach(camp => camp.pacingRows.forEach(row => { if (Number(row.day || 0) > maxDay) maxDay = Number(row.day || 0); }));
    maxDay = Math.min(120, maxDay);
    const positions = new Map();
    const latestValues = new Map();
    return Array.from({ length:maxDay }, (_, i) => {
      const day = i + 1;
      const row = { day, label:`D${day}` };
      pacingCampaigns.forEach(camp => {
        let pos = positions.get(camp.id) || 0;
        while (pos < camp.pacingRows.length && camp.pacingRows[pos].day <= day) {
          latestValues.set(camp.id, camp.pacingRows[pos].cumulativeRev);
          pos++;
        }
        positions.set(camp.id, pos);
        row[camp.id] = latestValues.has(camp.id) ? latestValues.get(camp.id) : null;
      });
      return row;
    });
  }, [pacingCampaigns]);

  const benchmarkSummary = useMemo(() => {
    const peerRows = campaignBenchmarkRows.filter(c => c.id !== selectedCampaignStats?.id);
    const baseline = peerRows.length ? peerRows : campaignBenchmarkRows.filter(c => c.id !== selectedCampaignStats?.id);
    return {
      peerRows,
      baseline,
      avgFirst7:averageValue(baseline.map(c => c.first7Rev)),
      avgFirst14:averageValue(baseline.map(c => c.first14Rev)),
      avgFirst30:averageValue(baseline.map(c => c.first30Rev)),
      avgDailyRev:averageValue(baseline.map(c => c.avgDailyRev)),
      avgRevenuePerDoor:averageValue(baseline.map(c => c.revenuePerDoor)),
      avgVideos:averageValue(baseline.map(c => c.videos)),
      avgPaidVideos:averageValue(baseline.map(c => c.paidVideos)),
      avgSeedingVideos:averageValue(baseline.map(c => c.seedingVideos)),
    };
  }, [campaignBenchmarkRows, selectedCampaignStats]);

  const planningDailyRows = useMemo(() => {
    if (!analysisPlanningMode && activeSubtab !== "planning") return [];
    const salesByDate = new Map(chartData.map((row, i) => [row.date, { ...row, sortIndex:i }]));
    const rawInventoryByDate = new Map();
    warehouseRows.forEach(row => {
      if (!row.date) return;
      const cur = rawInventoryByDate.get(row.date) || { inv:0, known:false };
      cur.inv += Number(row.inv || 0);
      cur.known = cur.known || hasKnownNumber(row.inv) || Number(row.inv || 0) > 0;
      rawInventoryByDate.set(row.date, cur);
    });
    const inlineInventoryByDate = new Map(inventoryData.map(row => [row.date, { inv:Number(row.inline || 0), known:!!row.inlineKnown }]));
    const dates = _.sortBy([...new Set([
      ...salesByDate.keys(),
      ...rawInventoryByDate.keys(),
      ...inlineInventoryByDate.keys(),
    ])].filter(Boolean));
    const firstSalesDate = _.sortBy([...salesByDate.values()]
      .filter(row => Number(row.rev || row.inline || 0) > 0 || Number(row.units || 0) > 0)
      .map(row => row.date)
      .filter(Boolean))[0] || "";
    const planningStart = selectedCampaignStats?.analysisStart || selectedCampaignStats?.firstSalesDate || firstSalesDate || dateRange.start || dates[0] || "";
    const scopedDates = planningStart ? dates.filter(date => date >= planningStart) : dates;
    return (scopedDates.length ? scopedDates : dates).map((date, i) => {
      const sale = salesByDate.get(date) || {};
      const rawInv = rawInventoryByDate.get(date);
      const inlineInv = inlineInventoryByDate.get(date);
      const invKnown = !!rawInv?.known || !!inlineInv?.known;
      const inv = rawInv?.known ? rawInv.inv : inlineInv?.known ? inlineInv.inv : undefined;
      return {
        ...sale,
        date,
        label:salesTrendDateLabel(date),
        day:planningStart ? Math.max(1, daysBetweenISO(planningStart, date) + 1) : i + 1,
        rev:Number(sale.rev || sale.inline || 0),
        units:Number(sale.units || 0),
        inv,
        invKnown,
      };
    });
  }, [analysisPlanningMode, activeSubtab, chartData, warehouseRows, inventoryData, selectedCampaignStats?.analysisStart, selectedCampaignStats?.firstSalesDate, dateRange.start]);

  const planningStats = useMemo(() => {
    if (!analysisPlanningMode && activeSubtab !== "planning") return EMPTY_CAMPAIGN_PLANNING_STATS;
    const dailyRows = planningDailyRows.length
      ? planningDailyRows
      : selectedCampaignStats?.dailyRows?.length
        ? selectedCampaignStats.dailyRows.map(row => ({ ...row, invKnown:hasKnownNumber(row.inv) }))
        : chartData.map((row, i) => ({ ...row, day:i + 1, invKnown:false }));
    const latest = dailyRows[dailyRows.length - 1] || {};
    const recentRows = dailyRows.slice(-14);
    const observedDays = Math.max(1, dailyRows.filter(r => Number(r.rev || 0) > 0 || Number(r.units || 0) > 0).length);
    const currentAvgDailyRevenue = _.sumBy(dailyRows, "rev") / observedDays;
    const avgDailyRevenue = planningDailyRows.length ? currentAvgDailyRevenue : selectedCampaignStats?.avgDailyRev || currentAvgDailyRevenue;
    const recentDailyUnits = recentRows.length ? _.sumBy(recentRows, "units") / recentRows.length : 0;
    const fallbackDailyUnits = observedDays ? _.sumBy(dailyRows, "units") / observedDays : 0;
    const velocityUnits = recentDailyUnits > 0 ? recentDailyUnits : fallbackDailyUnits;
    const latestInlineInventory = inventoryData[inventoryData.length - 1];
    const latestInventoryRaw = latest.invKnown && hasKnownNumber(latest.inv)
      ? latest.inv
      : latestInlineInventory?.inlineKnown && hasKnownNumber(latestInlineInventory.inline)
        ? latestInlineInventory.inline
        : "";
    const latestInventoryKnown = hasKnownNumber(latestInventoryRaw);
    const latestInventory = latestInventoryKnown ? Number(latestInventoryRaw) : 0;
    const discountDates = new Set(campaignEvents.filter(fn => ["tpd","markdown","promo"].includes(fn.type)).map(fn => fn.date).filter(Boolean));
    const fullPriceRows = metricRows.filter(row =>
      Number(row.rev || 0) > 0 &&
      Number(row.units || 0) > 0 &&
      Number(row.promo || 0) <= 0 &&
      Number(row.refund || 0) >= 0 &&
      !discountDates.has(row.date)
    );
    const fallbackPriceRows = metricRows.filter(row => Number(row.rev || 0) > 0 && Number(row.units || 0) > 0);
    const priceRows = fullPriceRows.length ? fullPriceRows : fallbackPriceRows;
    const priceUnits = _.sumBy(priceRows, row => Math.max(0, Number(row.units || 0)));
    const fullPriceUnitPrice = priceUnits > 0 ? _.sumBy(priceRows, row => Math.max(0, Number(row.rev || 0))) / priceUnits : 0;
    const inventorySalesTarget = latestInventoryKnown && fullPriceUnitPrice > 0 ? latestInventory * 0.7 * fullPriceUnitPrice : 0;
    const daysToSellout = latestInventoryKnown
      ? latestInventory <= 0 ? 0 : velocityUnits > 0 ? latestInventory / velocityUnits : null
      : null;
    const targetDays = selectedCampaign?.start && selectedCampaign?.end
      ? Math.max(1, inclusiveDays(selectedCampaign.start, selectedCampaign.end))
      : Math.max(90, selectedCampaignStats?.elapsedDays || 90);
    const projected30 = avgDailyRevenue * 30;
    const projectedFull = avgDailyRevenue * targetDays;
    const sellThroughReviewDate = daysToSellout === null
      ? ""
      : daysToSellout <= 45 ? endDate : offsetDate(endDate, Math.max(0, Math.round(daysToSellout - 45)));
    return {
      latestDate:latest.date || endDate,
      observedDays,
      avgDailyRevenue,
      recentDailyUnits,
      velocityUnits,
      latestInventory,
      latestInventoryKnown,
      fullPriceUnitPrice,
      inventorySalesTarget,
      daysToSellout,
      targetDays,
      projected30,
      projectedFull,
      sellThroughReviewDate,
    };
  }, [analysisPlanningMode, activeSubtab, planningDailyRows, selectedCampaignStats, chartData, inventoryData, selectedCampaign, endDate, campaignEvents, metricRows]);

  const planningActions = useMemo(() => {
    if (!analysisPlanningMode && activeSubtab !== "planning") return [];
    const actions = [];
    const projectedVsBenchmark = benchmarkSummary.avgFirst30 ? pctChange(planningStats.projected30, benchmarkSummary.avgFirst30) : null;
    const ko = lang === "ko";
    if (planningStats.daysToSellout !== null) {
      actions.push({
        title:planningStats.daysToSellout <= 45 ? (ko ? "Sell-through 성공" : "Sell-through success") : (ko ? "Sell-through 주의" : "Sell-through watch"),
        metric:ko ? `현재 판매 속도 기준 재고 ${Math.round(planningStats.daysToSellout).toLocaleString()}일분` : `${Math.round(planningStats.daysToSellout).toLocaleString()} days of inventory at current velocity`,
        action:planningStats.daysToSellout <= 45
          ? (ko ? "강한 sell-through 성과로 보세요. Costco 바이어가 확정하기 전에는 추가 재고 매입을 계획하지 마세요." : "Treat this as a strong sell-through outcome. Do not plan another inventory buy unless the Costco buyer confirms it.")
          : (ko ? `${planningStats.sellThroughReviewDate || "다음 계획 점검"}까지 sell-through 페이스를 매출 관점에서만 검토하세요.` : `Review sell-through pace by ${planningStats.sellThroughReviewDate || "the next planning check"} as a sales readout only.`),
        col:planningStats.daysToSellout <= 45 ? C.green : planningStats.daysToSellout <= 75 ? C.warn : C.green,
      });
    } else {
      actions.push({ title:ko ? "재고 판독 불가" : "Inventory read unavailable", metric:ko ? "사용 가능한 재고 또는 최근 유닛 속도 없음" : "No usable inventory or recent unit velocity", action:ko ? "일별 합계와 재고 스냅샷을 채워야 sell-through를 정확히 읽을 수 있습니다." : "Keep daily totals and inventory snapshots populated so sell-through can be read accurately.", col:C.blue });
    }
    actions.push({
      title:ko ? "30일 매출 예상" : "30-day sales projection",
      metric:benchmarkSummary.avgFirst30 ? `${fmtCompactMoney(planningStats.projected30)} / ${fmtGrowth(projectedVsBenchmark)} ${ko ? "vs 피어 30일 평균" : "vs peer 30-day avg"}` : (ko ? `현재 페이스 기준 ${fmtCompactMoney(planningStats.projected30)} 예상` : `${fmtCompactMoney(planningStats.projected30)} projected from current pace`),
      action:projectedVsBenchmark !== null && projectedVsBenchmark < -15 ? (ko ? "콘텐츠, TPD, 매장 개선으로 상승이 보일 때까지 페이스가 뒤처진 것으로 간주하세요." : "Treat this as behind pace until content, TPD, or warehouse fixes show lift.") : (ko ? "다음 Costco 리드아웃의 실시간 계획 목표로 사용하세요." : "Use this as the live planning target for the next Costco readout."),
      col:projectedVsBenchmark !== null && projectedVsBenchmark < -15 ? C.red : projectedVsBenchmark !== null && projectedVsBenchmark > 15 ? C.green : C.warn,
    });
    const hasVideoBenchmark = !!benchmarkSummary.baseline.length;
    const paidTarget = benchmarkSummary.avgPaidVideos || 0;
    const seedingTarget = benchmarkSummary.avgSeedingVideos || 0;
    const paidBehind = hasVideoBenchmark && campaignVideoMix.paid < paidTarget;
    const seedingBehind = hasVideoBenchmark && campaignVideoMix.seeding < seedingTarget;
    const contentAction = paidBehind && seedingBehind
      ? (ko ? "유료와 시딩 커버리지를 모두 늘린 뒤 다음 매출 수치가 움직이는지 확인하세요." : "Increase both paid and seeding coverage, then check whether the next sales read starts to move.")
      : paidBehind
        ? (ko ? "유료 크리에이터 커버리지가 벤치마크보다 낮습니다. 통제된 도달이 필요한 경우에만 유료 게시를 추가하세요." : "Paid creator coverage is below the benchmark; add paid posts only if the campaign needs controlled reach.")
        : seedingBehind
          ? (ko ? "시딩 커버리지가 벤치마크보다 낮습니다. 유료 영상 수와 같은 목표로 취급하지 말고 시딩을 확대하세요." : "Seeding coverage is below the benchmark; expand seeding without treating paid video count as the same target.")
          : (ko ? "유료/시딩 콘텐츠 묶음 이후의 매출 움직임을 계속 측정하세요." : "Keep measuring sales movement after each paid or seeding content cluster.");
    actions.push({
      title:ko ? "콘텐츠 지원" : "Content support",
      metric:hasVideoBenchmark
        ? (ko ? `유료 ${campaignVideoMix.paid.toLocaleString()} / 평균 ${paidTarget.toFixed(1)}; 시딩 ${campaignVideoMix.seeding.toLocaleString()} / 평균 ${seedingTarget.toFixed(1)}` : `Paid ${campaignVideoMix.paid.toLocaleString()} / ${paidTarget.toFixed(1)} avg; Seeding ${campaignVideoMix.seeding.toLocaleString()} / ${seedingTarget.toFixed(1)} avg`)
        : (ko ? `기간 내 유료 ${campaignVideoMix.paid.toLocaleString()}; 시딩 ${campaignVideoMix.seeding.toLocaleString()}` : `Paid ${campaignVideoMix.paid.toLocaleString()}; Seeding ${campaignVideoMix.seeding.toLocaleString()} in range`),
      action:contentAction,
      col:paidBehind || seedingBehind ? C.warn : C.green,
    });
    const weakDoors = storeRows.filter(r => r.revenuePerDoor <= 500).length;
    const strongDoors = storeRows.filter(r => r.revenuePerDoor >= 1000).length;
    actions.push({
      title:ko ? "매장 실행" : "Door execution",
      metric:ko ? `강한 매장 ${strongDoors} / 약한 매장 ${weakDoors}` : `${strongDoors} strong / ${weakDoors} weak doors`,
      action:weakDoors > strongDoors ? (ko ? "같은 캠페인 플레이북을 확장하기 전에 하위 매장 후속 조치를 우선하세요." : "Prioritize bottom-door follow-up before scaling the same campaign playbook.") : (ko ? "가장 강한 매장을 향후 캠페인의 현장 벤치마크로 사용하세요." : "Use strongest doors as the field benchmark for future campaigns."),
      col:weakDoors > strongDoors ? C.red : C.green,
    });
    return actions;
  }, [analysisPlanningMode, activeSubtab, lang, planningStats, benchmarkSummary, campaignVideoMix, storeRows]);
  const inlineSalesColor = selectedCampaign?.col || product?.col || C.green;
  const inlineUnitsColor = C.blue;
  const selectedSalesColor = usesOnlineSales ? C.blue : inlineSalesColor;
  const selectedUnitsColor = usesOnlineSales ? C.accent : inlineUnitsColor;
  const sourceReadLabel = usesOnlineSales
    ? (lang === "ko" ? "온라인 판매 데이터" : "Online sales data")
    : officialInlineTotalsMissing
      ? (lang === "ko" ? "Costco Daily Totals 누락" : "Costco Daily Totals missing")
      : "Costco Daily Totals";

  const priorRangeDays = Math.max(1, inclusiveDays(dateRange.start, dateRange.end));
  const priorDateRange = {
    start:offsetDate(dateRange.start, -priorRangeDays),
    end:offsetDate(dateRange.start, -1),
  };
  const hasDedicatedComparison = !!(
    comparisonData?.range?.start === priorDateRange.start &&
    comparisonData?.range?.end === priorDateRange.end
  );
  const priorInlineSourceRows = hasDedicatedComparison ? (comparisonData.inlineTotalSales || []) : inlineTotalSales;
  const priorOnlineSourceRows = hasDedicatedComparison ? (comparisonData.onlineSales || []) : onlineSales;
  const priorWarehouseSourceRows = hasDedicatedComparison ? (comparisonData.prodSales?.length ? comparisonData.prodSales : comparisonData.sales || []) : warehouseDenominatorSourceRows;
  const priorInlineRows = useMemo(() => {
    if (!showOverviewView) return [];
    return priorInlineSourceRows.map(r => ({ ...r, sourceType:"Inline" }))
      .filter(r => r.date >= priorDateRange.start && r.date <= priorDateRange.end && (!campaignPid || productValuesMatch(r.pid, campaignPid, productMeta)) && rowInCampaign(r));
  }, [showOverviewView, priorInlineSourceRows, priorDateRange.start, priorDateRange.end, campaignPid, rowInCampaign]);
  const priorOnlineRows = useMemo(() => {
    if (!showOverviewView) return [];
    return priorOnlineSourceRows.map(r => ({ ...r, sourceType:"Online" }))
      .filter(r => r.date >= priorDateRange.start && r.date <= priorDateRange.end && (!campaignPid || productValuesMatch(r.pid, campaignPid, productMeta)) && rowInCampaign(r));
  }, [showOverviewView, priorOnlineSourceRows, priorDateRange.start, priorDateRange.end, campaignPid, rowInCampaign]);
  const priorMetricRows = usesOnlineSales ? priorOnlineRows : priorInlineRows;
  const hasEligiblePriorData = priorMetricRows.length > 0;
  const priorRev = _.sumBy(priorMetricRows, r => Number(r.rev || 0));
  const priorOrders = _.sumBy(priorMetricRows, r => Number(r.orders || 0));
  const priorUnitsRaw = _.sumBy(priorMetricRows, r => Number(r.units || 0));
  const priorUnits = usesOnlineSales && priorUnitsRaw <= 0 && priorOrders > 0 ? priorOrders : priorUnitsRaw;
  const priorWarehouseRows = useMemo(() => {
    if (!showOverviewView) return [];
    return priorWarehouseSourceRows.filter(r => r.date >= priorDateRange.start && r.date <= priorDateRange.end && (!campaignPid || productValuesMatch(r.pid, campaignPid, productMeta)) && rowInCampaign(r));
  }, [showOverviewView, priorWarehouseSourceRows, priorDateRange.start, priorDateRange.end, campaignPid, rowInCampaign]);
  const priorDoorStats = useMemo(() => {
    if (!showOverviewView) return EMPTY_REVENUE_DOOR_STATS;
    return totalRevenueDoorStats(priorInlineRows, productMeta, revenueDoorProductIds, { denominatorRows:priorWarehouseRows, warehouses:whs, start:priorDateRange.start, end:priorDateRange.end });
  }, [showOverviewView, priorInlineRows, priorWarehouseRows, whs, productMeta, revenueDoorProductIds, priorDateRange.start, priorDateRange.end]);
  const comparisonText = (current, prior, zeroPriorLabel = "0") => {
    const state = comparisonValueState(current, prior, { hasEligiblePriorData });
    if (state.kind === "insufficient-history") return lang === "ko" ? "\uC774\uC804 \uAE30\uAC04 \uB370\uC774\uD130 \uBD80\uC871" : "Insufficient prior-period history";
    if (state.kind === "no-current") return lang === "ko" ? "\uD604\uC7AC \uAC12 \uC5C6\uC74C" : "No current value";
    if (state.kind === "zero-prior") return lang === "ko" ? `\uC774\uC804 \uAE30\uAC04 ${zeroPriorLabel}` : `Prior period ${zeroPriorLabel}`;
    if (state.kind === "nonpositive-prior") return lang === "ko" ? "\uC774\uC804 \uAE30\uAC04 \uAC12\uC774 0 \uC774\uD558" : "Prior period was non-positive";
    return lang === "ko"
      ? `${fmtGrowth(state.percent)} \uC774\uC804 \uAE30\uAC04 \uB300\uBE44`
      : `${fmtGrowth(state.percent)} vs prior`;
  };
  const priorMoneyText = fmtCompactMoney(priorRev);
  const priorUnitsText = priorUnits.toLocaleString();
  const priorDoorDelta = comparisonText(revenuePerDoor, priorDoorStats.revenuePerDoor, priorRev === 0 ? "$0 sales" : "$0");
  const comparisonRailItems = !showOverviewView ? [] : usesOnlineSales ? [
    { label:"Online Sales", current:fmtCompactMoney(selectedSalesRev), comparison:hasEligiblePriorData ? { prior:priorMoneyText, delta:comparisonText(selectedSalesRev, priorRev, "$0") } : null, color:selectedSalesColor },
    { label:unitSeriesLabel, current:selectedSalesUnits.toLocaleString(), comparison:hasEligiblePriorData ? { prior:priorUnitsText, delta:comparisonText(selectedSalesUnits, priorUnits, "0") } : null, color:selectedUnitsColor },
    { label:"Videos", current:campaignVideos.length.toLocaleString(), detail:`${campaignVideoMix.paid} paid / ${campaignVideoMix.seeding} seeding`, color:C.blue },
    { label:"Paid Media", current:campaignPpcTotals.sourceRows.toLocaleString(), detail:campaignPpcTotals.totalSpend ? `${fmtCompactMoney(campaignPpcTotals.totalSpend)} spend` : "Context only", color:C.muted },
  ] : [
    { label:"Inline Sales", current:officialInlineTotalsMissing ? t("common.missing", "Missing") : fmtCompactMoney(inlineRev), comparison:!officialInlineTotalsMissing && hasEligiblePriorData ? { prior:priorMoneyText, delta:comparisonText(inlineRev, priorRev, "$0") } : null, detail:officialInlineTotalsMissing ? "Current missing" : null, color:officialInlineTotalsMissing ? C.muted : selectedSalesColor },
    { label:"Inline Units", current:officialInlineTotalsMissing ? t("common.missing", "Missing") : inlineUnits.toLocaleString(), comparison:!officialInlineTotalsMissing && hasEligiblePriorData ? { prior:priorUnitsText, delta:comparisonText(inlineUnits, priorUnits, "0") } : null, detail:officialInlineTotalsMissing ? "Current missing" : null, color:officialInlineTotalsMissing ? C.muted : selectedUnitsColor },
    { label:"Revenue / Door", current:officialInlineTotalsMissing ? t("common.missing", "Missing") : activeDoors ? fmtCompactMoney(revenuePerDoor) : t("common.notAvailable", "N/A"), comparison:!officialInlineTotalsMissing && activeDoors && hasEligiblePriorData && priorDoorStats.activeDoors ? { prior:fmtCompactMoney(priorDoorStats.revenuePerDoor), delta:priorDoorDelta } : null, detail:officialInlineTotalsMissing ? "Current missing" : !activeDoors ? "No verified weekly periods" : null, color:officialInlineTotalsMissing ? C.muted : health.col },
    { label:"Videos", current:campaignVideos.length.toLocaleString(), detail:`${campaignVideoMix.paid} paid / ${campaignVideoMix.seeding} seeding`, color:C.blue },
  ];
  const kpis = usesOnlineSales ? [
    { label:"Online Sales", val:fmtCompactMoney(selectedSalesRev), exact:fmtCurrency(selectedSalesRev), c:selectedSalesColor },
    { label:unitSeriesLabel, val:selectedSalesUnits.toLocaleString(), c:selectedUnitsColor },
    { label:"Online Channels", val:onlineChannelCount ? onlineChannelCount.toLocaleString() : t("common.notAvailable", "N/A"), c:C.text },
    { label:"Revenue / Door", val:t("common.notAvailable", "N/A"), sub:uiLabel("Inline-only metric"), c:C.muted },
  ] : [
    { label:"Inline Sales", val:officialInlineTotalsMissing ? t("common.missing", "Missing") : fmtCompactMoney(inlineRev), exact:officialInlineTotalsMissing ? "" : fmtCurrency(inlineRev), c:officialInlineTotalsMissing ? C.muted : selectedCampaign?.col || product?.col || C.green },
    { label:"Inline Units", val:officialInlineTotalsMissing ? t("common.missing", "Missing") : inlineUnits.toLocaleString(), c:officialInlineTotalsMissing ? C.muted : C.blue },
    { label:"Total Warehouses", val:totalWarehouses ? totalWarehouses.toLocaleString() : t("common.notAvailable", "N/A"), c:C.text },
    { label:"Revenue / Door", val:officialInlineTotalsMissing ? t("common.missing", "Missing") : activeDoors ? fmtCompactMoney(revenuePerDoor) : t("common.notAvailable", "N/A"), exact:officialInlineTotalsMissing || !activeDoors ? "" : fmtCurrency(revenuePerDoor), sub:activeDoors ? `Average of ${doorStats.weeklyPeriodCount.toLocaleString()} weekly period${doorStats.weeklyPeriodCount===1 ? "" : "s"}` : "", c:officialInlineTotalsMissing ? C.muted : health.col },
  ];
  const renderReportGroups = compact => (
    <div style={{ display:"flex", flexDirection:"column", gap:compact ? 8 : 9 }}>
      {reportGroups.map(group => {
        const expanded = !!expandedReportGroups[group.key];
        const count = group.items.length;
        const metric = count > 1 ? `${count.toLocaleString()} findings` : group.metric;
        const severityLabel = reportSeverityLabel(group);
        return (
          <div key={group.key} style={{ border:`1px solid ${C.border}`, borderLeft:`${compact ? 3 : 4}px solid ${group.col}`, background:C.bg, borderRadius:compact ? 7 : 8, padding:compact ? "8px 9px" : "11px 12px" }}>
            <div style={{ display:"grid", gridTemplateColumns:compact ? "minmax(0,1fr) auto" : "92px minmax(0,1fr) auto", gap:compact ? 8 : 12, alignItems:"start" }}>
              {!compact && <div style={{ ...MONO, fontSize:10, color:group.col, textTransform:"uppercase", letterSpacing:1 }}>{severityLabel}</div>}
              <div style={{ minWidth:0 }}>
                <div style={{ display:"flex", justifyContent:"space-between", gap:12, alignItems:"baseline", marginBottom:4, flexWrap:"wrap" }}>
                  <div style={{ fontSize:compact ? 11 : 13, color:C.text, fontWeight:500 }}>{group.title}</div>
                  <div style={{ ...MONO, fontSize:compact ? 9 : 10, color:group.col }}>{metric}</div>
                </div>
                {!compact && <div style={{ fontSize:11, color:C.muted, lineHeight:1.55 }}>{group.action}</div>}
              </div>
              {count > 1 && (
                <button onClick={() => setExpandedReportGroups(prev => ({ ...prev, [group.key]:!prev[group.key] }))} style={{ padding:compact ? "3px 7px" : "5px 9px", borderRadius:6, border:`1px solid ${group.col}44`, background:`${group.col}12`, color:group.col, cursor:"pointer", fontSize:compact ? 9 : 10, ...SANS, fontWeight:500, whiteSpace:"nowrap" }}>
                  {expanded ? t("common.collapse", "Collapse") : t("common.expand", "Expand")}
                </button>
              )}
            </div>
            {expanded && (
              <div style={{ marginTop:9, paddingTop:9, borderTop:`1px solid ${C.border}`, display:"flex", flexDirection:"column", gap:6 }}>
                {group.items.map((item, i) => (
                  <div key={`${group.key}-${i}`} style={{ display:"flex", justifyContent:"space-between", gap:10, color:C.muted, fontSize:10, lineHeight:1.45 }}>
                    <span style={{ color:C.text, overflow:"hidden", textOverflow:"ellipsis" }}>{item.metric}</span>
                    <span style={{ ...MONO, color:item.col, textTransform:"uppercase", flexShrink:0 }}>{reportSeverityLabel(item)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
  return (
    <>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12, marginBottom:14, flexWrap:"wrap" }}>
        <div>
          <div style={{ ...MONO, fontSize:10, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:4 }}>{analysisPlanningMode ? (lang === "ko" ? "캠페인 분석 및 계획" : "Campaign Analysis & Planning") : (lang === "ko" ? "캠페인 커맨드 센터" : "Campaign Command Center")}</div>
          <div style={{ fontSize:22, color:C.text, fontWeight:500, lineHeight:1.15 }}>{campaignName}</div>
        </div>
        {!analysisPlanningMode && (
          <div style={{ display:"flex", gap:6, background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:4 }}>
            {[["overview",lang === "ko" ? "개요" : "Overview"],["report",lang === "ko" ? "리포트" : "Report"]].map(([key,label]) => (
              <button key={key} onClick={() => setSubtab(key)} style={{ padding:"7px 14px", borderRadius:6, border:`1px solid ${activeSubtab===key?C.border:"transparent"}`, background:activeSubtab===key?C.bg:"transparent", color:activeSubtab===key?C.text:C.muted, cursor:"pointer", fontSize:12, ...SANS, fontWeight:500 }}>{label}</button>
            ))}
          </div>
        )}
      </div>

      {!showOverviewView && <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:10, marginBottom:14 }} className="bi-kpi-grid">
        {kpis.map(k => (
          <KpiCard key={k.label} label={k.label} value={k.val} sub={k.ppc ? t("common.paidMedia", "Paid media") : k.sub} color={k.c} exact={k.exact}
            style={k.ppc ? { borderTop:`3px solid ${C.blue}55` } : {}}/>
        ))}
      </div>}


      {showReportView ? (
        <Panel title={`Campaign Report / ${campaignName}`}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10, marginBottom:14, flexWrap:"wrap" }}>
            <div style={{ fontSize:10, color:C.muted }}>
              {dateRange.start} to {dateRange.end} / {sourceReadLabel}
            </div>
            <div style={{ ...MONO, fontSize:10, color:usesOnlineSales ? C.blue : health.col, textTransform:"uppercase", letterSpacing:1 }}>
              {usesOnlineSales ? uiLabel("Online-only") : activeDoors ? health.label : uiLabel("No verified weekly periods")}
            </div>
          </div>
          <div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:"16px 18px" }}>
            {reportParagraphs.map((paragraph, i) => (
              <p key={i} style={{ margin:i === 0 ? "0 0 13px" : i === reportParagraphs.length - 1 ? "0" : "0 0 13px", color:C.text, fontSize:13, lineHeight:1.75 }}>
                {paragraph}
              </p>
            ))}
          </div>
        </Panel>
      ) : (
        <>
          {showAnalysisView && (
            <>
          <div className="bi-two-col" style={{ display:"grid", gridTemplateColumns:"minmax(0,1.2fr) minmax(320px,0.8fr)", gap:14, marginBottom:14 }}>
            <Panel title="Campaign Pacing Comparison" style={{ marginBottom:0 }}>
              {pacingChartData.length ? (
                <>
                  <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginBottom:10, maxHeight:benchmarkMode === "all" ? 76 : "none", overflowY:benchmarkMode === "all" ? "auto" : "visible", paddingRight:2 }}>
                    {pacingCampaigns.map(camp => (
                      <div key={camp.id} style={{ display:"flex", alignItems:"center", gap:6, fontSize:10, color:C.muted }}>
                        <span style={{ width:18, height:3, borderRadius:3, background:camp.col }}/>
                        <span style={{ color:C.text, fontWeight:500 }}>{camp.short}{camp.id === selectedCampaignStats?.id ? " (baseline)" : ""}</span>
                      </div>
                    ))}
                  </div>
                  {(() => {
                    const dateToDay = new Map((selectedCampaignStats?.pacingRows || []).map(r => [r.date, r.day]));
                    const pacingEventLines = campaignEvents
                      .filter(fn => fn.date && dateToDay.has(fn.date))
                      .map(fn => ({ label:`D${dateToDay.get(fn.date)}`, type:fn.type, col:FN_TYPES[fn.type]?.col || selectedCampaignStats?.col || C.accent }));
                    return (
                  <ResponsiveContainer width="100%" height={310}>
                    <LineChart data={pacingChartData} margin={{ top:8, right:12, bottom:6, left:4 }}>
                      <CartesianGrid stroke={C.border} strokeDasharray="2 5" vertical={false}/>
                      <XAxis dataKey="label" tick={{ fontSize:10, fill:C.muted, fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif" }} axisLine={false} tickLine={false} interval="preserveStartEnd"/>
                      <YAxis width={52} tick={{ fontSize:10, fill:C.muted, fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif" }} axisLine={false} tickLine={false} tickFormatter={fmtCompactMoney}/>
                      <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
                        <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:"9px 11px", fontSize:11, minWidth:210, boxShadow:"0 14px 34px rgba(15,23,42,0.12)" }}>
                          <div style={{ ...MONO, color:C.muted, fontSize:10, marginBottom:7 }}>{label}</div>
                          {payload.filter(p => p.value !== null).map(p => {
                            const camp = pacingCampaigns.find(c => c.id === p.dataKey);
                            return (
                              <div key={p.dataKey} style={{ display:"flex", justifyContent:"space-between", gap:16, marginBottom:5 }}>
                                <span style={{ color:camp?.col || C.muted }}>{camp?.short || p.name}</span>
                                <span style={{ ...MONO, color:C.text, fontWeight:500 }}>{fmtCompactMoney(p.value)}</span>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}/>
                      {pacingEventLines.map((evLine, i) => (
                        <ReferenceLine key={i} x={evLine.label} stroke={evLine.col} strokeDasharray="4 3" strokeWidth={1.5}
                          label={{ value:FN_TYPES[evLine.type]?.short || evLine.type, position:"insideTopLeft", fontSize:9, fill:evLine.col, fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif" }}
                        />
                      ))}
                      {pacingCampaigns.map((camp, i) => (
                        <Line key={camp.id} type="monotone" dataKey={camp.id} name={camp.short} stroke={camp.col} strokeWidth={camp.id === selectedCampaignStats?.id ? 3 : pacingCampaigns.length > 8 ? 1.5 : 2} dot={false} opacity={camp.id === selectedCampaignStats?.id ? 1 : pacingCampaigns.length > 8 ? 0.58 : i === 0 ? 1 : 0.72}/>
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                    );
                  })()}
                </>
              ) : (
                <div style={{ textAlign:"center", padding:"34px 0", color:C.muted, fontSize:11 }}>{lang==="ko"?"페이싱을 비교하려면 매출 기록이 있는 캠페인을 선택하세요.":"Select a campaign with sales history to compare pacing."}</div>
              )}
            </Panel>

            <Panel title="Pace Snapshot" style={{ marginBottom:0 }}>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(2,minmax(0,1fr))", gap:9, marginBottom:12 }}>
                {[
                  { label:"Observed Days", val:selectedCampaignStats?.elapsedDays ? selectedCampaignStats.elapsedDays.toLocaleString() : "N/A", c:C.text },
                  { label:"Avg Daily Sales", val:fmtCompactMoney(selectedCampaignStats?.avgDailyRev || 0), c:inlineSalesColor },
                  { label:"First 14 Days", val:fmtCompactMoney(selectedCampaignStats?.first14Rev || 0), sub:benchmarkSummary.avgFirst14 ? `${fmtGrowth(pctChange(selectedCampaignStats?.first14Rev || 0, benchmarkSummary.avgFirst14))} vs peer avg` : "first 14 active-sales days", c:benchmarkSummary.avgFirst14 && (selectedCampaignStats?.first14Rev || 0) < benchmarkSummary.avgFirst14 ? C.red : C.green },
                  { label:"Revenue / Door", val:selectedCampaignStats?.verifiedDoors ? fmtCompactMoney(selectedCampaignStats.revenuePerDoor) : "N/A", sub:selectedCampaignStats?.verifiedDoors ? `Average of ${selectedCampaignStats.weeklyRevenueDoorPeriodCount || 0} weekly periods` : "", c:campaignHealth(selectedCampaignStats?.revenuePerDoor || 0, selectedCampaignStats?.verifiedDoors || 0).col },
                ].map(card => (
                  <div key={card.label} style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 11px", minWidth:0 }}>
                    <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>{uiLabel(card.label)}</div>
                    <div style={{ ...MONO, fontSize:17, fontWeight:500, color:card.c, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{card.val}</div>
                    <div style={{ fontSize:10, color:C.muted, marginTop:3, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{card.sub}</div>
                  </div>
                ))}
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
                {campaignBenchmarkRows.slice(0, 6).map(row => (
                  <div key={row.id} style={{ display:"grid", gridTemplateColumns:"minmax(0,1fr) 92px 92px", gap:8, alignItems:"center", background:C.bg, border:`1px solid ${C.border}`, borderLeft:`3px solid ${row.col}`, borderRadius:7, padding:"8px 9px" }}>
                    <div style={{ minWidth:0 }}>
                      <div style={{ color:C.text, fontWeight:500, fontSize:11, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{row.short}</div>
                      <div style={{ color:C.muted, fontSize:10, marginTop:2 }}>{row.firstDate || "No date"} to {row.lastDate || "No date"}</div>
                    </div>
                    <div style={{ ...MONO, color:row.col, fontSize:11, fontWeight:500, textAlign:"right" }}>{fmtCompactMoney(row.rev)}</div>
                    <div style={{ ...MONO, color:C.text, fontSize:11, textAlign:"right" }}>{fmtCompactMoney(row.avgDailyRev)}/day</div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>

            </>
          )}
          {showPlanningView && (
            <>
          <Panel title="Planning Actions">
              <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
                {planningActions.map(item => (
                  <div key={item.title} className="bi-planning-action" style={{ border:`1px solid ${C.border}`, borderLeft:`4px solid ${item.col}`, background:C.bg, borderRadius:8, padding:"12px 13px" }}>
                    <div style={{ minWidth:0 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:7, color:C.text, fontWeight:500, fontSize:13, marginBottom:5 }}>
                        <span aria-hidden="true" style={{ width:7, height:7, borderRadius:"50%", background:item.col, flexShrink:0 }}/>
                        {item.title}
                      </div>
                      <div style={{ color:C.muted, fontSize:11, lineHeight:1.55 }}>{item.action}</div>
                    </div>
                    <div className="bi-planning-outcome" style={{ border:`1px solid ${item.col}38`, background:`${item.col}0D` }}>
                      <div style={{ ...MONO, color:C.muted, fontSize:9, textTransform:"uppercase", letterSpacing:1 }}>{lang === "ko" ? "결과" : "Outcome"}</div>
                      <div style={{ ...MONO, color:item.col, fontSize:14, lineHeight:1.35, fontWeight:600 }}>{item.metric}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
            </>
          )}
          {showOverviewView && (
            <>
          <div className="bi-two-col" style={{ display:"grid", gridTemplateColumns:"minmax(0,1fr) 280px", gap:14, marginBottom:14 }}>
            <Panel title={salesTrendTitle} style={{ marginBottom:0 }}>
              {chartData.length ? (
                <>
                  <div style={{ display:"flex", justifyContent:"space-between", gap:10, alignItems:"center", flexWrap:"wrap", margin:"0 0 10px" }}>
                    <div style={{ display:"flex", gap:12, flexWrap:"wrap", alignItems:"center" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:10, color:C.text }}>
                        <span style={{ width:18, height:3, borderRadius:3, background:selectedSalesColor }}/>
                        <span style={{ fontWeight:500 }}>{uiLabel(salesSeriesLabel)}</span>
                        <span style={{ color:C.muted }}>{t("common.leftAxis", "left axis")}</span>
                      </div>
                    </div>
                  </div>
                  <ResponsiveContainer width="100%" height={370}>
                    <LineChart data={chartData} margin={{ top:8, right:34, bottom:6, left:4 }}>
                      <CartesianGrid stroke={C.border} strokeDasharray="2 5" vertical={false}/>
                      <XAxis
                        dataKey="timestamp"
                        type="number"
                        scale="time"
                        domain={salesTrendDomain}
                        allowDataOverflow
                        tick={{ fontSize:10, fill:C.muted, fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif" }}
                        tickFormatter={value => salesTrendDateLabel(value, { spansYears:salesTrendSpansYears })}
                        axisLine={false}
                        tickLine={false}
                        interval="preserveStartEnd"
                      />
                      <YAxis yAxisId="revenue" width={48} tick={{ fontSize:10, fill:C.muted, fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif" }} axisLine={false} tickLine={false} tickFormatter={fmtCompactMoney}/>
                      <Tooltip content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        const sales = payload.find(p => p.dataKey === "sales");
                        return (
                          <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:"9px 11px", fontSize:11, minWidth:180, boxShadow:"0 14px 34px rgba(15,23,42,0.12)" }}>
                            <div style={{ ...MONO, color:C.muted, fontSize:10, marginBottom:7 }}>{payload[0]?.payload?.date || label}</div>
                            {sales && <div style={{ display:"flex", justifyContent:"space-between", gap:16 }}><span style={{ color:C.muted }}>{uiLabel(salesSeriesLabel)}</span><span style={{ ...MONO, color:selectedSalesColor, fontWeight:500 }}>{fmtCompactMoney(sales.value)}</span></div>}
                          </div>
                        );
                      }}/>
                      <Line yAxisId="revenue" type="monotone" dataKey="sales" name={salesSeriesLabel} stroke={selectedSalesColor} strokeWidth={2.4} dot={false}/>
                    </LineChart>
                  </ResponsiveContainer>
                </>
              ) : <div style={{ textAlign:"center", padding:"34px 0", color:C.muted, fontSize:11 }}>{lang==="ko"?"이 기간과 일치하는 캠페인 매출 행이 없습니다.":"No campaign sales rows match this range."}</div>}
            </Panel>

            <Panel title="KPI Comparison" style={{ marginBottom:0, padding:"14px 14px 12px" }}>
              <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
                {comparisonRailItems.map((item, i) => (
                  <div key={item.label} style={{ padding:i === 0 ? "0 0 12px" : "12px 0", borderTop:i ? `1px solid ${C.border}` : "none" }}>
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, marginBottom:5 }}>
                      <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:0.7 }}>{uiLabel(item.label)}</div>
                      <span style={{ width:7, height:7, borderRadius:7, background:item.color, flexShrink:0 }}/>
                    </div>
                    <div style={{ ...MONO, fontSize:19, fontWeight:500, color:item.color, lineHeight:1.1 }}>{item.current}</div>
                    {item.comparison ? (
                      <div style={{ display:"flex", justifyContent:"space-between", gap:8, marginTop:6, fontSize:10, color:C.muted }}>
                        <span>Prior {item.comparison.prior}</span>
                        <span style={{ color:item.comparison.delta.includes("+") ? C.green : item.comparison.delta.includes("-") ? C.red : C.muted, ...MONO }}>{item.comparison.delta}</span>
                      </div>
                    ) : item.detail ? (
                      <div style={{ marginTop:6, textAlign:"right", fontSize:10, color:C.muted, ...MONO }}>{item.detail}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            </Panel>
          </div>

          {!campaignCid && portfolioRows.length > 0 && (
            <Panel title={campaignPid ? "Campaign Portfolio" : "Product Portfolio"}>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(230px,1fr))", gap:10 }}>
                {portfolioRows.map(row => (
                  <div key={row.key} style={{ background:C.bg, border:`1px solid ${C.border}`, borderLeft:`4px solid ${row.col}`, borderRadius:5, padding:"11px 12px", minWidth:0 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", gap:10, alignItems:"baseline", marginBottom:7 }}>
                      <div style={{ color:C.text, fontWeight:500, fontSize:12, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{row.name}</div>
                      {!usesOnlineSales && <div style={{ ...MONO, color:row.health.col, fontSize:10, flexShrink:0 }}>{row.health.label}</div>}
                    </div>
                    <div style={{ height:5, background:C.card, borderRadius:4, overflow:"hidden", marginBottom:8 }}><div style={{ height:"100%", width:`${Math.max(4, (row.rev / topPortfolioRev) * 100)}%`, background:row.col }}/></div>
                    <div style={{ display:"grid", gridTemplateColumns:usesOnlineSales ? "repeat(2,1fr)" : "repeat(3,1fr)", gap:8, fontSize:10 }}>
                      <div><div style={{ color:C.muted }}>Sales</div><div style={{ ...MONO, color:row.col, fontWeight:500 }}>{fmtCompactMoney(row.rev)}</div></div>
                      {usesOnlineSales ? <div><div style={{ color:C.muted }}>{t("metric.units", "Units")}</div><div style={{ ...MONO, color:C.text, fontWeight:500 }}>{row.units.toLocaleString()}</div></div> : <>
                      <div><div style={{ color:C.muted }}>Doors</div><div style={{ ...MONO, color:C.text, fontWeight:500 }}>{row.doors}</div></div>
                      <div><div style={{ color:C.muted }}>Avg Weekly $/Door</div><div style={{ ...MONO, color:row.health.col, fontWeight:500 }}>{row.verifiedDoors ? fmtCompactMoney(row.revenuePerDoor) : "N/A"}</div></div>
                      </>}
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {campaignMetaRows.length > 0 && (
            <MetaAdsSection rows={campaignMetaRows} product={product} dateRange={dateRange} context={campaignName}/>
          )}

          {campaignNonMetaPpcRows.length > 0 && (
            <PpcPerformanceSection rows={campaignNonMetaPpcRows} allRows={ppcRows} product={product} dateRange={dateRange} context={campaignName} productMeta={productMeta}/>
          )}

          <div className="bi-two-col" style={{ display:"grid", gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)", gap:14, marginBottom:14 }}>
            <Panel title={inventoryFlowTitle} style={{ marginBottom:0 }}>
              {inventoryData.length ? (
                <>
                  <div style={{ display:"flex", alignItems:"center", gap:7, margin:"0 0 10px", fontSize:10, color:C.text }}>
                    <span style={{ width:10, height:10, borderRadius:3, background:selectedSalesColor }}/>
                    <span style={{ fontWeight:500 }}>{uiLabel(inventoryFlowLabel)}</span>
                    <span style={{ color:C.muted }}>{inventoryFlowSubLabel}</span>
                  </div>
                  <ResponsiveContainer width="100%" height={232}>
                    <BarChart data={inventoryData} margin={{ top:8, right:12, bottom:4, left:4 }}>
                      <CartesianGrid stroke={C.border} strokeDasharray="2 5" vertical={false}/>
                      <XAxis dataKey="label" tick={{ fontSize:10, fill:C.muted, fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif" }} axisLine={false} tickLine={false} interval="preserveStartEnd"/>
                      <YAxis width={44} tick={{ fontSize:10, fill:C.muted, fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif" }} axisLine={false} tickLine={false} tickFormatter={fmtUnits}/>
                      <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
                        <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:"9px 11px", fontSize:11, minWidth:150, boxShadow:"0 14px 34px rgba(15,23,42,0.12)" }}>
                          <div style={{ ...MONO, color:C.muted, fontSize:10, marginBottom:7 }}>{label}</div>
                          {payload.map(p => <div key={p.dataKey} style={{ display:"flex", justifyContent:"space-between", gap:16 }}><span style={{ color:C.muted }}>{uiLabel(inventoryFlowLabel)}</span><span style={{ color:p.color, ...MONO, fontWeight:500 }}>{fmtUnits(p.value)}</span></div>)}
                        </div>
                      ) : null}/>
                      <Bar dataKey="inventory" name={inventoryFlowLabel} fill={selectedSalesColor} radius={[3,3,0,0]} opacity={0.82} maxBarSize={34}/>
                    </BarChart>
                  </ResponsiveContainer>
                </>
              ) : <div style={{ textAlign:"center", padding:"28px 0", color:C.muted, fontSize:11 }}>{lang==="ko"?"이 캠페인의 재고 스냅샷이 없습니다.":"No inventory snapshots for this campaign."}</div>}
            </Panel>

            <Panel title={`Report Flags (${reportItems.length})`} style={{ marginBottom:0 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8, marginBottom:10, flexWrap:"wrap" }}>
                <div style={{ fontSize:10, color:C.muted }}>
                  {reportGroups.length.toLocaleString()} grouped / {sortedReportItems.length.toLocaleString()} total
                </div>
              </div>
              {renderReportGroups(true)}
            </Panel>
          </div>

          <Panel title="Warehouse Performance">
            {visibleStores.length ? (
              <div>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10, marginBottom:10, flexWrap:"wrap" }}>
                  <div style={{ fontSize:10, color:C.muted }}>
                    {lang === "ko" ? `${filteredStoreRows.length.toLocaleString()}개 중 ${visibleStores.length.toLocaleString()}개 매장 표시` : `Showing ${visibleStores.length.toLocaleString()} of ${filteredStoreRows.length.toLocaleString()} matched door${filteredStoreRows.length===1?"":"s"}.`}
                  </div>
                  <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"center" }}>
                    <input type="search" value={warehouseSearch} onChange={e=>setWarehouseSearch(e.target.value)} placeholder={t("common.searchWarehouses", "Search warehouses")} style={{ ...INP, width:180, padding:"7px 9px" }}/>
                    <SmBtn onClick={() => downloadRowsCsv("warehouse-performance.csv", [
                      { label:"Warehouse", value:r => r.name },
                      { label:"Location", value:r => r.location || r.region },
                      { label:"Revenue", value:r => r.rev },
                      { label:"Units", value:r => r.units },
                      { label:"Status", value:r => r.health.label },
                      { label:"Share", value:r => `${r.share.toFixed(1)}%` },
                    ], filteredStoreRows)}>{t("common.exportCsv", "Export CSV")}</SmBtn>
                    {filteredStoreRows.length > 24 && (
                      <SmBtn onClick={() => setShowAllWarehouseRows(v => !v)}>
                        {showAllWarehouseRows ? `${t("common.showTop", "Show Top")} 24` : `${t("common.showAll", "Show All")} ${filteredStoreRows.length.toLocaleString()}`}
                      </SmBtn>
                    )}
                  </div>
                </div>
                <div style={{ overflowX:"auto" }}>
                  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
                    <thead>
                      <tr>
                        {[
                          ["Warehouse","name"],
                          ["Location","location"],
                          ["Revenue","rev"],
                          ["Units","units"],
                          ["Status","statusLabel"],
                          ["Share","share"],
                        ].map(([h, key]) => (
                          <th key={h} aria-sort={warehouseSort.key === key ? (warehouseSort.dir === "desc" ? "descending" : "ascending") : "none"} style={{ textAlign:h === "Warehouse" || h === "Location" ? "left" : "right", color:C.muted, ...MONO, fontSize:10, textTransform:"uppercase", letterSpacing:1, padding:"0 8px 8px", borderBottom:`1px solid ${C.border}` }}><button type="button" onClick={() => setWarehouseTableSort(key)} style={{ background:"none", border:"none", padding:0, margin:0, cursor:"pointer", color:"inherit", font:"inherit", letterSpacing:"inherit", textTransform:"inherit" }}>{uiLabel(h)}{warehouseSort.key === key ? warehouseSort.dir === "desc" ? " ↓" : " ↑" : ""}</button></th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleStores.map(row => (
                        <tr key={row.wid}>
                          <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:C.text, fontWeight:500, minWidth:220 }}>{row.name}</td>
                          <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:C.muted }}>{row.location || row.region}</td>
                          <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:product?.col || C.green, textAlign:"right", ...MONO, fontWeight:500 }}>{fmtCompactMoney(row.rev)}</td>
                          <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:C.text, textAlign:"right", ...MONO }}>{fmtUnits(row.units)}</td>
                          <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, textAlign:"right" }}><StatusChip label={row.health.label} col={row.health.col}/></td>
                          <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:C.muted, textAlign:"right", ...MONO }}>{row.share.toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:16, color:C.muted, fontSize:11, lineHeight:1.7 }}>{lang==="ko"?"이 캠페인과 기간에 해당하는 웨어하우스 단위 매출 행이 없습니다.":"No warehouse-level sales rows are available for this campaign and date range."}</div>
            )}
          </Panel>
            </>
          )}
        </>
      )}
    </>
  );
}


// ═══════════════════════════════════════════════════════════════
const CALENDAR_ACTIVITY_KIND_RANK = { note:0, meta:1, video:2 };
function calendarActivitySortLabel(row = {}) {
  if (row.kind === "video") return videoDisplayName(row.item);
  return String(row.item?.title || row.item?.id || "");
}
function compareCalendarActivityRows(a, b) {
  const dateOrder = String(a.date || "").localeCompare(String(b.date || ""));
  if (dateOrder) return dateOrder;
  const kindOrder = (CALENDAR_ACTIVITY_KIND_RANK[a.kind] ?? 99) - (CALENDAR_ACTIVITY_KIND_RANK[b.kind] ?? 99);
  if (kindOrder) return kindOrder;
  return calendarActivitySortLabel(a).localeCompare(calendarActivitySortLabel(b));
}

function CalendarView({ footnotes, setFootnotes, selId, ranked, whs, calendarPid, videos = [], videoMetrics = [], prodSales = [], inlineTotalSales = [], onlineSales = [], salesChannel = "", ppcRows = [], dateRange = { start:DATA_START, end:DATA_END }, productMeta = {}, campaignMeta = {}, productOptions = groupProductFilterOptions(productCatalog(productMeta)), campaignId = "", notesDirty = false, setNotesDirty = () => {}, openDataSources = null }) {
  const { lang, t, label:uiLabel } = useUiText();
  const rangeStart = dateRange?.start || DATA_START;
  const rangeEnd = dateRange?.end || DATA_END;
  const monthDateFor = value => {
    const dt = parseISODate(value || rangeEnd || rangeStart || DATA_START);
    return new Date(dt.getUTCFullYear(), dt.getUTCMonth(), 1);
  };
  const [vd, setVd]           = useState(() => monthDateFor(rangeEnd));
  const [selDate, setSelDate] = useState(null);
  const [showForm, setForm]   = useState(false);
  const [form, setFv]         = useState({ date:"", type:"demo", wid:"", pid:"", title:"", body:"" });
  useEffect(() => {
    setVd(monthDateFor(rangeEnd));
    setSelDate(null);
  }, [rangeEnd, calendarPid, campaignId, selId]);
  const yr=vd.getFullYear(), mo=vd.getMonth();
  const firstDay=new Date(yr,mo,1).getDay();
  const dim=new Date(yr,mo+1,0).getDate();
  const selName=selId?ranked.find(w=>w.id===selId)?.name:null;
  const monthPfx=`${yr}-${String(mo+1).padStart(2,"0")}`;
  const prodLabel=calendarPid?productLabelForValue(calendarPid, productMeta):null;
  const eventTypes=["demo","tpd","promo","meta","issue","seasonal","markdown","other"];
  const salesProduct = calendarPid ? productWithMeta(calendarPid, productMeta) : null;
  const salesSourceLabel = salesChannel === "online" ? "Online Sales" : selId ? "Warehouse Sales" : inlineTotalSales.length ? "Costco Daily Totals" : "Warehouse Sales";
  const calendarSalesRows=useMemo(()=>{
    const source = salesChannel === "online" ? onlineSales : !selId && inlineTotalSales.length ? inlineTotalSales : prodSales;
    return source.filter(r =>
      r.date &&
      r.date.startsWith(monthPfx) &&
      r.date >= rangeStart &&
      r.date <= rangeEnd &&
      (!calendarPid || productValuesMatch(r.pid, calendarPid, productMeta)) &&
      rowMatchesCampaignScope(r, campaignId) &&
      (!selId || r.wid === selId) &&
      (Number(r.rev || 0) > 0 || Number(r.units || 0) > 0)
    );
  },[prodSales,inlineTotalSales,onlineSales,salesChannel,selId,calendarPid,campaignId,monthPfx,rangeStart,rangeEnd,productMeta]);
  const salesDateMap=useMemo(()=>{
    const m={};
    Object.entries(_.groupBy(calendarSalesRows,"date")).forEach(([date,rows])=>{
      m[date]={date,rev:_.sumBy(rows,"rev"),units:_.sumBy(rows,"units"),rows:rows.length,col:salesProduct?.col||C.green};
    });
    return m;
  },[calendarSalesRows,salesProduct]);

  const monthVideos=useMemo(()=>{
    const firstByVid=new Map();
    videoMetrics.forEach(m=>{
      if(!m.date)return;
      const prev=firstByVid.get(m.vid);
      if(!prev||m.date<prev.date)firstByVid.set(m.vid,m);
    });
    return videos.map(v=>{
      const first=firstByVid.get(v.id);
      const postedDate=v.postedDate||"";
      if(!postedDate)return null;
      return {...v,date:postedDate,metric:first,prod:productWithMeta(v.pid, productMeta)};
    }).filter(v=>v&&v.date.startsWith(monthPfx)&&(!calendarPid||productValuesMatch(v.pid, calendarPid, productMeta))&&rowMatchesCampaignScope(v,campaignId))
      .sort((a,b)=>a.date.localeCompare(b.date)||videoDisplayName(a).localeCompare(videoDisplayName(b)));
  },[videos,videoMetrics,monthPfx,calendarPid,campaignId,productMeta]);

  const monthMetaEvents = useMemo(() => metaCampaignStartEvents(ppcRows)
    .filter(event => event.date.startsWith(monthPfx) && event.date >= rangeStart && event.date <= rangeEnd)
    .filter(event => !calendarPid || productValuesMatch(event.pid || event.product, calendarPid, productMeta))
    .filter(event => rowMatchesCampaignScopeWithInference(event, campaignId, campaignMeta, productMeta, calendarPid))
  , [ppcRows, monthPfx, rangeStart, rangeEnd, calendarPid, campaignId, campaignMeta, productMeta]);
  const monthNotes=useMemo(()=>footnotes.filter(fn=>fn.date.startsWith(monthPfx)&&(!selId||!fn.wid||fn.wid===selId)&&(!calendarPid||!fn.pid||productValuesMatch(fn.pid, calendarPid, productMeta))&&rowMatchesCampaignScope(fn,campaignId)).sort((a,b)=>a.date.localeCompare(b.date)||String(a.title).localeCompare(String(b.title))),[footnotes,monthPfx,selId,calendarPid,campaignId,productMeta]);
  const noteDateMap=useMemo(()=>{const m={};monthNotes.forEach(fn=>{if(!m[fn.date])m[fn.date]=[];m[fn.date].push(fn);});return m;},[monthNotes]);
  const videoDateMap=useMemo(()=>{const m={};monthVideos.forEach(v=>{if(!m[v.date])m[v.date]=[];m[v.date].push(v);});return m;},[monthVideos]);
  const metaDateMap=useMemo(()=>{const m={};monthMetaEvents.forEach(event=>{if(!m[event.date])m[event.date]=[];m[event.date].push(event);});return m;},[monthMetaEvents]);

  const cells=[]; for(let i=0;i<firstDay;i++)cells.push(null); for(let d=1;d<=dim;d++)cells.push(d);

  const addNote=()=>{if(!form.date||!form.title)return;setFootnotes(prev=>[...prev,{...form,pid:form.pid||calendarPid||"",cid:campaignId||"",id:Date.now()}]);setNotesDirty(true);setFv({date:"",type:"demo",wid:"",pid:"",title:"",body:""});setForm(false);};
  const deleteNote=fn=>{
    const ok=window.confirm(lang==="ko"?`이 메모를 삭제할까요?\n${fn.date} - ${fn.title}`:`Delete this note?\n${fn.date} - ${fn.title}`);
    if(!ok)return;
    setFootnotes(p=>p.filter(f=>f.id!==fn.id));
    setNotesDirty(true);
  };
  const fieldSt={width:"100%",background:C.card,border:`1px solid ${C.border}`,borderRadius:6,padding:"5px 10px",color:C.text,fontSize:12,...SANS,outline:"none",boxSizing:"border-box"};

  const selDateNotes=selDate?noteDateMap[selDate]||[]:[];
  const selDateVideos=selDate?videoDateMap[selDate]||[]:[];
  const selDateMetaEvents=selDate?metaDateMap[selDate]||[]:[];
  const selDateSales=selDate?salesDateMap[selDate]:null;
  const calendarProductLabel=p=>p?.short||p?.name||"All Products";
  const videoSummaries=vids=>Object.values(_.groupBy(vids,v=>v.pid||v.prod?.short||"all")).map(group=>{
    const first=group[0]||{};
    const product=calendarProductLabel(first.prod);
    return {key:first.pid||product,label:`${group.length} video${group.length===1?"":"s"} - ${product}`,col:first.prod?.col||C.blue,count:group.length};
  }).sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label));
  const selectedRows=[
    ...selDateNotes.map(fn=>{
      const prod=productWithMeta(fn.pid, productMeta);
      const wh=ranked.find(w=>w.id===fn.wid);
      const t=FN_TYPES[fn.type]||FN_TYPES.other;
      return {id:`fn-${fn.id}`,isVideo:false,type:t.label,col:t.col,product:fn.pid?productLabelForValue(fn.pid, productMeta):"All Products",who:wh?.name||"All Stores",title:fn.title,body:fn.body};
    }),
    ...selDateMetaEvents.map(event=>({id:`meta-${event.id}`,isVideo:false,isMeta:true,type:FN_TYPES.meta.label,col:FN_TYPES.meta.col,product:event.pid?productLabelForValue(event.pid, productMeta):event.product||"All Products",who:"Meta Ads",title:event.title,body:event.body})),
  ...selDateVideos.map(v=>({id:`vid-${v.id}`,isVideo:true,type:v.type?`${v.type} Video`:"Video",col:v.prod?.col||C.blue,product:v.prod?.short||"All Products",who:[v.creator,v.platform].filter(Boolean).join(" / "),title:`1 video - ${calendarProductLabel(v.prod)}`,body:v.url,detail:videoDisplayName(v)})),
  ].sort((a,b)=>(a.isSales?-1:b.isSales?1:0)||a.type.localeCompare(b.type)||a.title.localeCompare(b.title));
  const monthLogRows=[
    ...monthNotes.map(fn=>({kind:"note",date:fn.date,item:fn})),
    ...monthMetaEvents.map(event=>({kind:"meta",date:event.date,item:event})),
    ...monthVideos.map(v=>({kind:"video",date:v.date,item:v})),
  ].sort(compareCalendarActivityRows);
  const eventBadge=(label,col)=>(
    <span style={{fontSize:10,...MONO,color:col,background:`${col}18`,border:`1px solid ${col}35`,borderRadius:4,padding:"2px 5px",lineHeight:1,whiteSpace:"nowrap"}}>{label}</span>
  );
  const selectedDatePanel=(
    <div style={{borderLeft:`1px solid ${C.border}`,paddingLeft:16,minHeight:360}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,marginBottom:12}}>
        <div>
          <div style={{...MONO,fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:1}}>{lang==="ko"?"선택한 날짜":"Selected Date"}</div>
          <div style={{fontSize:16,color:C.text,fontWeight:500,marginTop:4}}>{selDate||(lang==="ko"?"날짜를 선택하세요":"Choose a date")}</div>
          <div style={{fontSize:11,color:C.muted,marginTop:3}}>{selDate?(lang==="ko"?`캘린더 항목 ${selectedRows.length}개`:`${selectedRows.length} calendar item${selectedRows.length===1?"":"s"}`):(lang==="ko"?"캘린더에서 날짜를 클릭하면 해당 이벤트가 여기에 표시됩니다.":"Click any calendar day to view its events here.")}</div>
        </div>
        {selDate&&<button onClick={()=>setSelDate(null)} style={{background:"transparent",border:"none",color:C.muted,cursor:"pointer",fontSize:16,padding:"0 4px"}}>×</button>}
      </div>
      {!selDate ? (
        <div style={{fontSize:11,color:C.muted,lineHeight:1.6,borderTop:`1px solid ${C.border}`,paddingTop:12}}>
          {lang==="ko"?"매출, 영상 게시, 데모, TPD, 프로모션, 이슈, 시즌 메모가 이 패널에 표시됩니다.":"Sales, video posts, demos, TPDs, promos, issues, and seasonal notes will expand in this side panel."}
        </div>
      ) : selectedRows.length > 0 ? (
        <div style={{display:"flex",flexDirection:"column",gap:9}}>
          {selectedRows.map(row=>(
            <div key={row.id} style={{border:`1px solid ${C.border}`,borderLeft:`3px solid ${row.col}`,borderRadius:7,padding:"10px 11px",background:C.bg}}>
              <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap",marginBottom:7}}>
                {eventBadge(row.type,row.col)}
                <span style={{fontSize:10,color:row.col}}>{row.product}</span>
              </div>
              <div style={{fontSize:12,color:C.text,fontWeight:500,lineHeight:1.45}}>{row.title}</div>
              {row.who&&<div style={{fontSize:10,color:C.muted,marginTop:4,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{row.who}</div>}
              {row.detail&&<div style={{fontSize:11,color:C.muted,marginTop:5,lineHeight:1.45}}>{row.detail}</div>}
              {row.body&&row.isVideo&&safeExternalHttpUrl(row.body)&&<a href={safeExternalHttpUrl(row.body)} target="_blank" rel="noreferrer" style={{display:"inline-block",marginTop:7,color:C.blue,textDecoration:"none",fontSize:11}}>Open video ↗</a>}
              {row.body&&!row.isVideo&&<div style={{fontSize:11,color:C.muted,marginTop:6,lineHeight:1.5}}>{row.body}</div>}
            </div>
          ))}
        </div>
      ) : (
        <div style={{fontSize:11,color:C.muted,fontStyle:"italic",lineHeight:1.6,borderTop:`1px solid ${C.border}`,paddingTop:12}}>{lang==="ko"?"이 날짜에는 매출, 영상, 캘린더 이벤트가 없습니다. 아래 + 메모 추가로 데모, TPD, 프로모션, 이슈, 시즌 메모를 등록하세요.":"No sales, videos, or calendar events for this date. Use + Add Note below for demos, TPDs, promos, issues, seasonal notes, or other items."}</div>
      )}
    </div>
  );

  return (
    <>
      <Panel title={`Master Calendar · ${MONTHS[mo]} ${yr}${selName?` — ${selName}`:""}${prodLabel?` · ${prodLabel}`:""}`}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,maxWidth:1180}}>
          <SmBtn onClick={()=>setVd(new Date(yr,mo-1,1))}>{lang==="ko"?"← 이전":"← Prev"}</SmBtn>
          <span style={{...MONO,fontSize:13,fontWeight:500}}>{MONTHS[mo]} {yr}</span>
          <SmBtn onClick={()=>setVd(new Date(yr,mo+1,1))}>{lang==="ko"?"다음 →":"Next →"}</SmBtn>
        </div>
        {(monthPfx < rangeStart.slice(0,7) || monthPfx > rangeEnd.slice(0,7)) && (
          <div style={{ marginBottom:10, fontSize:10, color:C.muted, background:C.bg, border:`1px solid ${C.border}`, borderRadius:7, padding:"6px 9px", maxWidth:1180 }}>
            {lang==="ko"?"이 달은 선택된 기간 밖에 있어 기간 필터로 매출이 숨겨집니다.":"This month is outside the selected date range, so range-filtered sales are hidden here."}
          </div>
        )}

        <div className="bi-two-col" style={{display:"grid",gridTemplateColumns:"minmax(0,1.45fr) minmax(240px,300px)",gap:14,alignItems:"start",maxWidth:1360}}>
          <div style={{minWidth:0}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(7,minmax(0,1fr))",gap:6}}>
          {DAYS.map(d=><div key={d} style={{textAlign:"center",fontSize:10,...MONO,color:C.muted,padding:"3px 0"}}>{d}</div>)}
          {cells.map((d,i)=>{
            if(!d)return (<div key={`e${i}`} style={{minHeight:128}}/>);
            const ds=`${yr}-${String(mo+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
            const notes=noteDateMap[ds]||[];
            const eventNotes=notes.filter(n=>eventTypes.includes(n.type));
            const otherNotes=notes.filter(n=>!eventTypes.includes(n.type));
            const metas=metaDateMap[ds]||[];
            const calendarEvents=[...eventNotes,...metas];
            const vids=videoDateMap[ds]||[];
            const videoGroups=videoSummaries(vids);
            const salesDay=salesDateMap[ds];
            const firstCol=calendarEvents[0]?FN_TYPES[calendarEvents[0].type]?.col:(notes[0]?FN_TYPES[notes[0].type]?.col:(salesDay?.col||videoGroups[0]?.col||null));
            const isSelected=selDate===ds;
            const videoCols=[...new Set(vids.map(v=>v.prod?.col||C.blue))].slice(0,4);
            const shown=[...calendarEvents,...otherNotes].slice(0,2);
            const hidden=Math.max(0,calendarEvents.length+otherNotes.length-shown.length);
            const totalItems=calendarEvents.length+otherNotes.length+vids.length+(salesDay?1:0);
            return(
              <div key={d} role="button" tabIndex={0} onClick={()=>setSelDate(isSelected?null:ds)}
                onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setSelDate(isSelected?null:ds);}}}
                title={`${ds} - ${totalItems} calendar item${totalItems===1?"":"s"}`}
                style={{
                  minHeight:128,background:isSelected?C.hover:C.bg,borderRadius:6,padding:"9px 12px 9px 12px",
                  position:"relative",cursor:"pointer",overflow:"visible",
                  border:`1px solid ${isSelected?firstCol||C.accent:C.border}`,
                  boxShadow:isSelected?`0 0 0 1px ${firstCol||C.accent}30`:"none",
                  transition:"all 0.1s",
                }}>
                {calendarEvents.length>0&&(
                  <div style={{position:"absolute",left:0,top:6,bottom:6,width:3,display:"flex",flexDirection:"column",gap:2}}>
                    {[...new Set(calendarEvents.map(n=>FN_TYPES[n.type]?.col||C.accent))].slice(0,4).map(c=><span key={c} style={{flex:1,background:c,borderRadius:"0 2px 2px 0"}}/>)}
                  </div>
                )}
                {videoCols.length>0&&(
                  <div style={{position:"absolute",right:4,top:7,bottom:7,width:3,display:"flex",flexDirection:"column",gap:2}}>
                    {videoCols.map(c=><span key={c} style={{flex:1,background:c,borderRadius:2,opacity:0.9}}/>)}
                  </div>
                )}
                <div style={{...MONO,fontSize:10,color:isSelected?C.text:C.muted,fontWeight:isSelected?700:500,marginBottom:6}}>{d}</div>
                <div style={{display:"flex",flexDirection:"column",gap:3,paddingRight:videoCols.length?8:0}}>
                  {shown.map(fn=>(
                    <div key={fn.id} style={{fontSize:10,...MONO,color:FN_TYPES[fn.type]?.col||C.muted,whiteSpace:"normal",overflow:"visible",lineHeight:1.25,wordBreak:"break-word"}}>
                      {FN_TYPES[fn.type]?.short||"NOTE"} {fn.pid ? productLabelForValue(fn.pid, productMeta) : ""}
                    </div>
                  ))}
                  {videoGroups.slice(0,2).map(group=><div key={group.key} style={{fontSize:10,...MONO,color:group.col,whiteSpace:"normal",overflow:"visible",lineHeight:1.25,wordBreak:"break-word"}}>{group.label}</div>)}
                  {videoGroups.length>2&&<div style={{fontSize:10,...MONO,color:C.muted}}>+{videoGroups.length-2} more video group{videoGroups.length-2===1?"":"s"}</div>}
                  {hidden>0&&<div style={{fontSize:10,...MONO,color:C.muted}}>+{hidden} more event{hidden===1?"":"s"}</div>}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{marginTop:12,display:"flex",gap:12,...SANS,fontSize:10,color:C.muted,alignItems:"center",flexWrap:"wrap"}}>
          {eventTypes.map(k=>{
            const v=FN_TYPES[k];
            return (
              <div key={k} style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:3,height:12,background:v.col,borderRadius:1}}/><span style={{color:v.col}}>{uiLabel(v.label)}</span></div>
            );
          })}
          <div style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:3,height:12,background:salesProduct?.col||C.green,borderRadius:1}}/><span style={{color:salesProduct?.col||C.green}}>{uiLabel("Sales Activity")}</span></div>
          <div style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:3,height:12,background:C.blue,borderRadius:1}}/><span style={{color:C.blue}}>{uiLabel("Video Post")}</span></div>
          <span style={{color:C.muted}}>{lang==="ko"?"· 날짜를 클릭하면 오른쪽에 상세가 열립니다":"· Click any date to open details at right"}</span>
        </div>

        {/* Selected date — inline reveal, shows for any clicked date */}
          </div>
          {selectedDatePanel}
        </div>
      </Panel>

      {/* Product activity log + add form */}
      <Panel title={`Calendar Activity - ${MONTHS[mo]} ${yr} (${monthLogRows.length})`}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:12}}>
          <span style={{fontSize:11,color:C.muted}}>{lang==="ko"?"매출, 데모, TPD, 프로모션, 이슈, 시즌 메모, 기타 항목, 첫 게시 인플루언서 영상. 행을 클릭하면 위에서 해당 날짜가 열립니다.":"Sales, demos, TPDs, promos, issues, seasonal notes, other items, and first-posted influencer videos. Click a row to open that date above."}</span>
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            {notesDirty && (
              <button onClick={openDataSources || undefined} title={lang==="ko"?"데이터 소스에서 '현재 데이터 게시'를 눌러야 팀과 공유되고 새로고침 후에도 유지됩니다.":"Notes only persist for the team after 'Publish Current' in Data Sources."} style={{ display:"inline-flex", alignItems:"center", gap:6, border:`1px solid ${C.warn}55`, background:C.warnFade, color:C.warn, borderRadius:999, padding:"4px 9px", fontSize:10, ...SANS, fontWeight:500, cursor:openDataSources?"pointer":"default" }}>
                {lang==="ko"?"저장되지 않은 메모 — 데이터 소스에서 게시하세요":"Unsaved notes — publish in Data Sources to keep them"}
              </button>
            )}
            <SmBtn onClick={()=>{setForm(s=>!s); if(!showForm&&selDate)setFv(f=>({...f,date:f.date||selDate,pid:f.pid||calendarPid}));}} active={showForm}>{showForm?(lang==="ko"?"× 취소":"× Cancel"):(lang==="ko"?"+ 메모 추가":"+ Add Note")}</SmBtn>
          </div>
        </div>
        {showForm&&(
          <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:14,marginBottom:14}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
              <div><label style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,display:"block",marginBottom:4}}>{lang==="ko"?"날짜 *":"Date *"}</label><input type="date" value={form.date} onChange={e=>setFv(f=>({...f,date:e.target.value}))} style={fieldSt}/></div>
              <div><label style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,display:"block",marginBottom:4}}>{lang==="ko"?"유형":"Type"}</label><select value={form.type} onChange={e=>setFv(f=>({...f,type:e.target.value}))} style={fieldSt}>{Object.entries(FN_TYPES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select></div>
              <div><label style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,display:"block",marginBottom:4}}>{lang==="ko"?"매장":"Store"}</label><select value={form.wid} onChange={e=>setFv(f=>({...f,wid:e.target.value}))} style={fieldSt}><option value="">{uiLabel("All Stores")}</option>{ranked.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></div>
              <div><label style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,display:"block",marginBottom:4}}>{lang==="ko"?"제품":"Product"}</label><select value={form.pid} onChange={e=>setFv(f=>({...f,pid:e.target.value}))} style={fieldSt}><option value="">{uiLabel("All Products")}</option>{productOptions.map(p=><option key={p.id} value={p.id}>{p.short}</option>)}</select></div>
              <div style={{gridColumn:"1 / -1"}}><label style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,display:"block",marginBottom:4}}>{lang==="ko"?"제목 *":"Title *"}</label><input value={form.title} onChange={e=>setFv(f=>({...f,title:e.target.value}))} placeholder="e.g. TPD at Commerce" style={fieldSt}/></div>
            </div>
            <div style={{marginBottom:10}}><label style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,display:"block",marginBottom:4}}>{lang==="ko"?"메모 / 컨텍스트":"Notes / Context"}</label><textarea value={form.body} onChange={e=>setFv(f=>({...f,body:e.target.value}))} rows={2} style={{...fieldSt,resize:"vertical"}}/></div>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              <SmBtn onClick={()=>setForm(false)}>{lang==="ko"?"취소":"Cancel"}</SmBtn>
              <button onClick={addNote} disabled={!form.date||!form.title} style={{padding:"5px 16px",borderRadius:6,border:"none",background:form.date&&form.title?C.accent:"#333",color:form.date&&form.title?"#000":C.muted,cursor:form.date&&form.title?"pointer":"default",fontSize:12,...SANS,fontWeight:500}}>{lang==="ko"?"메모 저장":"Save Note"}</button>
            </div>
          </div>
        )}
        {monthLogRows.length===0?(
          <div style={{fontSize:11,color:C.muted,textAlign:"center",padding:"18px 0"}}>{lang==="ko"?`${MONTHS[mo]} ${yr}에는 매출, 영상, 캘린더 이벤트가 없습니다.`:`No sales, videos, or calendar events for ${MONTHS[mo]} ${yr}.`}</div>
        ):(
          <div style={{display:"flex",flexDirection:"column",gap:7}}>
            {monthLogRows.map(row=>{
              if(row.kind==="sales"){
                const s=row.item;
                return (
                  <div key={`s-${s.date}`} role="button" tabIndex={0} onClick={()=>setSelDate(s.date)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setSelDate(s.date);}}} style={{background:C.bg,borderRadius:8,padding:10,border:`1px solid ${C.border}`,borderLeft:`3px solid ${s.col}`,cursor:"pointer"}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                      {eventBadge("Sales",s.col)}
                      <span style={{...MONO,fontSize:10,color:C.muted}}>{s.date}</span>
                      <span style={{fontSize:10,color:s.col}}>{prodLabel||"All Products"}</span>
                      <span style={{fontSize:10,color:C.muted}}>{salesSourceLabel}</span>
                    </div>
                    <div style={{fontWeight:500,fontSize:12,color:C.text}}>{fmtCompactMoney(s.rev)} / {fmtUnits(s.units)} units</div>
                    <div style={{fontSize:11,color:C.muted,marginTop:2}}>{s.rows.toLocaleString()} source row{s.rows===1?"":"s"} in this calendar view.</div>
                  </div>
                );
              }
              if(row.kind==="meta"){
                const event=row.item;
                return (
                  <div key={`m-${event.id}`} role="button" tabIndex={0} onClick={()=>setSelDate(event.date)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setSelDate(event.date);}}} style={{background:C.bg,borderRadius:8,padding:10,border:`1px solid ${C.border}`,borderLeft:`3px solid ${FN_TYPES.meta.col}`,cursor:"pointer"}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                      {eventBadge("Meta Ad",FN_TYPES.meta.col)}
                      <span style={{...MONO,fontSize:10,color:C.muted}}>{event.date}</span>
                      <span style={{fontSize:10,color:FN_TYPES.meta.col}}>{event.pid ? productLabelForValue(event.pid, productMeta) : event.product || "All Products"}</span>
                      <span style={{fontSize:10,color:C.muted}}>Meta Ads</span>
                    </div>
                    <div style={{fontWeight:500,fontSize:12,color:C.text}}>{event.title}</div>
                    <div style={{fontSize:11,color:C.muted,marginTop:2,lineHeight:1.5}}>{event.body}</div>
                  </div>
                );
              }
              if(row.kind==="video"){
                const v=row.item;
                return (
                  <div key={`v-${v.id}`} role="button" tabIndex={0} onClick={()=>setSelDate(v.date)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setSelDate(v.date);}}} style={{background:C.bg,borderRadius:8,padding:10,border:`1px solid ${C.border}`,borderRight:`4px solid ${v.prod?.col||C.blue}`,cursor:"pointer"}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                      {eventBadge(v.type?`Video: ${v.type}`:"Video",v.prod?.col||C.blue)}
                      <span style={{...MONO,fontSize:10,color:C.muted}}>{v.date}</span>
                      <span style={{fontSize:10,color:v.prod?.col||C.blue}}>{v.prod?.short||"All Products"}</span>
                      <span style={{fontSize:10,color:C.muted}}>{v.creator} · {v.platform}</span>
                    </div>
                    <div style={{fontWeight:500,fontSize:12,color:C.text}}>1 video - {calendarProductLabel(v.prod)}</div>
                    <div style={{fontSize:11,color:C.muted,marginTop:2}}>{videoDisplayName(v)}</div>
                  </div>
                );
              }
              const fn=row.item, prod=productWithMeta(fn.pid, productMeta), type=FN_TYPES[fn.type]||FN_TYPES.other;
              return (
              <div key={`fn-${fn.id}`} role="button" tabIndex={0} style={{background:C.bg,borderRadius:8,padding:10,border:`1px solid ${C.border}`,borderLeft:`3px solid ${type.col}`,cursor:"pointer"}} onClick={()=>setSelDate(fn.date)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setSelDate(fn.date);}}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                      <Badge type={fn.type}/>
                      <span style={{...MONO,fontSize:10,color:C.muted}}>{fn.date}</span>
                      {prod&&<span style={{fontSize:10,color:prod.col}}>{prod.short}</span>}
                      {fn.wid&&<span style={{fontSize:10,color:C.muted}}>{ranked.find(w=>w.id===fn.wid)?.name||fn.wid}</span>}
                    </div>
                    <div style={{fontWeight:500,fontSize:12,color:C.text}}>{fn.title}</div>
                    {fn.body&&<div style={{fontSize:11,color:C.muted,marginTop:2,lineHeight:1.5}}>{fn.body}</div>}
                  </div>
                  <button aria-label={lang==="ko"?"메모 삭제":"Delete note"} onClick={e=>{e.stopPropagation();deleteNote(fn);}} style={{background:"transparent",border:"none",color:C.muted,cursor:"pointer",fontSize:13,padding:"0 4px",flexShrink:0}}>×</button>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </Panel>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// SALES VIEW
// ═══════════════════════════════════════════════════════════════

function AnalyticsView({ compactModel = null, sales, prodSales, inlineTotalSales, onlineSales, ppcRows = [], whs, ranked, selId, footnotes, dateRange, selPid, salesRegion, salesState, productMeta, campaignMeta = {}, campaignId = "", storeSearchActive = false, analysisSummaries = {}, salesChannel = "" }) {
  const { t, label:uiLabel } = useUiText();
  const fmtMoney = fmtCompactMoney;
  const compactSales = compactModel?.schema === SALES_COMPACT_SCHEMA;
  const product = selPid ? productWithMeta(selPid, productMeta) : null;
  const store = selId ? whs.find(w => w.id === selId) : null;
  const whById = useMemo(() => new Map(whs.map(w => [w.id, w])), [whs]);
  const activeStoreIds = useMemo(() => new Set(ranked.map(w => w.id)), [ranked]);
  const allowedStoreIds = useMemo(() => new Set(whs
    .filter(w => activeStoreIds.has(w.id) && (!salesRegion || w.region === salesRegion) && (!salesState || w.st === salesState) && (!selId || w.id === selId))
    .map(w => w.id)), [whs, activeStoreIds, salesRegion, salesState, selId]);
  const rowInCampaign = useCallback(row =>
    rowMatchesCampaignScopeWithInference(row, campaignId, campaignMeta, productMeta, selPid)
  , [campaignId, campaignMeta, productMeta, selPid]);
  const filteredWarehouseRows = useMemo(() => {
    if (compactSales) return [];
    const source = campaignId || selPid ? prodSales.filter(r => (!selPid || productValuesMatch(r.pid, selPid, productMeta))) : sales;
    return source.filter(r => r.date >= dateRange.start && r.date <= dateRange.end && allowedStoreIds.has(r.wid) && rowInCampaign(r));
  }, [compactSales, sales, prodSales, selPid, dateRange, allowedStoreIds, campaignId, rowInCampaign]);
  const filteredSales = useMemo(() => filteredWarehouseRows.filter(r => Number(r.rev || 0) > 0), [filteredWarehouseRows]);
  const salesSellThrough = useMemo(() => {
    if (compactSales) return compactModel.sellThrough || { available:false, rate:0 };
    const items = Object.values(_.groupBy(filteredWarehouseRows, r => `${r.wid}|${r.pid}`)).map(groupRows => {
      const sorted = _.sortBy(groupRows, "date");
      const latest = sorted[sorted.length - 1] || {};
      const onHand = Number(latest.inv || 0);
      const sold = _.sumBy(sorted, r => Math.max(0, Number(r.units || 0)));
      const revenue = _.sumBy(sorted, r => Number(r.rev || 0));
      const warehouse = whById.get(latest.wid);
      return shouldExcludeInventoryCoverage(warehouse, { onHand, totalUnits:sold, revenue }) ? null : { sold, onHand };
    }).filter(Boolean);
    const sold = _.sumBy(items, "sold");
    const onHand = _.sumBy(items, "onHand");
    return {
      available:items.length > 0 && sold + onHand > 0,
      rate:sold + onHand > 0 ? (sold / (sold + onHand)) * 100 : 0,
    };
  }, [compactSales, compactModel, filteredWarehouseRows, whById]);

  const warehouseScoped = !!(selId || salesRegion || salesState || storeSearchActive);
  const filteredInlineTotalSales = useMemo(() => (
    compactSales ? [] : inlineTotalSales.filter(r => r.date >= dateRange.start && r.date <= dateRange.end && (!selPid || productValuesMatch(r.pid, selPid, productMeta)) && rowInCampaign(r) && (Number(r.rev || 0) > 0 || Number(r.units || 0) > 0))
  ), [compactSales, inlineTotalSales, dateRange, selPid, productMeta, rowInCampaign]);
  const useInlineTotals = compactSales ? compactModel.useInlineTotals === true : !warehouseScoped;
  const officialInlineTotalsMissing = compactSales ? compactModel.officialInlineTotalsMissing === true : useInlineTotals && filteredInlineTotalSales.length === 0;
  const precomputedWarehouseChartRows = useMemo(() => {
    if (compactSales) return [];
    if (selId || storeSearchActive) return [];
    const source = salesState ? analysisSummaries.stateDaily : salesRegion ? analysisSummaries.regionDaily : [];
    return (source || []).filter(row => row.date >= dateRange.start && row.date <= dateRange.end && (!selPid || productValuesMatch(row.pid, selPid, productMeta)) && rowInCampaign(row) && (!salesRegion || !row.region || row.region === salesRegion) && (!salesState || !row.st || row.st === salesState));
  }, [compactSales, analysisSummaries, dateRange.start, dateRange.end, selPid, rowInCampaign, salesRegion, salesState, selId, storeSearchActive]);
  const inlineChartRows = compactSales ? compactModel.chartRows || [] : useInlineTotals ? filteredInlineTotalSales : precomputedWarehouseChartRows.length ? precomputedWarehouseChartRows : filteredSales;
  const inlineSourceLabel = compactSales ? compactModel.inlineSourceLabel : useInlineTotals ? "Costco Daily Totals" : precomputedWarehouseChartRows.length ? "Published Analysis Summary" : "Warehouse Master";
  const revenueDoorProductIds = useMemo(() => {
    if (selPid) return [selPid];
    if (useInlineTotals) return productIdsFromRows(filteredInlineTotalSales.filter(r => Number(r.rev || 0) > 0));
    return productIdsFromRows(filteredWarehouseRows.filter(r => Number(r.rev || 0) > 0));
  }, [selPid, useInlineTotals, filteredInlineTotalSales, filteredWarehouseRows]);
  const salesDoorStats = useMemo(() => (
    compactSales
      ? compactModel.revenueDoor || { activeDoors:0, revenuePerDoor:0, weeklyPeriodCount:0 }
      : totalRevenueDoorStats(inlineChartRows, productMeta, revenueDoorProductIds, { denominatorRows:filteredWarehouseRows, warehouses:whs, start:dateRange.start, end:dateRange.end })
  ), [compactSales, compactModel, inlineChartRows, filteredWarehouseRows, whs, productMeta, revenueDoorProductIds, dateRange.start, dateRange.end]);
  const salesDoorHealth = campaignHealth(salesDoorStats.revenuePerDoor, salesDoorStats.activeDoors);

  const displayOnlineSales = useMemo(() => compactSales
    ? upsertByKey(compactModel.onlineRows || [], onlineSales, row => `${row.date || ""}|${row.pid || ""}|${row.cid || ""}|${row.channel || ""}`)
    : onlineSales
  , [compactSales, compactModel, onlineSales]);
  const displayPpcRows = useMemo(() => compactSales
    ? upsertByKey(compactModel.ppcRows || [], ppcRows, row => row.id || `${row.snapshotStart || row.date || ""}|${row.snapshotEnd || ""}|${row.pid || ""}|${row.cid || ""}|${row.channel || row.provider || ""}`)
    : ppcRows
  , [compactSales, compactModel, ppcRows]);
  const filteredOnlineSales = useMemo(() => (
    displayOnlineSales.filter(r => r.date >= dateRange.start && r.date <= dateRange.end && (!selPid || productValuesMatch(r.pid, selPid, productMeta)) && rowInCampaign(r))
  ), [displayOnlineSales, dateRange, selPid, productMeta, rowInCampaign]);
  const filteredPpcRows = useMemo(() => (
    displayPpcRows.filter(row => campaignContextMatchesChannel(row, salesChannel, campaignMeta) && ppcRowInDateRange(row, dateRange) && ppcRowMatchesProduct(row, selPid, productMeta) && rowInCampaign(row))
  ), [displayPpcRows, dateRange, selPid, productMeta, rowInCampaign, salesChannel, campaignMeta]);

  const displayFootnotes = useMemo(() => compactSales
    ? upsertByKey(compactModel.footnotes || [], footnotes, note => note.id || `${note.date || ""}|${note.wid || ""}|${note.pid || ""}|${note.cid || ""}|${note.type || ""}|${note.title || ""}`)
    : footnotes
  , [compactSales, compactModel, footnotes]);
  const scopedFootnotes = useMemo(() => displayFootnotes.filter(fn => {
    if (!campaignContextMatchesChannel(fn, salesChannel, campaignMeta)) return false;
    if (fn.date < dateRange.start || fn.date > dateRange.end) return false;
    if (selId && fn.wid && fn.wid !== selId) return false;
    if (selPid && fn.pid && !productValuesMatch(fn.pid, selPid, productMeta)) return false;
    if (!rowInCampaign(fn)) return false;
    const warehouse = fn.wid ? whById.get(fn.wid) : null;
    if (salesRegion && fn.wid && warehouse?.region !== salesRegion) return false;
    if (salesState && fn.wid && warehouse?.st !== salesState) return false;
    return true;
  }), [displayFootnotes, salesChannel, campaignMeta, dateRange, selId, selPid, productMeta, rowInCampaign, whById, salesRegion, salesState]);

  const notesByDate = useMemo(() => {
    const map = new Map();
    scopedFootnotes.forEach(fn => {
      const note = chartNote(fn, 46);
      const list = map.get(fn.date) || [];
      const sig = `${note.type}|${note.title}|${note.preview}`;
      if (!list.some(existing => `${existing.type}|${existing.title}|${existing.preview}` === sig)) list.push(note);
      map.set(fn.date, list);
    });
    return map;
  }, [scopedFootnotes]);

  const chartData = useMemo(() => {
    const byDate = _.groupBy(inlineChartRows, "date");
    return Object.keys(byDate).sort().map(date => {
      const rows = byDate[date];
      const promo = _.sumBy(rows, "promo");
      return { date, label:salesTrendDateLabel(date), rev:_.sumBy(rows,"rev"), units:_.sumBy(rows,"units"), promo, promoPlot:Math.max(0,promo), refund:_.sumBy(rows,"refund"), inv:_.sumBy(rows,"inv"), notes:notesByDate.get(date) || [] };
    });
  }, [inlineChartRows, notesByDate]);

  const period = useMemo(() => {
    const latest = chartData[chartData.length - 1];
    const activeStores = useInlineTotals ? null : salesDoorStats.activeDoors;
    return {
      rev:_.sumBy(inlineChartRows,"rev"), units:_.sumBy(inlineChartRows,"units"), promo:_.sumBy(inlineChartRows,"promo"), refund:_.sumBy(inlineChartRows,"refund"), inv:latest?.inv || 0,
      bestWeek:_.maxBy(chartData,"rev"), activeStores,
    };
  }, [salesDoorStats.activeDoors, inlineChartRows, chartData, useInlineTotals]);

  const revenueLift = useMemo(() => {
    const mid = Math.floor(chartData.length / 2);
    const first = _.sumBy(chartData.slice(0, mid), "rev");
    const second = _.sumBy(chartData.slice(mid), "rev");
    return { first, second, delta:second - first, pct:pctChange(second, first) };
  }, [chartData]);
  const context = [product?.short, salesRegion, salesState, store?.name].filter(Boolean).join(" / ") || "All Products / All Stores";
  const refLines = useMemo(() => {
    return chartData.filter(c => c.notes?.length).map(c => {
      const first = c.notes[0];
      return { ...first, key:c.label, notes:c.notes };
    });
  }, [chartData]);

  return (
    <>
      {salesChannel !== "online" && <>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(155px,1fr))",gap:10,marginBottom:14}} className="bi-kpi-grid">
        {[
          {label:"Dollar Sales",val:officialInlineTotalsMissing ? t("common.missing", "Missing") : fmtMoney(period.rev),exact:officialInlineTotalsMissing ? "" : fmtCurrency(period.rev),c:officialInlineTotalsMissing ? C.muted : product?.col||C.green},
          {label:"Unit Sales",val:officialInlineTotalsMissing ? t("common.missing", "Missing") : period.units.toLocaleString(),c:officialInlineTotalsMissing ? C.muted : C.blue},
          {label:"Revenue Lift",val:fmtGrowth(revenueLift.pct),sub:revenueLift.pct===null?t("common.needsHistory", "Needs more history"):`${fmtMoney(Math.abs(revenueLift.delta))} ${revenueLift.delta>=0?"up":"down"} vs first half`,c:revenueLift.pct===null?C.muted:revenueLift.pct>=0?C.green:C.red},
          {label:"Sell-Through",val:salesSellThrough.available ? `${salesSellThrough.rate.toFixed(1)}%` : t("common.notAvailable", "N/A"),exact:salesSellThrough.available ? t("inventory.sellThroughHint", "Sold units / (sold units + on hand). Green at 60%+, watch at 35-60%, red below 35%.") : "",c:!salesSellThrough.available ? C.muted : salesSellThrough.rate >= 60 ? C.green : salesSellThrough.rate >= 35 ? C.warn : C.red},
          {label:"Revenue / Door",val:officialInlineTotalsMissing ? t("common.missing", "Missing") : salesDoorStats.activeDoors ? fmtMoney(salesDoorStats.revenuePerDoor) : t("common.notAvailable", "N/A"),exact:officialInlineTotalsMissing || !salesDoorStats.activeDoors ? "" : fmtCurrency(salesDoorStats.revenuePerDoor),sub:salesDoorStats.activeDoors ? `Average of ${salesDoorStats.weeklyPeriodCount.toLocaleString()} weekly period${salesDoorStats.weeklyPeriodCount===1 ? "" : "s"}` : "",c:officialInlineTotalsMissing ? C.muted : salesDoorHealth.col},
        ].map(k => (
          <KpiCard key={k.label} label={k.label} value={k.val} sub={k.sub} color={k.c} exact={k.exact}/>
        ))}
      </div>

      <Panel title={`Inline Daily Sales Trend / ${context}`}>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={chartData} margin={{top:5,right:8,bottom:5,left:0}}>
            <CartesianGrid stroke={C.border} strokeDasharray="2 5" vertical={false}/>
            <XAxis dataKey="label" tick={{fontSize:10,fill:C.muted,fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif"}} axisLine={false} tickLine={false} interval="preserveStartEnd"/>
            <YAxis tick={{fontSize:10,fill:C.muted,fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif"}} axisLine={false} tickLine={false} tickFormatter={fmtCompactMoney}/>
            <Tooltip content={<TT col={product?.col||C.accent}/>}/>
            <Line type="monotone" dataKey="rev" stroke={product?.col||C.accent} strokeWidth={2.5}
              dot={(props)=>{
                const fn=refLines.find(f=>f.key===props.payload?.label);
                if(!fn)return (<g key={`sd-${props.payload?.label}`}/>);
                const col=FN_TYPES[fn.type]?.col||C.accent;
                return (<g key={`sd-${props.payload?.label}`} style={{pointerEvents:"none"}}><circle cx={props.cx} cy={props.cy} r={4.75} fill={C.card} stroke={col} strokeWidth={2}/></g>);
              }}
              activeDot={{r:5,fill:product?.col||C.accent,strokeWidth:0}}
            />
          </LineChart>
        </ResponsiveContainer>
        <div style={{display:"flex",gap:14,flexWrap:"wrap",fontSize:10,color:C.muted,marginTop:6}}>
          <span><span style={{color:product?.col||C.accent}}>Solid</span> dollar sales</span>
          {refLines.length > 0 && <span><span style={{color:C.accent}}>Outlined dots</span> mark footnote days; hover for context.</span>}
          {period.bestWeek&&<span>Best day: <span style={{color:C.text}}>{period.bestWeek.date}</span> / {fmtMoney(period.bestWeek.rev)}</span>}
        </div>
        {chartData.length===0&&<div style={{textAlign:"center",padding:"24px 0",fontSize:11,color:C.muted}}>No sales data for this filter combination.</div>}
      </Panel>

      </>}
      {(salesChannel === "online" || displayOnlineSales.length > 0) && (
        <OnlineSalesSection rows={filteredOnlineSales} allRows={displayOnlineSales} product={product} dateRange={dateRange} storeContext={[salesRegion, salesState, store?.name].filter(Boolean).join(" / ")} footnotes={scopedFootnotes} productMeta={productMeta}/>
      )}
      {filteredPpcRows.length > 0 && (
        <PpcPerformanceSection rows={filteredPpcRows} allRows={displayPpcRows} product={product} dateRange={dateRange} context={[salesRegion, salesState, store?.name].filter(Boolean).join(" / ")} productMeta={productMeta}/>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// STORE SALES DIGEST
// ═══════════════════════════════════════════════════════════════

function OnlineSalesSection({ rows, allRows, product, dateRange, storeContext, footnotes = [], productMeta = {} }) {
  const { label:uiLabel } = useUiText();
  const col = product?.col || C.blue;
  const notesByDate = useMemo(() => {
    const map = new Map();
    footnotes.forEach(fn => {
      const note = chartNote(fn, 46);
      const list = map.get(fn.date) || [];
      const sig = `${note.type}|${note.title}|${note.preview}`;
      if (!list.some(existing => `${existing.type}|${existing.title}|${existing.preview}` === sig)) list.push(note);
      map.set(fn.date, list);
    });
    return map;
  }, [footnotes]);
  const chartData = useMemo(() => {
    const byDate = _.groupBy(rows, "date");
    return Object.keys(byDate).sort().map(date => {
      const groupRows = byDate[date];
      return {
        date,
        label:salesTrendDateLabel(date),
        rev:_.sumBy(groupRows, "rev"),
        units:_.sumBy(groupRows, "units"),
        orders:_.sumBy(groupRows, "orders"),
        sessions:_.sumBy(groupRows, "sessions"),
        adSpend:_.sumBy(groupRows, "adSpend"),
        notes:notesByDate.get(date) || [],
      };
    });
  }, [rows, notesByDate]);
  const totals = useMemo(() => ({
    rev:_.sumBy(rows, "rev"),
    units:_.sumBy(rows, "units"),
    orders:_.sumBy(rows, "orders"),
    sessions:_.sumBy(rows, "sessions"),
    adSpend:_.sumBy(rows, "adSpend"),
  }), [rows]);
  const revenueLift = useMemo(() => {
    const mid = Math.floor(chartData.length / 2);
    const first = _.sumBy(chartData.slice(0, mid), "rev");
    const second = _.sumBy(chartData.slice(mid), "rev");
    return { delta:second - first, pct:pctChange(second, first) };
  }, [chartData]);
  const productRows = useMemo(() => _.orderBy(Object.entries(_.groupBy(rows, r => productLabelForValue(r.pid || r.product, productMeta) || "Unassigned"))
    .map(([name, groupRows]) => {
      const pid = groupRows.find(r => r.pid)?.pid;
      const prod = productWithMeta(pid || name, productMeta);
      return { name, rev:_.sumBy(groupRows, "rev"), units:_.sumBy(groupRows, "units"), col:prod?.col || C.blue };
    }), "rev", "desc"), [rows, productMeta]);
  const maxProductRev = Math.max(1, ...productRows.map(r => r.rev));
  const avgUnit = totals.units > 0 ? totals.rev / totals.units : 0;
  const refLines = useMemo(() => (
    chartData.filter(c => c.notes?.length).map(c => {
      const first = c.notes[0];
      return { ...first, key:c.label, notes:c.notes };
    })
  ), [chartData]);
  const hasAnyOnlineRows = allRows.length > 0;

  return (
    <Panel title="Daily Online Sales Trend">

      {rows.length > 0 ? (
        <>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(135px,1fr))",gap:8,marginBottom:12}}>
            {[
              { label:"Online Revenue", val:fmtCompactMoney(totals.rev), c:C.blue },
              { label:"Units Sold", val:totals.units.toLocaleString(), c:C.blue },
              { label:"Revenue Lift", val:fmtGrowth(revenueLift.pct), sub:revenueLift.pct === null ? "Needs more history" : `${fmtCompactMoney(Math.abs(revenueLift.delta))} ${revenueLift.delta >= 0 ? "up" : "down"} vs first half`, c:revenueLift.pct === null ? C.muted : revenueLift.pct >= 0 ? C.green : C.red },
            ].map(k => (
              <div key={k.label} style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 12px",minWidth:0}}>
                <div style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:5}}>{uiLabel(k.label)}</div>
                <div style={{...MONO,fontSize:17,fontWeight:500,color:k.c,marginBottom:3,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{k.val}</div>
                <div style={{fontSize:10,color:C.muted,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{k.sub}</div>
              </div>
            ))}
          </div>

          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData} margin={{top:4,right:8,bottom:4,left:0}}>
              <CartesianGrid stroke={C.border} strokeDasharray="2 5" vertical={false}/>
              <XAxis dataKey="label" tick={{fontSize:10,fill:C.muted,fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif"}} axisLine={false} tickLine={false} interval="preserveStartEnd"/>
              <YAxis tick={{fontSize:10,fill:C.muted,fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif"}} axisLine={false} tickLine={false} tickFormatter={fmtCompactMoney}/>
              <Tooltip content={<TT col={C.blue}/>}/>
              <Line type="monotone" dataKey="rev" stroke={C.blue} strokeWidth={2.5}
                dot={(props)=>{
                  const fn=refLines.find(f=>f.key===props.payload?.label);
                  if(!fn)return (<g key={`os-${props.payload?.label}`}/>);
                  const marker=FN_TYPES[fn.type]?.col||C.accent;
                  return (<g key={`os-${props.payload?.label}`} style={{pointerEvents:"none"}}><circle cx={props.cx} cy={props.cy} r={4.75} fill={C.card} stroke={marker} strokeWidth={2}/></g>);
                }}
                activeDot={{r:5,fill:C.blue,strokeWidth:0}}
              />
            </LineChart>
          </ResponsiveContainer>
          <div style={{display:"flex",gap:14,flexWrap:"wrap",fontSize:10,color:C.muted,marginTop:6}}>
            <span><span style={{color:C.blue}}>Solid</span> online revenue</span>
            {refLines.length > 0 && <span><span style={{color:C.accent}}>Outlined dots</span> mark footnote days; hover for context.</span>}
          </div>

          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:12,marginTop:12}}>
            <div>
              <div style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Product Mix</div>
              {productRows.slice(0,6).map(row => (
                <div key={row.name} style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) 92px",gap:10,alignItems:"center",marginBottom:8}}>
                  <div style={{minWidth:0}}>
                    <div style={{display:"flex",justifyContent:"space-between",gap:8,fontSize:11,color:C.text,marginBottom:4}}>
                      <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{row.name}</span>
                      <span style={{...MONO,color:row.col,flexShrink:0}}>{fmtCompactMoney(row.rev)}</span>
                    </div>
                    <div style={{height:5,background:C.card,borderRadius:4,overflow:"hidden"}}><div style={{height:"100%",width:`${Math.max(3,(row.rev/maxProductRev)*100)}%`,background:row.col}}/></div>
                  </div>
                  <div style={{fontSize:10,color:C.muted,textAlign:"right"}}>{row.units.toLocaleString()} units</div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.1fr) minmax(260px,0.9fr)",gap:12,alignItems:"stretch"}}>
          <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:14}}>
            <div style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Online_Sales_Raw columns</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:6}}>
              {["Date","Product","Channel","Revenue","Units","Sessions","Ad Spend","Notes"].map((name, i) => (
                <div key={name} style={{background:C.card,border:`1px solid ${i < 4 ? col+"55" : C.border}`,borderRadius:6,padding:"7px 8px",fontSize:10,color:i < 4 ? C.text : C.muted}}>
                  {name}{i < 4 && <span style={{color:col}}> *</span>}
                </div>
              ))}
            </div>
          </div>
          <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:14}}>
            <div style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Sample row</div>
            <div style={{fontSize:11,color:C.text,lineHeight:1.8}}>
              <div><span style={{color:C.muted}}>Date:</span> 2026-03-01</div>
              <div><span style={{color:C.muted}}>Product:</span> Lumen Grove Daily Cream</div>
              <div><span style={{color:C.muted}}>Channel:</span> Costco.com</div>
              <div><span style={{color:C.muted}}>Revenue:</span> $5,200</div>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

function MetaAdsSection({ rows = [], product = null, dateRange = {}, context = "" }) {
  const { label:uiLabel } = useUiText();
  const metaRows = useMemo(() => (rows || []).filter(isMetaPpcRow), [rows]);
  const totals = useMemo(() => sumMetaRows(metaRows), [metaRows]);
  const startEvents = useMemo(() => metaCampaignStartEvents(metaRows), [metaRows]);
  const dailyData = useMemo(() => _.sortBy(Object.entries(_.groupBy(metaRows, row => ppcSnapshotDate(row) || "No date")).map(([date, groupRows]) => {
    const dailyTotals = sumMetaRows(groupRows);
    return {
      date,
      label:date === "No date" ? "No date" : salesTrendDateLabel(date),
      spend:dailyTotals.spend,
      impressions:dailyTotals.impressions,
      clicks:dailyTotals.clicks,
      videoPlays:dailyTotals.videoPlays,
    };
  }), "date"), [metaRows]);
  const adSetRows = useMemo(() => _.orderBy(Object.entries(_.groupBy(metaRows, row => row.adSetName || row.rawCampaign || row.campaign || "Unassigned ad set")).map(([name, groupRows]) => ({
    name,
    ...sumMetaRows(groupRows),
  })), ["spend", "impressions"], ["desc", "desc"]).slice(0, 6), [metaRows]);
  if (!metaRows.length) return null;

  return (
    <Panel title="Meta Advertising">
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:8,marginBottom:12}}>
        {[
          { label:"Spend", val:fmtCompactMoney(totals.spend), sub:`${totals.rows.toLocaleString()} reporting rows`, c:FN_TYPES.meta.col },
          { label:"Reach", val:totals.reach.toLocaleString(), sub:`${totals.impressions.toLocaleString()} impressions`, c:C.text },
          { label:"Link Clicks", val:totals.clicks.toLocaleString(), sub:`CTR ${fmtPercent(totals.ctr, 2)}`, c:C.blue },
          { label:"CPC", val:fmtCurrency(totals.avgCpc), sub:`CPM ${fmtCurrency(totals.cpm)}`, c:C.accent },
          { label:"Video Plays", val:totals.videoPlays.toLocaleString(), sub:`${totals.videoPlays100.toLocaleString()} completed`, c:C.green },
        ].map(card => (
          <div key={card.label} style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 12px",minWidth:0}}>
            <div style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:5}}>{uiLabel(card.label)}</div>
            <div style={{...MONO,fontSize:17,fontWeight:500,color:card.c,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{card.val}</div>
            <div style={{fontSize:10,color:C.muted,marginTop:3,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{card.sub}</div>
          </div>
        ))}
      </div>

      <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 12px",minWidth:0}}>
          <div style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Daily Meta Spend</div>
          {dailyData.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={dailyData} margin={{top:4,right:8,bottom:4,left:0}}>
                <CartesianGrid stroke={C.border} strokeDasharray="2 5" vertical={false}/>
                <XAxis dataKey="label" tick={{fontSize:10,fill:C.muted,fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif"}} axisLine={false} tickLine={false} interval="preserveStartEnd"/>
                <YAxis width={46} tick={{fontSize:10,fill:C.muted,fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif"}} axisLine={false} tickLine={false} tickFormatter={fmtCompactMoney}/>
                <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
                  <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:"9px 11px", fontSize:11, minWidth:180, boxShadow:"0 14px 34px rgba(15,23,42,0.12)" }}>
                    <div style={{ ...MONO, color:C.muted, fontSize:10, marginBottom:7 }}>{label}</div>
                    {payload.map(p => <div key={p.dataKey} style={{ display:"flex", justifyContent:"space-between", gap:16, marginBottom:5 }}><span style={{ color:C.muted }}>{p.name}</span><span style={{ ...MONO, color:p.color, fontWeight:500 }}>{p.dataKey === "spend" ? fmtCompactMoney(p.value) : Number(p.value || 0).toLocaleString()}</span></div>)}
                  </div>
                ) : null}/>
                <Bar dataKey="spend" name="Spend" fill={FN_TYPES.meta.col} radius={[3,3,0,0]} opacity={0.84} maxBarSize={34}/>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={{fontSize:11,color:C.muted,padding:"28px 0",textAlign:"center"}}>No dated Meta rows match this view.</div>
          )}
        </div>
    </Panel>
  );
}

function ProgrammaticPacingSection({ rows = [], productMeta = {} }) {
  const { lang, label:uiLabel } = useUiText();
  const latestDate = useMemo(() => (rows || []).map(ppcSnapshotDate).filter(Boolean).sort().at(-1) || "", [rows]);
  const latestRows = useMemo(() => latestDate ? rows.filter(row => ppcSnapshotDate(row) === latestDate) : rows, [rows, latestDate]);
  const summary = useMemo(() => latestRows.find(row => row.level === "campaign") || latestRows[0] || {}, [latestRows]);
  const creativeRows = useMemo(() => _.orderBy(latestRows.filter(row => row.level === "line_item"), ["lineItemId"], ["asc"]), [latestRows]);
  const periodRows = useMemo(() => _.orderBy(latestRows.filter(row => row.level === "period"), ["periodStart", "lineItemId"], ["asc", "asc"]), [latestRows]);
  const productLabel = productLabelForValue(summary.pid || summary.product, productMeta) || summary.product || "Unassigned";
  const audience = summary.audience || summary.rawCampaign || summary.campaign || "Programmatic Audience";
  const impressions = Number(summary.impressions || _.sumBy(creativeRows, row => Number(row.impressions || 0)));
  const clicks = Number(summary.clicks || _.sumBy(creativeRows, row => Number(row.clicks || 0)));
  const reach = Number(summary.reach || 0);
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : Number(summary.ctr || 0);
  const flightProgress = Math.max(0, Math.min(100, Number(summary.flightProgress || 0)));
  const source = String(summary.source || "").replace(/^.*[\\/]/, "");
  if (!rows.length) return null;

  return (
    <Panel title={lang === "ko" ? "프로그래매틱 오디언스 성과" : "Programmatic Audience Performance"}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:10,flexWrap:"wrap",marginBottom:12}}>
        <div style={{minWidth:0}}>
          <div style={{fontSize:12,fontWeight:600,color:C.text}}>{productLabel} / {audience}</div>
          <div style={{fontSize:10,color:C.muted,marginTop:3}}>
            {PROGRAMMATIC_PARTNER}
            {latestDate ? ` • ${lang === "ko" ? "보고 기준" : "reported through"} ${latestDate}` : ""}
            {summary.start && summary.end ? ` • ${lang === "ko" ? "집행 기간" : "flight"} ${summary.start}–${summary.end}` : ""}
          </div>
        </div>
        <div style={{fontSize:10,color:C.blue,background:`${C.blue}12`,border:`1px solid ${C.blue}30`,borderRadius:999,padding:"4px 8px",whiteSpace:"nowrap"}}>
          {lang === "ko" ? "유료 미디어 참고 지표" : "Paid-media context only"}
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:8,marginBottom:12}}>
        {[
          { label:lang === "ko" ? "고유 도달" : "Unique Reach", val:reach.toLocaleString(), c:C.green },
          { label:"Impressions", val:impressions.toLocaleString(), c:C.text },
          { label:"Clicks", val:clicks.toLocaleString(), c:C.blue },
          { label:"CTR", val:fmtPercent(ctr, 2), c:C.accent },
        ].map(card => (
          <div key={card.label} style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 12px",minWidth:0}}>
            <div style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:5}}>{uiLabel(card.label)}</div>
            <div style={{...MONO,fontSize:17,fontWeight:500,color:card.c,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{card.val}</div>
          </div>
        ))}
      </div>

      {(flightProgress > 0 || summary.daysRemaining > 0) && (
        <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 12px",marginBottom:12}}>
          <div style={{display:"flex",justifyContent:"space-between",gap:8,fontSize:10,color:C.muted,marginBottom:6}}>
            <span>{lang === "ko" ? "집행 페이싱" : "Flight pacing"}</span>
            <span style={{...MONO,color:C.text}}>{flightProgress ? `${flightProgress.toFixed(0)}%` : ""}{summary.daysRemaining ? ` • ${summary.daysRemaining} ${lang === "ko" ? "일 남음" : "days remaining"}` : ""}</span>
          </div>
          <div style={{height:6,background:C.card,borderRadius:999,overflow:"hidden"}}><div style={{height:"100%",width:`${flightProgress}%`,background:C.blue,borderRadius:999}}/></div>
        </div>
      )}

      {creativeRows.length > 0 && (
        <div style={{marginBottom:periodRows.length || summary.pacingNotes ? 12 : 0}}>
          <div style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>{lang === "ko" ? "크리에이티브 성과" : "Creative performance"}</div>
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
              <thead><tr>{[
                lang === "ko" ? "크리에이티브" : "Creative",
                "Impressions",
                "Clicks",
                "CTR",
              ].map((heading, index) => <th key={heading} style={{textAlign:index ? "right" : "left",color:C.muted,...MONO,fontSize:10,textTransform:"uppercase",letterSpacing:0.8,padding:"0 8px 7px",borderBottom:`1px solid ${C.border}`}}>{heading}</th>)}</tr></thead>
              <tbody>{creativeRows.map(row => (
                <tr key={row.id}>
                  <td style={{padding:"8px",borderBottom:`1px solid ${C.border}`,color:C.text,fontWeight:500}}>{row.lineItemId || row.rawCampaign || "Creative"}</td>
                  <td style={{padding:"8px",borderBottom:`1px solid ${C.border}`,textAlign:"right",...MONO}}>{Number(row.impressions || 0).toLocaleString()}</td>
                  <td style={{padding:"8px",borderBottom:`1px solid ${C.border}`,textAlign:"right",...MONO,color:C.blue}}>{Number(row.clicks || 0).toLocaleString()}</td>
                  <td style={{padding:"8px",borderBottom:`1px solid ${C.border}`,textAlign:"right",...MONO,color:C.accent}}>{fmtPercent(row.ctr, 2)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {periodRows.length > 0 && (
        <div style={{marginBottom:summary.pacingNotes ? 12 : 0}}>
          <div style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>{lang === "ko" ? "월별 크리에이티브 성과" : "Monthly creative performance"}</div>
          <div style={{overflowX:"auto",maxHeight:250}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
              <thead><tr>{[
                lang === "ko" ? "월" : "Month",
                lang === "ko" ? "크리에이티브" : "Creative",
                "Impressions",
                "Clicks",
                "CTR",
              ].map((heading, index) => <th key={heading} style={{position:"sticky",top:0,background:C.card,textAlign:index > 1 ? "right" : "left",color:C.muted,...MONO,fontSize:10,textTransform:"uppercase",letterSpacing:0.8,padding:"0 8px 7px",borderBottom:`1px solid ${C.border}`}}>{heading}</th>)}</tr></thead>
              <tbody>{periodRows.map(row => (
                <tr key={row.id}>
                  <td style={{padding:"8px",borderBottom:`1px solid ${C.border}`,color:C.muted}}>{row.reportingPeriod || row.periodStart}</td>
                  <td style={{padding:"8px",borderBottom:`1px solid ${C.border}`,color:C.text,fontWeight:500}}>{row.lineItemId || "Creative"}</td>
                  <td style={{padding:"8px",borderBottom:`1px solid ${C.border}`,textAlign:"right",...MONO}}>{Number(row.impressions || 0).toLocaleString()}</td>
                  <td style={{padding:"8px",borderBottom:`1px solid ${C.border}`,textAlign:"right",...MONO,color:C.blue}}>{Number(row.clicks || 0).toLocaleString()}</td>
                  <td style={{padding:"8px",borderBottom:`1px solid ${C.border}`,textAlign:"right",...MONO,color:C.accent}}>{fmtPercent(row.ctr, 2)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}

      {summary.pacingNotes && (
        <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 12px",fontSize:11,lineHeight:1.55,color:C.text}}>
          <span style={{color:C.muted}}>{lang === "ko" ? "페이싱 노트:" : "Pacing note:"}</span> {summary.pacingNotes}
          {source ? <div style={{fontSize:10,color:C.muted,marginTop:5}}>{lang === "ko" ? "소스" : "Source"}: {source}</div> : null}
        </div>
      )}
    </Panel>
  );
}

function PpcPerformanceSection({ rows = [], allRows = [], product = null, dateRange = {}, context = "", productMeta = {} }) {
  const { label:uiLabel } = useUiText();
  const programmaticRows = useMemo(() => (rows || []).filter(isProgrammaticPacingRow), [rows]);
  const regularRows = useMemo(() => (rows || []).filter(row => !isProgrammaticPacingRow(row)), [rows]);
  const totals = useMemo(() => sumPpcRows(regularRows), [regularRows]);
  const performanceRows = useMemo(() => preferredPpcPerformanceRows(regularRows), [regularRows]);
  const chartData = useMemo(() => {
    const byDate = _.groupBy(performanceRows, row => ppcSnapshotDate(row) || "No date");
    return Object.keys(byDate).sort().map(date => {
      const groupRows = byDate[date];
      const groupTotals = sumPpcRows(groupRows);
      return {
        date,
        label:date === "No date" ? "No date" : salesTrendDateLabel(date),
        sales:groupTotals.attributedSales,
        spend:groupTotals.spend,
        clicks:groupTotals.clicks,
        impressions:groupTotals.impressions,
        roas:groupTotals.roas,
      };
    });
  }, [performanceRows]);
  const productRows = useMemo(() => ppcProductMixRows(regularRows, productMeta), [regularRows, productMeta]);
  const maxProductSales = Math.max(1, ...productRows.map(row => row.totalSales));
  const col = product?.col || C.blue;

  return (
    <>
      {programmaticRows.length > 0 && <ProgrammaticPacingSection rows={programmaticRows} productMeta={productMeta}/>}
      {(regularRows.length > 0 || programmaticRows.length === 0) && <Panel title="Paid Media Performance">

      {regularRows.length > 0 ? (
        <>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(135px,1fr))",gap:8,marginBottom:12}}>
            {[
              { label:"Paid-Media Sales", val:fmtCompactMoney(totals.totalSales), sub:totals.hasLt ? `L7D: ${fmtCompactMoney(totals.attributedSales)}` : null, c:C.blue },
              { label:"Paid-Media Spend", val:fmtCompactMoney(totals.totalSpend), sub:totals.hasLt ? `L7D: ${fmtCompactMoney(totals.spend)}` : null, c:C.accent },
              { label:"Paid-Media ROAS", val:formatRoas(totals.totalRoas), c:totals.totalRoas >= 3 ? C.green : totals.totalRoas > 0 ? C.warn : C.muted },
              { label:"Impressions", val:totals.totalImpressions.toLocaleString(), sub:totals.hasLt ? `L7D: ${totals.impressions.toLocaleString()}` : null, c:C.text },
              ...(totals.missedSales || totals.missedSpend ? [{ label:"Missed Opportunity", val:fmtCompactMoney(totals.missedSales), sub:`${fmtCompactMoney(totals.missedSpend)} missed spend`, c:C.accent }] : []),
            ].map(k => (
              <div key={k.label} style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 12px",minWidth:0}}>
                <div style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:5}}>{uiLabel(k.label)}</div>
                <div style={{...MONO,fontSize:17,fontWeight:500,color:k.c,marginBottom:3,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{k.val}</div>
                <div style={{fontSize:10,color:C.muted,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{k.sub}</div>
              </div>
            ))}
          </div>

          {chartData.length > 0 && (
            <ResponsiveContainer width="100%" height={230}>
              <BarChart data={chartData} margin={{top:4,right:8,bottom:4,left:0}}>
                <CartesianGrid stroke={C.border} strokeDasharray="2 5" vertical={false}/>
                <XAxis dataKey="label" tick={{fontSize:10,fill:C.muted,fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif"}} axisLine={false} tickLine={false} interval="preserveStartEnd"/>
                <YAxis tick={{fontSize:10,fill:C.muted,fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif"}} axisLine={false} tickLine={false} tickFormatter={fmtCompactMoney}/>
                <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
                  <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:"9px 11px", fontSize:11, minWidth:190, boxShadow:"0 14px 34px rgba(15,23,42,0.12)" }}>
                    <div style={{ ...MONO, color:C.muted, fontSize:10, marginBottom:7 }}>{label}</div>
                    {payload.map(p => (
                      <div key={p.dataKey} style={{ display:"flex", justifyContent:"space-between", gap:16, marginBottom:5 }}>
                        <span style={{ color:C.muted }}>{p.dataKey === "sales" ? "Attributed Sales" : "Spend"}</span>
                        <span style={{ ...MONO, color:p.color, fontWeight:500 }}>{fmtCompactMoney(p.value)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}/>
                <Bar dataKey="sales" name="Paid-Media Sales" fill={C.blue} radius={[3,3,0,0]} opacity={0.82} maxBarSize={34}/>
                <Bar dataKey="spend" name="Paid-Media Spend" fill={C.accent} radius={[3,3,0,0]} opacity={0.72} maxBarSize={34}/>
              </BarChart>
            </ResponsiveContainer>
          )}

          {productRows.length > 1 && (
            <div style={{ marginTop:12 }}>
              <div style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Paid-Media Product Mix</div>
              {productRows.slice(0,6).map(row => (
                <div key={row.name} style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) 118px",gap:10,alignItems:"center",marginBottom:8}}>
                  <div style={{minWidth:0}}>
                    <div style={{display:"flex",justifyContent:"space-between",gap:8,fontSize:11,color:C.text,marginBottom:4}}>
                      <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{row.name}</span>
                      <span style={{...MONO,color:row.col,flexShrink:0}}>{fmtCompactMoney(row.totalSales)}</span>
                    </div>
                    <div style={{height:5,background:C.card,borderRadius:4,overflow:"hidden"}}><div style={{height:"100%",width:`${Math.max(3,(row.totalSales/maxProductSales)*100)}%`,background:row.col}}/></div>
                  </div>
                  <div style={{fontSize:10,color:C.muted,textAlign:"right"}}>{formatRoas(row.totalRoas)} ROAS</div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div style={{background:C.bg,border:`1px solid ${C.border}`,borderRadius:8,padding:14,color:C.muted,fontSize:11,lineHeight:1.7}}>
          No paid-media rows match this filter. If you uploaded a Criteo or Meta report, check PPC_Product_Map, Product_ID, or Campaign_ID when the media product or campaign name differs from BYOU's product and campaign names.
        </div>
      )}
    </Panel>}
    </>
  );
}

// PRODUCTS VIEW
// ═══════════════════════════════════════════════════════════════

function InventoryTable({ title, rows, empty, tableKey = "", initialLimit = 20, isExpanded = false, onToggleExpanded = () => {}, onRevoke = null }) {
  const { lang, t, label:uiLabel } = useUiText();
    const [query, setQuery] = useState("");
    const [sort, setSort] = useState({ key:"sellThrough", dir:"asc" });
    const filteredRows = useMemo(() => {
      const q = query.trim().toLowerCase();
      const filtered = q ? rows.filter(row => [row.name, row.location, row.region, row.product, row.campaign, row.status.label].some(value => String(value || "").toLowerCase().includes(q))) : rows;
      return sortedRows(filtered.map(row => ({ ...row, statusLabel:row.status.label, statusSeverity:row.status.severity })), sort.key, sort.dir);
    }, [rows, query, sort]);
    const visibleRows = isExpanded ? filteredRows : filteredRows.slice(0, initialLimit);
    const setTableSort = key => setSort(prev => ({ key, dir:prev.key === key && prev.dir === "desc" ? "asc" : "desc" }));
    return (
    <Panel title={title} style={{ marginBottom:0 }}>
      {rows.length ? (
        <div style={{ overflowX:"auto" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, flexWrap:"wrap", marginBottom:10 }}>
            <div style={{ fontSize:10, color:C.muted }}>{lang === "ko" ? `${filteredRows.length.toLocaleString()}개 일치` : `${filteredRows.length.toLocaleString()} matching row${filteredRows.length===1?"":"s"}`}</div>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
              <input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder={t("common.searchCoverage", "Search coverage")} style={{ ...INP, width:170, padding:"7px 9px" }}/>
              <SmBtn onClick={() => downloadRowsCsv(`${tableKey}-coverage.csv`, [
                { label:"Scope", value:r => r.name },
                { label:"Product", value:r => r.product },
                { label:"Campaign", value:r => r.campaign },
                { label:"Last Known Sale", value:r => r.lastKnownSale },
                { label:"Inventory", value:r => r.available },
                { label:"Sold Units", value:r => r.totalUnits },
                { label:"Avg Weekly", value:r => r.weeklyUnits },
                { label:"Sell-Through", value:r => `${r.sellThrough.toFixed(1)}%` },
                { label:"Status", value:r => r.status.label },
              ], filteredRows)}>{t("common.exportCsv", "Export CSV")}</SmBtn>
            </div>
          </div>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
            <thead>
              <tr>
                {[
                  ["Scope","name"],
                  ["Product","product"],
                  ["Last Known Sale","lastKnownSale"],
                  ["Inventory","available"],
                  ["Sold Units","totalUnits"],
                  ["Avg Weekly","weeklyUnits"],
                  ["Sell-Through","sellThrough"],
                  ["Status","statusSeverity"],
                ].map(([h, key]) => (
                  <th key={h} scope="col" aria-sort={sort.key === key ? (sort.dir === "desc" ? "descending" : "ascending") : "none"} style={{ textAlign:h === "Scope" || h === "Product" ? "left" : "right", color:C.muted, ...MONO, fontSize:10, textTransform:"uppercase", letterSpacing:1, padding:"0 8px 8px", borderBottom:`1px solid ${C.border}` }}><button type="button" onClick={() => setTableSort(key)} style={{ background:"none", border:"none", padding:0, margin:0, cursor:"pointer", color:"inherit", font:"inherit", letterSpacing:"inherit", textTransform:"inherit" }}>{uiLabel(h)}{sort.key === key ? sort.dir === "desc" ? " ↓" : " ↑" : ""}</button></th>
                ))}
                {onRevoke && <th scope="col" style={{ textAlign:"right", color:C.muted, ...MONO, fontSize:10, textTransform:"uppercase", letterSpacing:1, padding:"0 8px 8px", borderBottom:`1px solid ${C.border}` }}>{uiLabel("Action")}</th>}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(row => (
                <tr key={row.key}>
                  <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:C.text, minWidth:180 }}>
                    <div style={{ fontWeight:500, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", maxWidth:250 }}>{row.name}</div>
                    <div style={{ color:C.muted, fontSize:10 }}>{row.location || row.region}</div>
                  </td>
                  <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:C.text }}>
                    <div>{row.product}</div>
                  </td>
                  <td title={row.lastKnownSale || undefined} style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:C.muted, textAlign:"right", ...MONO }}>{row.lastKnownSale || "—"}</td>
                  <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:row.available <= 0 ? C.green : C.text, textAlign:"right", ...MONO, fontWeight:500 }}>{fmtUnits(row.available)}</td>
                  <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:C.blue, textAlign:"right", ...MONO }}>{fmtUnits(row.totalUnits)}</td>
                  <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:C.text, textAlign:"right", ...MONO }}>{fmtUnits(row.weeklyUnits)}</td>
                  <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:row.status.col, textAlign:"right", ...MONO }}>{row.sellThrough.toFixed(1)}%</td>
                  <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, textAlign:"right" }}>
                    <StatusChip label={row.ownerInventoryResult?.lastKnown ? (lang === "ko" ? "마지막 확인 재고" : "Last known inventory") : row.status.label} col={row.ownerInventoryResult?.lastKnown ? C.muted : row.status.col}/>
                  </td>
                  {onRevoke && <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, textAlign:"right" }}>{row.approvedAllocation?.approvalSource === "manual_runtime" ? <button type="button" aria-label={lang === "ko" ? `${row.name} ${row.product}, 캠페인 ${row.campaignId}, ${row.date}, ${fmtUnits(row.available)}개 수동 재고 승인 제거` : `Remove manual inventory approval for ${row.product} at ${row.name}, campaign ${row.campaignId}, ${row.date}, ${fmtUnits(row.available)} units`} onClick={() => onRevoke(row)} style={{ whiteSpace:"nowrap", padding:"6px 9px", borderRadius:7, border:"1px solid #9B2C2C66", background:"#9B2C2C10", color:"#9B2C2C", cursor:"pointer", fontSize:10, fontWeight:600, ...SANS }}>{lang === "ko" ? "승인 제거" : "Remove Approval"}</button> : <span style={{ color:C.muted, fontSize:10 }}>-</span>}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {filteredRows.length > initialLimit && (
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:12, marginTop:10, flexWrap:"wrap" }}>
              <div style={{ fontSize:10, color:C.muted }}>{lang === "ko" ? (isExpanded ? `전체 ${filteredRows.length.toLocaleString()}개 재고 행 표시` : `처음 ${initialLimit}개 재고 행 표시`) : (isExpanded ? `Showing all ${filteredRows.length.toLocaleString()} inventory rows.` : `Showing the first ${initialLimit} inventory rows.`)}</div>
              <button onClick={onToggleExpanded} style={{ padding:"7px 12px", borderRadius:7, border:`1px solid ${C.border}`, background:C.bg, color:C.accent, cursor:"pointer", fontSize:11, ...SANS, fontWeight:500 }}>
                {isExpanded ? `${t("common.showTop", "Show first")} ${initialLimit}` : `${t("common.showAll", "Show all")} ${filteredRows.length.toLocaleString()}`}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:16, color:C.muted, fontSize:11, lineHeight:1.7 }}>{empty}</div>
      )}
    </Panel>
    );
  }

function inventoryValidationReason(item, lang = "en") {
  const evidence = item?.inventoryValidation || {};
  const reasons = [];
  const pendingStatus = String(item?.approvedAllocation?.inventoryStatus || "").trim();
  const pendingStatusKey = pendingStatus.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (["receiving", "intransit"].includes(pendingStatusKey)) {
    reasons.push(lang === "ko"
      ? `승인 증빙 상태가 ${pendingStatus}이므로 현재 보유 재고로 확인되지 않았습니다. 실제 입고 후 On hand 상태로 다시 확인해야 합니다.`
      : `Approval evidence says ${pendingStatus}, which does not confirm currently available stock. Recheck after receipt and confirm On hand.`);
  }
  if (evidence.reasonCodes?.includes("stale-inventory-balance")) {
    reasons.push(lang === "ko"
      ? `마지막 재고 잔액 날짜 ${evidence.latestDate || "알 수 없음"}가 선택한 종료일 ${evidence.asOfDate || "알 수 없음"}보다 이전이므로 최신 창고 확인이 필요합니다.`
      : `The last inventory balance is from ${evidence.latestDate || "an unknown date"}, before the selected end ${evidence.asOfDate || "an unknown date"}; fresh warehouse confirmation is required.`);
  }
  if (evidence.reasonCodes?.includes("current-at-or-above-review-threshold")) {
    reasons.push(lang === "ko"
      ? `현재 잔액 ${fmtUnits(evidence.latestOnHand)}개가 1,000개 수동 검토 기준 이상입니다.`
      : `Current balance ${fmtUnits(evidence.latestOnHand)} is at or above the 1,000-unit manual-review threshold.`);
  } else if (evidence.reasonCodes?.includes("recent-peak-at-or-above-review-threshold")) {
    reasons.push(lang === "ko"
      ? `최근 최고 잔액 ${fmtUnits(evidence.recentPeakOnHand)}개가 1,000개 수동 검토 기준 이상입니다.`
      : `Recent peak ${fmtUnits(evidence.recentPeakOnHand)} is at or above the 1,000-unit manual-review threshold.`);
  }
  if (evidence.reasonCodes?.includes("recent-large-inventory-addition")) {
    reasons.push(lang === "ko"
      ? `${evidence.largestAdditionDate || "최근"}에 추정 입고 +${fmtUnits(evidence.largestAddition)}개에 대한 근거 확인이 필요합니다.`
      : `Implied addition of +${fmtUnits(evidence.largestAddition)} units on ${evidence.largestAdditionDate || "a recent day"} needs source rationale.`);
  }
  if (evidence.reasonCodes?.includes("recent-large-inventory-removal")) {
    reasons.push(lang === "ko"
      ? `${evidence.largestRemovalDate || "최근"}에 추정 재고 감소 -${fmtUnits(evidence.largestRemoval)}개에 대한 이동, 폐기, 반품 또는 수량 조정 근거가 필요합니다.`
      : `Implied removal of -${fmtUnits(evidence.largestRemoval)} units on ${evidence.largestRemovalDate || "a recent day"} needs transfer, write-off, return, disposal, or count-correction evidence.`);
  }
  if (evidence.reasonCodes?.includes("online-inventory-replenishment")) {
    reasons.push(lang === "ko"
      ? `${evidence.largestAdditionDate || "최근"}에 온라인 재고가 +${fmtUnits(evidence.largestAddition)}개 증가한 것으로 추정됩니다. 입고 또는 이동 증빙으로 ${fmtUnits(evidence.largestAdditionThreshold)}개 검토 기준을 초과한 이유를 확인해야 합니다.`
      : `Online inventory implies a +${fmtUnits(evidence.largestAddition)} unit replenishment on ${evidence.largestAdditionDate || "a recent day"}, above the ${fmtUnits(evidence.largestAdditionThreshold)} unit relative review threshold; receipt or transfer evidence is required.`);
  }
  if (evidence.reasonCodes?.includes("unverified-allocation")) {
    reasons.push(lang === "ko"
      ? "판매 근거 없이 양수 재고가 보고되었습니다. 입고 또는 이동 증빙과 검토 승인이 필요합니다."
      : "Positive inventory was reported without credible net sales. Receipt or transfer evidence and reviewer approval are required.");
  }
  if (evidence.reasonCodes?.includes("current-at-or-above-watch-threshold")) {
    reasons.push(lang === "ko"
      ? `현재 잔액 ${fmtUnits(evidence.latestOnHand)}개가 700개 주의 기준 이상입니다.`
      : `Current balance ${fmtUnits(evidence.latestOnHand)} is at or above the 700-unit watch level.`);
  }
  return reasons.join(" ");
}

function InventoryApprovalModal({ row, onClose, onApprove }) {
  const { lang } = useUiText();
  const accessibleMuted = "#4B5563";
  const accessibleBorder = "#6B7280";
  const accessibleError = "#991B1B";
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(typeof document !== "undefined" ? document.activeElement : null);
  const requestAbortRef = useRef(null);
  const [idempotencyKey] = useState(() => globalThis.crypto?.randomUUID?.() || `inventory-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const [receiptReference, setReceiptReference] = useState("");
  const [receiptDate, setReceiptDate] = useState(() => localDateKey());
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [approvalPassword, setApprovalPassword] = useState("");
  const [confirmation, setConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    return () => {
      requestAbortRef.current?.abort();
      const previous = previousFocusRef.current;
      const target = previous?.isConnected ? previous : document.querySelector('[data-inventory-focus-fallback="true"]');
      if (typeof target?.focus === "function") target.focus();
    };
  }, []);

  const closeModal = useCallback(() => {
    requestAbortRef.current?.abort();
    onClose();
  }, [onClose]);

  useEffect(() => {
    const onKey = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])]
        .filter(element => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeModal]);

  const ready = receiptReference.trim()
    && receiptDate
    && adjustmentReason.trim()
    && reviewer.trim().length >= 2
    && approvalPassword
    && confirmation;
  const submit = async event => {
    event.preventDefault();
    if (!ready || busy) return;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setBusy(true);
    setError("");
    try {
      await onApprove({
        row,
        idempotencyKey,
        approvalPassword,
        confirmation,
        signal:controller.signal,
        evidence:{ receiptReference, receiptDate, adjustmentReason, reviewer },
      });
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      setApprovalPassword("");
      onClose();
    } catch (submitError) {
      if (submitError?.name === "AbortError" || controller.signal.aborted) return;
      setApprovalPassword("");
      setError(submitError.message || "This inventory fact could not be approved.");
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(4,26,44,0.48)", zIndex:1500, display:"grid", placeItems:"center", padding:16, ...SANS }}>
      <form ref={dialogRef} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="inventory-approval-title" aria-describedby="inventory-approval-description" aria-busy={busy} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:"20px 22px", width:"min(620px, calc(100vw - 32px))", maxHeight:"calc(100vh - 32px)", overflowY:"auto", boxShadow:"0 24px 70px rgba(15,23,42,0.3)" }}>
        <div id="inventory-approval-title" style={{ fontSize:15, fontWeight:600, color:C.text, marginBottom:6 }}>{lang === "ko" ? "현재 보유 재고 승인" : "Approve Current On-hand Inventory"}</div>
        <div id="inventory-approval-description" style={{ fontSize:11, color:accessibleMuted, lineHeight:1.6, marginBottom:14 }}>
          {lang === "ko"
            ? "이 승인은 기존 Costco 창고 기록의 정확한 캠페인, 날짜 및 수량에만 적용되며 14일 후 또는 사실이 변경되면 만료됩니다. 새 창고는 생성되지 않습니다."
            : "This approval applies only to this existing Costco warehouse's exact campaign, date, and quantity. It expires after 14 days or immediately when the fact changes. It never creates a new warehouse."}
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))", gap:8, background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:12, marginBottom:14 }}>
          {[
            [lang === "ko" ? "창고" : "Warehouse", row.name],
            [lang === "ko" ? "제품" : "Product", row.product],
            [lang === "ko" ? "캠페인 ID" : "Campaign ID", row.campaignId],
            [lang === "ko" ? "재고 사실" : "Inventory fact", lang === "ko" ? `${row.date} / ${fmtUnits(row.available)}개` : `${row.date} / ${fmtUnits(row.available)} units`],
          ].map(([label, value]) => (
            <div key={label} style={{ minWidth:0 }}><div style={{ ...MONO, color:accessibleMuted, fontSize:9, textTransform:"uppercase", letterSpacing:1, marginBottom:3 }}>{label}</div><div style={{ color:C.text, fontSize:11, overflowWrap:"anywhere" }}>{value || "-"}</div></div>
          ))}
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(min(190px,100%),1fr))", gap:10 }}>
          <label style={{ display:"block", fontSize:10, color:accessibleMuted }}>
            <span style={{ display:"block", marginBottom:5 }}>{lang === "ko" ? "입고, 이동 또는 실사 참조" : "Receipt, transfer, or physical-count reference"}</span>
            <input autoFocus required value={receiptReference} onChange={event => setReceiptReference(event.target.value)} maxLength={200} style={{ ...INP, border:`1px solid ${accessibleBorder}`, fontSize:12, padding:"9px 10px" }}/>
          </label>
          <label style={{ display:"block", fontSize:10, color:accessibleMuted }}>
            <span style={{ display:"block", marginBottom:5 }}>{lang === "ko" ? "최근 입고 / 실사 날짜" : "Fresh receipt / physical-count date"}</span>
            <input type="date" required value={receiptDate} min={row.date} max={localDateKey()} onChange={event => setReceiptDate(event.target.value)} style={{ ...INP, border:`1px solid ${accessibleBorder}`, fontSize:12, padding:"8px 10px" }}/>
          </label>
        </div>
        <label style={{ display:"block", fontSize:10, color:accessibleMuted, marginTop:10 }}>
          <span style={{ display:"block", marginBottom:5 }}>{lang === "ko" ? "조정 사유 / 확인 내용" : "Adjustment reason / what was verified"}</span>
          <textarea required value={adjustmentReason} onChange={event => setAdjustmentReason(event.target.value)} maxLength={1000} rows={3} style={{ ...INP, border:`1px solid ${accessibleBorder}`, resize:"vertical", fontSize:12, padding:"9px 10px" }}/>
        </label>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(min(190px,100%),1fr))", gap:10, marginTop:10 }}>
          <label style={{ display:"block", fontSize:10, color:accessibleMuted }}>
            <span style={{ display:"block", marginBottom:5 }}>{lang === "ko" ? "검토자 이름" : "Reviewer name"}</span>
            <input required minLength={2} value={reviewer} onChange={event => setReviewer(event.target.value)} maxLength={100} autoComplete="name" style={{ ...INP, border:`1px solid ${accessibleBorder}`, fontSize:12, padding:"9px 10px" }}/>
          </label>
          <label style={{ display:"block", fontSize:10, color:accessibleMuted }}>
            <span style={{ display:"block", marginBottom:5 }}>{lang === "ko" ? "재고 승인 비밀번호" : "Inventory approval password"}</span>
            <input type="password" required value={approvalPassword} onChange={event => setApprovalPassword(event.target.value)} maxLength={256} autoComplete="current-password" style={{ ...INP, border:`1px solid ${accessibleBorder}`, fontSize:12, padding:"9px 10px" }}/>
          </label>
        </div>
        <div style={{ fontSize:10, color:accessibleMuted, marginTop:6 }}>{lang === "ko" ? "별도 승인 비밀번호가 설정되지 않은 경우 대시보드 로그인 비밀번호를 다시 입력하세요." : "Re-enter the dashboard password unless a separate inventory approval password has been configured."}</div>
        <label style={{ display:"flex", alignItems:"flex-start", gap:8, marginTop:12, color:C.text, fontSize:11, lineHeight:1.5, cursor:"pointer" }}>
          <input type="checkbox" required checked={confirmation} onChange={event => setConfirmation(event.target.checked)} style={{ marginTop:3 }}/>
          <span>{lang === "ko" ? `${receiptDate}의 최근 입고 또는 실사 증빙에서 현재 보유 재고가 정확히 ${fmtUnits(row.available)}개이며 ${row.date} 원본 사실과 일치함을 확인합니다.` : `I confirm fresh receipt or physical-count evidence dated ${receiptDate} shows exactly ${fmtUnits(row.available)} units currently on hand, matching campaign ${row.campaignId}'s ${row.date} source fact.`}</span>
        </label>
        {error && <div role="alert" style={{ marginTop:12, border:`1px solid ${accessibleError}`, background:"#FFF5F5", color:accessibleError, borderRadius:7, padding:"9px 10px", fontSize:11, lineHeight:1.5 }}>{lang === "ko" ? `승인할 수 없습니다. ${error}` : error}</div>}
        <div style={{ display:"flex", justifyContent:"flex-end", gap:8, marginTop:14 }}>
          <SmBtn onClick={closeModal}>{lang === "ko" ? "취소" : "Cancel"}</SmBtn>
          <button type="submit" disabled={!ready || busy} style={{ padding:"7px 14px", borderRadius:8, border:"none", background:ready && !busy ? "#2F6F49" : C.border, color:"#FFFFFF", fontWeight:600, fontSize:12, cursor:ready && !busy ? "pointer" : "default", ...SANS }}>{busy ? (lang === "ko" ? "검증 중..." : "Validating...") : (lang === "ko" ? "현재 보유로 승인" : "Approve On Hand")}</button>
        </div>
      </form>
    </div>
  );
}

function InventoryApprovalRevocationModal({ row, onClose, onRevoke }) {
  const { lang } = useUiText();
  const accessibleMuted = "#4B5563";
  const accessibleBorder = "#6B7280";
  const accessibleError = "#991B1B";
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(typeof document !== "undefined" ? document.activeElement : null);
  const requestAbortRef = useRef(null);
  const [idempotencyKey] = useState(() => globalThis.crypto?.randomUUID?.() || `inventory-revoke-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const [reason, setReason] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [approvalPassword, setApprovalPassword] = useState("");
  const [confirmation, setConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => () => {
    requestAbortRef.current?.abort();
    const previous = previousFocusRef.current;
    const target = previous?.isConnected ? previous : document.querySelector('[data-inventory-focus-fallback="true"]');
    if (typeof target?.focus === "function") target.focus();
  }, []);

  const closeModal = useCallback(() => {
    requestAbortRef.current?.abort();
    onClose();
  }, [onClose]);

  useEffect(() => {
    const onKey = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeModal]);

  const ready = reason.trim() && reviewer.trim().length >= 2 && approvalPassword && confirmation;
  const submit = async event => {
    event.preventDefault();
    if (!ready || busy) return;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setBusy(true);
    setError("");
    try {
      await onRevoke({ row, idempotencyKey, reason, reviewer, approvalPassword, confirmation, signal:controller.signal });
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      setApprovalPassword("");
      onClose();
    } catch (submitError) {
      if (submitError?.name === "AbortError" || controller.signal.aborted) return;
      setApprovalPassword("");
      setError(submitError.message || "This manual inventory approval could not be removed.");
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(4,26,44,0.48)", zIndex:1500, display:"grid", placeItems:"center", padding:16, ...SANS }}>
      <form ref={dialogRef} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="inventory-revoke-title" aria-describedby="inventory-revoke-description" aria-busy={busy} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:"20px 22px", width:"min(560px, calc(100vw - 32px))", maxHeight:"calc(100vh - 32px)", overflowY:"auto", boxShadow:"0 24px 70px rgba(15,23,42,0.3)" }}>
        <div id="inventory-revoke-title" style={{ fontSize:15, fontWeight:600, color:C.text, marginBottom:6 }}>{lang === "ko" ? "수동 재고 승인 제거" : "Remove Manual Inventory Approval"}</div>
        <div id="inventory-revoke-description" style={{ fontSize:11, color:accessibleMuted, lineHeight:1.6, marginBottom:14 }}>
          {lang === "ko" ? "이 창고는 즉시 검증된 재고에서 제외되고 재검토 대기 상태로 돌아갑니다. 원본 판매 및 재고 기록은 변경되지 않습니다." : "This warehouse will immediately leave verified inventory and return to review. Raw sales and inventory history will not change."}
        </div>
        <div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:12, marginBottom:14, color:C.text, fontSize:11, lineHeight:1.6 }}>
          <div style={{ fontWeight:600 }}>{row.name} / {row.product}</div>
          <div style={{ color:accessibleMuted }}>{row.campaignId} / {row.date} / {fmtUnits(row.available)} {lang === "ko" ? "개" : "units"}</div>
        </div>
        <label style={{ display:"block", fontSize:10, color:accessibleMuted }}>
          <span style={{ display:"block", marginBottom:5 }}>{lang === "ko" ? "승인을 제거하는 이유" : "Reason for removing the approval"}</span>
          <textarea autoFocus required value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} rows={3} style={{ ...INP, border:`1px solid ${accessibleBorder}`, resize:"vertical", fontSize:12, padding:"9px 10px" }}/>
        </label>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(min(190px,100%),1fr))", gap:10, marginTop:10 }}>
          <label style={{ display:"block", fontSize:10, color:accessibleMuted }}>
            <span style={{ display:"block", marginBottom:5 }}>{lang === "ko" ? "검토자 이름" : "Reviewer name"}</span>
            <input required minLength={2} value={reviewer} onChange={event => setReviewer(event.target.value)} maxLength={100} autoComplete="name" style={{ ...INP, border:`1px solid ${accessibleBorder}`, fontSize:12, padding:"9px 10px" }}/>
          </label>
          <label style={{ display:"block", fontSize:10, color:accessibleMuted }}>
            <span style={{ display:"block", marginBottom:5 }}>{lang === "ko" ? "재고 승인 비밀번호" : "Inventory approval password"}</span>
            <input type="password" required value={approvalPassword} onChange={event => setApprovalPassword(event.target.value)} maxLength={256} autoComplete="current-password" style={{ ...INP, border:`1px solid ${accessibleBorder}`, fontSize:12, padding:"9px 10px" }}/>
          </label>
        </div>
        <label style={{ display:"flex", alignItems:"flex-start", gap:8, marginTop:12, color:C.text, fontSize:11, lineHeight:1.5, cursor:"pointer" }}>
          <input type="checkbox" required checked={confirmation} onChange={event => setConfirmation(event.target.checked)} style={{ marginTop:3 }}/>
          <span>{lang === "ko" ? "이 수동 승인을 제거하고 해당 재고를 재검토 대기 상태로 되돌리는 것을 확인합니다." : "I confirm that this manual approval should be removed and the inventory returned to review."}</span>
        </label>
        {error && <div role="alert" style={{ marginTop:12, border:`1px solid ${accessibleError}`, background:"#FFF5F5", color:accessibleError, borderRadius:7, padding:"9px 10px", fontSize:11, lineHeight:1.5 }}>{lang === "ko" ? `제거할 수 없습니다. ${error}` : error}</div>}
        <div style={{ display:"flex", justifyContent:"flex-end", gap:8, marginTop:14 }}>
          <SmBtn onClick={closeModal}>{lang === "ko" ? "취소" : "Cancel"}</SmBtn>
          <button type="submit" disabled={!ready || busy} style={{ padding:"7px 14px", borderRadius:8, border:"none", background:ready && !busy ? "#9B2C2C" : C.border, color:"#FFFFFF", fontWeight:600, fontSize:12, cursor:ready && !busy ? "pointer" : "default", ...SANS }}>{busy ? (lang === "ko" ? "제거 중..." : "Removing...") : (lang === "ko" ? "수동 승인 제거" : "Remove Approval")}</button>
        </div>
      </form>
    </div>
  );
}

function InventoryReviewTable({ rows, mode = "queue", onApprove = null }) {
  const { lang, t, label:uiLabel } = useUiText();
  const accessibleMuted = "#4B5563";
  const accessibleWarn = "#8A5200";
  const accessibleError = "#991B1B";
  const reviewedMode = mode === "reviewed";
  const sorted = useMemo(() => [...rows].sort((a, b) => (
    Number(b.inventoryValidation?.requiresReview || 0) - Number(a.inventoryValidation?.requiresReview || 0)
    || Number(b.available || 0) - Number(a.available || 0)
  )), [rows]);
  const requiredCount = sorted.filter(row => row.inventoryValidation?.requiresReview).length;
  const watchCount = sorted.filter(row => row.inventoryValidation?.watchRequired).length;
  return (
    <Panel title={reviewedMode ? (lang === "ko" ? "검토 완료 - 현재 보유 증빙 대기" : "Reviewed - Awaiting On-hand Evidence") : (lang === "ko" ? "재고 재검증 대기열" : "Inventory Re-validation Queue")}>
      <div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:"11px 13px", marginBottom:12, color:accessibleMuted, fontSize:11, lineHeight:1.65 }}>
        {reviewedMode
          ? (lang === "ko"
            ? `${sorted.length.toLocaleString()}건은 이전에 검토되었지만 현재 보유 증빙이 없어 확인된 재고에서 계속 제외됩니다. 정확한 증빙을 입력하여 한 건씩 승인할 수 있습니다.`
            : `${sorted.length.toLocaleString()} item${sorted.length === 1 ? " was" : "s were"} reviewed previously but remain excluded from verified inventory because no exact On-hand evidence was recorded. Approve each exact fact after entering its evidence.`)
          : lang === "ko"
          ? `수동 재검증 필요 ${requiredCount.toLocaleString()}건은 확인된 재고 합계, 흐름 및 매장 커버리지에서 제외됩니다. 주의 ${watchCount.toLocaleString()}건은 계속 표시되지만 확인이 권장됩니다.`
          : `${requiredCount.toLocaleString()} manual-review item${requiredCount === 1 ? " is" : "s are"} excluded from verified inventory totals, flow, and store coverage. ${watchCount.toLocaleString()} watch item${watchCount === 1 ? " remains" : "s remain"} visible but should be double-checked.`}
      </div>
      {sorted.length ? (
        <div style={{ overflowX:"auto" }}>
          <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:10 }}>
            <SmBtn onClick={() => downloadRowsCsv(reviewedMode ? "inventory-reviewed-awaiting-evidence.csv" : "inventory-revalidation-queue.csv", [
              { label:"Warehouse", value:r => r.name },
              { label:"Location", value:r => r.location },
              { label:"Product", value:r => r.product },
              { label:"Last Updated", value:r => r.date },
              { label:"Reported Inventory", value:r => r.available },
              { label:"Review Level", value:r => reviewedMode ? "Reviewed - evidence required" : r.inventoryValidation?.requiresReview ? "Manual review required" : "Watch" },
              { label:"Reason", value:r => inventoryValidationReason(r, "en") },
            ], sorted)}>{t("common.exportCsv", "Export CSV")}</SmBtn>
          </div>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
            <caption style={{ position:"absolute", width:1, height:1, padding:0, margin:-1, overflow:"hidden", clip:"rect(0,0,0,0)", whiteSpace:"nowrap", border:0 }}>{reviewedMode ? (lang === "ko" ? "검토 완료 후 현재 보유 증빙을 기다리는 재고" : "Reviewed inventory awaiting exact on-hand evidence") : (lang === "ko" ? "재고 재검증 대기열" : "Inventory re-validation queue")}</caption>
            <thead><tr>
              {["Warehouse","Product","Last Updated","Reported Inventory","Review Level","Reason", ...(onApprove ? ["Action"] : [])].map(heading => (
                <th key={heading} scope="col" style={{ textAlign:heading === "Warehouse" || heading === "Product" || heading === "Reason" ? "left" : "right", color:accessibleMuted, ...MONO, fontSize:10, textTransform:"uppercase", letterSpacing:1, padding:"0 8px 8px", borderBottom:`1px solid ${C.border}` }}>{uiLabel(heading)}</th>
              ))}
            </tr></thead>
            <tbody>{sorted.map(row => {
              const required = row.inventoryValidation?.requiresReview;
              return (
                <tr key={`${row.key}-validation`}>
                  <th scope="row" style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:C.text, minWidth:190, textAlign:"left", fontWeight:400 }}><div style={{ fontWeight:500 }}>{row.name}</div><div style={{ color:accessibleMuted, fontSize:10 }}>{row.location || row.region}</div></th>
                  <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:C.text }}>
                    <div>{row.product}</div>
                    {row.campaign && <div style={{ color:C.muted, fontSize:10 }}>{row.campaign}</div>}
                  </td>
                  <td title={row.date} style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:accessibleMuted, textAlign:"right", ...MONO }}>{row.date?.slice(5)}</td>
                  <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:required ? accessibleError : accessibleWarn, textAlign:"right", ...MONO, fontWeight:600 }}>{fmtUnits(row.available)}</td>
                  <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, textAlign:"right" }}><StatusChip label={reviewedMode ? (lang === "ko" ? "증빙 대기" : "Evidence Needed") : required ? (lang === "ko" ? "수동 검토 필요" : "Manual Review") : (lang === "ko" ? "주의" : "Watch")} col={reviewedMode || required ? accessibleError : accessibleWarn}/></td>
                  <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, color:accessibleMuted, minWidth:300, lineHeight:1.45 }}>{inventoryValidationReason(row, lang)}</td>
                  {onApprove && <td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}`, textAlign:"right" }}>{row.type === "Inline" && row.available >= 2 && (reviewedMode || required) ? <button type="button" aria-label={lang === "ko" ? `${row.name} ${row.product}, 캠페인 ${row.campaignId}, ${row.date}, ${fmtUnits(row.available)}개 현재 보유 재고 승인` : `Approve on-hand inventory for ${row.product} at ${row.name}, campaign ${row.campaignId}, ${row.date}, ${fmtUnits(row.available)} units`} onClick={() => onApprove(row)} style={{ whiteSpace:"nowrap", padding:"6px 9px", borderRadius:7, border:"1px solid #2F6F4966", background:"#2F6F4912", color:"#2F6F49", cursor:"pointer", fontSize:10, fontWeight:600, ...SANS }}>{lang === "ko" ? "현재 보유 승인" : "Approve On Hand"}</button> : <span style={{ color:accessibleMuted, fontSize:10 }}>-</span>}</td>}
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      ) : (
        <div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:16, color:C.muted, fontSize:11 }}>{lang === "ko" ? "현재 필터에 재검증이 필요한 재고가 없습니다." : "No inventory in the current scope requires re-validation."}</div>
      )}
    </Panel>
  );
}

function compactInventoryStatus(statusCode, lang = "en") {
  const status = {
    sold_through:{ label:lang === "ko" ? "판매 완료" : "Sold Through", col:C.green, severity:4 },
    no_current_inventory:{ label:lang === "ko" ? "현재 재고 없음" : "No Current Inventory", col:C.muted, severity:5 },
    no_movement:{ label:"No Movement", col:C.red, severity:0 },
    critical:{ label:"Critical", col:C.red, severity:1 },
    watch:{ label:"Watch", col:C.warn, severity:2 },
    sold_out:{ label:"Sold Out", col:C.green, severity:4 },
    healthy:{ label:"Healthy", col:C.green, severity:3 },
    last_known_inventory:{ label:lang === "ko" ? "마지막 확인 재고" : "Last known inventory", col:C.muted, severity:5 },
  }[statusCode];
  return status || { label:String(statusCode || "—"), col:C.muted, severity:9 };
}

function compactInventoryDisplayRows(rows = [], lang = "en") {
  return rows.map(row => ({
    ...row,
    status:compactInventoryStatus(row.statusCode, lang),
    ownerInventoryResult:row.displayStatusCode === "last_known_inventory" ? { lastKnown:true } : undefined,
    approvedAllocation:row.manualApproval ? {
      ...row.manualApproval,
      pid:row.productId,
      cid:row.campaignId,
      wid:row.warehouseId,
    } : null,
  }));
}

function CompactInventoryView({ model, selId, selPid, inventoryType, inventoryRegion, inventoryState, productMeta = {}, whs = [], onRevokeInventory = null }) {
  const { lang, t } = useUiText();
  const [inventoryExpanded, setInventoryExpanded] = useState({});
  const [inventoryRevocationRow, setInventoryRevocationRow] = useState(null);
  const inlineItems = useMemo(() => compactInventoryDisplayRows(model.inlineRows || [], lang), [model.inlineRows, lang]);
  const inlineSoldThroughItems = useMemo(() => compactInventoryDisplayRows(model.inlineSoldThroughRows || [], lang), [model.inlineSoldThroughRows, lang]);
  const onlineItems = useMemo(() => compactInventoryDisplayRows(model.onlineRows || [], lang), [model.onlineRows, lang]);
  const onlineSoldThroughItems = useMemo(() => compactInventoryDisplayRows(model.onlineSoldThroughRows || [], lang), [model.onlineSoldThroughRows, lang]);
  const product = selPid ? productWithMeta(selPid, productMeta) : null;
  const warehouseName = selId
    ? (model.sidebarRows || []).find(row => row.id === selId)?.name || whs.find(row => row.id === selId)?.name
    : "";
  const scope = [
    product?.short || t("filter.allProducts", "All Products"),
    inventoryType === "inline" ? t("filter.inlineStores", "Inline Stores") : inventoryType === "online" ? t("filter.online", "Online") : t("filter.inlineOnline", "Inline + Online"),
    inventoryType !== "online" ? inventoryRegion : "",
    inventoryType !== "online" ? inventoryState : "",
    inventoryType !== "online" ? warehouseName : "",
  ].filter(Boolean).join(" / ");
  const totals = model.totals || {};
  const chartData = Array.isArray(model.chartData) ? model.chartData : [];
  const showInline = inventoryType !== "online";
  const showOnline = inventoryType !== "inline";

  return (
    <div data-inventory-view data-inventory-compact="true" data-processing-ms="0" data-flow-processing-ms="0" data-worker-transfer-ms="0" data-flow-status="ready">
      <div tabIndex={-1} data-inventory-focus-fallback="true" aria-label={lang === "ko" ? "재고 요약" : "Inventory summary"} style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:10, marginBottom:14 }} className="bi-kpi-grid">
        {[
          { label:"Available Units", val:fmtUnits(totals.availableUnits), c:C.green },
          { label:"Inline Units", val:fmtUnits(totals.inlineUnits), c:C.blue },
          { label:"Online Units", val:fmtUnits(totals.onlineUnits), c:C.accent },
          { label:lang === "ko" ? "검증된 재고 보유 창고" : "Verified Stocked Warehouses", val:Number(totals.verifiedStockedWarehouses || 0).toLocaleString(), exact:lang === "ko" ? "현재 범위에서 검증된 재고를 보유한 Costco 물리적 창고 수입니다. 판매 완료, 제외 및 재검증 행은 포함되지 않습니다." : "Unique physical Costco warehouses with current verified stock in this Inventory scope. Sold-through, suppressed, and re-validation rows are not counted.", c:C.text },
        ].map(k => <KpiCard key={k.label} label={k.label} value={k.val} color={k.c} exact={k.exact}/>)}
      </div>

      <Panel title={`Inventory Flow / ${scope}`}>
        {chartData.length ? (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData} margin={{ top:5, right:8, bottom:5, left:0 }}>
              <CartesianGrid stroke={C.border} strokeDasharray="2 5" vertical={false}/>
              <XAxis dataKey="label" tick={{ fontSize:10, fill:C.muted, fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif" }} axisLine={false} tickLine={false} interval="preserveStartEnd"/>
              <YAxis tick={{ fontSize:10, fill:C.muted, fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif" }} axisLine={false} tickLine={false} tickFormatter={fmtUnits}/>
              <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
                <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:"8px 10px", boxShadow:"0 10px 30px rgba(0,0,0,0.35)" }}>
                  <div style={{ ...MONO, color:C.muted, fontSize:10, marginBottom:6 }}>{label}</div>
                  {payload.map(point => <div key={point.dataKey} style={{ color:point.color, fontSize:11, marginBottom:3 }}>{point.name}: <span style={{ ...MONO }}>{fmtUnits(point.value)} units</span></div>)}
                </div>
              ) : null}/>
              {showInline && <Bar dataKey="inline" name="Inline" fill={C.blue} radius={[3,3,0,0]} opacity={0.82}/>}
              {showOnline && <Bar dataKey="online" name="Online" fill={C.accent} radius={[3,3,0,0]} opacity={0.82}/>}
            </BarChart>
          </ResponsiveContainer>
        ) : <div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:"28px 16px", textAlign:"center", color:C.muted, fontSize:11 }}>{lang === "ko" ? "이 필터와 일치하는 재고 스냅샷이 없습니다." : "No inventory snapshots match these filters."}</div>}
      </Panel>

      {inventoryRevocationRow && onRevokeInventory && <InventoryApprovalRevocationModal row={inventoryRevocationRow} onClose={() => setInventoryRevocationRow(null)} onRevoke={onRevokeInventory}/>}

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(min(420px,100%),1fr))", gap:14, marginBottom:14 }}>
        {showInline && <InventoryTable title={lang === "ko" ? "인라인 재고 - 검증된 재고 보유 창고" : "Inline Inventory - Verified Stocked Warehouses"} rows={inlineItems} tableKey="inline" initialLimit={20} isExpanded={!!inventoryExpanded.inline} onToggleExpanded={() => setInventoryExpanded(previous => ({ ...previous, inline:!previous.inline }))} onRevoke={onRevokeInventory ? setInventoryRevocationRow : null} empty={lang === "ko" ? "현재 날짜 및 제품 필터와 일치하는 검증된 재고 보유 창고가 없습니다." : "No verified stocked warehouses matched the current date and product filters."}/>}
        {showInline && <InventoryTable title={lang === "ko" ? "판매 완료 창고" : "Sold Through Warehouses"} rows={inlineSoldThroughItems} tableKey="inline-sold-through" initialLimit={20} isExpanded={!!inventoryExpanded.soldThrough} onToggleExpanded={() => setInventoryExpanded(previous => ({ ...previous, soldThrough:!previous.soldThrough }))} empty={lang === "ko" ? "현재 제품 및 캠페인 필터와 일치하는 판매 완료 창고가 없습니다." : "No sold-through warehouses matched the current product and campaign filters."}/>}
        {showOnline && <InventoryTable title={lang === "ko" ? "온라인 재고 - 검증된 현재 재고" : "Online Inventory - Verified Current Stock"} rows={onlineItems} tableKey="online" isExpanded={!!inventoryExpanded.online} onToggleExpanded={() => setInventoryExpanded(previous => ({ ...previous, online:!previous.online }))} empty={lang === "ko" ? "현재 필터와 일치하는 검증된 온라인 재고가 없습니다." : "No verified online inventory matched the current filters."}/>}
        {showOnline && <InventoryTable title={lang === "ko" ? "온라인 판매 완료" : "Online Sold Through"} rows={onlineSoldThroughItems} tableKey="online-sold-through" isExpanded={!!inventoryExpanded.onlineSoldThrough} onToggleExpanded={() => setInventoryExpanded(previous => ({ ...previous, onlineSoldThrough:!previous.onlineSoldThrough }))} empty={lang === "ko" ? "현재 필터와 일치하는 온라인 판매 완료 항목이 없습니다." : "No sold-through online inventory matched the current filters."}/>}
      </div>

      {Number(model.onlineAggregateCount || 0) === 0 && showOnline && (
        <Panel title="Inventory Upload Blueprint">
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))", gap:12 }}>
            {[
              { title:"Inline_Inventory_Raw", cols:["Date","Store","Product","Inventory","Units"] },
              { title:"Online_Inventory_Raw", cols:["Date","Product","Channel","Inventory","Units"] },
            ].map(section => <div key={section.title} style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:14 }}>
              <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>{section.title}</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(88px,1fr))", gap:6 }}>
                {section.cols.map((column, index) => <div key={column} style={{ background:C.card, border:`1px solid ${index < 4 ? C.accent+"55" : C.border}`, borderRadius:6, padding:"7px 8px", fontSize:10, color:index < 4 ? C.text : C.muted }}>{column}{index < 4 && <span style={{ color:C.accent }}> *</span>}</div>)}
              </div>
            </div>)}
          </div>
        </Panel>
      )}
    </div>
  );
}

function InventoryView(props) {
  return props.compactModel
    ? <CompactInventoryView model={props.compactModel} {...props}/>
    : <LegacyInventoryView {...props}/>;
}

function LegacyInventoryView({ ownerSalesHistory = [], ownerInventoryDecisions = [], prodSales, inlineTotalSales, onlineSales, inventoryApprovals = [], inventoryReviewDispositions = [], whs, selId, dateRange, selPid, inventoryType, inventoryRegion, inventoryState, productMeta = {}, campaignMeta = {}, campaignId = "", storeSearchActive = false, approvalEvaluationDate = "", onApproveInventory = null, onRevokeInventory = null }) {
  const processingStarted = performance.now();
  const performanceElement = useRef(null);
  const { lang, t, label:uiLabel } = useUiText();
  const product = selPid ? productWithMeta(selPid, productMeta) : null;
  const effectiveApprovalEvaluationDate = approvalEvaluationDate || localDateKey();
  const [inventoryExpanded, setInventoryExpanded] = useState({});
  const [inventoryApprovalRow, setInventoryApprovalRow] = useState(null);
  const [inventoryRevocationRow, setInventoryRevocationRow] = useState(null);
  const whById = useMemo(() => new Map(whs.map(w => [w.id, w])), [whs]);
  const allowedStoreIds = useMemo(() => new Set(whs
    .filter(w => (!inventoryRegion || w.region === inventoryRegion) && (!inventoryState || w.st === inventoryState) && (!selId || w.id === selId))
    .map(w => w.id)), [whs, inventoryRegion, inventoryState, selId]);
  const campaignIsEligible = useMemo(() => {
    const campaignEligibilityCache = new Map();
    return (row, grain) => {
      if (campaignId) return true;
      const cacheKey = `${String(row?.cid || "")}|${String(row?.pid || "")}|${grain}`;
      if (!campaignEligibilityCache.has(cacheKey)) {
        campaignEligibilityCache.set(cacheKey, inventoryCampaignActiveAt(
          campaignWithMeta(row?.cid, campaignMeta, productMeta),
          productWithMeta(row?.pid, productMeta),
          { asOfDate:dateRange.end, grain },
        ));
      }
      return campaignEligibilityCache.get(cacheKey);
    };
  }, [campaignId, campaignMeta, productMeta, dateRange.end]);
  const statusFor = useCallback((onHand, totalUnits, sellThrough, expectedSellThrough, inventoryState = "") => {
    if (inventoryState === "sold-through") return { label:lang === "ko" ? "판매 완료" : "Sold Through", col:C.green, severity:4 };
    if (onHand <= 0 && totalUnits <= 0) return { label:lang === "ko" ? "현재 재고 없음" : "No Current Inventory", col:C.muted, severity:5 };
    if (totalUnits <= 0 && onHand > 0) return { label:"No Movement", col:C.red, severity:0 };
    if (sellThrough < expectedSellThrough * 0.5 && onHand > 0) return { label:"Critical", col:C.red, severity:1 };
    if (sellThrough < expectedSellThrough * 0.8 && onHand > 0) return { label:"Watch", col:C.warn, severity:2 };
    if (onHand <= 0 && totalUnits > 0) return { label:"Sold Out", col:C.green, severity:4 };
    return { label:"Healthy", col:C.green, severity:3 };
  }, [lang]);

  // Classify each warehouse/product once from all history through the selected end.
  // The selected start is used only for the displayed performance metrics.
  const inlineAggregateItems = useMemo(() => {
    const rows = prodSales.filter(r => r.date <= dateRange.end && allowedStoreIds.has(r.wid) && (!selPid || productValuesMatch(r.pid, selPid, productMeta)) && rowMatchesCampaignScope(r, campaignId) && campaignIsEligible(r, "physical_warehouse"));
    const groupedRows = _.groupBy(rows, inventoryCampaignScopeKey);
    return Object.entries(groupedRows).map(([key, groupRows]) => {
      const sorted = _.sortBy(groupRows, "date");
      const periodRows = sorted.filter(r => r.date >= dateRange.start && r.date <= dateRange.end);
      const latest = sorted[sorted.length - 1] || {};
      const wh = whById.get(latest.wid);
      const prod = productWithMeta(latest.pid, productMeta);
      const weeks = Math.max(1, new Set(periodRows.map(r => r.date)).size);
      const coverageEvidence = inventoryCoverageEvidence(sorted);
      const periodEvidence = inventoryCoverageEvidence(periodRows);
      const approvedAllocation = matchingInventoryApproval(inventoryApprovals, {
        wid:latest.wid,
        pid:latest.pid,
        cid:latest.cid || "",
        inventoryDate:coverageEvidence.latestInventoryDate,
        onHand:coverageEvidence.onHand,
      }, effectiveApprovalEvaluationDate);
      const reviewDisposition = matchingInventoryReviewDisposition(inventoryReviewDispositions, {
        grain:"physical_warehouse",
        wid:latest.wid,
        pid:latest.pid,
        cid:latest.cid || "",
        inventoryDate:coverageEvidence.latestInventoryDate,
        onHand:coverageEvidence.onHand,
      });
      const validationOptions = { asOfDate:dateRange.end, evaluationDate:effectiveApprovalEvaluationDate, approvedAllocation };
      const eligibility = inventoryEligibilityState(sorted, wh, validationOptions);
      const rawValidation = inventoryValidationEvidence(sorted, validationOptions);
      const dispositionExcludesVerifiedInventory = reviewDisposition?.decision === "rejected"
        || (reviewDisposition?.decision === "reviewed_quarantined" && !rawValidation.approvalApplied);
      const materialAdjustment = rawValidation.reasonCodes.some(code => code === "recent-large-inventory-addition" || code === "recent-large-inventory-removal");
      const suppressRoutineNoise = ["unknown", "never-stocked", "token-or-phantom", "refund-proxy"].includes(eligibility.state) && !materialAdjustment;
      const eligibilityReview = eligibility.requiresReview && !suppressRoutineNoise;
      const validationReview = rawValidation.requiresReview && (!suppressRoutineNoise || materialAdjustment);
      const watchRequired = eligibility.countsAsStocked && rawValidation.watchRequired;
      const reasonCodes = [...new Set([
        ...(validationReview || watchRequired ? rawValidation.reasonCodes : []),
        ...(eligibilityReview ? eligibility.reasonCodes : []),
      ])];
      const inventoryValidation = {
        ...rawValidation,
        requiresReview:eligibilityReview || validationReview,
        watchRequired,
        reasonCodes,
      };
      const totalUnits = periodEvidence.totalUnits;
      const netUnits = periodEvidence.netUnits;
      const weeklyUnits = averageWeeklyUnits(totalUnits, weeks);
      const onHand = coverageEvidence.onHand;
      const peakOnHand = coverageEvidence.peakOnHand;
      const revenue = periodEvidence.revenue;
      const available = Math.max(0, Number(onHand || 0));
      const sellThrough = inventorySellThrough(totalUnits, onHand);
      const expectedSellThrough = Math.min(85, Math.max(25, weeks * 8));
      const status = statusFor(available, totalUnits, sellThrough, expectedSellThrough, eligibility.state);
      return {
        key,
        warehouseId:latest.wid,
        productId:latest.pid,
        campaignId:latest.cid || "",
        campaign:latest.campaign || "",
        warehouseKey:String(warehouseNumberFromText(wh?.warehouseNo || wh?.name || "") || latest.wid || ""),
        type:"Inline",
        name:wh?.name || latest.wid,
        location:warehouseLocationLabel(wh),
        region:wh?.region || "",
        product:prod?.short || latest.pid || "Product",
        date:coverageEvidence.latestInventoryDate || latest.date,
        lastKnownSale:sorted.findLast(row => Number(row.units) > 0)?.date || "",
        onHand:available,
        peakOnHand,
        available,
        totalUnits,
        netUnits,
        reportingPeriods:weeks,
        revenue,
        weeklyUnits,
        sellThrough,
        expectedSellThrough,
        status,
        eligibility,
        lifecycleState:eligibility.state,
        countsAsStocked:eligibility.countsAsStocked && !dispositionExcludesVerifiedInventory,
        soldThrough:eligibility.soldThrough && !dispositionExcludesVerifiedInventory,
        flowEligible:eligibility.flowEligible && !dispositionExcludesVerifiedInventory,
        flowRequest:dispositionExcludesVerifiedInventory ? null : {type:"inline",rows:sorted,warehouse:wh,options:validationOptions,latestDate:coverageEvidence.latestInventoryDate || latest.date,campaignId:latest.cid || ""},
        reviewEligible:(inventoryValidation.requiresReview || inventoryValidation.watchRequired) && !reviewDisposition,
        inventoryValidation,
        approvedAllocation,
        reviewDisposition,
      };
    }).map(item => applyOwnerInventoryResult(item, resolveOwnerInventoryDecision(ownerInventoryDecisions, { pid:item.productId, cid:item.campaignId, wid:item.warehouseId, grain:"physical_warehouse" }, groupedRows[item.key], dateRange.end))).filter(r => r?.date).sort((a,b) => a.status.severity - b.status.severity || a.sellThrough - b.sellThrough);
  }, [prodSales, dateRange, allowedStoreIds, selPid, campaignId, campaignIsEligible, whById, statusFor, productMeta, inventoryApprovals, inventoryReviewDispositions, ownerInventoryDecisions, effectiveApprovalEvaluationDate]);

  const acceptedInventoryTotals = useMemo(() => {
    const totals = ownerSalesTotalsForScope(ownerSalesHistory, { to:dateRange.end }, whs);
    return new Map(totals.rows.flatMap(row => row.cids.map(cid => [`${row.wid}|${row.pid}|${cid}`, row.correctedUnits])));
  }, [ownerSalesHistory, dateRange.end, whs]);
  const inlineCurrentItems = inlineAggregateItems;

  // Inventory remains campaign-specific through validation, current balances,
  // sold-through history, review, and flow. The warehouse KPI alone deduplicates doors.
  const inlineReviewItems = useMemo(() => inlineAggregateItems
    .filter(item => item.reviewEligible), [inlineAggregateItems]);

  const inlineReviewedQuarantinedItems = useMemo(() => inlineAggregateItems
    .filter(item => item.reviewDisposition?.decision === "reviewed_quarantined" && !item.inventoryValidation?.approvalApplied), [inlineAggregateItems]);

  const inlineCoverageItems = useMemo(() => inlineCurrentItems
    .filter(item => item.countsAsStocked)
    .filter(item => !item.inventoryValidation?.requiresReview)
    .map(item => {
      const totalUnits = acceptedInventoryTotals.get(item.key) ?? Math.max(0, Number(item.netUnits || 0));
      const sellThrough = inventorySellThrough(totalUnits, item.onHand);
      return {
        ...item,
        totalUnits,
        weeklyUnits:averageWeeklyUnits(Math.max(0, Number(item.netUnits || 0)), item.reportingPeriods),
        sellThrough,
        status:statusFor(item.onHand, totalUnits, sellThrough, item.expectedSellThrough, item.lifecycleState),
      };
    })
    .sort((a,b) => a.status.severity - b.status.severity || a.sellThrough - b.sellThrough), [inlineCurrentItems, statusFor, acceptedInventoryTotals]);

  const inlineSoldThroughItems = useMemo(() => inlineAggregateItems
    .filter(item => item.soldThrough && !item.inventoryValidation?.requiresReview)
    .filter(item => item.ownerInventoryResult?.consumerEligible !== false && !isNonStoreInventoryLocation(whById.get(item.warehouseId)))
    .map(item => {
      const totalUnits = acceptedInventoryTotals.get(item.key) ?? Math.max(0, Number(item.netUnits || 0));
      return {
        ...item,
        totalUnits,
        weeklyUnits:averageWeeklyUnits(Math.max(0, Number(item.netUnits || 0)), item.reportingPeriods),
        sellThrough:100,
        status:statusFor(0, totalUnits, 100, item.expectedSellThrough, "sold-through"),
      };
    })
    .filter(item => item.totalUnits >= 100)
    .sort((a, b) => String(b.lastKnownSale || "").localeCompare(String(a.lastKnownSale || "")) || a.name.localeCompare(b.name)), [inlineAggregateItems, statusFor, acceptedInventoryTotals, whById]);


  const inlineItems = inlineCoverageItems.filter(item => item.ownerInventoryResult?.consumerEligible !== false && !isNonStoreInventoryLocation(whById.get(item.warehouseId)));

  const onlineAggregateItems = useMemo(() => {
    const rows = aggregateOnlineInventoryRows(onlineSales.filter(r => r.date <= dateRange.end && (!selPid || productValuesMatch(r.pid, selPid, productMeta)) && rowMatchesCampaignScope(r, campaignId) && campaignIsEligible(r, "online_aggregate")));
    const groupedRows = _.groupBy(rows, r => `${r.pid || r.product || ""}|${r.cid || ""}`);
    return Object.entries(groupedRows).map(([key, groupRows]) => {
      const sorted = _.sortBy(groupRows, "date");
      const periodRows = sorted.filter(r => r.date >= dateRange.start && r.date <= dateRange.end);
      const latest = sorted[sorted.length - 1] || {};
      const coverageEvidence = inventoryCoverageEvidence(sorted);
      if (!coverageEvidence.inventoryKnown) return null;
      const periodEvidence = inventoryCoverageEvidence(periodRows);
      const prod = productWithMeta(latest.pid, productMeta);
      const approvedAllocation = matchingInventoryApproval(inventoryApprovals, {
        grain:"online_aggregate",
        pid:latest.pid,
        cid:latest.cid || "",
        inventoryDate:coverageEvidence.latestInventoryDate,
        onHand:coverageEvidence.onHand,
      }, effectiveApprovalEvaluationDate);
      const reviewDisposition = matchingInventoryReviewDisposition(inventoryReviewDispositions, {
        grain:"online_aggregate",
        pid:latest.pid,
        cid:latest.cid || "",
        inventoryDate:coverageEvidence.latestInventoryDate,
        onHand:coverageEvidence.onHand,
      });
      const validationOptions = { grain:"online_aggregate", asOfDate:dateRange.end, evaluationDate:effectiveApprovalEvaluationDate, approvedAllocation };
      const eligibility = inventoryEligibilityState(sorted, {}, validationOptions);
      const rawValidation = onlineInventoryValidationEvidence(sorted, validationOptions);
      const dispositionExcludesVerifiedInventory = reviewDisposition?.decision === "rejected"
        || (reviewDisposition?.decision === "reviewed_quarantined" && !rawValidation.approvalApplied);
      const replenishmentReview = rawValidation.reasonCodes.includes("online-inventory-replenishment");
      const suppressRoutineNoise = ["unknown", "never-stocked", "token-or-phantom", "refund-proxy"].includes(eligibility.state) && !replenishmentReview;
      const eligibilityReview = eligibility.requiresReview && !suppressRoutineNoise;
      const validationReview = rawValidation.requiresReview && (!suppressRoutineNoise || replenishmentReview);
      const inventoryValidation = {
        ...rawValidation,
        requiresReview:eligibilityReview || validationReview,
        watchRequired:false,
        reasonCodes:[...new Set([
          ...(validationReview ? rawValidation.reasonCodes : []),
          ...(eligibilityReview ? eligibility.reasonCodes : []),
        ])],
      };
      const weeks = Math.max(1, new Set(periodRows.map(r => r.date)).size);
      const totalUnits = Math.max(0, Number(periodEvidence.netUnits || 0));
      const weeklyUnits = averageWeeklyUnits(totalUnits, weeks);
      const onHand = Math.max(0, Number(coverageEvidence.onHand || 0));
      const available = onHand;
      const sellThrough = inventorySellThrough(totalUnits, onHand);
      const expectedSellThrough = Math.min(85, Math.max(25, weeks * 8));
      const status = statusFor(onHand, totalUnits, sellThrough, expectedSellThrough, eligibility.state);
      return {
        key,
        warehouseId:"",
        productId:latest.pid,
        campaignId:latest.cid || "",
        campaign:latest.campaign || "",
        type:"Online",
        name:"Online aggregate",
        location:"Ecommerce aggregate",
        region:"Online",
        product:prod?.short || productDisplayName(latest.product) || "Product",
        date:coverageEvidence.latestInventoryDate || latest.date,
        lastKnownSale:sorted.findLast(row => Number(row.units) > 0)?.date || "",
        onHand,
        available,
        totalUnits,
        netUnits:periodEvidence.netUnits,
        weeklyUnits,
        sellThrough,
        expectedSellThrough,
        status,
        eligibility,
        lifecycleState:eligibility.state,
        countsAsStocked:eligibility.countsAsStocked && !dispositionExcludesVerifiedInventory,
        soldThrough:eligibility.soldThrough && !dispositionExcludesVerifiedInventory,
        flowRequest:dispositionExcludesVerifiedInventory ? null : {type:"online",rows:sorted,warehouse:{},options:validationOptions,latestDate:coverageEvidence.latestInventoryDate || latest.date,campaignId:latest.cid || ""},
        reviewEligible:inventoryValidation.requiresReview && !reviewDisposition,
        inventoryValidation,
        approvedAllocation,
        reviewDisposition,
      };
    }).filter(Boolean).map(item => applyOwnerInventoryResult(item, resolveOwnerInventoryDecision(ownerInventoryDecisions, { pid:item.productId, cid:item.campaignId, wid:"", grain:"online_aggregate" }, groupedRows[item.key], dateRange.end))).sort((a,b) => a.status.severity - b.status.severity || a.sellThrough - b.sellThrough);
  }, [onlineSales, dateRange, selPid, campaignId, campaignIsEligible, statusFor, productMeta, inventoryApprovals, inventoryReviewDispositions, ownerInventoryDecisions, effectiveApprovalEvaluationDate]);

  const onlineCurrentItems = onlineAggregateItems;
  const onlineReviewItems = useMemo(() => onlineAggregateItems.filter(item => item.reviewEligible), [onlineAggregateItems]);
  const onlineReviewedQuarantinedItems = useMemo(() => onlineAggregateItems
    .filter(item => item.reviewDisposition?.decision === "reviewed_quarantined" && !item.inventoryValidation?.approvalApplied), [onlineAggregateItems]);
  const onlineItems = useMemo(() => onlineCurrentItems.filter(item => item.countsAsStocked && !item.inventoryValidation?.requiresReview), [onlineCurrentItems]);
  const onlineSoldThroughItems = useMemo(() => onlineAggregateItems
    .filter(item => item.soldThrough && !item.inventoryValidation?.requiresReview)
    .map(item => ({ ...item, sellThrough:100, status:statusFor(0, item.totalUnits, 100, item.expectedSellThrough, "sold-through") })), [onlineAggregateItems, statusFor]);

  // Inventory reporting uses only physical stores whose inventory passed the validation gate.
  // Official Costco sales and units continue to use Costco_Daily_Totals outside this Inventory view.
  const inlineMetricItems = inlineCoverageItems;

  const visibleItems = useMemo(() => [
    ...(inventoryType !== "online" ? inlineMetricItems : []),
    ...(inventoryType !== "inline" ? onlineItems : []),
  ], [inventoryType, inlineMetricItems, onlineItems]);

  const totals = useMemo(() => {
    const available = _.sumBy(visibleItems, "available");
    const sold = _.sumBy(visibleItems, "totalUnits");
    const totalWarehouses = new Set(inlineCoverageItems.filter(item => item.ownerInventoryResult?.consumerEligible !== false && !isNonStoreInventoryLocation(whById.get(item.warehouseId))).map(item => item.warehouseKey).filter(Boolean)).size;
    return {
      available,
      inline:_.sumBy(inlineMetricItems, "available"),
      online:_.sumBy(onlineItems, "available"),
      totalWarehouses,
      risk:visibleItems.filter(r => r.status.label !== "No Movement" && r.status.severity <= 2).length,
      sellThrough:sold + available > 0 ? (sold / (sold + available)) * 100 : 0,
      velocity:_.sumBy(visibleItems, "weeklyUnits"),
    };
  }, [visibleItems, inlineMetricItems, inlineCoverageItems, onlineItems]);

  const flowJobs = useMemo(() => [
    ...(inventoryType === "online" ? [] : inlineAggregateItems),
    ...(inventoryType === "inline" ? [] : onlineAggregateItems),
  ].filter(item => item.flowRequest && !item.ownerInventoryResult?.applied && !item.ownerInventoryResult?.conflict).map(item => item.flowRequest), [inlineAggregateItems,onlineAggregateItems,inventoryType]);
  const flow = useInventoryFlow(flowJobs,dateRange);
  const chartData = flow.chartData;
  // Retain the calculation duration when the worker result triggers a cheap rerender.
  const processingMs = useMemo(() => performance.now() - processingStarted,[flowJobs,inlineMetricItems,onlineItems]);
  useEffect(() => {
    const element = performanceElement.current;
    if (!element) return;
    const committed = performance.now();
    let next;
    const frame = requestAnimationFrame(() => {next = requestAnimationFrame(() => {
      element.dataset.postCommitFrameMs = String(performance.now() - committed);
    });});
    return () => {cancelAnimationFrame(frame);cancelAnimationFrame(next);};
  },[inlineAggregateItems,onlineAggregateItems,chartData]);

  const scope = [product?.short || t("filter.allProducts", "All Products"), inventoryType === "inline" ? t("filter.inlineStores", "Inline Stores") : inventoryType === "online" ? t("filter.online", "Online") : t("filter.inlineOnline", "Inline + Online"), inventoryType !== "online" ? inventoryRegion : "", inventoryType !== "online" ? inventoryState : "", inventoryType !== "online" && selId ? whById.get(selId)?.name : ""].filter(Boolean).join(" / ");
  const showInline = inventoryType !== "online";
  const showOnline = inventoryType !== "inline";


  return (
    <div ref={performanceElement} data-inventory-view data-processing-ms={processingMs} data-flow-processing-ms={flow.processingMs} data-worker-transfer-ms={flow.transferMs} data-flow-status={flow.status}>
      <div tabIndex={-1} data-inventory-focus-fallback="true" aria-label={lang === "ko" ? "재고 요약" : "Inventory summary"} style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:10, marginBottom:14 }} className="bi-kpi-grid">
        {[
          { label:"Available Units", val:fmtUnits(totals.available), c:C.green },
          { label:"Inline Units", val:fmtUnits(totals.inline), c:C.blue },
          { label:"Online Units", val:fmtUnits(totals.online), c:C.accent },
          { label:lang === "ko" ? "검증된 재고 보유 창고" : "Verified Stocked Warehouses", val:totals.totalWarehouses.toLocaleString(), exact:lang === "ko" ? "현재 범위에서 검증된 재고를 보유한 Costco 물리적 창고 수입니다. 판매 완료, 제외 및 재검증 행은 포함되지 않습니다." : "Unique physical Costco warehouses with current verified stock in this Inventory scope. Sold-through, suppressed, and re-validation rows are not counted.", c:C.text },
        ].map(k => (
          <KpiCard key={k.label} label={k.label} value={k.val} sub={k.sub} color={k.c} exact={k.exact}/>
        ))}
      </div>

      <Panel title={`Inventory Flow / ${scope}`}>
        {flow.status !== "ready" ? <RuntimeViewBoundary state={flow.status} label={lang === "ko" ? "재고 차트" : "inventory chart"} lang={lang} onRetry={flow.retry} detail={flow.error || ""}/> : chartData.length ? (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData} margin={{ top:5, right:8, bottom:5, left:0 }}>
              <CartesianGrid stroke={C.border} strokeDasharray="2 5" vertical={false}/>
              <XAxis dataKey="label" tick={{ fontSize:10, fill:C.muted, fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif" }} axisLine={false} tickLine={false} interval="preserveStartEnd"/>
              <YAxis tick={{ fontSize:10, fill:C.muted, fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif" }} axisLine={false} tickLine={false} tickFormatter={fmtUnits}/>
              <Tooltip content={({ active, payload, label }) => active && payload?.length ? (
                <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, padding:"8px 10px", boxShadow:"0 10px 30px rgba(0,0,0,0.35)" }}>
                  <div style={{ ...MONO, color:C.muted, fontSize:10, marginBottom:6 }}>{label}</div>
                  {payload.map(p => <div key={p.dataKey} style={{ color:p.color, fontSize:11, marginBottom:3 }}>{p.name}: <span style={{ ...MONO }}>{fmtUnits(p.value)} units</span></div>)}
                </div>
              ) : null}/>
              {showInline && <Bar dataKey="inline" name="Inline" fill={C.blue} radius={[3,3,0,0]} opacity={0.82}/>}
              {showOnline && <Bar dataKey="online" name="Online" fill={C.accent} radius={[3,3,0,0]} opacity={0.82}/>}
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:"28px 16px", textAlign:"center", color:C.muted, fontSize:11 }}>{lang==="ko"?"이 필터와 일치하는 재고 스냅샷이 없습니다.":"No inventory snapshots match these filters."}</div>
        )}
      </Panel>



      {inventoryApprovalRow && onApproveInventory && <InventoryApprovalModal row={inventoryApprovalRow} onClose={() => setInventoryApprovalRow(null)} onApprove={onApproveInventory}/>}

      {inventoryRevocationRow && onRevokeInventory && <InventoryApprovalRevocationModal row={inventoryRevocationRow} onClose={() => setInventoryRevocationRow(null)} onRevoke={onRevokeInventory}/>}

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(min(420px,100%),1fr))", gap:14, marginBottom:14 }}>
        {showInline && <InventoryTable title={lang === "ko" ? "인라인 재고 - 검증된 재고 보유 창고" : "Inline Inventory - Verified Stocked Warehouses"} rows={inlineItems} tableKey="inline" initialLimit={20} isExpanded={!!inventoryExpanded.inline} onToggleExpanded={() => setInventoryExpanded(prev => ({ ...prev, inline:!prev.inline }))} onRevoke={onRevokeInventory ? setInventoryRevocationRow : null} empty={lang === "ko" ? "현재 날짜 및 제품 필터와 일치하는 검증된 재고 보유 창고가 없습니다." : "No verified stocked warehouses matched the current date and product filters."}/>}
        {showInline && <InventoryTable title={lang === "ko" ? "판매 완료 창고" : "Sold Through Warehouses"} rows={inlineSoldThroughItems} tableKey="inline-sold-through" initialLimit={20} isExpanded={!!inventoryExpanded.soldThrough} onToggleExpanded={() => setInventoryExpanded(prev => ({ ...prev, soldThrough:!prev.soldThrough }))} empty={lang === "ko" ? "현재 제품 및 캠페인 필터와 일치하는 판매 완료 창고가 없습니다." : "No sold-through warehouses matched the current product and campaign filters."}/>}
        {showOnline && <InventoryTable
          title={lang === "ko" ? "온라인 재고 - 검증된 현재 재고" : "Online Inventory - Verified Current Stock"}
          rows={onlineItems}
          tableKey="online"
          isExpanded={!!inventoryExpanded.online}
          onToggleExpanded={() => setInventoryExpanded(prev => ({ ...prev, online:!prev.online }))}
          empty={lang === "ko" ? "현재 필터와 일치하는 검증된 온라인 재고가 없습니다." : "No verified online inventory matched the current filters."}
        />}
        {showOnline && <InventoryTable
          title={lang === "ko" ? "온라인 판매 완료" : "Online Sold Through"}
          rows={onlineSoldThroughItems}
          tableKey="online-sold-through"
          isExpanded={!!inventoryExpanded.onlineSoldThrough}
          onToggleExpanded={() => setInventoryExpanded(prev => ({ ...prev, onlineSoldThrough:!prev.onlineSoldThrough }))}
          empty={lang === "ko" ? "현재 필터와 일치하는 온라인 판매 완료 항목이 없습니다." : "No sold-through online inventory matched the current filters."}
        />}
      </div>

      {onlineAggregateItems.length === 0 && showOnline && (
        <Panel title="Inventory Upload Blueprint">
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))", gap:12 }}>
            {[
              { title:"Inline_Inventory_Raw", cols:["Date","Store","Product","Inventory","Units"] },
              { title:"Online_Inventory_Raw", cols:["Date","Product","Channel","Inventory","Units"] },
            ].map(section => (
              <div key={section.title} style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:14 }}>
                <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:8 }}>{section.title}</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(88px,1fr))", gap:6 }}>
                  {section.cols.map((col, i) => (
                    <div key={col} style={{ background:C.card, border:`1px solid ${i < 4 ? C.accent+"55" : C.border}`, borderRadius:6, padding:"7px 8px", fontSize:10, color:i < 4 ? C.text : C.muted }}>{col}{i < 4 && <span style={{ color:C.accent }}> *</span>}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

function ProductsView({ prodSales, ranked, selId, footnotes, selPid, dateRange, productMeta = {} }) {
  const prod = selPid
    ? (productWithMeta(selPid, productMeta) || productCatalog(productMeta)[0])
    : { id:"", name:"All Products", short:"All", col:C.accent, frac:1 };

  const filteredPS = useMemo(() =>
    prodSales.filter(r => (!selPid || productValuesMatch(r.pid, selPid, productMeta)) && r.date>=dateRange.start && r.date<=dateRange.end && (!selId||r.wid===selId))
  ,[prodSales,selPid,dateRange,selId,productMeta]);

  const days = inclusiveDays(dateRange.start, dateRange.end);
  const useDailyView = days <= 14;

  const chartData = useMemo(() => {
    const byDate=_.groupBy(filteredPS,"date");
    const dates=_.sortBy(Object.keys(byDate));
    if(useDailyView)return dates.map(date=>({label:salesTrendDateLabel(date),rev:_.sumBy(byDate[date]||[],"rev")}));
    return _.chunk(dates,7).map(chunk=>({label:salesTrendDateLabel(chunk[0]),rev:_.sumBy(chunk.flatMap(d=>byDate[d]||[]),"rev")}));
  },[filteredPS,useDailyView]);

  const byStore = useMemo(()=>_.orderBy(ranked.map(w=>({...w,total:_.sumBy(filteredPS.filter(r=>r.wid===w.id),"rev"),units:_.sumBy(filteredPS.filter(r=>r.wid===w.id),"units")})).filter(w=>w.total>0),"total","desc"),[filteredPS,ranked]);

  const totalProdRev = _.sumBy(byStore,"total");
  const totalUnits   = _.sumBy(byStore,"units");
  const daysSpan     = Math.max(1, days);
  const avgDay       = totalProdRev > 0 ? Math.round(totalProdRev / daysSpan) : 0;
  const sorted       = _.sortBy(filteredPS,"date");
  const h            = Math.floor(sorted.length/2);
  const rA           = _.sumBy(sorted.slice(0,h),"rev"), rB=_.sumBy(sorted.slice(h),"rev");
  const growth       = rA>0?(((rB-rA)/rA)*100):0;
  const activeStores = byStore.length;

  const prodNotes = footnotes.filter(f=>(!selPid||f.pid===selPid)&&f.date>=dateRange.start&&f.date<=dateRange.end&&(!selId||!f.wid||f.wid===selId));
  const refLines  = useMemo(()=>{
    const labels=chartData.map(c=>c.label),seen=new Set();
    return prodNotes.map(fn=>{
      const md=salesTrendDateLabel(fn.date);
      const key=useDailyView?md:(()=>{let bl=labels[0]||"";for(const l of labels){if(md>=l)bl=l;else break;}return bl;})();
      const k=`${fn.type}|${key}`;if(seen.has(k))return null;seen.add(k);return{...fn,key};
    }).filter(Boolean);
  },[prodNotes,chartData,useDailyView]);

  const selName=selId?ranked.find(w=>w.id===selId)?.name:null;

  return(
    <>
      {/* Product KPIs — marketing-analyst-focused */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
        {[
          {label:"Revenue",     val:fmtCompactMoney(totalProdRev), sub:`${dateRange.start.slice(5)} → ${dateRange.end.slice(5)}`,     c:prod.col},
          {label:"Units Sold",  val:totalUnits.toLocaleString(),            sub:`~$${Math.round(totalProdRev/Math.max(totalUnits,1))} avg/unit`, c:C.blue},
          {label:"Daily Avg",   val:`$${avgDay.toLocaleString()}`,          sub:`Over ${daysSpan} days`,                                        c:C.text},
          {label:"Revenue Lift",val:`${growth>=0?"+":""}${growth.toFixed(1)}%`, sub:`${activeStores}/${ranked.length} stores active`,         c:growth>=0?C.green:C.red},
        ].map(({label,val,sub,c})=>(
          <div key={label} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 16px"}}>
            <div style={{fontSize:10,...MONO,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>{label}</div>
            <div style={{...MONO,fontSize:16,fontWeight:500,color:c,marginBottom:3,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{val}</div>
            <div style={{fontSize:11,color:C.muted,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Revenue trend */}
      <Panel title={`${prod.name} — ${useDailyView?"Daily":"Weekly"} Revenue${selName?` · ${selName}`:""}`}>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={chartData} margin={{top:5,right:8,bottom:5,left:0}}>
            <CartesianGrid stroke={C.border} strokeDasharray="2 5" vertical={false}/>
            <XAxis dataKey="label" tick={{fontSize:10,fill:C.muted,fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif"}} axisLine={false} tickLine={false} interval={useDailyView?0:"preserveStartEnd"}/>
            <YAxis tick={{fontSize:10,fill:C.muted,fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif"}} axisLine={false} tickLine={false} tickFormatter={fmtCompactMoney}/>
            <Tooltip content={<TT col={prod.col}/>}/>
            {refLines.map((fn,i)=>(
              <ReferenceLine key={i} x={fn.key} stroke={FN_TYPES[fn.type]?.col||prod.col} strokeDasharray="4 3" strokeWidth={2}
                label={{value:FN_TYPES[fn.type]?.short,position:"insideTopLeft",fontSize:10,fill:FN_TYPES[fn.type]?.col||prod.col,fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif"}}
              />
            ))}
            <Line type="monotone" dataKey="rev" stroke={prod.col} strokeWidth={2.5}
              dot={(props)=>{
                const fn=refLines.find(f=>f.key===props.payload?.label);
                if(!fn)return (<g key={`pd-${props.payload?.label}`}/>);
                const col=FN_TYPES[fn.type]?.col||prod.col;
                return (
                  <circle key={`pd-${props.payload?.label}`} cx={props.cx} cy={props.cy} r={6} fill={col} stroke={C.card} strokeWidth={1.5}/>
                );
              }}
              activeDot={{r:5,fill:prod.col,strokeWidth:0}}
            />
          </LineChart>
        </ResponsiveContainer>
        {chartData.length===0&&<div style={{textAlign:"center",padding:"20px 0",fontSize:11,color:C.muted}}>No data for this range and product.</div>}
        <div style={{marginTop:6,fontSize:10,color:C.muted,...SANS}}>Tip: set start=end for a single-day lookup. Range ≤14 days switches to daily bars.</div>
      </Panel>

      {/* Per-store breakdown — only when no store selected */}
      {!selId && byStore.length>0 && (
        <Panel title={`${prod.name} — Revenue by Store`}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={byStore} margin={{top:5,right:8,bottom:36,left:0}}>
              <CartesianGrid stroke={C.border} strokeDasharray="2 5" vertical={false}/>
              <XAxis dataKey="name" tick={{fontSize:10,fill:C.muted,fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif"}} angle={-35} textAnchor="end" axisLine={false} tickLine={false} interval={0}/>
              <YAxis tick={{fontSize:10,fill:C.muted,fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif"}} axisLine={false} tickLine={false} tickFormatter={fmtCompactMoney}/>
              <Tooltip content={<TT col={prod.col}/>}/>
              <Bar dataKey="total" radius={[3,3,0,0]} fill={prod.col} opacity={0.88}/>
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      )}

      {/* Product footnotes */}
      {prodNotes.length>0&&(
        <Panel title={`${prod.short} — Notes in Range`}>
          {prodNotes.map(fn=>(
            <div key={fn.id} style={{background:C.bg,borderRadius:8,padding:10,marginBottom:8,border:`1px solid ${C.border}`,borderLeft:`3px solid ${FN_TYPES[fn.type]?.col||prod.col}`}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}><Badge type={fn.type}/><span style={{...MONO,fontSize:10,color:C.muted}}>{fn.date}</span></div>
              <div style={{fontWeight:500,fontSize:12}}>{fn.title}</div>
              {fn.body&&<div style={{fontSize:11,color:C.muted,marginTop:3}}>{fn.body}</div>}
            </div>
          ))}
        </Panel>
      )}
    </>
  );
}
