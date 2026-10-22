import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { normalizeOwnerInventoryDecisions } from "./src/lib/ownerInventoryDecisions.js";
import { buildPublishedSummaries, buildRuntimeBootstrap } from "./src/lib/publishedDataset.js";
import { normalizeOwnerSalesCorrections, buildOwnerSalesCorrectionHistory } from "./src/lib/ownerSalesCorrections.js";
import { buildRuntimeView, runtimeSourceOptions, inventoryRuntimeScope } from "./src/lib/runtimeViews.js";
import { INVENTORY_VIEW_REPRESENTATION } from "./src/lib/inventoryViewModel.js";
import { buildInventoryViewModelAsync } from "./src/lib/inventoryViewWorkerClient.mjs";
import {
  ANALYSIS_COMPACT_REPRESENTATION,
  analysisCompactCacheKey,
  analysisCompactWarmOptionsBySection,
  buildAnalysisCompactResult,
  normalizeAnalysisCompactOptions,
  restoreAnalysisCompactEvidence,
} from "./src/lib/analysisCompact.js";
import { loadAnalysisReferenceData } from "./src/lib/analysisReferenceData.mjs";
import { SALES_COMPACT_REPRESENTATION, SALES_UNUSED_WAREHOUSE_FIELDS, buildSalesCompactResult, salesCompactCacheKey, salesWarehouseReadScope } from "./src/lib/salesCompact.js";
import { normalizeStoreText, warehouseNumberFromText } from "./src/lib/storeLookup.js";
import { canonicalWarehouseDirectoryFromStores, canonicalWarehouseIsUnique } from "./src/lib/canonicalWarehouseApproval.js";
import { validateInventoryApprovalsForDataset, validateInventoryReviewDispositionsForDataset } from "./src/lib/serverDailyUpdate.js";
import {
  inventoryEligibilityState,
  filterWarehouseMatches,
  inventoryRowHasKnownBalance,
  inventoryValidationEvidence,
  isInventoryCoverageWarehouse,
  matchingInventoryReviewDisposition,
} from "./src/lib/dashboardScope.js";
import {
  exactLatestInventoryFactsMatchApproval,
  inventoryApprovalCampaignCoversObservation,
  MANUAL_INVENTORY_APPROVAL_DAYS,
  mergeRuntimeInventoryApprovals,
} from "./src/lib/manualInventoryApproval.js";
import { buildOwnerLegacyInventoryApprovalPreflight } from "./src/lib/ownerLegacyInventoryApproval.js";
import { eventUsesOnlineSales, selectAnalysisEventNotes, pacingWarehouseSourcePids } from "./src/lib/analysisSectionModels.js";
import { previousDatabaseVersionForRetention } from "./src/lib/publicationIntegrity.js";
import { buildSalesReadBlocks, readSalesReadBlocks } from "./src/lib/salesReadBlocks.mjs";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const connectionString = ""; // Public sample reads fictional file data only.
const configured = !!String(connectionString).trim();
export function classifyDatabaseTransport(value = "", environment = process.env) {
  const configuredValue = String(value || "").trim();
  const railwayRuntime = !!(
    environment?.RAILWAY_PROJECT_ID
    || environment?.RAILWAY_ENVIRONMENT_ID
    || environment?.RAILWAY_SERVICE_ID
    || environment?.RAILWAY_ENVIRONMENT_NAME
  );
  const railwayProduction = railwayRuntime && (
    String(environment?.NODE_ENV || "").toLowerCase() === "production"
    || String(environment?.RAILWAY_ENVIRONMENT_NAME || "").toLowerCase() === "production"
  );
  if (!configuredValue) {
    return { configured:false, classification:"not-configured", privateNetwork:false, railwayProduction, allowed:true };
  }
  let parsed;
  try {
    parsed = new URL(configuredValue);
  } catch {
    return { configured:true, classification:"malformed", privateNetwork:false, railwayProduction, allowed:false };
  }
  const protocol = String(parsed.protocol || "").toLowerCase();
  const hostname = String(parsed.hostname || "").toLowerCase().replace(/\.$/, "");
  if (!["postgres:", "postgresql:"].includes(protocol) || !hostname) {
    return { configured:true, classification:"malformed", privateNetwork:false, railwayProduction, allowed:false };
  }
  const privateNetwork = hostname.endsWith(".railway.internal") && hostname.length > ".railway.internal".length;
  const publicProxy = hostname.endsWith(".proxy.rlwy.net") || hostname.endsWith(".railway.app");
  const classification = privateNetwork ? "railway-private" : publicProxy ? "railway-public-proxy" : "external";
  return {
    configured:true,
    classification,
    privateNetwork,
    railwayProduction,
    allowed:!railwayProduction || privateNetwork,
  };
}
const databaseTransport = classifyDatabaseTransport(connectionString);
const useSsl = /^(require|verify-ca|verify-full)$/i.test(String(process.env.PGSSLMODE || ""));
const pool = configured && databaseTransport.allowed ? new Pool({
  connectionString,
  max:Number(process.env.BYOU_DB_POOL_SIZE || 8),
  idleTimeoutMillis:30_000,
  connectionTimeoutMillis:8_000,
  ssl:useSsl ? { rejectUnauthorized:true } : undefined,
}) : null;
let migrationPromise = null;
let canonicalWarehouseDirectoryPromise = null;
let bootstrapCache = null;
const viewCache = new Map();
const viewInFlight = new Map();
let inventoryViewAdmissionActive = false;
let queuedInventoryViewAdmission = null;
let viewGeneration = 0;
const VIEW_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const VIEW_CACHE_MAX = 32;
const RAW_WAREHOUSE_VIEWS = new Set(["inventory", "calendar", "warehouse"]);
const AFFINITY_ADDITIVE_FIELDS = Object.freeze(["rev", "units", "promo", "promoUnits", "refund", "refundUnits", "orders", "sessions", "adSpend"]);
const AFFINITY_STATE_FIELDS = Object.freeze(["inv", "inbound", "reserved"]);

function inventoryViewBusyError() {
  const error = new Error("Inventory is busy processing another selection. Retry the latest selection shortly.");
  error.code = "INVENTORY_WORKER_BUSY";
  error.status = 503;
  return error;
}

function startInventoryViewAdmission(entry) {
  inventoryViewAdmissionActive = true;
  Promise.resolve()
    .then(entry.operation)
    .then(entry.resolve, entry.reject)
    .finally(() => {
      const next = queuedInventoryViewAdmission;
      queuedInventoryViewAdmission = null;
      if (next) startInventoryViewAdmission(next);
      else inventoryViewAdmissionActive = false;
    });
}

function runInventoryViewWithAdmission(operation) {
  return new Promise((resolve, reject) => {
    const entry = { operation, resolve, reject };
    if (!inventoryViewAdmissionActive) startInventoryViewAdmission(entry);
    else if (!queuedInventoryViewAdmission) queuedInventoryViewAdmission = entry;
    else reject(inventoryViewBusyError());
  });
}

export function parseAffinityWeeklyShadowMode(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "off") return "off";
  if (normalized === "compare") return "compare";
  throw new Error("BYOU_AFFINITY_WEEKLY_SHADOW must be off or compare.");
}

let affinityWeeklyShadowMode = "off";
try {
  affinityWeeklyShadowMode = parseAffinityWeeklyShadowMode(process.env.BYOU_AFFINITY_WEEKLY_SHADOW);
} catch (error) {
  console.warn("[BYOU Intel] Affinity weekly shadow disabled:", error.message);
}

function invalidateRuntimeViewCaches() {
  viewGeneration += 1;
  viewCache.clear();
  viewInFlight.clear();
}

pool?.on("error", error => console.error("[BYOU Intel] PostgreSQL pool error:", error.message));

export function databaseConfigured() {
  return configured;
}

export function databaseTransportStatus() {
  return { ...databaseTransport };
}

function assertDatabaseTransportAllowed() {
  if (!configured || databaseTransport.allowed) return;
  const error = new Error("The configured database transport is not permitted in this environment.");
  error.code = "DATABASE_TRANSPORT_NOT_PERMITTED";
  error.status = 503;
  throw error;
}

export function databaseViewSummaryPlan(options = {}) {
  const productScoped = !!(options.pids?.length || options.cids?.length || options.cid);
  if (options.view === "videos") return {
    productScoped, useRawWarehouseRows:false, includeRawPortfolioSales:false,
    includeCampaignWarehouseDaily:false, includePortfolioWarehouseDaily:false,
    summaryCategories:[],
  };
  const useRawWarehouseRows = RAW_WAREHOUSE_VIEWS.has(options.view);
  const includeRawPortfolioSales = useRawWarehouseRows && options.view !== "inventory";
  const dateScopedAllCampaigns = options.view === "campaign" && !!options.from && !!options.to && !productScoped;
  const compactAnalysis = options.view === "rankings" && options.representation === ANALYSIS_COMPACT_REPRESENTATION;
  const compactSales = options.view === "analytics" && options.representation === SALES_COMPACT_REPRESENTATION;
  const analysisNeedsProductHistory = compactAnalysis && ["pacing", "affinity", "comparison", "events", "warehouses"].includes(options.section);
  const analysisNeedsPortfolioHistory = compactAnalysis && options.section === "demographics";
  const includeCampaignWarehouseDaily = !useRawWarehouseRows && (productScoped || dateScopedAllCampaigns || analysisNeedsProductHistory);
  const includePortfolioWarehouseDaily = !useRawWarehouseRows && (!productScoped || analysisNeedsPortfolioHistory) && !analysisNeedsProductHistory;
  const compactInventory = options.view === "inventory" && options.representation === INVENTORY_VIEW_REPRESENTATION;
  const summaryCategories = compactInventory
    ? ["campaign-daily-online"]
    : compactSales
      ? ["campaign-daily-inline", "campaign-daily-online", productScoped ? "campaign-warehouse-daily" : "warehouse-portfolio-daily"]
    : compactAnalysis
      ? options.section === "events"
        ? []
        : options.section === "demographics" && !productScoped
          ? ["warehouse-portfolio-daily"]
          : ["campaign-warehouse-daily"]
      : ["campaign-daily-inline", "campaign-daily-online"];
  if (!compactAnalysis && !compactSales) {
    if (["campaign", "rankings"].includes(options.view)) summaryCategories.push("analysis-daily");
    if (includeCampaignWarehouseDaily) summaryCategories.push("campaign-warehouse-daily");
    if (includePortfolioWarehouseDaily) summaryCategories.push("warehouse-portfolio-daily");
    if (options.view === "analytics" && options.region) summaryCategories.push("analysis-region-daily");
    if (options.view === "analytics" && options.state) summaryCategories.push("analysis-state-daily");
  }
  return {
    productScoped,
    useRawWarehouseRows,
    includeRawPortfolioSales,
    includeCampaignWarehouseDaily,
    includePortfolioWarehouseDaily,
    summaryCategories,
  };
}

export function compactSalesFactSourceOptions(options = {}) {
  return { ...options, wid:"", wids:[], region:"", state:"" };
}

export function warehouseAnalysisSourceOptions(bootstrap = {}, options = {}) {
  const publishedStart = text(bootstrap.summaries?.bounds?.start).slice(0, 10);
  const publishedEnd = text(bootstrap.summaries?.bounds?.end).slice(0, 10);
  const requestedDates = [text(options.from).slice(0, 10), text(options.to).slice(0, 10)]
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value));
  if (requestedDates.some(value => publishedStart && value < publishedStart || publishedEnd && value > publishedEnd)) {
    const error = new Error(`Warehouse Analysis dates must remain within published data coverage (${publishedStart || "unknown"} to ${publishedEnd || "unknown"}).`);
    error.status = 400;
    error.code = "WAREHOUSE_SCOPE_OUTSIDE_PUBLICATION";
    throw error;
  }
  const requestedCampaigns = new Set([...(options.cids || []), options.cid, options.primaryCid].map(text).filter(Boolean));
  const requestedProducts = new Set([...(options.pids || []), options.primaryPid].map(text).filter(Boolean));
  const campaigns = Object.entries(bootstrap.campaignMeta || {}).map(([key, value]) => ({
    id:text(value?.id || key),
    pid:text(value?.pid),
    start:text(value?.start).slice(0, 10),
  })).filter(campaign => (!requestedCampaigns.size || requestedCampaigns.has(campaign.id))
    && (!requestedProducts.size || requestedProducts.has(campaign.pid)));
  const earliestCampaignStart = campaigns.map(campaign => campaign.start).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort()[0] || "";
  const sourceStart = [publishedStart, earliestCampaignStart, text(options.from)]
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort()[0] || "";
  return {
    ...options,
    from:sourceStart,
    wid:"",
    wids:[],
    region:"",
    state:"",
  };
}

export function compactAnalysisOfficialRows(bootstrap = {}, options = {}, empty = false) {
  const pacing = options.view === "rankings"
    && options.representation === ANALYSIS_COMPACT_REPRESENTATION
    && options.section === "pacing";
  const warehouses = options.view === "rankings"
    && options.representation === ANALYSIS_COMPACT_REPRESENTATION
    && options.section === "warehouses";
  if ((!pacing && !warehouses) || empty || !Array.isArray(bootstrap.inlineTotalSales)) return [];
  if (warehouses) return bootstrap.inlineTotalSales;
  // Published official totals have no warehouse geography. The prior SQL path
  // therefore returned no official rows for any geographic request.
  if (options.wids?.length || options.wid || options.region || options.state) return [];
  return bootstrap.inlineTotalSales;
}

function eventScopeWindow(notes = []) {
  const dates = notes.map(note => text(note?.date).slice(0, 10)).filter(Boolean).sort();
  return dates.length ? { from:shiftDateKey(dates[0], -7), to:shiftDateKey(dates.at(-1), 6) } : null;
}

function intersectEventWarehouses(options = {}, noteWarehouses = []) {
  const requested = options.wids?.length ? normalizedSet(options.wids) : options.wid ? [text(options.wid)] : [];
  if (!noteWarehouses.length) return requested;
  if (!requested.length) return normalizedSet(noteWarehouses);
  const allowed = new Set(noteWarehouses);
  const intersection = requested.filter(wid => allowed.has(wid));
  return intersection.length ? intersection : ["__byou_no_event_warehouse_match__"];
}

export function analysisEventEvidenceScopes(notes = [], options = {}) {
  const inlineNotes = notes.filter(note => !eventUsesOnlineSales(note));
  const onlineNotes = notes.filter(eventUsesOnlineSales);
  const inlineWindow = eventScopeWindow(inlineNotes);
  const onlineWindow = eventScopeWindow(onlineNotes);
  let inline = null;
  if (inlineWindow) {
    const allWarehouseSpecific = inlineNotes.every(note => text(note?.wid));
    const noteWarehouses = allWarehouseSpecific ? normalizedSet(inlineNotes.map(note => note.wid)) : [];
    inline = { ...options, ...inlineWindow };
    if (allWarehouseSpecific) {
      inline.wid = "";
      inline.wids = intersectEventWarehouses(options, noteWarehouses);
    }
  }
  const online = onlineWindow ? { ...options, ...onlineWindow } : null;
  return { inline, online };
}

export async function loadCompactEventDatabaseEvidence({
  client,
  versionId,
  bootstrap = {},
  options = {},
  queryRowsImpl = queryRows,
} = {}) {
  const factRows = await queryRowsImpl(
    "byou_fact_rows",
    "kind",
    versionId,
    ["footnotes"],
    options,
    { allowBlankPid:true, allowBlankCid:true },
    client,
  );
  const footnotes = selectAnalysisEventNotes({
    footnotes:factRows.footnotes || [],
    productMeta:bootstrap.productMeta || {},
    campaignMeta:bootstrap.campaignMeta || {},
  }, options);
  const scopes = analysisEventEvidenceScopes(footnotes, options);
  if (!footnotes.length) return { footnotes:[], warehouseDaily:[], onlineDaily:[], scopes };
  const warehouse = scopes.inline
    ? await queryRowsImpl(
        "byou_summary_rows",
        "grain",
        versionId,
        ["campaign-warehouse-daily"],
        scopes.inline,
        { allowBlankPid:false, allowBlankCid:true },
        client,
      )
    : {};
  const online = scopes.online
    ? await queryRowsImpl(
        "byou_summary_rows",
        "grain",
        versionId,
        ["campaign-daily-online"],
        scopes.online,
        { allowBlankPid:false, allowBlankCid:true },
        client,
      )
    : {};
  return {
    footnotes,
    warehouseDaily:warehouse["campaign-warehouse-daily"] || [],
    onlineDaily:online["campaign-daily-online"] || [],
    scopes,
  };
}

function normalizedSet(values = []) {
  return [...new Set((values || []).map(value => text(value).trim()).filter(Boolean))].sort();
}

function shiftDateKey(value, days) {
  const parsed = Date.parse(`${text(value).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed) ? new Date(parsed + Number(days || 0) * 86400000).toISOString().slice(0, 10) : text(value);
}

export function inventoryCompactCacheKey(versionId, options = {}) {
  const cids = normalizedSet(options.cids?.length ? options.cids : options.cid ? [options.cid] : []);
  return `${text(versionId)}|${JSON.stringify({
    representation:INVENTORY_VIEW_REPRESENTATION,
    from:text(options.from),
    to:text(options.to),
    pids:normalizedSet(options.pids),
    cids,
    wid:text(options.wid),
    region:text(options.region),
    state:text(options.state),
    inventoryType:text(options.inventoryType),
    storeSearch:text(options.storeSearch).trim(),
    publication:text(options.publication),
    evaluationDate:text(options.evaluationDate),
    approvalRevision:text(options.approvalRevision || "0"),
  })}`;
}

export function compactViewInFlightKey(generation, options = {}) {
  const compactInventory = options?.view === "inventory" && options?.representation === INVENTORY_VIEW_REPRESENTATION;
  const compactAnalysis = options?.view === "rankings" && options?.representation === ANALYSIS_COMPACT_REPRESENTATION;
  const compactSales = options?.view === "analytics" && options?.representation === SALES_COMPACT_REPRESENTATION;
  if (!compactInventory && !compactAnalysis && !compactSales) return "";
  const identity = compactInventory
    ? inventoryCompactCacheKey("pending", options)
    : compactAnalysis
      ? analysisCompactCacheKey("pending", options)
      : salesCompactCacheKey("pending", options);
  return `${generation}|${identity}${options.forceRefresh ? "|force" : ""}`;
}

export function inventoryCompactWarmOptions(bootstrap = {}, evaluationDate = businessDateKey()) {
  const bounds = bootstrap.summaries?.bounds || {};
  return {
    view:"inventory",
    representation:INVENTORY_VIEW_REPRESENTATION,
    from:text(bounds.start),
    to:text(bounds.end),
    pids:[],
    cid:"",
    cids:[],
    wid:"",
    region:"",
    state:"",
    inventoryType:"inline",
    storeSearch:"",
    publication:text(bootstrap.publishedAt),
    evaluationDate:text(evaluationDate),
    approvalRevision:text(bootstrap.approvalRevision || "0"),
  };
}

export function inventoryCompactPhysicalSourceOptions(bootstrap = {}, options = {}) {
  const storeSearch = text(options.storeSearch).trim();
  if (!storeSearch) return options;
  const candidates = (bootstrap.whs || []).filter(warehouse => (
    isInventoryCoverageWarehouse(warehouse)
    && (!options.wid || text(warehouse?.id) === text(options.wid))
    && (!options.region || text(warehouse?.region) === text(options.region))
    && (!options.state || text(warehouse?.st || warehouse?.state) === text(options.state))
  ));
  const matches = filterWarehouseMatches(candidates, storeSearch).map(warehouse => text(warehouse?.id)).filter(Boolean);
  return {
    ...options,
    wid:"",
    wids:matches.length ? matches : ["__byou_no_inventory_store_match__"],
  };
}

export async function runDatabaseMigrations(migrationPool, migrations) {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    // A blocked schema change must not queue an exclusive lock indefinitely.
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const sql of migrations) await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function initializeDatabase() {
  if (!configured) return false;
  assertDatabaseTransportAllowed();
  if (!migrationPromise) {
    migrationPromise = Promise.all([
      readFile(path.join(__dirname, "migrations", "001_published_runtime.sql"), "utf8"),
      readFile(path.join(__dirname, "migrations", "002_manual_inventory_approvals.sql"), "utf8"),
      readFile(path.join(__dirname, "migrations", "003_owner_legacy_inventory_approvals.sql"), "utf8"),
      readFile(path.join(__dirname, "migrations", "005_auth_state.sql"), "utf8"),
      readFile(path.join(__dirname, "migrations", "006_runtime_product_index.sql"), "utf8"),
    ])
      .then(migrations => runDatabaseMigrations(pool, migrations))
      .then(() => true)
      .catch(error => {
        migrationPromise = null;
        throw error;
      });
  }
  return migrationPromise;
}

export async function connectAuthenticationDatabase() {
  if (!await initializeDatabase()) throw new Error("Authentication database is not configured.");
  return pool.connect();
}

function text(value) {
  return String(value ?? "");
}

function dateKey(value) {
  const valueText = text(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(valueText) ? valueText : null;
}

function businessDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone:"America/Los_Angeles",
    year:"numeric",
    month:"2-digit",
    day:"2-digit",
  }).formatToParts(value);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

async function canonicalWarehouseDirectory() {
  if (!canonicalWarehouseDirectoryPromise) {
    canonicalWarehouseDirectoryPromise = readFile(path.join(__dirname, "public", "data", "costco-market-demographics.json"), "utf8")
      .then(source => JSON.parse(source))
      .then(payload => canonicalWarehouseDirectoryFromStores(payload?.stores || []))
      .catch(error => {
        canonicalWarehouseDirectoryPromise = null;
        throw error;
      });
  }
  return canonicalWarehouseDirectoryPromise;
}

function warehouseFields(row, warehouseById) {
  const warehouse = warehouseById.get(text(row?.wid));
  return {
    region:text(row?.region || warehouse?.region),
    state:text(row?.st || warehouse?.st),
  };
}

async function insertRows(client, table, versionId, category, rows, warehouseById) {
  const batchSize = 250;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const params = [];
    const values = batch.map((row, index) => {
      const geo = warehouseFields(row, warehouseById);
      const base = params.length;
      params.push(
        versionId,
        category,
        offset + index,
        dateKey(row?.date),
        text(row?.pid),
        text(row?.cid),
        text(row?.wid),
        geo.region,
        geo.state,
        text(row?.channel),
        JSON.stringify(row || {}),
      );
      return `(${Array.from({ length:11 }, (_, parameter) => `$${base + parameter + 1}`).join(",")})`;
    });
    const categoryColumn = table === "byou_fact_rows" ? "kind" : "grain";
    await client.query(
      `INSERT INTO ${table} (version_id, ${categoryColumn}, ordinal, date_key, pid, cid, wid, region, state, channel, payload) VALUES ${values.join(",")}`,
      params,
    );
  }
}

function summaryGroups(summaries) {
  return [
    ["campaign-daily-inline", summaries.campaign.dailyInline],
    ["campaign-daily-online", summaries.campaign.dailyOnline],
    ["campaign-warehouse-period", summaries.campaign.warehouse],
    ["campaign-warehouse-daily", summaries.campaign.warehouseDaily],
    ["warehouse-portfolio-period", summaries.campaign.portfolioWarehouse],
    ["warehouse-portfolio-daily", summaries.campaign.portfolioWarehouseDaily],
    ["analysis-daily", summaries.analysis.daily],
    ["analysis-region-daily", summaries.analysis.regionDaily],
    ["analysis-state-daily", summaries.analysis.stateDaily],
  ];
}

export async function publishDatasetToDatabase(dataset, prepared = {}) {
  if (!configured) return { configured:false };
  await initializeDatabase();
  const today = businessDateKey();
  const validatedDataset = {
    ...dataset,
    ownerInventoryDecisions:normalizeOwnerInventoryDecisions(dataset.ownerInventoryDecisions || [], dataset),
    ownerSalesCorrections:normalizeOwnerSalesCorrections(dataset.ownerSalesCorrections || [], dataset, { today }),
    inventoryApprovals:validateInventoryApprovalsForDataset(dataset, {
      today,
      canonicalWarehouseDirectory:await canonicalWarehouseDirectory(),
    }),
    inventoryReviewDispositions:validateInventoryReviewDispositionsForDataset(dataset, { today }),
  };
  const versionId = text(prepared.versionId || prepared.publicationId) || crypto.randomUUID();
  const summaries = prepared.summaries || buildPublishedSummaries(validatedDataset);
  const preparedBootstrap = prepared.bootstrap || buildRuntimeBootstrap(validatedDataset, summaries);
  const bootstrap = {
    ...preparedBootstrap,
    ownerInventoryDecisions:validatedDataset.ownerInventoryDecisions,
    ownerSalesCorrections:validatedDataset.ownerSalesCorrections,
    ownerSalesCorrectionHistory:buildOwnerSalesCorrectionHistory(validatedDataset),
    inventoryApprovals:validatedDataset.inventoryApprovals,
    inventoryReviewDispositions:validatedDataset.inventoryReviewDispositions,
  };
  const warehouseById = new Map((validatedDataset.whs || []).map(row => [text(row?.id), row]));
  const factGroups = [
    ["sales", validatedDataset.sales || []],
    ["prodSales", validatedDataset.prodSales || []],
    ["inlineTotalSales", validatedDataset.inlineTotalSales || []],
    ["onlineSales", validatedDataset.onlineSales || []],
    ["ppcRows", validatedDataset.ppcRows || []],
    ["footnotes", validatedDataset.footnotes || []],
    ["videos", validatedDataset.videos || []],
    ["videoMetrics", validatedDataset.videoMetrics || []],
  ];
  const rowCounts = Object.fromEntries(factGroups.map(([kind, rows]) => [kind, rows.length]));
  const groupedSummaries = summaryGroups(summaries);
  const summaryRowCounts = Object.fromEntries(groupedSummaries.map(([grain, rows]) => [grain, (rows || []).length]));
  const publicationMetadata = {
    bounds:summaries.bounds,
    publicationId:text(prepared.publicationId),
    datasetSha256:text(prepared.datasetSha256),
    startupSha256:text(prepared.startupSha256),
    summaryRowCounts,
  };
  const client = await pool.connect();
  let committed = false;
  let preUpdateActiveVersionId = "";
  try {
    await client.query("BEGIN");
    const preUpdateState = await client.query("SELECT active_version FROM byou_runtime_state WHERE singleton=true FOR UPDATE");
    preUpdateActiveVersionId = text(preUpdateState.rows[0]?.active_version);
    const existingVersion = await client.query(
      "SELECT id, published_at, status, metadata, row_counts FROM byou_dataset_versions WHERE id=$1",
      [versionId],
    );
    if (existingVersion.rows.length) {
      const existing = existingVersion.rows[0];
      const existingPublishedAt = existing.published_at instanceof Date
        ? existing.published_at.toISOString()
        : new Date(existing.published_at).toISOString();
      const metadata = existing.metadata || {};
      const exact = existing.status === "active"
        && preUpdateActiveVersionId === versionId
        && existingPublishedAt === new Date(validatedDataset.publishedAt).toISOString()
        && text(metadata.publicationId) === text(prepared.publicationId)
        && text(metadata.datasetSha256) === text(prepared.datasetSha256)
        && text(metadata.startupSha256) === text(prepared.startupSha256)
        && Object.entries(rowCounts).every(([key, value]) => Number(existing.row_counts?.[key]) === Number(value));
      if (!exact) {
        throw Object.assign(new Error("The publication database version already exists with different or inactive content."), { status:409, code:"PUBLICATION_DATABASE_VERSION_COLLISION" });
      }
      await client.query("COMMIT");
      committed = true;
      bootstrapCache = { versionId, payload:bootstrap };
      invalidateRuntimeViewCaches();
      return { configured:true, versionId, rowCounts, previousVersionId:"", cleanupWarning:"", alreadyApplied:true };
    }
    await client.query(
      "INSERT INTO byou_dataset_versions (id, published_at, source_schema, status, metadata, row_counts) VALUES ($1,$2,$3,'loading',$4::jsonb,$5::jsonb)",
      [versionId, validatedDataset.publishedAt, validatedDataset.schema, JSON.stringify(publicationMetadata), JSON.stringify(rowCounts)],
    );
    await client.query(
      "INSERT INTO byou_dataset_blobs (version_id, kind, payload) VALUES ($1,'bootstrap',$2::jsonb)",
      [versionId, JSON.stringify(bootstrap)],
    );
    await client.query(
      "INSERT INTO byou_dataset_blobs (version_id, kind, payload) VALUES ($1,'owner-sales-corrections',$2::jsonb)",
      [versionId, JSON.stringify(validatedDataset.ownerSalesCorrections)],
    );
    for (const [kind, rows] of factGroups) await insertRows(client, "byou_fact_rows", versionId, kind, rows, warehouseById);
    for (const [grain, rows] of groupedSummaries) await insertRows(client, "byou_summary_rows", versionId, grain, rows || [], warehouseById);
    const insertedFacts = await client.query("SELECT kind, count(*)::int AS count FROM byou_fact_rows WHERE version_id=$1 GROUP BY kind", [versionId]);
    const insertedFactCounts = Object.fromEntries(insertedFacts.rows.map(row => [text(row.kind), Number(row.count)]));
    const insertedSummaries = await client.query("SELECT grain, count(*)::int AS count FROM byou_summary_rows WHERE version_id=$1 GROUP BY grain", [versionId]);
    const insertedSummaryCounts = Object.fromEntries(insertedSummaries.rows.map(row => [text(row.grain), Number(row.count)]));
    const factCountsMatch = Object.entries(rowCounts).every(([kind, count]) => Number(insertedFactCounts[kind] || 0) === count);
    const summaryCountsMatch = Object.entries(summaryRowCounts).every(([grain, count]) => Number(insertedSummaryCounts[grain] || 0) === count);
    if (!factCountsMatch || !summaryCountsMatch) {
      throw Object.assign(new Error("The database row counts did not match the validated publication."), { status:500, code:"PUBLICATION_DATABASE_COUNT_MISMATCH" });
    }
    // Optional derived read acceleration must never block an otherwise valid
    // publication or change its authoritative summaries.
    await client.query("SAVEPOINT sales_read_blocks");
    try {
      await buildSalesReadBlocks(client, versionId);
      await client.query("RELEASE SAVEPOINT sales_read_blocks");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT sales_read_blocks");
      await client.query("RELEASE SAVEPOINT sales_read_blocks");
      console.warn("[BYOU Intel] Sales read blocks were not prepared; authoritative summary reads remain enabled.");
    }
    await client.query("UPDATE byou_dataset_versions SET status='superseded' WHERE status='active'");
    await client.query("UPDATE byou_dataset_versions SET status='active' WHERE id=$1", [versionId]);
    await client.query(
      "INSERT INTO byou_runtime_state (singleton, active_version, updated_at) VALUES (true,$1,now()) ON CONFLICT (singleton) DO UPDATE SET active_version=excluded.active_version, updated_at=now()",
      [versionId],
    );
    await client.query("COMMIT");
    committed = true;
    bootstrapCache = { versionId, payload:bootstrap };
    invalidateRuntimeViewCaches();
    const previousVersionId = previousDatabaseVersionForRetention(prepared.previousVersionId, preUpdateActiveVersionId);
    let cleanupWarning = "";
    try {
      await pool.query(`DELETE FROM byou_dataset_versions
        WHERE id <> $1
          AND ($2 = '' OR id <> $2)`, [versionId, previousVersionId]);
    } catch (error) {
      cleanupWarning = error.message || "Superseded publication cleanup failed.";
      console.error("[BYOU Intel] Superseded database cleanup did not complete:", cleanupWarning);
    }
    return { configured:true, versionId, rowCounts, previousVersionId, cleanupWarning };
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function activeVersion(client = pool) {
  const result = await client.query("SELECT active_version FROM byou_runtime_state WHERE singleton=true");
  return text(result.rows[0]?.active_version);
}

async function getDatabaseBaseBootstrap(versionId = "", client = pool) {
  if (!configured) return null;
  await initializeDatabase();
  const resolvedVersionId = text(versionId || await activeVersion(client));
  if (!resolvedVersionId) return null;
  if (bootstrapCache?.versionId === resolvedVersionId) return bootstrapCache.payload;
  const result = await client.query("SELECT payload FROM byou_dataset_blobs WHERE version_id=$1 AND kind='bootstrap'", [resolvedVersionId]);
  const storedPayload = result.rows[0]?.payload || null;
  if (!storedPayload) return null;
  let payload = storedPayload;
  if (!Array.isArray(payload.warehouseDailySales)) {
    const daily = await client.query(
      "SELECT payload FROM byou_summary_rows WHERE version_id=$1 AND grain='analysis-daily' ORDER BY date_key NULLS FIRST, ordinal",
      [resolvedVersionId],
    );
    payload = { ...payload, warehouseDailySales:daily.rows.map(row => row.payload) };
  }
  bootstrapCache = { versionId:resolvedVersionId, payload };
  return payload;
}

function approvalDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  return dateKey(value) || "";
}

function approvalProjection(row = {}) {
  return {
    issueId:text(row.issue_id),
    issueCode:text(row.issue_code),
    approved:true,
    pid:text(row.pid),
    cid:text(row.cid),
    grain:"physical_warehouse",
    wid:text(row.wid),
    location:text(row.location),
    inventoryDate:approvalDate(row.inventory_date),
    onHand:Number(row.on_hand),
    inventoryStatus:"On hand",
    receiptDate:approvalDate(row.receipt_date),
    approvalDate:approvalDate(row.approval_date),
    expiresOn:approvalDate(row.expires_on),
    approvalSource:"manual_runtime",
    evidenceKind:text(row.evidence_kind || "receipt_or_count"),
  };
}

function inventoryApprovalHistoryFingerprint(scope = {}, facts = [], warehouse = {}) {
  const normalizedFacts = (facts || []).map(row => ({
    date:dateKey(row?.date) || "",
    invKnown:Object.prototype.hasOwnProperty.call(row || {}, "invKnown") ? row?.invKnown === true : null,
    inv:inventoryRowHasKnownBalance(row) ? Number(row.inv) : null,
    units:Number.isFinite(Number(row?.units)) ? Number(row.units) : 0,
    rev:Number.isFinite(Number(row?.rev)) ? Number(row.rev) : 0,
  }));
  return crypto.createHash("sha256").update(JSON.stringify({
    scope:{ pid:text(scope.pid), cid:text(scope.cid), wid:text(scope.wid) },
    warehouse:{
      number:warehouseNumberFromText(warehouse?.warehouseNo || warehouse?.name || warehouse?.id),
      name:normalizeStoreText(warehouse?.name),
      state:text(warehouse?.st || warehouse?.state).trim().toUpperCase(),
    },
    facts:normalizedFacts,
  })).digest("hex");
}

async function manualInventoryApprovalRevision(client = pool) {
  const result = await client.query("SELECT COALESCE(MAX(event_sequence), 0)::text AS approval_revision FROM byou_inventory_approval_events");
  return text(result.rows[0]?.approval_revision || "0");
}

export async function getManualInventoryApprovalOverlay({ versionId = "", evaluationDate = businessDateKey(), approvalRevision = "", client = pool, warehouses = null } = {}) {
  if (!configured) return { configured:false, versionId:"", approvals:[], approvalRevision:"0", evaluationDate };
  await initializeDatabase();
  const resolvedVersionId = text(versionId || await activeVersion(client));
  if (!resolvedVersionId) return { configured:true, versionId:"", approvals:[], approvalRevision:"0", evaluationDate };
  const resolvedApprovalRevision = text(approvalRevision || await manualInventoryApprovalRevision(client) || "0");
  const warehouseRows = Array.isArray(warehouses)
    ? warehouses
    : (await getDatabaseBaseBootstrap(resolvedVersionId, client))?.whs || [];
  const warehouseById = new Map(warehouseRows.map(warehouse => [text(warehouse?.id), warehouse]));
  const directory = await canonicalWarehouseDirectory();
  const result = await client.query(`
    WITH latest_events AS (
      SELECT DISTINCT ON (grain, pid, cid, wid)
        action, event_sequence, evidence_kind, fact_sha256, issue_id, issue_code, grain, pid, cid, wid, location,
        inventory_date, on_hand, receipt_date, approval_date, expires_on
      FROM byou_inventory_approval_events
      ORDER BY grain, pid, cid, wid, event_sequence DESC
    ), active_events AS (
      SELECT *
      FROM latest_events
      WHERE action='approved' AND expires_on >= $2::date
    )
    SELECT
      $1::text AS version_id,
      e.fact_sha256,
      e.evidence_kind, e.issue_id, e.issue_code, e.grain, e.pid, e.cid, e.wid, e.location,
      e.inventory_date, e.on_hand, e.receipt_date, e.approval_date, e.expires_on,
      scoped.fact_payloads
    FROM active_events e
    CROSS JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(f.payload ORDER BY f.date_key NULLS FIRST, f.ordinal), '[]'::jsonb) AS fact_payloads
      FROM byou_fact_rows f
      WHERE f.version_id=$1 AND f.kind='prodSales'
        AND f.pid=e.pid AND f.cid=e.cid AND f.wid=e.wid
    ) scoped
    ORDER BY e.pid, e.cid, e.wid, e.inventory_date
  `, [resolvedVersionId, evaluationDate]);
  const validRows = result.rows.filter(row => {
    const facts = Array.isArray(row.fact_payloads) ? row.fact_payloads : [];
    const warehouse = warehouseById.get(text(row.wid));
    return !!warehouse
      && isInventoryCoverageWarehouse(warehouse)
      && canonicalWarehouseIsUnique(warehouse, warehouseRows, directory)
      && exactLatestInventoryFactsMatchApproval(facts, {
        pid:row.pid,
        cid:row.cid,
        wid:row.wid,
        inventoryDate:approvalDate(row.inventory_date),
        onHand:Number(row.on_hand),
      })
      && inventoryApprovalHistoryFingerprint(row, facts, warehouse) === text(row.fact_sha256);
  });
  return {
    configured:true,
    versionId:resolvedVersionId,
    approvals:validRows.map(approvalProjection),
    approvalRevision:resolvedApprovalRevision,
    evaluationDate,
  };
}

async function getDatabaseBootstrapForVersion(versionId, client, evaluationDate = businessDateKey(), approvalRevision = "") {
  const bootstrap = await getDatabaseBaseBootstrap(versionId, client);
  if (!bootstrap) return null;
  const overlay = await getManualInventoryApprovalOverlay({ versionId, evaluationDate, approvalRevision, client, warehouses:bootstrap.whs || [] });
  const publishedInventoryApprovals = Array.isArray(bootstrap.inventoryApprovals) ? bootstrap.inventoryApprovals : [];
  const inventoryApprovals = mergeRuntimeInventoryApprovals(bootstrap, overlay.approvals, evaluationDate);
  return {
    ...bootstrap,
    publishedInventoryApprovals,
    manualInventoryApprovals:inventoryApprovals.filter(approval => approval?.approvalSource === "manual_runtime"),
    inventoryApprovals,
    approvalRevision:overlay.approvalRevision,
    approvalEvaluationDate:evaluationDate,
  };
}

export async function getDatabaseBootstrapBinding(requestedVersionId = "") {
  if (!configured) return null;
  await initializeDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const exactVersionId = text(requestedVersionId);
    if (exactVersionId) {
      const available = await client.query(`
        SELECT 1
        FROM byou_dataset_versions version
        JOIN byou_dataset_blobs blob ON blob.version_id=version.id AND blob.kind='bootstrap'
        WHERE version.id=$1
      `, [exactVersionId]);
      if (!available.rows.length) {
        await client.query("COMMIT");
        return null;
      }
    }
    const versionId = text(exactVersionId || await activeVersion(client));
    const bootstrap = versionId ? await getDatabaseBootstrapForVersion(versionId, client) : null;
    await client.query("COMMIT");
    return bootstrap ? { versionId, bootstrap } : null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getDatabasePublicationBinding(requestedVersionId = "") {
  if (!configured) return null;
  await initializeDatabase();
  const client = await pool.connect();
  try {
    const versionId = text(requestedVersionId || await activeVersion(client));
    if (!versionId) return null;
    const result = await client.query(`
      SELECT version.id, version.published_at
      FROM byou_dataset_versions version
      JOIN byou_dataset_blobs blob ON blob.version_id=version.id AND blob.kind='bootstrap'
      WHERE version.id=$1
    `, [versionId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      versionId:text(row.id),
      publishedAt:row.published_at instanceof Date ? row.published_at.toISOString() : text(row.published_at),
    };
  } finally {
    client.release();
  }
}

export async function getDatabaseBootstrap(requestedVersionId = "") {
  return (await getDatabaseBootstrapBinding(requestedVersionId))?.bootstrap || null;
}

function databaseApprovalError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

async function lockedApprovalPublication(client, requestedVersionId = "", unavailableMessage = "The requested publication is unavailable for inventory approval.") {
  const state = await client.query("SELECT active_version FROM byou_runtime_state WHERE singleton=true FOR UPDATE");
  const activeVersionId = text(state.rows[0]?.active_version);
  if (!activeVersionId) {
    throw databaseApprovalError(503, "INVENTORY_APPROVAL_DATABASE_REQUIRED", "No active shared dataset is available for inventory approval.");
  }
  const versionId = text(requestedVersionId || activeVersionId);
  const version = await client.query("SELECT id, published_at FROM byou_dataset_versions WHERE id=$1", [versionId]);
  const row = version.rows[0];
  if (!row) throw databaseApprovalError(503, "INVENTORY_APPROVAL_PUBLICATION_UNAVAILABLE", unavailableMessage);
  const publishedAt = row.published_at instanceof Date ? row.published_at.toISOString() : text(row.published_at);
  return { versionId:text(row.id), publishedAt };
}

function metadataValue(map = {}, id = "") {
  if (map?.[id] && text(map[id]?.id) === text(id)) return map[id];
  return Object.values(map || {}).find(row => text(row?.id) === text(id)) || null;
}

function stableApprovalRequest(scope, evidence, sourcePublishedAt) {
  return JSON.stringify({
    sourcePublishedAt,
    scope:{ pid:scope.pid, cid:scope.cid, wid:scope.wid, inventoryDate:scope.inventoryDate, onHand:scope.onHand },
    evidence:{ receiptReference:evidence.receiptReference, receiptDate:evidence.receiptDate, adjustmentReason:evidence.adjustmentReason, reviewer:evidence.reviewer },
  });
}

function stableRevocationRequest(scope, reason, reviewer, sourcePublishedAt) {
  return JSON.stringify({
    action:"revoked",
    sourcePublishedAt,
    scope:{ pid:scope.pid, cid:scope.cid, wid:scope.wid, inventoryDate:scope.inventoryDate, onHand:scope.onHand },
    reason,
    reviewer,
  });
}

function addApprovalDays(date, days) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

async function latestManualApprovalEvent(client, row) {
  const result = await client.query(`
    SELECT *
    FROM byou_inventory_approval_events
    WHERE grain='physical_warehouse' AND pid=$1 AND cid=$2 AND wid=$3
    ORDER BY event_sequence DESC
    LIMIT 1
    FOR UPDATE
  `, [row.pid, row.cid, row.wid]);
  return result.rows[0] || null;
}

async function activeApprovalRetryProjection(client, prior, versionId, evaluationDate) {
  const latest = await latestManualApprovalEvent(client, prior);
  if (!latest || Number(latest.event_sequence) !== Number(prior.event_sequence) || latest.action !== "approved") return null;
  const bootstrap = await getDatabaseBaseBootstrap(versionId, client);
  if (!bootstrap) return null;
  const overlay = await getManualInventoryApprovalOverlay({
    versionId,
    evaluationDate,
    client,
    warehouses:bootstrap.whs || [],
  });
  const activeApprovals = mergeRuntimeInventoryApprovals(bootstrap, overlay.approvals, evaluationDate)
    .filter(approval => approval?.approvalSource === "manual_runtime");
  return activeApprovals.find(approval => (
    text(approval.pid) === text(prior.pid)
    && text(approval.cid) === text(prior.cid)
    && text(approval.wid) === text(prior.wid)
    && approval.inventoryDate === approvalDate(prior.inventory_date)
    && Number(approval.onHand) === Number(prior.on_hand)
  )) || null;
}

export async function createManualInventoryApproval({
  databaseVersionId,
  idempotencyKey,
  sourcePublishedAt,
  scope,
  evidence,
  actor,
  approvedOn = businessDateKey(),
} = {}) {
  if (!configured) throw databaseApprovalError(503, "INVENTORY_APPROVAL_DATABASE_REQUIRED", "Manual inventory approval is unavailable because the shared database is not ready.");
  await initializeDatabase();
  const client = await pool.connect();
  const requestSha256 = crypto.createHash("sha256").update(stableApprovalRequest(scope, evidence, sourcePublishedAt)).digest("hex");
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const { versionId, publishedAt } = await lockedApprovalPublication(client, databaseVersionId, "The manifest-bound dataset is unavailable for inventory approval.");

    const priorIdempotency = await client.query(
      "SELECT * FROM byou_inventory_approval_events WHERE idempotency_key=$1",
      [idempotencyKey],
    );
    if (priorIdempotency.rows.length) {
      const prior = priorIdempotency.rows[0];
      if (prior.request_sha256 !== requestSha256 || prior.action !== "approved") throw databaseApprovalError(409, "INVENTORY_APPROVAL_IDEMPOTENCY_COLLISION", "This approval request key was already used for different evidence.");
      const approval = await activeApprovalRetryProjection(client, prior, versionId, approvedOn);
      if (!approval) throw databaseApprovalError(409, "INVENTORY_APPROVAL_NOT_ACTIVE", "The original approval is no longer the active exact inventory approval. Refresh BYOU Intel before taking another action.");
      const approvalRevision = await manualInventoryApprovalRevision(client);
      await client.query("COMMIT");
      transactionStarted = false;
      return { approval, alreadyApplied:true, versionId, approvalRevision };
    }
    if (!sourcePublishedAt || Date.parse(sourcePublishedAt) !== Date.parse(publishedAt)) {
      throw databaseApprovalError(409, "STALE_REVIEW_SCOPE", "The published data changed after this review was opened. Refresh BYOU Intel and review the current fact.");
    }
    if (evidence.receiptDate < scope.inventoryDate
      || evidence.receiptDate > approvedOn
      || addApprovalDays(evidence.receiptDate, MANUAL_INVENTORY_APPROVAL_DAYS) < approvedOn) {
      throw databaseApprovalError(422, "INVENTORY_APPROVAL_EVIDENCE_STALE", "On-hand evidence must be dated on or after the source fact and within the last 14 days.");
    }

    const bootstrapResult = await client.query(
      "SELECT payload FROM byou_dataset_blobs WHERE version_id=$1 AND kind='bootstrap'",
      [versionId],
    );
    const bootstrap = bootstrapResult.rows[0]?.payload;
    if (!bootstrap) throw databaseApprovalError(503, "INVENTORY_APPROVAL_DATABASE_REQUIRED", "The active dataset metadata is unavailable.");
    const product = metadataValue(bootstrap.productMeta, scope.pid);
    const campaign = metadataValue(bootstrap.campaignMeta, scope.cid);
    const warehouse = (bootstrap.whs || []).find(row => text(row?.id) === scope.wid);
    const warehouseDirectory = await canonicalWarehouseDirectory();
    if (!product || !campaign || !warehouse || !isInventoryCoverageWarehouse(warehouse) || !canonicalWarehouseIsUnique(warehouse, bootstrap.whs || [], warehouseDirectory)) {
      throw databaseApprovalError(422, "INVENTORY_APPROVAL_SCOPE_INVALID", "The selected product, campaign, or physical Costco warehouse is not a unique exact match in the active Costco directory.");
    }

    const factsResult = await client.query(`
      SELECT payload
      FROM byou_fact_rows
      WHERE version_id=$1 AND kind='prodSales' AND pid=$2 AND cid=$3 AND wid=$4
      ORDER BY date_key NULLS FIRST, ordinal
    `, [versionId, scope.pid, scope.cid, scope.wid]);
    const facts = factsResult.rows.map(row => row.payload).filter(row => row && typeof row === "object");
    if (!exactLatestInventoryFactsMatchApproval(facts, scope)) {
      throw databaseApprovalError(409, "STALE_REVIEW_SCOPE", "The warehouse date or on-hand balance no longer matches the active dataset. Refresh and review the current fact.");
    }
    const dataThrough = dateKey(bootstrap?.workbookSales?.meta?.end) || scope.inventoryDate;
    if (!inventoryApprovalCampaignCoversObservation(campaign, product, scope.inventoryDate)) {
      throw databaseApprovalError(409, "INVENTORY_APPROVAL_CAMPAIGN_INACTIVE", "This campaign ID does not cover the exact inline inventory observation.");
    }

    const disposition = matchingInventoryReviewDisposition(bootstrap.inventoryReviewDispositions || [], {
      grain:"physical_warehouse",
      ...scope,
    });
    if (disposition?.decision === "rejected") {
      throw databaseApprovalError(409, "INVENTORY_APPROVAL_REJECTED", "This inventory scope has a durable Rejected decision and cannot be approved without reversing that decision first.");
    }
    const eligibility = inventoryEligibilityState(facts, warehouse, { asOfDate:dataThrough, evaluationDate:approvedOn });
    const validation = inventoryValidationEvidence(facts, { asOfDate:dataThrough, evaluationDate:approvedOn });
    if (disposition?.decision !== "reviewed_quarantined" && !eligibility.requiresReview && !validation.requiresReview) {
      throw databaseApprovalError(409, "INVENTORY_APPROVAL_NOT_REQUIRED", "This warehouse is not currently awaiting manual inventory approval.");
    }

    const issueId = text(disposition?.issueId) || `manual-${crypto.createHash("sha256").update([scope.pid, scope.cid, scope.wid].join("|")).digest("hex").slice(0, 24)}`;
    const issueCode = "physical_inventory_review";
    const expiresOn = addApprovalDays(approvedOn, MANUAL_INVENTORY_APPROVAL_DAYS);
    const location = text(warehouse.name || warehouse.id);
    const factSha256 = inventoryApprovalHistoryFingerprint(scope, facts, warehouse);
    const eventId = crypto.randomUUID();
    await client.query(`
      INSERT INTO byou_inventory_approval_events (
        event_id, idempotency_key, request_sha256, action, source_version, source_published_at,
        fact_sha256, issue_id, issue_code, grain, pid, cid, wid, location,
        inventory_date, on_hand, inventory_status, receipt_date, approval_date, expires_on,
        receipt_reference, adjustment_reason, reviewer, actor
      ) VALUES (
        $1,$2,$3,'approved',$4,$5,$6,$7,$8,'physical_warehouse',$9,$10,$11,$12,
        $13,$14,'On hand',$15,$16,$17,$18,$19,$20,$21
      )
    `, [
      eventId, idempotencyKey, requestSha256, versionId, publishedAt,
      factSha256, issueId, issueCode, scope.pid, scope.cid, scope.wid, location,
      scope.inventoryDate, scope.onHand, evidence.receiptDate, approvedOn, expiresOn,
      evidence.receiptReference, evidence.adjustmentReason, evidence.reviewer, actor,
    ]);
    const approvalRevision = await manualInventoryApprovalRevision(client);
    await client.query("COMMIT");
    transactionStarted = false;
    invalidateRuntimeViewCaches();
    return {
      approval:{
        issueId,
        issueCode,
        approved:true,
        pid:scope.pid,
        cid:scope.cid,
        grain:"physical_warehouse",
        wid:scope.wid,
        location,
        inventoryDate:scope.inventoryDate,
        onHand:scope.onHand,
        inventoryStatus:"On hand",
        receiptDate:evidence.receiptDate,
        approvalDate:approvedOn,
        expiresOn,
        approvalSource:"manual_runtime",
      },
      alreadyApplied:false,
      versionId,
      approvalRevision,
    };
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function ownerLegacyScopeRows(dispositions = []) {
  const seen = new Set();
  return (dispositions || []).filter(row => (
    row?.decision === "reviewed_quarantined"
    && row?.grain === "physical_warehouse"
    && row?.pid
    && row?.cid
    && row?.wid
  )).map(row => ({ pid:text(row.pid), cid:text(row.cid), wid:text(row.wid) })).filter(row => {
    const key = [row.pid, row.cid, row.wid].join("\u001f");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ownerLegacyRequestHash(manifestHash, candidate = {}) {
  return crypto.createHash("sha256").update(JSON.stringify({
    action:"approved",
    evidenceKind:"owner_legacy_attestation",
    manifestHash,
    scope:{
      pid:candidate.pid,
      cid:candidate.cid,
      wid:candidate.wid,
      inventoryDate:candidate.inventoryDate,
      onHand:candidate.onHand,
    },
    sourceDisposition:{
      issueId:candidate.sourceDispositionIssueId,
      inventoryDate:candidate.sourceDispositionDate,
      onHand:candidate.sourceDispositionOnHand,
    },
  })).digest("hex");
}

export async function migrateOwnerReviewedInventoryApprovals({
  databaseVersionId,
  sourcePublishedAt,
  authorizationReference,
  reviewer,
  actor,
  expectedManifestHash = "",
  expectedCandidateCount = null,
  dryRun = true,
  approvedOn = businessDateKey(),
} = {}) {
  if (!configured) throw databaseApprovalError(503, "INVENTORY_APPROVAL_DATABASE_REQUIRED", "Owner-reviewed inventory migration requires the shared database.");
  if (!text(authorizationReference).trim() || text(authorizationReference).length > 200) {
    throw databaseApprovalError(422, "OWNER_REVIEW_AUTHORIZATION_REQUIRED", "A bounded owner-authorization reference is required.");
  }
  if (!text(reviewer).trim() || text(reviewer).length > 100 || !text(actor).trim()) {
    throw databaseApprovalError(422, "OWNER_REVIEW_ACTOR_REQUIRED", "The owner reviewer and authenticated actor are required.");
  }
  await initializeDatabase();
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const { versionId, publishedAt } = await lockedApprovalPublication(client, databaseVersionId, "The manifest-bound dataset is unavailable for owner-reviewed inventory migration.");
    if (sourcePublishedAt && Date.parse(sourcePublishedAt) !== Date.parse(publishedAt)) {
      throw databaseApprovalError(409, "STALE_REVIEW_SCOPE", "The published data changed before the owner-reviewed migration. Run preflight again.");
    }
    if (!dryRun && !sourcePublishedAt) {
      throw databaseApprovalError(422, "OWNER_REVIEW_SOURCE_REQUIRED", "Applying owner-reviewed inventory requires the exact published timestamp returned by preflight.");
    }

    if (!dryRun && /^[0-9a-f]{64}$/.test(text(expectedManifestHash))) {
      const priorBatches = await client.query(`
        SELECT authorization_manifest_sha256, COUNT(*)::integer AS count
        FROM byou_inventory_approval_events
        WHERE evidence_kind='owner_legacy_attestation'
          AND action='approved'
        GROUP BY authorization_manifest_sha256
        ORDER BY authorization_manifest_sha256
      `);
      if (priorBatches.rows.length > 0) {
        const exactPrior = priorBatches.rows.length === 1
          && text(priorBatches.rows[0]?.authorization_manifest_sha256) === expectedManifestHash
          && Number(priorBatches.rows[0]?.count) === Number(expectedCandidateCount);
        if (!exactPrior) {
          throw databaseApprovalError(409, "OWNER_REVIEW_MIGRATION_ALREADY_USED", "The one-time owner-reviewed inventory migration was already used for a different manifest or count.");
        }
        await client.query("COMMIT");
        transactionStarted = false;
        return {
          dryRun:false,
          alreadyApplied:true,
          insertedCount:Number(priorBatches.rows[0].count),
          manifestHash:expectedManifestHash,
          versionId,
          publishedAt,
          evaluationDate:approvedOn,
        };
      }
    }

    const bootstrap = await getDatabaseBaseBootstrap(versionId, client);
    if (!bootstrap) throw databaseApprovalError(503, "INVENTORY_APPROVAL_DATABASE_REQUIRED", "The active dataset metadata is unavailable.");
    const scopes = ownerLegacyScopeRows(bootstrap.inventoryReviewDispositions || []);
    const factsResult = scopes.length ? await client.query(`
      WITH requested_scopes AS (
        SELECT DISTINCT pid, cid, wid
        FROM jsonb_to_recordset($2::jsonb) AS scope(pid text, cid text, wid text)
      )
      SELECT fact.payload
      FROM byou_fact_rows fact
      JOIN requested_scopes scope
        ON scope.pid=fact.pid AND scope.cid=fact.cid AND scope.wid=fact.wid
      WHERE fact.version_id=$1 AND fact.kind='prodSales'
      ORDER BY fact.pid, fact.cid, fact.wid, fact.date_key NULLS FIRST, fact.ordinal
    `, [versionId, JSON.stringify(scopes)]) : { rows:[] };
    const facts = factsResult.rows.map(row => row.payload).filter(row => row && typeof row === "object");
    const overlay = await getManualInventoryApprovalOverlay({
      versionId,
      evaluationDate:approvedOn,
      client,
      warehouses:bootstrap.whs || [],
    });
    const activeApprovals = mergeRuntimeInventoryApprovals(bootstrap, overlay.approvals, approvedOn);
    const latestEvents = await client.query(`
      SELECT DISTINCT ON (grain, pid, cid, wid)
        action, pid, cid, wid
      FROM byou_inventory_approval_events
      WHERE grain='physical_warehouse'
      ORDER BY grain, pid, cid, wid, event_sequence DESC
    `);
    const revokedScopeKeys = new Set(latestEvents.rows
      .filter(row => row.action === "revoked")
      .map(row => [row.pid, row.cid, row.wid].map(value => text(value).trim().toLowerCase()).join("|")));
    const directory = await canonicalWarehouseDirectory();
    const preflight = buildOwnerLegacyInventoryApprovalPreflight({
      runtime:bootstrap,
      facts,
      activeApprovals,
      revokedScopeKeys,
      canonicalWarehouseDirectory:directory,
      sourceVersion:versionId,
      sourcePublishedAt:publishedAt,
      authorizationReference,
      evaluationDate:approvedOn,
      fingerprint:inventoryApprovalHistoryFingerprint,
    });
    const safePreflight = {
      reviewedCount:preflight.reviewedCount,
      candidateCount:preflight.candidateCount,
      alreadyApprovedCount:preflight.alreadyApprovedCount,
      excludedCount:preflight.excludedCount,
      candidateByProduct:preflight.candidateByProduct,
      excludedByReason:preflight.excludedByReason,
      candidates:preflight.candidates.map(candidate => ({
        issueId:candidate.issueId,
        pid:candidate.pid,
        cid:candidate.cid,
        wid:candidate.wid,
        inventoryDate:candidate.inventoryDate,
        onHand:candidate.onHand,
        sourceDispositionIssueId:candidate.sourceDispositionIssueId,
        sourceDispositionDate:candidate.sourceDispositionDate,
        sourceDispositionOnHand:candidate.sourceDispositionOnHand,
      })),
      excluded:preflight.excluded,
      manifestHash:preflight.manifestHash,
    };
    if (dryRun) {
      await client.query("COMMIT");
      transactionStarted = false;
      return {
        dryRun:true,
        alreadyApplied:false,
        versionId,
        publishedAt,
        evaluationDate:approvedOn,
        ...safePreflight,
      };
    }
    if (!/^[0-9a-f]{64}$/.test(text(expectedManifestHash)) || expectedManifestHash !== preflight.manifestHash) {
      throw databaseApprovalError(409, "OWNER_REVIEW_MANIFEST_CHANGED", "The owner-reviewed inventory manifest changed after preflight. No approvals were inserted.");
    }
    if (!Number.isInteger(Number(expectedCandidateCount)) || Number(expectedCandidateCount) !== preflight.candidateCount) {
      throw databaseApprovalError(409, "OWNER_REVIEW_COUNT_CHANGED", "The eligible owner-reviewed inventory count changed after preflight. No approvals were inserted.");
    }
    if (!preflight.candidateCount) {
      throw databaseApprovalError(409, "OWNER_REVIEW_NOTHING_TO_APPLY", "No current accepted inventory reviews are eligible for migration.");
    }

    const expiresOn = addApprovalDays(approvedOn, MANUAL_INVENTORY_APPROVAL_DAYS);
    for (const candidate of preflight.candidates) {
      const scopeHash = crypto.createHash("sha256")
        .update([candidate.pid, candidate.cid, candidate.wid, candidate.inventoryDate, candidate.onHand].join("|"))
        .digest("hex");
      const idempotencyKey = `owner-legacy:${preflight.manifestHash.slice(0, 24)}:${scopeHash.slice(0, 24)}`;
      await client.query(`
        INSERT INTO byou_inventory_approval_events (
          event_id, idempotency_key, request_sha256, action, source_version, source_published_at,
          fact_sha256, issue_id, issue_code, grain, pid, cid, wid, location,
          inventory_date, on_hand, inventory_status, receipt_date, approval_date, expires_on,
          receipt_reference, adjustment_reason, reviewer, actor, evidence_kind,
          authorization_reference, authorization_manifest_sha256,
          source_disposition_issue_id, source_disposition_date, source_disposition_on_hand
        ) VALUES (
          $1,$2,$3,'approved',$4,$5,$6,$7,$8,'physical_warehouse',$9,$10,$11,$12,
          $13,$14,'On hand',NULL,$15,$16,'',$17,$18,$19,'owner_legacy_attestation',
          $20,$21,$22,$23,$24
        )
      `, [
        crypto.randomUUID(),
        idempotencyKey,
        ownerLegacyRequestHash(preflight.manifestHash, candidate),
        versionId,
        publishedAt,
        candidate.factSha256,
        candidate.issueId,
        candidate.issueCode,
        candidate.pid,
        candidate.cid,
        candidate.wid,
        candidate.location,
        candidate.inventoryDate,
        candidate.onHand,
        approvedOn,
        expiresOn,
        "Owner-authorized promotion of a previously accepted inventory review.",
        reviewer,
        actor,
        authorizationReference,
        preflight.manifestHash,
        candidate.sourceDispositionIssueId,
        candidate.sourceDispositionDate,
        candidate.sourceDispositionOnHand,
      ]);
    }
    await client.query("COMMIT");
    transactionStarted = false;
    invalidateRuntimeViewCaches();
    return {
      dryRun:false,
      alreadyApplied:false,
      insertedCount:preflight.candidateCount,
      versionId,
      publishedAt,
      evaluationDate:approvedOn,
      expiresOn,
      ...safePreflight,
    };
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function revocationProjection(row = {}) {
  return {
    issueId:text(row.issue_id),
    pid:text(row.pid),
    cid:text(row.cid),
    grain:"physical_warehouse",
    wid:text(row.wid),
    inventoryDate:approvalDate(row.inventory_date),
    onHand:Number(row.on_hand),
    approvalSource:"manual_runtime",
  };
}

export async function revokeManualInventoryApproval({
  databaseVersionId,
  idempotencyKey,
  sourcePublishedAt,
  scope,
  reason,
  reviewer,
  actor,
} = {}) {
  if (!configured) throw databaseApprovalError(503, "INVENTORY_APPROVAL_DATABASE_REQUIRED", "Manual inventory approval is unavailable because the shared database is not ready.");
  await initializeDatabase();
  const client = await pool.connect();
  const requestSha256 = crypto.createHash("sha256").update(stableRevocationRequest(scope, reason, reviewer, sourcePublishedAt)).digest("hex");
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const { versionId, publishedAt } = await lockedApprovalPublication(client, databaseVersionId, "The manifest-bound dataset is unavailable for inventory approval removal.");

    const priorIdempotency = await client.query(
      "SELECT * FROM byou_inventory_approval_events WHERE idempotency_key=$1",
      [idempotencyKey],
    );
    if (priorIdempotency.rows.length) {
      const prior = priorIdempotency.rows[0];
      if (prior.request_sha256 !== requestSha256 || prior.action !== "revoked") throw databaseApprovalError(409, "INVENTORY_APPROVAL_IDEMPOTENCY_COLLISION", "This approval request key was already used for a different action.");
      const latest = await latestManualApprovalEvent(client, prior);
      if (!latest || Number(latest.event_sequence) !== Number(prior.event_sequence) || latest.action !== "revoked") {
        throw databaseApprovalError(409, "INVENTORY_APPROVAL_NOT_ACTIVE", "The original removal is no longer the current inventory decision. Refresh BYOU Intel before taking another action.");
      }
      const approvalRevision = await manualInventoryApprovalRevision(client);
      await client.query("COMMIT");
      transactionStarted = false;
      return { revocation:revocationProjection(prior), alreadyApplied:true, versionId, approvalRevision };
    }
    if (!sourcePublishedAt || Date.parse(sourcePublishedAt) !== Date.parse(publishedAt)) {
      throw databaseApprovalError(409, "STALE_REVIEW_SCOPE", "The published data changed after this approval was displayed. Refresh BYOU Intel before removing it.");
    }

    const approved = await latestManualApprovalEvent(client, scope);
    if (!approved
      || approved.action !== "approved"
      || approvalDate(approved.inventory_date) !== scope.inventoryDate
      || Number(approved.on_hand) !== scope.onHand) {
      throw databaseApprovalError(409, "INVENTORY_APPROVAL_NOT_ACTIVE", "This exact manual approval is no longer active. Refresh BYOU Intel to see the current state.");
    }

    const eventId = crypto.randomUUID();
    await client.query(`
      INSERT INTO byou_inventory_approval_events (
        event_id, idempotency_key, request_sha256, action, source_version, source_published_at,
        fact_sha256, issue_id, issue_code, grain, pid, cid, wid, location,
        inventory_date, on_hand, inventory_status, receipt_date, approval_date, expires_on,
        receipt_reference, adjustment_reason, revocation_reason, reviewer, actor,
        evidence_kind, authorization_reference, authorization_manifest_sha256,
        source_disposition_issue_id, source_disposition_date, source_disposition_on_hand
      ) VALUES (
        $1,$2,$3,'revoked',$4,$5,$6,$7,$8,'physical_warehouse',$9,$10,$11,$12,
        $13,$14,'On hand',$15,$16,$17,$18,$19,$20,$21,$22,
        $23,$24,$25,$26,$27,$28
      )
    `, [
      eventId, idempotencyKey, requestSha256, versionId, publishedAt,
      approved.fact_sha256, approved.issue_id, approved.issue_code,
      scope.pid, scope.cid, scope.wid, approved.location,
      scope.inventoryDate, scope.onHand, approved.receipt_date, approved.approval_date, approved.expires_on,
      approved.receipt_reference, approved.adjustment_reason, reason, reviewer, actor,
      approved.evidence_kind || "receipt_or_count",
      approved.authorization_reference || "",
      approved.authorization_manifest_sha256 || "",
      approved.source_disposition_issue_id || "",
      approved.source_disposition_date || null,
      approved.source_disposition_on_hand ?? null,
    ]);
    const approvalRevision = await manualInventoryApprovalRevision(client);
    await client.query("COMMIT");
    transactionStarted = false;
    invalidateRuntimeViewCaches();
    return {
      revocation:{
        issueId:text(approved.issue_id),
        pid:scope.pid,
        cid:scope.cid,
        grain:"physical_warehouse",
        wid:scope.wid,
        inventoryDate:scope.inventoryDate,
        onHand:scope.onHand,
        approvalSource:"manual_runtime",
      },
      alreadyApplied:false,
      versionId,
      approvalRevision,
    };
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function addScope(clauses, params, options, { allowBlankPid = true, allowBlankCid = true } = {}) {
  if (options.from) { params.push(options.from); clauses.push(`(date_key IS NULL OR date_key >= $${params.length}::date)`); }
  if (options.to) { params.push(options.to); clauses.push(`(date_key IS NULL OR date_key <= $${params.length}::date)`); }
  if (options.pids?.length) {
    params.push(options.pids);
    clauses.push(allowBlankPid ? `(pid = ANY($${params.length}::text[]) OR pid='')` : `pid = ANY($${params.length}::text[])`);
  }
  const cids = options.cids?.length ? options.cids : options.cid ? [options.cid] : [];
  if (cids.length) {
    params.push(cids);
    clauses.push(allowBlankCid ? `(cid=ANY($${params.length}::text[]) OR cid='')` : `cid=ANY($${params.length}::text[])`);
  }
  if (options.wids?.length) { params.push(options.wids); clauses.push(`wid=ANY($${params.length}::text[])`); }
  else if (options.wid) { params.push(options.wid); clauses.push(`wid=$${params.length}`); }
  if (options.region) { params.push(options.region); clauses.push(`region=$${params.length}`); }
  if (options.state) { params.push(options.state); clauses.push(`state=$${params.length}`); }
  return { clauses, params };
}

function affinityJsonNumber(field) {
  return `COALESCE(NULLIF(payload ->> '${field}', '')::double precision, 0)`;
}

export function affinityWeeklyQuerySpec(versionId, options = {}) {
  const requestFrom = text(options.from).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestFrom)) throw new Error("Affinity weekly shadow requires a valid request start date.");
  const params = [text(versionId), requestFrom];
  const clauses = ["version_id=$1", "grain='campaign-warehouse-daily'"];
  const allProductScope = { ...options, pids:[], cid:"", cids:[] };
  addScope(clauses, params, allProductScope, { allowBlankPid:false, allowBlankCid:true });
  const additiveColumns = AFFINITY_ADDITIVE_FIELDS.map(field => `
    bool_or(${affinityJsonNumber(field)} <> 0) AS has_${field.toLowerCase()},
    sum(${affinityJsonNumber(field)} ORDER BY date_key NULLS FIRST, ordinal) AS ${field.toLowerCase()}`).join(",");
  const stateColumns = AFFINITY_STATE_FIELDS.map(field => `
    bool_or(payload ? '${field}' OR COALESCE((payload ->> '${field}Known')::boolean, false)) AS has_${field},
    (array_agg(${affinityJsonNumber(field)} ORDER BY date_key DESC NULLS LAST, ordinal DESC)
      FILTER (WHERE payload ? '${field}' OR COALESCE((payload ->> '${field}Known')::boolean, false)))[1] AS ${field}`).join(",");
  return {
    text:`
      WITH scoped AS (
        SELECT ordinal, date_key, pid, cid, wid, payload,
          ($2::date + GREATEST(0, (COALESCE(date_key, $2::date) - $2::date) / 7) * 7)::date AS bucket_date
        FROM byou_summary_rows
        WHERE ${clauses.join(" AND ")}
      ), grouped AS (
        SELECT bucket_date, wid, pid, cid,
          (array_agg(payload ORDER BY date_key NULLS FIRST, ordinal))[1] AS first_payload,
          (array_agg(date_key ORDER BY date_key NULLS FIRST, ordinal))[1] AS first_source_date,
          (array_agg(ordinal ORDER BY date_key NULLS FIRST, ordinal))[1] AS first_source_ordinal,
          ${additiveColumns},
          ${stateColumns}
        FROM scoped
        GROUP BY bucket_date, wid, pid, cid
      )
      SELECT * FROM grouped
      ORDER BY first_source_date NULLS FIRST, first_source_ordinal
    `,
    values:params,
  };
}

function databaseDateKey(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  const match = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function databaseBoolean(value) {
  return value === true || String(value).toLowerCase() === "true";
}

export function affinityWeeklyRowFromDatabase(row = {}) {
  const firstPayload = row.first_payload && typeof row.first_payload === "object" ? row.first_payload : {};
  const output = {
    date:databaseDateKey(row.bucket_date),
    wid:text(row.wid),
    pid:text(row.pid),
    cid:text(row.cid),
  };
  for (const field of ["product", "campaign", "channel", "source"]) {
    if (firstPayload[field]) output[field] = firstPayload[field];
  }
  output.summaryType = "warehouse-weekly-query";
  for (const field of AFFINITY_ADDITIVE_FIELDS) {
    if (databaseBoolean(row[`has_${field.toLowerCase()}`])) output[field] = Number(row[field.toLowerCase()] || 0);
  }
  for (const field of AFFINITY_STATE_FIELDS) {
    if (!databaseBoolean(row[`has_${field}`])) continue;
    output[field] = Number(row[field] || 0);
    output[`${field}Known`] = true;
  }
  return output;
}

async function queryAffinityWeeklyRows(versionId, options = {}, client = pool) {
  const startedAt = performance.now();
  const spec = affinityWeeklyQuerySpec(versionId, options);
  const result = await client.query(spec.text, spec.values);
  return {
    rows:(result.rows || []).map(affinityWeeklyRowFromDatabase),
    queryMs:Math.round(performance.now() - startedAt),
  };
}

export async function runAffinityWeeklyShadowQuery({ client, versionId, options = {}, queryImpl = queryAffinityWeeklyRows } = {}) {
  await client.query("SAVEPOINT affinity_weekly_shadow");
  try {
    const result = await queryImpl(versionId, options, client);
    await client.query("RELEASE SAVEPOINT affinity_weekly_shadow");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK TO SAVEPOINT affinity_weekly_shadow");
      await client.query("RELEASE SAVEPOINT affinity_weekly_shadow");
    } catch (recoveryError) {
      recoveryError.cause ||= error;
      throw recoveryError;
    }
    return { errorCode:text(error?.code || error?.name || "shadow-query-failed") };
  }
}

export function comparableAnalysisCompactResult(view = {}) {
  const {
    queryMs:ignoredQueryMs,
    dbMs:ignoredDbMs,
    runtimeMs:ignoredRuntimeMs,
    referenceMs:ignoredReferenceMs,
    modelMs:ignoredModelMs,
    serverCached:ignoredServerCached,
    affinityWeeklyShadow:ignoredShadow,
    ...comparable
  } = view || {};
  return comparable;
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJsonValue(value[key])]));
}

function mismatchPaths(left, right, path = "", found = []) {
  if (found.length >= 12) return found;
  if (Object.is(left, right)) return found;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) found.push(`${path}.length`.replace(/^\./, ""));
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length && found.length < 12; index += 1) mismatchPaths(left[index], right[index], `${path}[${index}]`, found);
    return found;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) mismatchPaths(left[key], right[key], path ? `${path}.${key}` : key, found);
    return found;
  }
  found.push(path || "root");
  return found;
}

export function compareAffinityWeeklyShadow(authoritative = {}, candidate = {}) {
  const left = canonicalJsonValue(comparableAnalysisCompactResult(authoritative));
  const right = canonicalJsonValue(comparableAnalysisCompactResult(candidate));
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  return {
    equal:leftJson === rightJson,
    authoritativeHash:crypto.createHash("sha256").update(leftJson).digest("hex"),
    candidateHash:crypto.createHash("sha256").update(rightJson).digest("hex"),
    mismatchPaths:leftJson === rightJson ? [] : mismatchPaths(left, right),
  };
}

function runtimeRowsQueryParts(table, categoryColumn, versionId, categories, options, scopeOptions) {
  if (!((table === "byou_summary_rows" && categoryColumn === "grain") || (table === "byou_fact_rows" && categoryColumn === "kind"))) throw new Error("Unsupported runtime row table.");
  const params = [versionId, categories];
  const clauses = [`version_id=$1`, `${categoryColumn}=ANY($2::text[])`];
  addScope(clauses, params, options, scopeOptions);
  return { clauses, params };
}

export function runtimeRowsQuerySpec(table, categoryColumn, versionId, categories, options, scopeOptions) {
  const { clauses, params } = runtimeRowsQueryParts(table, categoryColumn, versionId, categories, options, scopeOptions);
  return { text:`SELECT ${categoryColumn} AS category, payload FROM ${table} WHERE ${clauses.join(" AND ")} ORDER BY ${categoryColumn}, date_key NULLS FIRST, ordinal`, values:params };
}

export function salesSummaryQuerySpec(versionId, categories, options, bootstrap) {
  const { clauses, params } = runtimeRowsQueryParts("byou_summary_rows", "grain", versionId, categories, options, { allowBlankPid:false, allowBlankCid:true });
  const warehouseGrain = "grain IN ('campaign-warehouse-daily', 'warehouse-portfolio-daily')";
  const scope = salesWarehouseReadScope(bootstrap, options);
  const warehouseClauses = [];
  if (scope.warehouseIds !== null) {
    params.push(scope.warehouseIds);
    const idsParameter = params.length;
    // Match JavaScript trim(), including non-ASCII whitespace in legacy IDs.
    params.push("\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff");
    warehouseClauses.push(`(wid=ANY($${idsParameter}::text[]) OR btrim(wid, $${params.length})=ANY($${idsParameter}::text[]))`);
  }
  if (scope.hiddenScopes.length) {
    params.push(scope.hiddenScopes);
    warehouseClauses.push(`NOT ((pid || '|' || cid || '|' || wid)=ANY($${params.length}::text[]))`);
  }
  if (warehouseClauses.length) clauses.push(`(NOT (${warehouseGrain}) OR (${warehouseClauses.join(" AND ")}))`);
  params.push(SALES_UNUSED_WAREHOUSE_FIELDS);
  return {
    text:`SELECT grain AS category, CASE WHEN ${warehouseGrain} THEN payload - $${params.length}::text[] ELSE payload END AS payload FROM byou_summary_rows WHERE ${clauses.join(" AND ")} ORDER BY grain, date_key NULLS FIRST, ordinal`,
    values:params,
  };
}

function groupRuntimeRows(rows, categories) {
  const grouped = Object.fromEntries(categories.map(category => [category, []]));
  for (const row of rows) grouped[row.category]?.push(row.payload);
  return grouped;
}

async function queryRows(table, categoryColumn, versionId, categories, options, scopeOptions, client = pool) {
  const spec = runtimeRowsQuerySpec(table, categoryColumn, versionId, categories, options, scopeOptions);
  const result = await client.query(spec.text, spec.values);
  return groupRuntimeRows(result.rows, categories);
}

export async function querySalesSummaryRows(versionId, categories, options, bootstrap, client) {
  const blocks = await readSalesReadBlocks(client, versionId, categories, options, bootstrap);
  if (blocks !== null) return blocks;
  const spec = salesSummaryQuerySpec(versionId, categories, options, bootstrap);
  const result = await client.query(spec.text, spec.values);
  return groupRuntimeRows(result.rows, categories);
}

// Version contents are immutable. Cache only the small identifier directory,
// never rows from a different publication or request's product/campaign scope.
const warehouseProductDirectories = new Map();
async function pacingSummaryScope(client, versionId, bootstrap, options) {
  let pids = warehouseProductDirectories.get(versionId);
  if (!pids) {
    const result = await client.query("SELECT DISTINCT pid FROM byou_summary_rows WHERE version_id=$1 AND grain='campaign-warehouse-daily'", [versionId]);
    pids = result.rows.map(row => row.pid);
    warehouseProductDirectories.set(versionId, pids);
    while (warehouseProductDirectories.size > 4) warehouseProductDirectories.delete(warehouseProductDirectories.keys().next().value);
  }
  const selected = pacingWarehouseSourcePids(bootstrap, options, pids);
  return { options:{ ...options, pids:selected }, empty:selected.length === 0 };
}

async function getDatabaseViewUncoalesced(options) {
  if (!configured) return null;
  const startedAt = performance.now();
  await initializeDatabase();
  const client = await pool.connect();
  let transactionCommitted = false;
  let clientReleased = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const versionId = text(options.databaseVersionId || await activeVersion(client));
    if (!versionId) {
      await client.query("COMMIT");
      return null;
    }
    const compactInventory = options.view === "inventory" && options.representation === INVENTORY_VIEW_REPRESENTATION;
    const compactAnalysis = options.view === "rankings" && options.representation === ANALYSIS_COMPACT_REPRESENTATION;
    const compactSales = options.view === "analytics" && options.representation === SALES_COMPACT_REPRESENTATION;
    let requestOptions = compactAnalysis ? normalizeAnalysisCompactOptions(options) : options;
    let bootstrap = null;
    let cacheKey = "";
    const publicationBootstrap = await getDatabaseBaseBootstrap(versionId, client);
    if (!publicationBootstrap) {
      await client.query("COMMIT");
      return null;
    }
    if (!options.publication || Date.parse(options.publication) !== Date.parse(publicationBootstrap.publishedAt)) {
      throw databaseApprovalError(409, "STALE_RUNTIME_PUBLICATION", "The published dashboard data changed. Refresh BYOU Intel before continuing.");
    }
    if (options.view === "videos") bootstrap = publicationBootstrap;
    if (compactInventory || compactAnalysis || compactSales) {
      const baseBootstrap = publicationBootstrap;
      const evaluationDate = compactInventory ? businessDateKey() : "";
      if (compactInventory && text(options.evaluationDate) && text(options.evaluationDate) !== evaluationDate) {
        throw databaseApprovalError(409, "STALE_INVENTORY_EVALUATION_DATE", "The Inventory approval date changed. Refresh BYOU Intel before continuing.");
      }
      const approvalRevision = compactInventory ? await manualInventoryApprovalRevision(client) : "0";
      if (compactInventory && text(options.approvalRevision) && text(options.approvalRevision) !== approvalRevision) {
        throw databaseApprovalError(409, "STALE_INVENTORY_APPROVALS", "The Inventory approval state changed. Refresh BYOU Intel before continuing.");
      }
      requestOptions = compactInventory
        ? { ...options, evaluationDate, approvalRevision }
        : compactAnalysis
          ? normalizeAnalysisCompactOptions(options)
          : options;
      if (compactAnalysis || compactSales) bootstrap = baseBootstrap;
      cacheKey = compactInventory
        ? inventoryCompactCacheKey(versionId, requestOptions)
        : compactAnalysis
          ? analysisCompactCacheKey(versionId, requestOptions)
          : salesCompactCacheKey(versionId, requestOptions);
    } else {
      const cacheOptions = options.view === "rankings" ? { ...options, view:"campaign" } : options;
      cacheKey = `${versionId}|${JSON.stringify(cacheOptions)}`;
    }
    const cached = viewCache.get(cacheKey);
    if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) {
      await client.query("COMMIT");
      return {
        ...cached.view,
        view:requestOptions.view,
        queryMs:0,
        ...(compactInventory || compactAnalysis || compactSales ? { dbMs:0, runtimeMs:0, referenceMs:0, modelMs:0 } : {}),
        serverCached:true,
      };
    }
    if (cached) viewCache.delete(cacheKey);
    if (!bootstrap) bootstrap = compactInventory
      ? await getDatabaseBootstrapForVersion(versionId, client, requestOptions.evaluationDate, requestOptions.approvalRevision)
      : await getDatabaseBootstrapForVersion(versionId, client);
    if (!bootstrap) {
      await client.query("COMMIT");
      return null;
    }
    const {
      useRawWarehouseRows,
      includeRawPortfolioSales,
      includeCampaignWarehouseDaily,
      includePortfolioWarehouseDaily,
      summaryCategories,
    } = databaseViewSummaryPlan(requestOptions);
    const inventoryScope = inventoryRuntimeScope(bootstrap, requestOptions);
    let summaryQueryOptions = compactInventory
      ? { ...inventoryScope.sourceOptions, wid:"", region:"", state:"" }
      : compactAnalysis && requestOptions.section === "affinity"
        ? { ...inventoryScope.sourceOptions, pids:[], cid:"", cids:[], region:requestOptions.affinityRegion, state:requestOptions.affinityState }
      : compactAnalysis && requestOptions.section === "warehouses"
        ? warehouseAnalysisSourceOptions(bootstrap, inventoryScope.sourceOptions)
      : inventoryScope.sourceOptions;
    const pacingScope = compactAnalysis && requestOptions.section === "pacing" && !inventoryScope.empty
      ? await pacingSummaryScope(client, versionId, bootstrap, summaryQueryOptions)
      : null;
    if (pacingScope) summaryQueryOptions = pacingScope.options;
    const dailySummaryStartedAt = performance.now();
    const summaries = inventoryScope.empty || pacingScope?.empty || !summaryCategories.length
      ? {}
      : compactSales
        ? await querySalesSummaryRows(versionId, summaryCategories, summaryQueryOptions, bootstrap, client)
      : await queryRows("byou_summary_rows", "grain", versionId, summaryCategories, summaryQueryOptions, { allowBlankPid:false, allowBlankCid:true }, client);
    const dailySummaryQueryMs = Math.round(performance.now() - dailySummaryStartedAt);
    let affinityWeeklyShadow = null;
    let affinityWeeklyShadowStartedAt = null;
    if (affinityWeeklyShadowMode === "compare" && compactAnalysis && requestOptions.section === "affinity" && !inventoryScope.empty) {
      affinityWeeklyShadowStartedAt = performance.now();
      affinityWeeklyShadow = await runAffinityWeeklyShadowQuery({ client, versionId, options:summaryQueryOptions });
    }
    const eventEvidence = compactAnalysis && requestOptions.section === "events" && !inventoryScope.empty
      ? await loadCompactEventDatabaseEvidence({
          client,
          versionId,
          bootstrap,
          options:inventoryScope.sourceOptions,
        })
      : null;
    const analysisOfficialRows = compactAnalysisOfficialRows(bootstrap, requestOptions, inventoryScope.empty);
    const compactAnalysisContext = {
      pacing:["footnotes", "videos"],
      affinity:[],
      demographics:[],
      comparison:[],
      events:[],
      warehouses:[],
    };
    const contextByView = {
      campaign:["ppcRows", "footnotes", "videos", "videoMetrics"],
      rankings:["ppcRows", "footnotes", "videos", "videoMetrics"],
      analytics:["ppcRows", "footnotes"],
      map:["footnotes"],
      inventory:[],
      calendar:["ppcRows", "footnotes", "videos", "videoMetrics"],
      videos:["videos", "videoMetrics"],
      warehouse:["footnotes"],
    };
    const factCategories = [...(compactAnalysis ? compactAnalysisContext[requestOptions.section] || [] : contextByView[requestOptions.view] || [])];
    if (useRawWarehouseRows) factCategories.push("prodSales");
    if (includeRawPortfolioSales) factCategories.push("sales");
    const factQueryOptions = compactInventory
      ? inventoryCompactPhysicalSourceOptions(bootstrap, inventoryScope.sourceOptions)
      : compactAnalysis && requestOptions.section === "pacing"
        ? { ...requestOptions, from:bootstrap.summaries?.bounds?.start || requestOptions.from, to:bootstrap.summaries?.bounds?.end || requestOptions.to, pids:[], cid:"", cids:[] }
      : compactSales
        ? compactSalesFactSourceOptions(requestOptions)
      : requestOptions.view === "inventory" ? inventoryScope.sourceOptions : requestOptions;
    const facts = inventoryScope.empty || !factCategories.length
      ? {}
      : await queryRows("byou_fact_rows", "kind", versionId, factCategories, factQueryOptions, { allowBlankPid:true, allowBlankCid:true }, client);
    const dataset = {
      publishedAt:bootstrap.publishedAt,
      productMeta:bootstrap.productMeta || {},
      campaignMeta:bootstrap.campaignMeta || {},
      // Legacy runtime views carry published approvals because the browser owns
      // the small no-store manual overlay. Compact Inventory must calculate the
      // exact result here, so it receives the merged current approval state.
      inventoryApprovals:compactInventory
        ? bootstrap.inventoryApprovals || []
        : bootstrap.publishedInventoryApprovals || (bootstrap.inventoryApprovals || []).filter(approval => approval?.approvalSource !== "manual_runtime"),
      inventoryReviewDispositions:bootstrap.inventoryReviewDispositions || [],
      ownerInventoryDecisions:bootstrap.ownerInventoryDecisions || [],
      ownerSalesCorrections:bootstrap.ownerSalesCorrections || [],
      ownerSalesCorrectionHistory:bootstrap.ownerSalesCorrectionHistory || [],
      workbookSales:bootstrap.workbookSales || {},
      whs:bootstrap.whs || [],
      activeWarehouseIds:bootstrap.activeWarehouseIds || [],
      sales:useRawWarehouseRows ? facts.sales || [] : [],
      prodSales:useRawWarehouseRows ? facts.prodSales || [] : [],
      onlineSales:eventEvidence ? eventEvidence.onlineDaily : summaries["campaign-daily-online"] || [],
      ppcRows:facts.ppcRows || [],
      footnotes:eventEvidence ? eventEvidence.footnotes : facts.footnotes || [],
      videos:facts.videos || [],
      videoMetrics:facts.videoMetrics || [],
      summaries:{
        bounds:bootstrap.summaries?.bounds || {},
        campaign:{
          dailyInline:summaries["campaign-daily-inline"] || [],
          dailyOnline:eventEvidence ? eventEvidence.onlineDaily : summaries["campaign-daily-online"] || [],
          warehouseDaily:useRawWarehouseRows || !includeCampaignWarehouseDaily
            ? undefined
            : eventEvidence ? eventEvidence.warehouseDaily : summaries["campaign-warehouse-daily"] || [],
          portfolioWarehouseDaily:useRawWarehouseRows || !includePortfolioWarehouseDaily ? undefined : summaries["warehouse-portfolio-daily"] || [],
        },
        analysis:{
          daily:summaries["analysis-daily"] || [],
          regionDaily:summaries["analysis-region-daily"] || [],
          stateDaily:summaries["analysis-state-daily"] || [],
        },
      },
    };
    await client.query("COMMIT");
    transactionCommitted = true;
    client.release();
    clientReleased = true;
    const databaseFinishedAt = performance.now();
    const runtimeStartedAt = performance.now();
    const runtimeOptions = compactAnalysis && requestOptions.section === "affinity"
      ? { ...requestOptions, pids:[], cid:"", cids:[] }
      : requestOptions;
    let view = compactInventory
      ? await buildInventoryViewModelAsync(dataset, {
          ...requestOptions,
          versionId,
          evaluationDate:bootstrap.approvalEvaluationDate || requestOptions.evaluationDate,
          approvalRevision:bootstrap.approvalRevision || requestOptions.approvalRevision,
        })
      : compactSales
        ? buildSalesCompactResult(dataset, requestOptions)
      : compactAnalysis && requestOptions.section === "events"
        ? { ...dataset, prodSales:dataset.summaries?.campaign?.warehouseDaily || [] }
      : compactAnalysis && requestOptions.section === "warehouses"
        ? {
            ...dataset,
            prodSales:dataset.summaries?.campaign?.warehouseDaily || [],
            inlineTotalSales:analysisOfficialRows,
          }
      : buildRuntimeView(dataset, runtimeOptions);
    const runtimeFinishedAt = performance.now();
    if (compactInventory) {
      Object.assign(view, {
        dbMs:Math.round(databaseFinishedAt - startedAt),
        runtimeMs:0,
        referenceMs:0,
        modelMs:Math.round(runtimeFinishedAt - runtimeStartedAt),
      });
    }
    if (compactSales) {
      Object.assign(view, {
        dbMs:Math.round(databaseFinishedAt - startedAt),
        runtimeMs:0,
        referenceMs:0,
        modelMs:Math.round(runtimeFinishedAt - runtimeStartedAt),
      });
    }
    if (compactAnalysis) view = restoreAnalysisCompactEvidence(view, dataset, requestOptions.section);
    if (!useRawWarehouseRows && !includePortfolioWarehouseDaily) delete view.sales;
    if (!useRawWarehouseRows && !includeCampaignWarehouseDaily) delete view.prodSales;
    view.source = "postgres";
    view.versionId = versionId;
    if (compactAnalysis) {
      Object.assign(view, {
        productMeta:dataset.productMeta,
        campaignMeta:dataset.campaignMeta,
        whs:dataset.whs,
        analysisOfficialRows,
      });
      const referenceStartedAt = performance.now();
      const referenceData = requestOptions.section === "affinity" ? await loadAnalysisReferenceData() : {};
      const referenceFinishedAt = performance.now();
      const modelStartedAt = performance.now();
      const authoritativeRuntimeView = view;
      view = buildAnalysisCompactResult(view, requestOptions, referenceData);
      const modelFinishedAt = performance.now();
      Object.assign(view, {
        dbMs:Math.round(databaseFinishedAt - startedAt),
        runtimeMs:Math.round(runtimeFinishedAt - runtimeStartedAt),
        referenceMs:Math.round(referenceFinishedAt - referenceStartedAt),
        modelMs:Math.round(modelFinishedAt - modelStartedAt),
      });
      if (requestOptions.section === "affinity" && affinityWeeklyShadow) {
        const requestHash = crypto.createHash("sha256").update(cacheKey).digest("hex").slice(0, 16);
        if (affinityWeeklyShadow.errorCode) {
          console.warn("[BYOU Intel] Affinity weekly shadow query failed", JSON.stringify({
            requestHash,
            versionId,
            errorCode:affinityWeeklyShadow.errorCode,
          }));
        } else {
          try {
            const shadowRuntimeStartedAt = performance.now();
            const candidateRuntime = {
              ...authoritativeRuntimeView,
              prodSales:affinityWeeklyShadow.rows,
              analysisOfficialRows:[],
            };
            const shadowRuntimeFinishedAt = performance.now();
            const shadowModelStartedAt = performance.now();
            const candidate = buildAnalysisCompactResult(candidateRuntime, requestOptions, referenceData);
            const shadowModelFinishedAt = performance.now();
            const comparison = compareAffinityWeeklyShadow(view, candidate);
            console.info("[BYOU Intel] Affinity weekly shadow comparison", JSON.stringify({
              requestHash,
              versionId,
              equal:comparison.equal,
              authoritativeHash:comparison.authoritativeHash,
              candidateHash:comparison.candidateHash,
              mismatchPaths:comparison.mismatchPaths,
              dailyRows:dataset.summaries?.campaign?.warehouseDaily?.length || 0,
              weeklyRows:affinityWeeklyShadow.rows.length,
              weeklyQueryMs:affinityWeeklyShadow.queryMs,
              dailySummaryQueryMs,
              dailyBytes:Buffer.byteLength(JSON.stringify(dataset.summaries?.campaign?.warehouseDaily || [])),
              weeklyBytes:Buffer.byteLength(JSON.stringify(affinityWeeklyShadow.rows)),
              candidateAssemblyMs:Math.round(shadowRuntimeFinishedAt - shadowRuntimeStartedAt),
              weeklyModelMs:Math.round(shadowModelFinishedAt - shadowModelStartedAt),
              shadowOverheadMs:affinityWeeklyShadowStartedAt == null ? null : Math.round(performance.now() - affinityWeeklyShadowStartedAt),
            }));
          } catch (error) {
            console.warn("[BYOU Intel] Affinity weekly shadow model failed", JSON.stringify({
              requestHash,
              versionId,
              errorCode:text(error?.code || error?.name || "shadow-model-failed"),
            }));
          }
        }
      }
    }
    view.queryMs = Math.round(performance.now() - startedAt);
    const cacheRows = (view.sales?.length || 0) + (view.prodSales?.length || 0) + (view.analysis?.regionDaily?.length || 0) + (view.analysis?.stateDaily?.length || 0);
    if (compactInventory || compactAnalysis || compactSales || cacheRows <= 25_000) {
      viewCache.set(cacheKey, { view, expiresAt:Date.now() + VIEW_CACHE_TTL_MS });
      while (viewCache.size > VIEW_CACHE_MAX) viewCache.delete(viewCache.keys().next().value);
    }
    return view;
  } catch (error) {
    if (!transactionCommitted) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (!clientReleased) client.release();
  }
}

export function getDatabaseView(options) {
  const compactInventory = options?.view === "inventory" && options?.representation === INVENTORY_VIEW_REPRESENTATION;
  const compactAnalysis = options?.view === "rankings" && options?.representation === ANALYSIS_COMPACT_REPRESENTATION;
  const compactSales = options?.view === "analytics" && options?.representation === SALES_COMPACT_REPRESENTATION;
  if (!compactInventory && !compactAnalysis && !compactSales) return getDatabaseViewUncoalesced(options);
  const inFlightKey = compactViewInFlightKey(viewGeneration, options);
  const existing = viewInFlight.get(inFlightKey);
  if (existing) return existing;
  let task = null;
  const operation = () => getDatabaseViewUncoalesced(options);
  task = (compactInventory ? runInventoryViewWithAdmission(operation) : operation()).finally(() => {
    if (viewInFlight.get(inFlightKey) === task) viewInFlight.delete(inFlightKey);
  });
  viewInFlight.set(inFlightKey, task);
  return task;
}

export async function warmDatabaseCampaignViews(limit = 8) {
  if (!configured) return { warmed:0, elapsedMs:0 };
  const bootstrap = await getDatabaseBootstrap();
  if (!bootstrap) return { warmed:0, elapsedMs:0 };
  const bounds = bootstrap.summaries?.bounds || {};
  const campaigns = Object.entries(bootstrap.campaignMeta || {})
    .map(([key, campaign]) => ({ key, ...campaign }))
    .filter(campaign => campaign.pid && campaign.start && campaign.end)
    .sort((a, b) => String(b.end || b.start).localeCompare(String(a.end || a.start)))
    .slice(0, Math.max(0, limit));
  const startedAt = performance.now();
  let warmed = 0;
  for (let offset = 0; offset < campaigns.length; offset += 2) {
    const batch = campaigns.slice(offset, offset + 2);
    await Promise.all(batch.map(async campaign => {
      const from = campaign.start > bounds.start ? campaign.start : bounds.start;
      const campaignEnd = campaign.end || bounds.end;
      const to = campaignEnd < bounds.end ? campaignEnd : bounds.end;
      if (!from || !to || from > to) return;
      await getDatabaseView({ view:"campaign", from, to, pids:[campaign.pid], cid:campaign.id || campaign.key, wid:"", region:"", state:"", publication:bootstrap.publishedAt });
      warmed += 1;
    }));
  }
  return { warmed, elapsedMs:Math.round(performance.now() - startedAt) };
}

export async function warmDatabaseInventoryCompactView() {
  if (!configured) return { warmed:0, elapsedMs:0 };
  const bootstrap = await getDatabaseBootstrap();
  const options = inventoryCompactWarmOptions(bootstrap || {});
  if (!bootstrap || !options.from || !options.to || options.from > options.to) return { warmed:0, elapsedMs:0 };
  const startedAt = performance.now();
  await getDatabaseView({ ...options, publication:bootstrap.publishedAt });
  return { warmed:1, elapsedMs:Math.round(performance.now() - startedAt) };
}

export async function warmDatabaseAnalysisCompactView({ force = false } = {}) {
  if (!configured) return { warmed:0, elapsedMs:0 };
  const bootstrap = await getDatabaseBootstrap();
  const optionsBySection = analysisCompactWarmOptionsBySection(bootstrap || {});
  if (!bootstrap || optionsBySection.some(options => !options.from || !options.to || options.from > options.to)) return { warmed:0, elapsedMs:0 };
  const startedAt = performance.now();
  let warmed = 0;
  for (const options of optionsBySection) {
    await getDatabaseView({ ...options, forceRefresh:force, publication:bootstrap.publishedAt });
    warmed += 1;
    await new Promise(resolve => setImmediate(resolve));
  }
  return { warmed, elapsedMs:Math.round(performance.now() - startedAt) };
}
export async function databaseHealth() {
  const transport = { ...databaseTransport };
  if (!configured) return { configured:false, ready:false, transport };
  if (!databaseTransport.allowed) {
    return { configured:true, ready:false, transport, code:"DATABASE_TRANSPORT_NOT_PERMITTED", error:"The configured database transport is not permitted." };
  }
  try {
    await initializeDatabase();
    const result = await pool.query("SELECT active_version, updated_at FROM byou_runtime_state WHERE singleton=true");
    return { configured:true, ready:true, transport, activeVersion:text(result.rows[0]?.active_version), updatedAt:result.rows[0]?.updated_at || null };
  } catch {
    return { configured:true, ready:false, transport, error:"The database connection is not ready." };
  }
}
