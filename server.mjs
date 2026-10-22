import './sample/configure.mjs';
import './sample/offline-guard.cjs';
import { mergeOwnerInventoryDecisions } from "./src/lib/ownerInventoryDecisions.js";
import { createCompetitorStore, competitorView, hash as competitorHash } from "./src/lib/competitorResearch.mjs";
import http from "node:http";
import { CAMPAIGN_TRANSPORT_REPRESENTATION, encodeCampaignView } from "./src/lib/campaignTransport.js";
import crypto from "node:crypto";
import fs from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { buildPublishedSummaries, buildRuntimeBootstrap, runtimeBootstrapHasRevenueDoorSummary } from "./src/lib/publishedDataset.js";
import { buildRuntimeView } from "./src/lib/runtimeViews.js";
import { INVENTORY_VIEW_REPRESENTATION } from "./src/lib/inventoryViewModel.js";
import { buildInventoryViewModelAsync } from "./src/lib/inventoryViewWorkerClient.mjs";
import { ANALYSIS_COMPACT_REPRESENTATION, ANALYSIS_SECTIONS, analysisCompactCacheKey, buildAnalysisCompactResult, normalizeAnalysisCompactOptions, restoreAnalysisCompactEvidence } from "./src/lib/analysisCompact.js";
import { SALES_COMPACT_MAX_PRODUCT_IDS, SALES_COMPACT_REPRESENTATION, buildSalesCompactResult } from "./src/lib/salesCompact.js";
import { loadAnalysisReferenceData } from "./src/lib/analysisReferenceData.mjs";
import { startDailyWarmScheduler } from "./src/lib/dailyWarmScheduler.js";
import { dailyUpdateMergeOptions, mergeDailyUpdateDataset, readDailyUpdateWorkbook, replaceWarehouseDailySlice, validateInventoryApprovalsForDataset, validateInventoryReviewDispositionsForDataset, verifyDailyUpdateMasterLineage } from "./src/lib/serverDailyUpdate.js";
import { createManualInventoryApproval, databaseConfigured, databaseHealth, databaseTransportStatus, getDatabaseBootstrap, getDatabaseBootstrapBinding, getDatabasePublicationBinding, getDatabaseView, migrateOwnerReviewedInventoryApprovals, publishDatasetToDatabase, revokeManualInventoryApproval, warmDatabaseAnalysisCompactView, warmDatabaseCampaignViews, warmDatabaseInventoryCompactView } from "./database.mjs";
import { normalizeManualInventoryApprovalRequest, normalizeManualInventoryRevocationRequest } from "./src/lib/manualInventoryApproval.js";
import { canonicalWarehouseDirectoryFromStores } from "./src/lib/canonicalWarehouseApproval.js";
import { buildOwnerSalesCorrectionHistory, mergeOwnerSalesCorrections, rebindOwnerSalesCorrections } from "./src/lib/ownerSalesCorrections.js";
import { validatePnlImportEnvelope } from "./src/lib/pnl.js";
import { getPnlView, pnlDatabaseHealth, savePnlImport, savePnlOverride } from "./pnl-database.mjs";
import { pnlAuthConfigured, pnlPermissionsForEmail, verifiedSupabaseIdentity } from "./pnl-auth.mjs";
import { createPnlPreviewReceipt, verifyPnlPreviewReceipt } from "./pnl-preview.mjs";
import { benchmarkColdPage, benchmarkColdRequestFromReferer } from "./src/lib/runtimeBenchmark.js";
import { assertHistoricalFactsRetained, normalizeDatasetRows as normalizeContractDatasetRows, validateFullDatasetCandidate } from "./src/lib/publishedDatasetContract.js";
import { buildPublicationManifest, publicationDatabaseVersion, runtimeFileFallbackAllowed, selectPublicationReadSource, sha256Text, validatePublicationManifest } from "./src/lib/publicationIntegrity.js";
import { inspectJsonPublicationFile } from "./src/lib/publicationFileIntegrity.mjs";
import { connectAuthenticationDatabase } from "./database.mjs";
import { createAuthState } from "./server/auth-state.mjs";
import { streamUploadParts, streamUploadToFile } from "./server/upload-stream.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "dist");
const dataDir = path.join(__dirname, "sample-state", "intel");
const competitorStore = createCompetitorStore(dataDir);
const datasetPath = path.join(dataDir, "latest-dataset.json");
const startupDatasetPath = path.join(dataDir, "latest-startup.json");
const publicationManifestPath = path.join(dataDir, "current-publication.json");
const publicationGenerationDir = path.join(dataDir, "publications");
const uploadDir = path.join(dataDir, "uploads");
const fullPublicationJobDir = path.join(dataDir, "full-publication-jobs");
const dailyUpdateJobDir = path.join(dataDir, "daily-update-jobs");
let canonicalWarehouseDirectoryPromise = null;
const port = 4293;
const maxBodyBytes = Number(process.env.BYOU_MAX_DATASET_MB || 300) * 1024 * 1024;
const maxDailyUpdateBytes = Number(process.env.BYOU_MAX_DAILY_UPDATE_MB || 10) * 1024 * 1024;
const maxPnlImportBytes = Number(process.env.BYOU_MAX_PNL_IMPORT_MB || 8) * 1024 * 1024;
const adminToken = process.env.BYOU_ADMIN_TOKEN || "";
const historyReplacementToken = process.env.BYOU_HISTORY_REPLACEMENT_TOKEN || "";
const readApiToken = process.env.BYOU_READ_API_TOKEN || "";
const accessPassword = process.env.BYOU_ACCESS_PASSWORD || process.env.BYOU_APP_PASSWORD || "";
const accessUsername = process.env.BYOU_ACCESS_USERNAME || "";
const dedicatedInventoryApprovalPassword = process.env.BYOU_INVENTORY_APPROVAL_PASSWORD || "";
const inventoryApprovalPassword = dedicatedInventoryApprovalPassword || accessPassword;
const authDisabledAllowed = /^(1|true|yes)$/i.test(String(process.env.BYOU_ALLOW_AUTH_DISABLED || "")) && process.env.NODE_ENV !== "production";
const configuredSessionDays = Number(process.env.BYOU_SESSION_DAYS || 30);
const sessionDays = Number.isFinite(configuredSessionDays) && configuredSessionDays > 0 ? configuredSessionDays : 30;
const sessionMaxAgeSeconds = sessionDays * 24 * 60 * 60;
const LOCAL_FALLBACK_SESSION_SECRET = "byou-intel-local-session-secret";
const sessionSecret = process.env.BYOU_SESSION_SECRET || accessPassword || adminToken || LOCAL_FALLBACK_SESSION_SECRET;
if (!process.env.BYOU_SESSION_SECRET) {
  console.warn("[BYOU Intel] BYOU_SESSION_SECRET is not set. Falling back to the access password as the session signing key, so changing the password will log everyone out. Set a dedicated random BYOU_SESSION_SECRET in production.");
}
if (sessionSecret === LOCAL_FALLBACK_SESSION_SECRET && process.env.NODE_ENV === "production") {
  // A publicly known signing key would let anyone forge a session cookie. Refuse to start.
  throw new Error("[BYOU Intel] Refusing to start in production without BYOU_SESSION_SECRET, BYOU_ACCESS_PASSWORD, or BYOU_ADMIN_TOKEN configured.");
}

// Filesystem and driver errors carry absolute paths and internal details. Return a fixed
// message to the browser and keep the raw text in the server log only.
function publicErrorMessage(error, fallback = "The request could not be completed.") {
  const message = String(error?.message || "");
  const looksInternal = !!error?.syscall || /^E[A-Z]+:/.test(message) || /[A-Za-z]:\\|\/app\//.test(message);
  if (looksInternal) {
    console.error("[BYOU Intel] Internal error hidden from client:", message);
    return fallback;
  }
  return message || fallback;
}

function publicErrorCode(error, fallback = "PUBLICATION_UNAVAILABLE") {
  const code = String(error?.code || "");
  return !code || (/^E[A-Z0-9]+$/.test(code) && !!error?.syscall) ? fallback : code;
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
const buildCommit = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || process.env.SOURCE_VERSION || "";
const authState = createAuthState({ connect:databaseConfigured() ? connectAuthenticationDatabase : undefined, production:process.env.NODE_ENV === "production" });
const inventoryApprovalAttempts = new Map();
const loginWindowMs = 15 * 60 * 1000;
const maxLoginAttempts = 8;
const dailyUpdateTestDelayMs = process.env.NODE_ENV === "test" ? Math.max(0, Number(process.env.BYOU_DAILY_UPDATE_TEST_DELAY_MS || 0)) : 0;
const fullPublicationTestDelayMs = process.env.NODE_ENV === "test" ? Math.max(0, Number(process.env.BYOU_FULL_PUBLICATION_TEST_DELAY_MS || 0)) : 0;
const fullPublicationQueue = [];
const queuedFullPublicationJobs = new Set();
let fullPublicationProcessorRunning = false;
const dailyUpdateQueue = [];
const queuedDailyUpdateJobs = new Set();
let dailyUpdateProcessorRunning = false;
let datasetWriteQueue = Promise.resolve();
let verifiedPublicationCache = null;
let legacyPublicationTimestampCache = null;
const warehouseFileViewCache = new Map();
const WAREHOUSE_FILE_VIEW_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const WAREHOUSE_FILE_VIEW_CACHE_MAX = 32;

const mimeTypes = {
  ".html":"text/html; charset=utf-8",
  ".js":"application/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8",
  ".json":"application/json; charset=utf-8",
  ".png":"image/png",
  ".jpg":"image/jpeg",
  ".jpeg":"image/jpeg",
  ".svg":"image/svg+xml",
  ".ico":"image/x-icon",
  ".otf":"font/otf",
  ".ttf":"font/ttf",
  ".woff":"font/woff",
  ".woff2":"font/woff2",
  ".map":"application/json; charset=utf-8",
};
// Text-like assets compress 3-4x; OTF/TTF fonts ~30-40%. Already-compressed formats are skipped.
const compressibleExtensions = new Set([".html", ".js", ".css", ".json", ".svg", ".map", ".otf", ".ttf"]);
// Compressed static bodies are cached per file+mtime so the 1 MB entry bundle is gzipped once, not per request.
const staticGzipCache = new Map();
const STATIC_GZIP_CACHE_MAX = 64;

// CSP tuned to the dashboard's real needs: all scripts are external same-origin
// bundles (no inline script in index.html), Papa parses CSVs in blob workers,
// and the "live URL" feature fetches user-supplied https sheets.
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = {
  "x-content-type-options":"nosniff",
  "x-frame-options":"DENY",
  "referrer-policy":"no-referrer",
  "content-security-policy":contentSecurityPolicy,
};

function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);
}

function calendarResponseEncoding(acceptEncoding = "") {
  const qualities = new Map();
  for (const part of String(acceptEncoding).split(",")) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    const quality = parameters.map(value => value.trim()).find(value => /^q\s*=/.test(value));
    const match = quality?.match(/^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/);
    qualities.set(name.trim(), quality === undefined ? 1 : match ? Number(match[1]) : 0);
  }
  const br = qualities.get("br") || 0;
  const gzip = qualities.get("gzip") || 0;
  return br > 0 && br >= gzip ? "br" : gzip > 0 ? "gzip" : "";
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const request = res.req;
  const headers = {
    "content-type":"application/json; charset=utf-8",
    "cache-control":"no-store",
    ...extraHeaders,
  };
  const cacheable = !String(headers["cache-control"] || "").toLowerCase().includes("no-store");
  if (cacheable && !headers.etag) headers.etag = `W/"${crypto.createHash("sha1").update(body).digest("hex")}"`;
  if (headers.etag && String(request?.headers?.["if-none-match"] || "") === headers.etag) {
    res.writeHead(304, { ...headers, vary:"accept-encoding" });
    res.end();
    return;
  }
  const acceptsGzip = /(?:^|,)\s*gzip(?:\s*;|\s*,|\s*$)/i.test(String(request?.headers?.["accept-encoding"] || ""));
  // Calendar's raw-history response is large. Compress identical JSON bytes
  // asynchronously; retain gzip/identity for clients without explicit Brotli support.
  const encoding = payload?.schema === "byou-intel-view-v1" && payload.view === "calendar"
    ? calendarResponseEncoding(request?.headers?.["accept-encoding"])
    : acceptsGzip ? "gzip" : "";
  if (encoding && body.length >= 1024) {
    const compress = encoding === "br" ? zlib.brotliCompress : zlib.gzip;
    const compressionOptions = encoding === "br"
      ? { params:{ [zlib.constants.BROTLI_PARAM_QUALITY]:4 } }
      : { level:6 };
    compress(body, compressionOptions, (error, compressed) => {
      if (res.destroyed) return;
      const responseBody = error ? body : compressed;
      res.writeHead(status, {
        ...headers,
        "content-length":responseBody.length,
        ...(error ? {} : { "content-encoding":encoding }),
        vary:"accept-encoding",
      });
      res.end(responseBody);
    });
    return;
  }
  res.writeHead(status, { ...headers, "content-length":body.length, vary:"accept-encoding" });
  res.end(body);
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "")
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const idx = part.indexOf("=");
      if (idx < 0) return [decodeURIComponent(part), ""];
      return [decodeURIComponent(part.slice(0, idx)), decodeURIComponent(part.slice(idx + 1))];
    }));
}

function isSecureRequest(req) {
  return String(req.headers["x-forwarded-proto"] || "").toLowerCase().includes("https") || process.env.NODE_ENV === "production";
}

function cookieHeader(req, token, maxAge = sessionMaxAgeSeconds) {
  const attrs = [
    `byou_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.round(maxAge))}`,
  ];
  if (isSecureRequest(req)) attrs.push("Secure");
  return attrs.join("; ");
}

function getAccessSettings() {
  const missingPassword = !accessPassword && !authDisabledAllowed;
  return {
    configured:!!accessPassword,
    disabledAllowed:authDisabledAllowed,
    misconfigured:missingPassword,
    error:missingPassword ? "Dashboard password is not configured. Set BYOU_ACCESS_PASSWORD or BYOU_APP_PASSWORD before using BYOU Intel." : "",
    username:accessUsername,
    password:accessPassword,
  };
}

function safeCompareText(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function signSessionPayload(encodedPayload) {
  return crypto.createHmac("sha256", sessionSecret).update(encodedPayload).digest("base64url");
}

function createSessionToken(session) {
  const encodedPayload = Buffer.from(JSON.stringify({ ...session, v:1 }), "utf8").toString("base64url");
  return `${encodedPayload}.${signSessionPayload(encodedPayload)}`;
}

function verifySessionToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return null;
  if (!safeCompareText(signature, signSessionPayload(encodedPayload))) return null;

  try {
    const session = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!session || Number(session.expiresAt || 0) <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function verifyAccessPassword(password, settings = getAccessSettings()) {
  if (!settings.configured) return false;
  return safeCompareText(password, settings.password);
}

async function currentSession(req) {
  const accessSettings = getAccessSettings();
  if (accessSettings.misconfigured) return { authenticated:false, disabled:false, misconfigured:true, error:accessSettings.error };
  if (!accessSettings.configured && accessSettings.disabledAllowed) return { authenticated:true, disabled:true };
  const token = parseCookies(req).byou_session || "";
  const session = token ? verifySessionToken(token) : null;
  if (!session || await authState.isRevoked(token)) return { authenticated:false, disabled:false };
  if (session.expiresAt <= Date.now()) {
    return { authenticated:false, disabled:false };
  }
  return { authenticated:true, disabled:false, token, session };
}

async function requireUserAuth(req, res) {
  const session = await currentSession(req);
  if (session.authenticated) return true;
  if (session.misconfigured) {
    sendJson(res, 503, { error:session.error });
    return false;
  }
  sendJson(res, 401, { error:"Login required." });
  return false;
}

async function requireUserOrAdminAuth(req, res) {
  if (adminAuthorized(req)) return true;
  return requireUserAuth(req, res);
}

function clientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

function loginAttemptKey(req) {
  // Always scope to the configured account, never a caller-supplied username.
  const scoped = accessUsername.toLowerCase();
  return `${clientKey(req)}|${scoped}`;
}

function inventoryApprovalLimited(key) {
  const now = Date.now();
  const attempt = inventoryApprovalAttempts.get(key);
  if (!attempt || attempt.resetAt <= now) {
    inventoryApprovalAttempts.delete(key);
    return false;
  }
  return attempt.count >= maxLoginAttempts;
}

function recordInventoryApprovalFailure(key) {
  const now = Date.now();
  const attempt = inventoryApprovalAttempts.get(key);
  if (!attempt || attempt.resetAt <= now) {
    inventoryApprovalAttempts.set(key, { count:1, resetAt:now + loginWindowMs });
    return;
  }
  attempt.count += 1;
}

function clearInventoryApprovalFailures(key) {
  inventoryApprovalAttempts.delete(key);
}

function adminAuthorized(req) {
  if (!adminToken) return false;
  const auth = String(req.headers.authorization || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const headerToken = String(req.headers["x-admin-token"] || "");
  return safeCompareText(bearer || headerToken, adminToken);
}

function internalReadAuthorized(req) {
  if (!readApiToken) return false;
  const auth = String(req.headers.authorization || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const headerToken = String(req.headers["x-byou-read-token"] || "");
  return (bearer && safeCompareText(bearer, readApiToken)) || (headerToken && safeCompareText(headerToken, readApiToken));
}

// Browsers always attach an Origin header to cross-site POST requests. Login and logout
// accept non-browser clients (no Origin) but reject any Origin that is not this app.
function originAllowedIfPresent(req) {
  if (!String(req.headers.origin || "").trim()) return true;
  return sameOriginMutation(req);
}

function sameOriginMutation(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
    const expectedHost = forwardedHost || String(req.headers.host || "").trim();
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const expectedProtocol = `${forwardedProto || (isSecureRequest(req) ? "https" : "http")}:`;
    return originUrl.host === expectedHost && originUrl.protocol === expectedProtocol;
  } catch {
    return false;
  }
}

function businessDateKey() {
  const timeZone = process.env.BYOU_TIME_ZONE || "America/Los_Angeles";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year:"numeric",
      month:"2-digit",
      day:"2-digit",
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function readBodyBuffer(req, limit = maxBodyBytes, limitMessage = "Dataset is larger than the configured upload limit.") {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", chunk => {
      total += chunk.length;
      if (total > limit) {
        reject(Object.assign(new Error(limitMessage), { status:413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function datasetLimitError() {
  return Object.assign(new Error("Dataset is larger than the configured upload limit."), { status:413 });
}

function decodeBodyBuffer(buffer, encoding, limit = maxBodyBytes, limitMessage = "Dataset is larger than the configured upload limit.") {
  const isGzip = String(encoding || "").toLowerCase().includes("gzip");
  let decoded = buffer;
  if (isGzip) {
    try {
      decoded = zlib.gunzipSync(buffer, { maxOutputLength:limit + 1 });
    } catch (error) {
      if (error?.code === "ERR_BUFFER_TOO_LARGE") throw Object.assign(new Error(limitMessage), { status:413 });
      throw error;
    }
  }
  if (decoded.length > limit) throw Object.assign(new Error(limitMessage), { status:413 });
  return decoded;
}

async function readBody(req, limit = maxBodyBytes, limitMessage = "Dataset is larger than the configured upload limit.") {
  const buffer = await readBodyBuffer(req, limit, limitMessage);
  const encoding = String(req.headers["content-encoding"] || "").toLowerCase();
  const decoded = decodeBodyBuffer(buffer, encoding, limit, limitMessage);
  return decoded.toString("utf8");
}

function normalizeDatasetRows(dataset = {}) {
  return normalizeContractDatasetRows(dataset);
}

function factDateCoverage(rows = []) {
  const dates = [...new Set((rows || [])
    .map(row => String(row?.date || "").trim())
    .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)))]
    .sort();
  return {
    start:dates[0] || "",
    end:dates.at(-1) || "",
    dates:dates.length,
  };
}

const assertOfficialHistoryRetained = assertHistoricalFactsRetained;

function summarizeDataset(dataset, bytes) {
  const normalized = normalizeDatasetRows(dataset);
  const warehouseCoverage = factDateCoverage(normalized.prodSales);
  const inlineCoverage = factDateCoverage(normalized.inlineTotalSales);
  const onlineCoverage = factDateCoverage(normalized.onlineSales);
  return {
    publishedAt:normalized?.publishedAt || "",
    workbookSource:normalized?.workbookSales?.meta?.source || "",
    publicationCertification:normalized?.publicationCertification || null,
    bytes,
    salesRows:normalized.sales.length,
    productRows:normalized.prodSales.length,
    warehouseStart:warehouseCoverage.start,
    warehouseEnd:warehouseCoverage.end,
    warehouseDates:warehouseCoverage.dates,
    inlineTotalRows:normalized.inlineTotalSales.length,
    inlineStart:inlineCoverage.start,
    inlineEnd:inlineCoverage.end,
    inlineDates:inlineCoverage.dates,
    onlineRows:normalized.onlineSales.length,
    onlineStart:onlineCoverage.start,
    onlineEnd:onlineCoverage.end,
    onlineDates:onlineCoverage.dates,
    reviewDispositions:normalized.inventoryReviewDispositions.length,
    ownerSalesCorrections:normalized.ownerSalesCorrections.length,
    ppcRows:normalized.ppcRows.length,
    eventRows:normalized.footnotes.length,
    videos:normalized.videos.length,
    videoRows:normalized.videoMetrics.length,
    warehouses:normalized.whs.length,
    products:[...new Set(Object.values(normalized?.productMeta || {}).map(row => row?.id).filter(Boolean))].length,
    campaigns:[...new Set(Object.values(normalized?.campaignMeta || {}).map(row => row?.id).filter(Boolean))].length,
  };
}

function assertExpectedPublicationSummary(summary, expected = {}) {
  for (const field of ["warehouses", "products", "campaigns", "productRows", "warehouseDates", "inlineTotalRows", "inlineDates", "onlineRows", "onlineDates", "ownerSalesCorrections"]) {
    if (expected[field] === undefined) continue;
    if (Number(summary[field]) !== Number(expected[field])) {
      throw Object.assign(new Error(`Full publication ${field} did not match the approved expectation.`), { status:409, code:"FULL_PUBLICATION_EXPECTATION_MISMATCH" });
    }
  }
  for (const field of ["warehouseStart", "warehouseEnd", "inlineStart", "inlineEnd", "onlineStart", "onlineEnd"]) {
    if (expected[field] === undefined) continue;
    if (String(summary[field] || "") !== String(expected[field])) {
      throw Object.assign(new Error(`Full publication ${field} did not match the approved expectation.`), { status:409, code:"FULL_PUBLICATION_EXPECTATION_MISMATCH" });
    }
  }
}

function savePublishedDataset(dataset, options = {}) {
  const operation = datasetWriteQueue.then(() => writePublishedDataset(dataset, options));
  datasetWriteQueue = operation.catch(() => {});
  return operation;
}

async function writePublishedDataset(dataset, { expectedPublishedAt, expectedSummary = {}, checkHistory = false, allowHistoryReplacement = false, publicationId:requestedPublicationId = "" } = {}) {
  dataset = validateFullDatasetCandidate({ ...dataset, publishedAt:dataset?.publishedAt || new Date().toISOString() });
  // A normal full upload must not erase accepted corrections omitted by an older client.
  let previous = {};
  let previousPublication = { manifest:null };
  try {
    previousPublication = await readActivePublication();
    previous = normalizeDatasetRows(JSON.parse(await readFile(previousPublication.dataset, "utf8")));
  }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous.publishedAt && expectedPublishedAt === undefined) {
    throw Object.assign(new Error("A full publish must name the publication it was prepared from."), { status:409, code:"DATASET_BASE_REQUIRED" });
  }
  if (expectedPublishedAt !== undefined && String(previous.publishedAt || "") !== String(expectedPublishedAt)) {
    throw Object.assign(new Error("The shared dataset changed after this release was prepared. Refresh and revalidate before publishing."), { status:409, code:"DATASET_BASE_CHANGED" });
  }
  if (previous.publishedAt && String(dataset.publishedAt || "") === String(previous.publishedAt)) {
    throw Object.assign(new Error("A new publication cannot reuse the active publication timestamp."), { status:409, code:"DATASET_PUBLICATION_REUSED" });
  }
  if (checkHistory) assertOfficialHistoryRetained(previous, dataset, allowHistoryReplacement);
  const previousCorrections = rebindOwnerSalesCorrections(previous.ownerSalesCorrections, previous, dataset, { today:businessDateKey() });
  dataset.ownerSalesCorrections = mergeOwnerSalesCorrections(previousCorrections, dataset.ownerSalesCorrections, dataset, { today:businessDateKey() });
  dataset.ownerInventoryDecisions = mergeOwnerInventoryDecisions(previous.ownerInventoryDecisions, dataset.ownerInventoryDecisions, dataset);
  dataset.ownerSalesCorrectionHistory = buildOwnerSalesCorrectionHistory(dataset);
  dataset.inventoryApprovals = validateInventoryApprovalsForDataset(dataset, {
    today:businessDateKey(),
    canonicalWarehouseDirectory:await canonicalWarehouseDirectory(),
  });
  dataset.inventoryReviewDispositions = validateInventoryReviewDispositionsForDataset(dataset, { today:businessDateKey() });
  dataset = validateFullDatasetCandidate(dataset);
  assertExpectedPublicationSummary(summarizeDataset(dataset, 0), expectedSummary);
  if (checkHistory) {
    dataset.publicationCertification = {
      schema:"byou-publication-certification-v1",
      ...expectedSummary,
    };
  }
  const summaries = buildPublishedSummaries(dataset);
  const startup = buildRuntimeBootstrap(dataset, summaries);
  const normalized = `${JSON.stringify(dataset)}\n`;
  const startupText = `${JSON.stringify(startup)}\n`;
  const publicationId = requestedPublicationId || crypto.randomUUID();
  const generationDir = path.join(publicationGenerationDir, publicationId);
  await mkdir(generationDir, { recursive:true });
  const generationDatasetPath = path.join(generationDir, "dataset.json");
  const generationStartupPath = path.join(generationDir, "startup.json");
  const writeImmutableGenerationFile = async (filePath, contents) => {
    try {
      await writeFile(filePath, contents, { encoding:"utf8", flag:"wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readFile(filePath, "utf8");
      if (sha256Text(existing) !== sha256Text(contents)) {
        throw Object.assign(new Error("The publication generation ID is already associated with different immutable content."), { status:409, code:"PUBLICATION_GENERATION_COLLISION" });
      }
    }
  };
  await Promise.all([
    writeImmutableGenerationFile(generationDatasetPath, normalized),
    writeImmutableGenerationFile(generationStartupPath, startupText),
  ]);
  const database = await publishDatasetToDatabase(dataset, {
    summaries,
    bootstrap:startup,
    publicationId,
    datasetSha256:sha256Text(normalized),
    startupSha256:sha256Text(startupText),
    previousVersionId:previousPublication.manifest?.databaseVersionId || "",
  });
  const manifest = buildPublicationManifest({
    publicationId,
    publishedAt:dataset.publishedAt,
    datasetText:normalized,
    startupText,
    databaseVersionId:database.versionId || "",
  });
  await mkdir(dataDir, { recursive:true });
  const suffix = `.tmp-${publicationId}`;
  const tempManifestPath = `${publicationManifestPath}${suffix}`;
  await writeFile(tempManifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  await rename(tempManifestPath, publicationManifestPath);
  verifiedPublicationCache = null;
  warehouseFileViewCache.clear();
  // These aliases exist for older operational readers. The manifest is the
  // sole active-generation pointer, so an alias-copy failure cannot split reads.
  try {
    const tempPath = `${datasetPath}${suffix}`;
    const tempStartupPath = `${startupDatasetPath}${suffix}`;
    await Promise.all([writeFile(tempPath, normalized, "utf8"), writeFile(tempStartupPath, startupText, "utf8")]);
    await Promise.all([rename(tempPath, datasetPath), rename(tempStartupPath, startupDatasetPath)]);
  } catch (error) {
    console.error("[BYOU Intel] Legacy publication aliases were not refreshed:", error.message);
  }
  let generationCleanupWarning = "";
  try {
    await cleanupPublicationGenerations([publicationId, previousPublication.manifest?.publicationId || ""]);
  } catch (error) {
    generationCleanupWarning = error.message || "Superseded publication cleanup failed.";
    console.error("[BYOU Intel] Superseded file-generation cleanup did not complete:", generationCleanupWarning);
  }
  void warmDatabaseInventoryCompactView().then(result => {
    if (result.warmed) console.log(`[BYOU Intel] Warmed the default compact Inventory view in ${result.elapsedMs} ms.`);
    return warmDatabaseAnalysisCompactView();
  }).then(result => {
    if (result.warmed) console.log(`[BYOU Intel] Warmed ${result.warmed} default compact Analysis views in ${result.elapsedMs} ms.`);
    return warmDatabaseCampaignViews();
  }).then(result => {
    if (result.warmed) console.log(`[BYOU Intel] Warmed ${result.warmed} recent Campaign views in ${result.elapsedMs} ms.`);
  }).catch(error => console.error("[BYOU Intel] Dashboard cache warm-up did not complete:", error.message));
  return {
    ...summarizeDataset(dataset, Buffer.byteLength(normalized)),
    startupBytes:Buffer.byteLength(startupText),
    publicationId,
    manifest,
    generationCleanupWarning,
    database,
  };
}

async function savePublishedDatasetFromText(text, { allowHistoryReplacement = false, expectedPublishedAt, expectedSummary = {}, publicationId = "" } = {}) {
  const incoming = JSON.parse(text);
  return savePublishedDataset(incoming, { expectedPublishedAt, expectedSummary, checkHistory:true, allowHistoryReplacement, publicationId });
}

async function handleGetSession(req, res) {
  const session = await currentSession(req);
  const supabaseIdentity = await verifiedSupabaseIdentity(req);
  const accessSettings = getAccessSettings();
  const identity = supabaseIdentity || (session.authenticated
    ? { authenticated:true, provider:"legacy", ...pnlPermissionsForEmail("") }
    : { authenticated:false, provider:"none", canView:false, canEdit:false, email:"" });
  sendJson(res, 200, {
    required:!!accessSettings.configured || !!accessSettings.misconfigured,
    authenticated:!!session.authenticated || !!supabaseIdentity,
    authDisabled:!!accessSettings.disabledAllowed && !accessSettings.configured,
    authMisconfigured:!!accessSettings.misconfigured,
    error:accessSettings.error,
    usernameRequired:!!accessSettings.username,
    sessionDays,
    authProvider:identity.provider,
    email:identity.email,
    pnl:{ canView:identity.canView, canEdit:identity.canEdit, authConfigured:pnlAuthConfigured() },
  });
}

function publicationArtifactPaths(manifest) {
  const validated = validatePublicationManifest(manifest);
  const directory = path.join(publicationGenerationDir, validated.publicationId);
  return {
    manifest:validated,
    dataset:path.join(directory, validated.dataset.file),
    startup:path.join(directory, validated.startup.file),
  };
}

async function readActivePublication({ verifyHashes = true } = {}) {
  let manifest;
  let manifestText = "";
  try {
    manifestText = await readFile(publicationManifestPath, "utf8");
    manifest = validatePublicationManifest(JSON.parse(manifestText));
  } catch (error) {
    if (error?.code === "ENOENT") return { manifest:null, dataset:datasetPath, startup:startupDatasetPath };
    throw Object.assign(new Error(`The active publication pointer is unreadable: ${error.message}`), { status:503, code:"PUBLICATION_MANIFEST_INVALID" });
  }
  const artifacts = publicationArtifactPaths(manifest);
  const manifestSha256 = sha256Text(manifestText);
  if (verifyHashes && verifiedPublicationCache?.manifestSha256 === manifestSha256) {
    const [datasetInfo, startupInfo] = await Promise.all([stat(artifacts.dataset), stat(artifacts.startup)]);
    if (datasetInfo.size === verifiedPublicationCache.datasetSize
      && datasetInfo.mtimeMs === verifiedPublicationCache.datasetMtimeMs
      && startupInfo.size === verifiedPublicationCache.startupSize
      && startupInfo.mtimeMs === verifiedPublicationCache.startupMtimeMs) return verifiedPublicationCache.artifacts;
  }
  if (verifyHashes) {
    const [datasetIntegrity, startupIntegrity] = await Promise.all([
      inspectJsonPublicationFile(artifacts.dataset),
      inspectJsonPublicationFile(artifacts.startup),
    ]);
    if (datasetIntegrity.bytes !== manifest.dataset.bytes
      || startupIntegrity.bytes !== manifest.startup.bytes
      || datasetIntegrity.sha256 !== manifest.dataset.sha256
      || startupIntegrity.sha256 !== manifest.startup.sha256) {
      throw Object.assign(new Error("The active publication files do not match their immutable manifest."), { status:503, code:"PUBLICATION_HASH_MISMATCH" });
    }
    if (datasetIntegrity.publishedAt !== manifest.publishedAt || startupIntegrity.publishedAt !== manifest.publishedAt) {
      throw Object.assign(new Error("The active publication files belong to different generations."), { status:503, code:"PUBLICATION_GENERATION_MISMATCH" });
    }
    const [datasetInfo, startupInfo] = await Promise.all([stat(artifacts.dataset), stat(artifacts.startup)]);
    verifiedPublicationCache = {
      manifestSha256, artifacts,
      datasetSize:datasetInfo.size, datasetMtimeMs:datasetInfo.mtimeMs,
      startupSize:startupInfo.size, startupMtimeMs:startupInfo.mtimeMs,
    };
  }
  return artifacts;
}

async function readActiveDataset() {
  const publication = await readActivePublication();
  return normalizeDatasetRows(JSON.parse(await readFile(publication.dataset, "utf8")));
}

async function activeFilePublishedAt(publication) {
  if (publication.manifest) return publication.manifest.publishedAt;
  const info = await stat(publication.dataset);
  if (legacyPublicationTimestampCache?.size === info.size && legacyPublicationTimestampCache?.mtimeMs === info.mtimeMs) {
    return legacyPublicationTimestampCache.publishedAt;
  }
  let inspected;
  try { inspected = await inspectJsonPublicationFile(publication.dataset); }
  catch (error) {
    throw Object.assign(new Error(`The active legacy dataset is unreadable: ${error.message}`), { status:503, code:"PUBLICATION_LEGACY_INVALID" });
  }
  const publishedAt = String(inspected?.publishedAt || "");
  if (!Number.isFinite(Date.parse(publishedAt))) {
    throw Object.assign(new Error("The active legacy dataset has no valid publication timestamp."), { status:503, code:"PUBLICATION_LEGACY_INVALID" });
  }
  legacyPublicationTimestampCache = { size:info.size, mtimeMs:info.mtimeMs, publishedAt };
  return publishedAt;
}

async function databasePublicationRead(publication, { includeBootstrap = false } = {}) {
  const filePublishedAt = await activeFilePublishedAt(publication);
  const transport = databaseTransportStatus();
  if (transport.configured && !transport.allowed) {
    throw Object.assign(new Error("The configured database transport is not permitted in this environment."), { status:503, code:"DATABASE_TRANSPORT_NOT_PERMITTED" });
  }
  const manifestVersionId = String(publication.manifest?.databaseVersionId || "").trim();
  if (!databaseConfigured() || (publication.manifest && !manifestVersionId)) {
    return { source:"file", databaseVersionId:"", filePublishedAt, bootstrap:null, reason:publication.manifest ? "manifest-unbound" : "database-unavailable" };
  }
  try {
    const loadBinding = includeBootstrap ? getDatabaseBootstrapBinding : getDatabasePublicationBinding;
    const binding = await loadBinding(manifestVersionId);
    const selection = selectPublicationReadSource({
      manifest:publication.manifest,
      filePublishedAt,
      databaseVersionId:binding?.versionId,
      databasePublishedAt:binding?.bootstrap?.publishedAt || binding?.publishedAt,
    });
    return { ...selection, filePublishedAt, bootstrap:selection.source === "database" ? binding?.bootstrap || null : null };
  } catch (error) {
    if (error?.code === "DATABASE_TRANSPORT_NOT_PERMITTED") throw error;
    return { source:"file", databaseVersionId:"", filePublishedAt, bootstrap:null, reason:"database-error", error };
  }
}

async function requiredApprovalDatabasePublication(publication) {
  publicationDatabaseVersion(publication.manifest);
  const binding = await databasePublicationRead(publication, { includeBootstrap:true });
  if (binding.source !== "database" || !binding.bootstrap) {
    throw Object.assign(new Error("The file and database publications are not the same generation, so inventory approval is temporarily unavailable."), {
      status:503,
      code:"INVENTORY_APPROVAL_PUBLICATION_UNAVAILABLE",
    });
  }
  return binding;
}

async function cleanupPublicationGenerations(keepIds = []) {
  const keep = new Set(keepIds.filter(id => /^[0-9a-f-]{36}$/i.test(String(id || ""))));
  let entries = [];
  try { entries = await readdir(publicationGenerationDir, { withFileTypes:true }); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name) || keep.has(entry.name)) continue;
    const target = path.resolve(publicationGenerationDir, entry.name);
    if (path.dirname(target) !== path.resolve(publicationGenerationDir)) continue;
    await rm(target, { recursive:true, force:true });
  }
}

async function handlePostLogin(req, res) {
  if (!originAllowedIfPresent(req)) return sendJson(res, 403, { error:"Login must be submitted from the BYOU Intel app." });
  const accessSettings = getAccessSettings();
  if (accessSettings.misconfigured) {
    sendJson(res, 503, { error:accessSettings.error });
    return;
  }
  if (!accessSettings.configured && accessSettings.disabledAllowed) {
    sendJson(res, 200, { ok:true, authenticated:true, required:false });
    return;
  }
  try {
    const body = JSON.parse((await readBodyBuffer(req, 16 * 1024, "Login request is too large.")).toString("utf8"));
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const attemptKey = loginAttemptKey(req);
    const valid = (!accessSettings.username || username.toLowerCase() === accessSettings.username.toLowerCase()) && verifyAccessPassword(password, accessSettings);
    const attempt = await authState.attempt(attemptKey, valid);
    if (attempt.limited) {
      sendJson(res, 429, { error:"Too many incorrect login attempts. Try again later." });
      return;
    }
    if (!attempt.accepted) {
      sendJson(res, 401, { error:"Incorrect login." });
      return;
    }
    const session = {
      username:username || "team",
      createdAt:Date.now(),
      expiresAt:Date.now() + sessionMaxAgeSeconds * 1000,
      id:crypto.randomUUID(),
    };
    const token = createSessionToken(session);
    res.setHeader("set-cookie", cookieHeader(req, token));
    sendJson(res, 200, { ok:true, authenticated:true, required:true, sessionDays });
  } catch (error) {
    if (error.code === "AUTH_STATE_UNAVAILABLE") return sendJson(res, 503, { error:error.message, code:error.code });
    sendJson(res, 400, { error:"Could not log in." });
  }
}

async function handlePostLogout(req, res) {
  if (!originAllowedIfPresent(req)) return sendJson(res, 403, { error:"Logout must be submitted from the BYOU Intel app." });
  const token = parseCookies(req).byou_session || "";
  const session = verifySessionToken(token);
  if (session) await authState.revoke(token, session.expiresAt);
  res.setHeader("set-cookie", cookieHeader(req, "", 0));
  sendJson(res, 200, { ok:true });
}

function datasetEtag(info) {
  return `"${Number(info.size).toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
}

function requestHasCurrentDataset(req, info, etag) {
  const ifNoneMatch = String(req.headers["if-none-match"] || "");
  if (ifNoneMatch) return ifNoneMatch.split(",").map(value => value.trim()).includes(etag);
  const ifModifiedSince = Date.parse(String(req.headers["if-modified-since"] || ""));
  return Number.isFinite(ifModifiedSince) && Math.trunc(info.mtimeMs / 1000) * 1000 <= ifModifiedSince;
}

async function streamDatasetFile(req, res, filePath, missingMessage) {
  try {
    const info = await stat(filePath);
    const etag = datasetEtag(info);
    const headers = {
      "content-type":"application/json; charset=utf-8",
      "cache-control":"private, no-cache",
      "etag":etag,
      "last-modified":info.mtime.toUTCString(),
      "vary":"accept-encoding",
      "x-byou-dataset-bytes":String(info.size),
    };
    if (requestHasCurrentDataset(req, info, etag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    if (String(req.headers["accept-encoding"] || "").includes("gzip")) {
      res.writeHead(200, { ...headers, "content-encoding":"gzip" });
      fs.createReadStream(filePath).pipe(zlib.createGzip()).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, "content-length":String(info.size) });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { error:missingMessage });
  }
}

async function ensureStartupDataset(publication = null, expectedPublishedAt = "") {
  publication ||= await readActivePublication();
  if (publication.manifest) return publication.startup;
  const dataset = normalizeDatasetRows(JSON.parse(await readFile(publication.dataset, "utf8")));
  if (expectedPublishedAt && Date.parse(dataset.publishedAt) !== Date.parse(expectedPublishedAt)) {
    throw Object.assign(new Error("The active legacy dataset changed while its startup view was being prepared."), { status:409, code:"PUBLICATION_LEGACY_CHANGED" });
  }
  try {
    const existing = JSON.parse(await readFile(startupDatasetPath, "utf8"));
    if (existing?.schema === "byou-intel-bootstrap-v4"
      && Date.parse(existing?.publishedAt) === Date.parse(dataset.publishedAt)
      && Array.isArray(existing?.warehouseDailySales)
      && runtimeBootstrapHasRevenueDoorSummary(existing)) return startupDatasetPath;
  } catch {}
  const startup = buildRuntimeBootstrap(dataset);
  await mkdir(dataDir, { recursive:true });
  const text = `${JSON.stringify(startup)}\n`;
  const tempPath = `${startupDatasetPath}.tmp-${Date.now()}`;
  await writeFile(tempPath, text, "utf8");
  await rename(tempPath, startupDatasetPath);
  return startupDatasetPath;
}

async function handleGetDataset(req, res) {
  try {
    const publication = await readActivePublication();
    return streamDatasetFile(req, res, publication.dataset, "No shared dataset has been published yet.");
  } catch (error) {
    return sendJson(res, error.status || 503, { error:publicErrorMessage(error, "The published dataset is not available yet."), code:publicErrorCode(error) });
  }
}

async function handleGetStartupDataset(req, res) {
  const unavailable = "The published startup dataset is not available yet.";
  let publication;
  try { publication = await readActivePublication(); }
  catch (error) { return sendJson(res, error.status || 503, { error:publicErrorMessage(error, unavailable), code:publicErrorCode(error) }); }
  let databasePublication;
  try { databasePublication = await databasePublicationRead(publication); }
  catch (error) { return sendJson(res, error.status || 503, { error:publicErrorMessage(error, unavailable), code:publicErrorCode(error) }); }
  if (publication.manifest) {
    return streamDatasetFile(req, res, publication.startup, "No shared startup dataset has been published yet.");
  }
  let startupPath;
  try {
    startupPath = await ensureStartupDataset(publication, databasePublication.filePublishedAt);
  } catch (error) {
    sendJson(res, error.status || 404, { error:publicErrorMessage(error, "No shared startup dataset has been published yet."), code:publicErrorCode(error) });
    return;
  }
  return streamDatasetFile(req, res, startupPath, "No shared startup dataset has been published yet.");
}

function runtimeViewOptions(reqUrl) {
  const allowedViews = new Set(["campaign", "rankings", "analytics", "map", "inventory", "calendar", "videos", "warehouse"]);
  const requestedView = reqUrl.searchParams.get("view");
  const view = allowedViews.has(requestedView) ? requestedView : "campaign";
  const validDate = (value, label) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00Z`) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
      const error = new Error(`The requested ${label} date is invalid.`);
      error.status = 400;
      throw error;
    }
    return raw;
  };
  const from = validDate(reqUrl.searchParams.get("from"), "start");
  const to = validDate(reqUrl.searchParams.get("to"), "end");
  if (from && to && from > to) {
    const error = new Error("The requested start date must not be after the end date.");
    error.status = 400;
    throw error;
  }
  const cid = String(reqUrl.searchParams.get("cid") || "").trim();
  const cids = [...new Set(String(reqUrl.searchParams.get("cids") || cid).split(",").map(value => value.trim()).filter(Boolean).slice(0, 10))];
  const representation = String(reqUrl.searchParams.get("representation") || "").trim();
  const compactInventory = view === "inventory" && representation === INVENTORY_VIEW_REPRESENTATION;
  const compactAnalysis = view === "rankings" && representation === ANALYSIS_COMPACT_REPRESENTATION;
  const compactSales = view === "analytics" && representation === SALES_COMPACT_REPRESENTATION;
  const campaignTransport = view === "campaign" && representation === CAMPAIGN_TRANSPORT_REPRESENTATION;
  const requestedPids = [...new Set(String(reqUrl.searchParams.get("pids") || reqUrl.searchParams.get("pid") || "").split(",").map(value => value.trim()).filter(Boolean))];
  if (representation && !compactInventory && !compactAnalysis && !compactSales && !campaignTransport) {
    const error = new Error("The requested dashboard representation is not supported.");
    error.status = 400;
    throw error;
  }
  if (compactSales && requestedPids.length > SALES_COMPACT_MAX_PRODUCT_IDS) {
    const error = new Error(`The focused Sales view supports up to ${SALES_COMPACT_MAX_PRODUCT_IDS} product identifiers.`);
    error.code = "SALES_PRODUCT_SCOPE_TOO_LARGE";
    error.status = 400;
    throw error;
  }
  const sectionValue = String(reqUrl.searchParams.get("section") || "pacing").trim().toLowerCase();
  if (compactAnalysis && !ANALYSIS_SECTIONS.includes(sectionValue)) {
    const error = new Error("The requested Analysis section is not supported.");
    error.status = 400;
    throw error;
  }
  const inventoryTypeValue = String(reqUrl.searchParams.get("inventoryType") || "").trim().toLowerCase();
  const inventoryType = ["inline", "online"].includes(inventoryTypeValue) ? inventoryTypeValue : "";
  const publicationValue = String(reqUrl.searchParams.get("publication") || "").trim();
  const publication = publicationValue && Number.isFinite(Date.parse(publicationValue)) ? publicationValue : "";
  if (publicationValue && !publication) {
    const error = new Error("The requested publication timestamp is invalid.");
    error.status = 400;
    throw error;
  }
  const approvalRevisionValue = String(reqUrl.searchParams.get("approvalRevision") || "").trim();
  if (approvalRevisionValue && !/^\d+$/.test(approvalRevisionValue)) {
    const error = new Error("The requested inventory approval revision is invalid.");
    error.status = 400;
    throw error;
  }
  const options = {
    view,
    from,
    to,
    pids:compactAnalysis || compactSales ? requestedPids : requestedPids.slice(0, 10),
    cid:cids.length === 1 ? cids[0] : "",
    cids,
    wid:String(reqUrl.searchParams.get("wid") || "").trim(),
    region:String(reqUrl.searchParams.get("region") || "").trim(),
    state:String(reqUrl.searchParams.get("state") || "").trim(),
    representation,
    section:compactAnalysis ? sectionValue : "",
    inventoryType,
    storeSearch:String(reqUrl.searchParams.get("storeSearch") || "").trim().slice(0, 120),
    publication,
    evaluationDate:validDate(reqUrl.searchParams.get("evaluationDate"), "evaluation"),
    approvalRevision:approvalRevisionValue || "0",
    primaryPid:String(reqUrl.searchParams.get("primaryPid") || "").trim(),
    primaryCid:String(reqUrl.searchParams.get("primaryCid") || "").trim(),
    comparisonPid:String(reqUrl.searchParams.get("comparisonPid") || "").trim(),
    comparisonCid:String(reqUrl.searchParams.get("comparisonCid") || "").trim(),
    affinityRegion:String(reqUrl.searchParams.get("affinityRegion") || "").trim(),
    affinityState:String(reqUrl.searchParams.get("affinityState") || "").trim(),
    affinityMinimumPeriods:String(reqUrl.searchParams.get("affinityMinimumPeriods") || "").trim(),
    affinityMinimumUnits:String(reqUrl.searchParams.get("affinityMinimumUnits") || "").trim(),
    compareA:String(reqUrl.searchParams.get("compareA") || "").trim(),
    compareB:String(reqUrl.searchParams.get("compareB") || "").trim(),
    compareCampaignA:String(reqUrl.searchParams.get("compareCampaignA") || "").trim(),
    compareCampaignB:String(reqUrl.searchParams.get("compareCampaignB") || "").trim(),
    compareBucket:String(reqUrl.searchParams.get("compareBucket") || "").trim(),
    compareMetric:String(reqUrl.searchParams.get("compareMetric") || "").trim(),
    compareNormMode:String(reqUrl.searchParams.get("compareNormMode") || "").trim(),
    compareMinUnits:String(reqUrl.searchParams.get("compareMinUnits") || "").trim(),
    compareRegion:String(reqUrl.searchParams.get("compareRegion") || "").trim(),
    compareState:String(reqUrl.searchParams.get("compareState") || "").trim(),
    compareFrom:validDate(reqUrl.searchParams.get("compareFrom"), "comparison start"),
    compareTo:validDate(reqUrl.searchParams.get("compareTo"), "comparison end"),
  };
  if (!compactAnalysis) return options;
  try {
    return { ...options, ...normalizeAnalysisCompactOptions(options) };
  } catch (error) {
    error.status = 400;
    throw error;
  }
}

async function handleGetRuntimeView(req, res, reqUrl) {
  const startedAt = performance.now();
  try {
    const publication = await readActivePublication({ verifyHashes:false });
    const databaseTransport = databaseTransportStatus();
    if (!runtimeFileFallbackAllowed({
      railwayProduction:databaseTransport.railwayProduction,
      readSource:"file",
      prepared:!!publication.manifest,
    })) {
      return sendJson(res, 503, {
        error:"The published database is not ready for this selected view. Please retry; the server skipped an unsafe legacy whole-file read.",
        code:"RUNTIME_DATABASE_NOT_READY",
      }, { "retry-after":"2" });
    }
    const databasePublication = await databasePublicationRead(publication);
    const options = {
      ...runtimeViewOptions(reqUrl),
      databaseVersionId:databasePublication.databaseVersionId,
      forceRefresh:benchmarkColdRequestFromReferer(req.headers.referer, reqUrl.host),
    };
    const compactInventory = options.representation === INVENTORY_VIEW_REPRESENTATION;
    const compactAnalysis = options.representation === ANALYSIS_COMPACT_REPRESENTATION;
    const compactSales = options.representation === SALES_COMPACT_REPRESENTATION;
    if (compactInventory && (!options.from || !options.to || !options.evaluationDate)) {
      return sendJson(res, 400, { error:"Compact Inventory requests require a selected date range and evaluation date." });
    }
    if (compactInventory && options.evaluationDate !== businessDateKey()) {
      return sendJson(res, 409, { error:"The Inventory approval date changed. Refresh BYOU Intel before continuing.", code:"STALE_INVENTORY_EVALUATION_DATE" });
    }
    if (!options.publication) {
      return sendJson(res, 400, { error:"Runtime requests require the active publication timestamp.", code:"RUNTIME_PUBLICATION_REQUIRED" });
    }
    if (Date.parse(options.publication) !== Date.parse(databasePublication.filePublishedAt)) {
      return sendJson(res, 409, { error:"A newer dashboard publication is available. Refreshing is required.", code:"STALE_RUNTIME_PUBLICATION" });
    }
    if (compactAnalysis && (!options.from || !options.to)) {
      return sendJson(res, 400, { error:"Compact Analysis requests require a selected date range and publication." });
    }
    if (compactSales && (!options.from || !options.to)) {
      return sendJson(res, 400, { error:"Compact Sales requests require a selected date range and publication." });
    }
    if (compactAnalysis && options.compareFrom && options.compareTo && options.compareFrom > options.compareTo) {
      return sendJson(res, 400, { error:"The comparison start date must be on or before the comparison end date." });
    }
    if (!runtimeFileFallbackAllowed({ railwayProduction:databaseTransport.railwayProduction, readSource:databasePublication.source })) {
      return sendJson(res, 503, {
        error:"The published database is not ready for this selected view. Please retry; the server skipped an unsafe whole-file rebuild.",
        code:"RUNTIME_DATABASE_NOT_READY",
      }, { "retry-after":"2" });
    }
    let view = null;
    let warehouseFileCacheKey = "";
    let databaseViewError = null;
    if (databasePublication.source === "database") {
      try {
        view = await getDatabaseView(options);
      } catch (error) {
        databaseViewError = error;
        if (compactInventory && error?.code === "INVENTORY_WORKER_BUSY") {
          return sendJson(res, 503, {
            error:error.message,
            code:"INVENTORY_WORKER_BUSY",
          }, { "retry-after":"1" });
        }
        if (compactInventory || compactAnalysis || compactSales) {
          const label = compactInventory ? "Inventory" : compactAnalysis ? "Analysis" : "Sales";
          if (error?.status === 400) return sendJson(res, 400, { error:error.message, code:error.code || "INVALID_COMPACT_VIEW" });
          if (error?.status === 409) return sendJson(res, 409, { error:error.message, code:error.code || `STALE_${label.toUpperCase()}_VIEW` });
          console.error(`[BYOU Intel] Compact database ${label} view failed; skipping an unsafe request-time file rebuild:`, error.message);
        } else {
          console.error("[BYOU Intel] Database view failed; skipping an unsafe request-time file rebuild:", error.message);
        }
      }
    }
    if (!view && (databasePublication.reason === "database-error" || databaseViewError)) {
      return sendJson(res, 503, {
        error:"The selected view could not be read from the published database. Please retry; the server skipped an unsafe whole-file rebuild.",
        code:"RUNTIME_DATABASE_RETRY",
      }, { "retry-after":"2" });
    }
    if (!view) {
      if (compactAnalysis && options.section === "warehouses" && !options.forceRefresh) {
        const info = await stat(publication.dataset);
        warehouseFileCacheKey = `${datasetEtag(info)}|${analysisCompactCacheKey(options.publication, options)}`;
        const cached = warehouseFileViewCache.get(warehouseFileCacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          view = { ...cached.view, queryMs:0, serverCached:true };
        } else if (cached) {
          warehouseFileViewCache.delete(warehouseFileCacheKey);
        }
      }
    }
    if (!view) {
      if (!runtimeFileFallbackAllowed({ railwayProduction:databaseTransport.railwayProduction, readSource:"file" })) {
        return sendJson(res, 503, {
          error:"The selected view is not prepared in the published database. Please retry; the server skipped an unsafe whole-file rebuild.",
          code:"RUNTIME_DATABASE_RETRY",
        }, { "retry-after":"2" });
      }
      const dataset = normalizeDatasetRows(JSON.parse(await readFile(publication.dataset, "utf8")));
      dataset.summaries = buildPublishedSummaries(dataset);
      if (Date.parse(options.publication) !== Date.parse(String(dataset.publishedAt || ""))) {
        return sendJson(res, 409, { error:"A newer dashboard publication is available. Refreshing is required.", code:"STALE_RUNTIME_PUBLICATION" });
      }
      view = compactInventory
        ? await buildInventoryViewModelAsync(dataset, options)
        : compactSales
          ? buildSalesCompactResult(dataset, options)
        : compactAnalysis && options.section === "warehouses"
          ? {
              ...dataset,
              prodSales:dataset.summaries?.campaign?.warehouseDaily || dataset.prodSales || [],
              inlineTotalSales:dataset.summaries?.campaign?.dailyInline || dataset.inlineTotalSales || [],
            }
        : buildRuntimeView(dataset, compactAnalysis && options.section === "affinity" ? { ...options, pids:[], cid:"", cids:[] } : options);
      if (compactAnalysis) view = restoreAnalysisCompactEvidence(view, dataset, options.section);
      if (compactAnalysis && options.section === "events") {
        const evidenceFrom = new Date(`${options.from}T00:00:00Z`);
        evidenceFrom.setUTCDate(evidenceFrom.getUTCDate() - 7);
        const evidenceTo = new Date(`${options.to}T00:00:00Z`);
        evidenceTo.setUTCDate(evidenceTo.getUTCDate() + 6);
        const from = evidenceFrom.toISOString().slice(0, 10);
        const to = evidenceTo.toISOString().slice(0, 10);
        view = {
          ...view,
          prodSales:(view.prodSales || []).filter(row => row.date >= from && row.date <= to),
          onlineSales:(view.onlineSales || []).filter(row => row.date >= from && row.date <= to),
        };
      }
      view.source = "file-fallback";
      if (compactAnalysis) {
        Object.assign(view, {
          productMeta:dataset.productMeta || {},
          campaignMeta:dataset.campaignMeta || {},
          whs:dataset.whs || [],
          analysisOfficialRows:dataset.summaries?.campaign?.dailyInline || dataset.inlineTotalSales || [],
        });
        const referenceData = options.section === "affinity" ? await loadAnalysisReferenceData() : {};
        view = buildAnalysisCompactResult(view, options, referenceData);
      }
      view.queryMs = Math.round(performance.now() - startedAt);
      if (warehouseFileCacheKey) {
        warehouseFileViewCache.set(warehouseFileCacheKey, {
          view,
          expiresAt:Date.now() + WAREHOUSE_FILE_VIEW_CACHE_TTL_MS,
        });
        while (warehouseFileViewCache.size > WAREHOUSE_FILE_VIEW_CACHE_MAX) {
          warehouseFileViewCache.delete(warehouseFileViewCache.keys().next().value);
        }
      }
    }
    const responseView = options.representation === CAMPAIGN_TRANSPORT_REPRESENTATION ? encodeCampaignView(view) : view;
    return sendJson(res, 200, responseView, {
      "cache-control":compactInventory || compactAnalysis || compactSales ? "no-store" : "private, max-age=30, stale-while-revalidate=300",
      "server-timing":`query;dur=${Math.max(0, Number(view.queryMs || 0))}`,
    });
  } catch (error) {
    const status = error?.status || (error?.code === "ENOENT" ? 404 : 500);
    return sendJson(res, status, {
      error:error.message || "Could not load the requested dashboard view.",
      code:error.code,
    }, error?.code === "INVENTORY_WORKER_BUSY" ? { "retry-after":"1" } : {});
  }
}

async function handleGetInventoryApprovals(req, res) {
  const evaluationDate = businessDateKey();
  if (!databaseConfigured()) {
    return sendJson(res, 200, {
      enabled:false,
      usesDashboardPassword:false,
      approvals:[],
      evaluationDate,
      approvalRevision:"0",
      message:"Manual inventory approval requires the shared database.",
    });
  }
  try {
    const publication = await readActivePublication();
    const { bootstrap } = await requiredApprovalDatabasePublication(publication);
    const combinedApprovals = Array.isArray(bootstrap?.inventoryApprovals) ? bootstrap.inventoryApprovals : [];
    const publishedApprovals = Array.isArray(bootstrap?.publishedInventoryApprovals)
      ? bootstrap.publishedInventoryApprovals
      : combinedApprovals.filter(approval => approval?.approvalSource !== "manual_runtime");
    const manualApprovals = Array.isArray(bootstrap?.manualInventoryApprovals)
      ? bootstrap.manualInventoryApprovals
      : combinedApprovals.filter(approval => approval?.approvalSource === "manual_runtime");
    return sendJson(res, 200, {
      enabled:!!inventoryApprovalPassword,
      usesDashboardPassword:!!inventoryApprovalPassword && !dedicatedInventoryApprovalPassword,
      publishedAt:String(bootstrap?.publishedAt || ""),
      approvals:[...publishedApprovals, ...manualApprovals],
      evaluationDate,
      approvalRevision:String(bootstrap?.approvalRevision || "0"),
      message:inventoryApprovalPassword ? "" : "Manual inventory approval is not configured.",
    });
  } catch (error) {
    return sendJson(res, error.status || 503, { enabled:false, approvals:[], error:error.message || "Manual inventory approval is unavailable.", code:error.code || "INVENTORY_APPROVAL_FAILED" });
  }
}

async function handlePostInventoryApproval(req, res) {
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return sendJson(res, 415, { error:"Inventory approval requests must be JSON.", code:"INVENTORY_APPROVAL_CONTENT_TYPE" });
  }
  if (!sameOriginMutation(req)) return sendJson(res, 403, { error:"Inventory approval must be submitted from the BYOU Intel app.", code:"INVENTORY_APPROVAL_ORIGIN" });
  if (!databaseConfigured()) return sendJson(res, 503, { error:"Manual inventory approval requires the shared database.", code:"INVENTORY_APPROVAL_DATABASE_REQUIRED" });
  if (!inventoryApprovalPassword) return sendJson(res, 503, { error:"Manual inventory approval is not configured.", code:"INVENTORY_APPROVAL_NOT_CONFIGURED" });

  const session = await currentSession(req);
  if (!session?.authenticated || session.disabled || !session.token) {
    return sendJson(res, 403, { error:"A signed BYOU Intel login session is required for inventory approval.", code:"INVENTORY_APPROVAL_SESSION_REQUIRED" });
  }
  const actor = (accessUsername ? String(session?.session?.username || "").trim() : "") || "dashboard-team";
  const sessionAttemptKey = `session:${crypto.createHash("sha256").update(session.token).digest("hex")}`;
  const accountAttemptKey = `account:${actor.toLowerCase()}`;
  if ([sessionAttemptKey, accountAttemptKey].some(inventoryApprovalLimited)) return sendJson(res, 429, { error:"Too many incorrect approval attempts. Try again later.", code:"INVENTORY_APPROVAL_RATE_LIMIT" });

  try {
    const buffer = await readBodyBuffer(req, 16 * 1024, "Inventory approval request is too large.");
    const body = JSON.parse(buffer.toString("utf8"));
    const normalized = normalizeManualInventoryApprovalRequest(body, businessDateKey());
    if (!normalized.ok) return sendJson(res, 422, { error:normalized.errors[0], errors:normalized.errors, code:"INVENTORY_APPROVAL_INVALID" });
    if (!safeCompareText(normalized.value.approvalPassword, inventoryApprovalPassword)) {
      recordInventoryApprovalFailure(sessionAttemptKey);
      recordInventoryApprovalFailure(accountAttemptKey);
      return sendJson(res, 403, { error:"Incorrect approval password.", code:"INVENTORY_APPROVAL_UNAUTHORIZED" });
    }
    clearInventoryApprovalFailures(sessionAttemptKey);
    const publication = await readActivePublication();
    const { databaseVersionId } = await requiredApprovalDatabasePublication(publication);
    const result = await createManualInventoryApproval({
      databaseVersionId,
      idempotencyKey:normalized.value.idempotencyKey,
      sourcePublishedAt:normalized.value.sourcePublishedAt,
      scope:normalized.value.scope,
      evidence:normalized.value.evidence,
      actor,
      approvedOn:businessDateKey(),
    });
    return sendJson(res, result.alreadyApplied ? 200 : 201, {
      ok:true,
      alreadyApplied:result.alreadyApplied,
      approval:result.approval,
      evaluationDate:businessDateKey(),
      approvalRevision:String(result.approvalRevision || ""),
      message:result.alreadyApplied
        ? "This exact on-hand inventory fact was already approved."
        : "The exact on-hand inventory fact is approved for 14 days unless the campaign, date, or balance changes.",
    });
  } catch (error) {
    if (error instanceof SyntaxError) return sendJson(res, 400, { error:"Inventory approval request is not valid JSON.", code:"INVENTORY_APPROVAL_INVALID_JSON" });
    return sendJson(res, error.status || 500, { error:error.message || "Inventory approval failed.", code:error.code || "INVENTORY_APPROVAL_FAILED" });
  }
}

async function handleDeleteInventoryApproval(req, res) {
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return sendJson(res, 415, { error:"Inventory approval removal requests must be JSON.", code:"INVENTORY_APPROVAL_CONTENT_TYPE" });
  }
  if (!sameOriginMutation(req)) return sendJson(res, 403, { error:"Inventory approval must be removed from the BYOU Intel app.", code:"INVENTORY_APPROVAL_ORIGIN" });
  if (!databaseConfigured()) return sendJson(res, 503, { error:"Manual inventory approval requires the shared database.", code:"INVENTORY_APPROVAL_DATABASE_REQUIRED" });
  if (!inventoryApprovalPassword) return sendJson(res, 503, { error:"Manual inventory approval is not configured.", code:"INVENTORY_APPROVAL_NOT_CONFIGURED" });

  const session = await currentSession(req);
  if (!session?.authenticated || session.disabled || !session.token) {
    return sendJson(res, 403, { error:"A signed BYOU Intel login session is required for inventory approval removal.", code:"INVENTORY_APPROVAL_SESSION_REQUIRED" });
  }
  const actor = (accessUsername ? String(session?.session?.username || "").trim() : "") || "dashboard-team";
  const sessionAttemptKey = `session:${crypto.createHash("sha256").update(session.token).digest("hex")}`;
  const accountAttemptKey = `account:${actor.toLowerCase()}`;
  if ([sessionAttemptKey, accountAttemptKey].some(inventoryApprovalLimited)) return sendJson(res, 429, { error:"Too many incorrect approval attempts. Try again later.", code:"INVENTORY_APPROVAL_RATE_LIMIT" });

  try {
    const buffer = await readBodyBuffer(req, 16 * 1024, "Inventory approval removal request is too large.");
    const body = JSON.parse(buffer.toString("utf8"));
    const normalized = normalizeManualInventoryRevocationRequest(body);
    if (!normalized.ok) return sendJson(res, 422, { error:normalized.errors[0], errors:normalized.errors, code:"INVENTORY_APPROVAL_INVALID" });
    if (!safeCompareText(normalized.value.approvalPassword, inventoryApprovalPassword)) {
      recordInventoryApprovalFailure(sessionAttemptKey);
      recordInventoryApprovalFailure(accountAttemptKey);
      return sendJson(res, 403, { error:"Incorrect approval password.", code:"INVENTORY_APPROVAL_UNAUTHORIZED" });
    }
    clearInventoryApprovalFailures(sessionAttemptKey);
    const publication = await readActivePublication();
    const { databaseVersionId } = await requiredApprovalDatabasePublication(publication);
    const result = await revokeManualInventoryApproval({
      databaseVersionId,
      idempotencyKey:normalized.value.idempotencyKey,
      sourcePublishedAt:normalized.value.sourcePublishedAt,
      scope:normalized.value.scope,
      reason:normalized.value.reason,
      reviewer:normalized.value.reviewer,
      actor,
    });
    return sendJson(res, result.alreadyApplied ? 200 : 201, {
      ok:true,
      alreadyApplied:result.alreadyApplied,
      revocation:result.revocation,
      evaluationDate:businessDateKey(),
      approvalRevision:String(result.approvalRevision || ""),
      message:result.alreadyApplied
        ? "This manual inventory approval was already removed."
        : "The manual approval was removed and the exact inventory fact returned to quarantine.",
    });
  } catch (error) {
    if (error instanceof SyntaxError) return sendJson(res, 400, { error:"Inventory approval removal request is not valid JSON.", code:"INVENTORY_APPROVAL_INVALID_JSON" });
    return sendJson(res, error.status || 500, { error:error.message || "Inventory approval removal failed.", code:error.code || "INVENTORY_APPROVAL_FAILED" });
  }
}

async function handlePostOwnerReviewedInventoryMigration(req, res) {
  if (!adminAuthorized(req)) return sendJson(res, 401, { error:"Admin token required.", code:"OWNER_REVIEW_ADMIN_REQUIRED" });
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
    return sendJson(res, 415, { error:"Owner-reviewed inventory migration requests must be JSON.", code:"OWNER_REVIEW_CONTENT_TYPE" });
  }
  if (!databaseConfigured()) return sendJson(res, 503, { error:"Owner-reviewed inventory migration requires the shared database.", code:"INVENTORY_APPROVAL_DATABASE_REQUIRED" });
  try {
    const buffer = await readBodyBuffer(req, 16 * 1024, "Owner-reviewed inventory migration request is too large.");
    const body = JSON.parse(buffer.toString("utf8"));
    const authorizationReference = String(body?.authorizationReference || "").trim();
    const reviewer = String(body?.reviewer || "").trim();
    const sourcePublishedAt = String(body?.sourcePublishedAt || "").trim();
    const expectedManifestHash = String(body?.expectedManifestHash || "").trim().toLowerCase();
    const expectedCandidateCount = body?.expectedCandidateCount;
    const dryRun = body?.dryRun !== false;
    const sourceTimestampValid = Number.isFinite(Date.parse(sourcePublishedAt));
    if (!authorizationReference || authorizationReference.length > 200 || reviewer.length < 2 || reviewer.length > 100 || (!dryRun && !sourceTimestampValid) || (sourcePublishedAt && !sourceTimestampValid)) {
      return sendJson(res, 422, { error:"A valid source revision, owner-authorization reference, and reviewer are required.", code:"OWNER_REVIEW_INVALID" });
    }
    if (!dryRun && (!/^[0-9a-f]{64}$/.test(expectedManifestHash) || !Number.isInteger(Number(expectedCandidateCount)))) {
      return sendJson(res, 422, { error:"The exact preflight manifest hash and candidate count are required before applying owner-reviewed inventory.", code:"OWNER_REVIEW_PREFLIGHT_REQUIRED" });
    }
    const publication = await readActivePublication();
    const approvalPublication = await requiredApprovalDatabasePublication(publication);
    const databaseVersionId = approvalPublication.databaseVersionId;
    const result = await migrateOwnerReviewedInventoryApprovals({
      databaseVersionId,
      sourcePublishedAt:sourcePublishedAt || approvalPublication.filePublishedAt,
      authorizationReference,
      reviewer,
      actor:"admin-publisher",
      expectedManifestHash,
      expectedCandidateCount,
      dryRun,
      approvedOn:businessDateKey(),
    });
    return sendJson(res, dryRun || result.alreadyApplied ? 200 : 201, { ok:true, ...result });
  } catch (error) {
    if (error instanceof SyntaxError) return sendJson(res, 400, { error:"Owner-reviewed inventory migration request is not valid JSON.", code:"OWNER_REVIEW_INVALID_JSON" });
    return sendJson(res, error.status || 500, { error:error.message || "Owner-reviewed inventory migration failed.", code:error.code || "OWNER_REVIEW_FAILED" });
  }
}

function fullPublicationJobPaths(jobId) {
  return {
    state:path.join(fullPublicationJobDir, `${jobId}.json`),
    payload:path.join(fullPublicationJobDir, `${jobId}.payload`),
  };
}

async function readFullPublicationJob(jobId) {
  return JSON.parse(await readFile(fullPublicationJobPaths(jobId).state, "utf8"));
}

async function saveFullPublicationJob(job) {
  const next = { ...job, updatedAt:new Date().toISOString() };
  await writeJsonAtomic(fullPublicationJobPaths(job.jobId).state, next);
  return next;
}

function publicFullPublicationJob(job) {
  const status = String(job?.status || "accepted");
  return {
    kind:"full-publication",
    jobId:String(job?.jobId || ""),
    status,
    verified:status === "verified",
    acceptedAt:String(job?.acceptedAt || ""),
    startedAt:String(job?.startedAt || ""),
    finishedAt:String(job?.finishedAt || ""),
    targetPublishedAt:String(job?.targetPublishedAt || ""),
    publishedAt:String(job?.publishedAt || ""),
    expectations:job?.expectedSummary || job?.dataset?.publicationCertification || null,
    dataset:job?.dataset || null,
    ...(status === "failed" ? {
      code:String(job?.code || "FULL_PUBLICATION_FAILED"),
      error:String(job?.error || "The full publication job failed."),
      httpStatus:Number(job?.httpStatus || 409),
    } : {}),
  };
}

function sendFullPublicationJob(res, job) {
  const publicJob = publicFullPublicationJob(job);
  if (publicJob.status === "failed") {
    sendJson(res, publicJob.httpStatus, { ok:false, accepted:false, ...publicJob });
    return;
  }
  const pending = ["accepted", "processing"].includes(publicJob.status);
  sendJson(res, pending ? 202 : 200, {
    ok:true,
    accepted:pending,
    ...publicJob,
    statusUrl:`/api/dataset/publish/status?jobId=${encodeURIComponent(publicJob.jobId)}`,
  });
}

function safeFullPublicationFailure(error) {
  const status = Number(error?.status || 500);
  return {
    code:String(error?.code || "FULL_PUBLICATION_FAILED"),
    error:status >= 400 && status < 500
      ? String(error?.message || "The full publication job failed.")
      : "The full publication job failed on the server.",
    httpStatus:status >= 400 && status < 500 ? status : 500,
  };
}

function enqueueFullPublicationJob(jobId) {
  if (!jobId || queuedFullPublicationJobs.has(jobId)) return;
  queuedFullPublicationJobs.add(jobId);
  fullPublicationQueue.push(jobId);
  setImmediate(() => { void processFullPublicationQueue(); });
}

async function recoveredFullPublicationSummary(job) {
  const publication = await readActivePublication();
  if (!publication.manifest || publication.manifest.publicationId !== job.publicationId) return null;
  const datasetText = await readFile(publication.dataset, "utf8");
  const startupInfo = await stat(publication.startup);
  const dataset = normalizeDatasetRows(JSON.parse(datasetText));
  return {
    ...summarizeDataset(dataset, Buffer.byteLength(datasetText)),
    startupBytes:startupInfo.size,
    publicationId:publication.manifest.publicationId,
    manifest:publication.manifest,
    generationCleanupWarning:"",
    database:{ configured:databaseConfigured(), versionId:publication.manifest.databaseVersionId || "" },
  };
}

async function runFullPublicationJob(jobId) {
  let job = await readFullPublicationJob(jobId);
  if (["verified", "failed"].includes(job.status)) return;
  const paths = fullPublicationJobPaths(jobId);
  try {
    const recovered = await recoveredFullPublicationSummary(job);
    if (recovered) {
      await saveFullPublicationJob({
        ...job,
        status:"verified",
        publishedAt:recovered.publishedAt,
        dataset:recovered,
        finishedAt:new Date().toISOString(),
      });
      await rm(paths.payload, { force:true }).catch(() => {});
      return;
    }
    job = await saveFullPublicationJob({
      ...job,
      status:"processing",
      startedAt:job.startedAt || new Date().toISOString(),
      error:"",
      code:"",
    });
    if (fullPublicationTestDelayMs) await new Promise(resolve => setTimeout(resolve, fullPublicationTestDelayMs));
    const text = await readFile(paths.payload, "utf8");
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    if (hash !== job.hash) throw Object.assign(new Error("The staged full-publication payload hash changed."), { status:409, code:"FULL_PUBLICATION_HASH_MISMATCH" });
    const summary = await savePublishedDatasetFromText(text, {
      expectedPublishedAt:job.expectedPublishedAt,
      expectedSummary:job.expectedSummary || {},
      allowHistoryReplacement:!!job.allowHistoryReplacement,
      publicationId:job.publicationId,
    });
    await saveFullPublicationJob({
      ...job,
      status:"verified",
      publishedAt:summary.publishedAt,
      dataset:summary,
      finishedAt:new Date().toISOString(),
    });
    await rm(paths.payload, { force:true }).catch(() => {});
  } catch (error) {
    const failure = safeFullPublicationFailure(error);
    console.error(`[BYOU Intel] Full publication job ${jobId} failed:`, error?.message || error);
    const status = Number(error?.status || 500);
    if (status >= 400 && status < 500 && status !== 503) {
      await saveFullPublicationJob({ ...job, status:"failed", ...failure, finishedAt:new Date().toISOString() });
      await rm(paths.payload, { force:true }).catch(() => {});
    } else {
      await saveFullPublicationJob({
        ...job,
        status:"accepted",
        lastAttemptAt:new Date().toISOString(),
        attemptCount:Number(job.attemptCount || 0) + 1,
        lastErrorCode:failure.code,
        finishedAt:"",
      });
    }
  }
}

async function processFullPublicationQueue() {
  if (fullPublicationProcessorRunning) return;
  fullPublicationProcessorRunning = true;
  try {
    while (fullPublicationQueue.length) {
      const jobId = fullPublicationQueue.shift();
      try {
        await runFullPublicationJob(jobId);
      } catch (error) {
        console.error(`[BYOU Intel] Full publication job ${jobId} could not be processed:`, error.message);
      } finally {
        queuedFullPublicationJobs.delete(jobId);
      }
    }
  } finally {
    fullPublicationProcessorRunning = false;
    if (fullPublicationQueue.length) setImmediate(() => { void processFullPublicationQueue(); });
  }
}

async function drainFullPublicationQueue() {
  while (fullPublicationProcessorRunning || fullPublicationQueue.length) {
    await processFullPublicationQueue();
    if (fullPublicationProcessorRunning) await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function resumeFullPublicationJobs() {
  await mkdir(fullPublicationJobDir, { recursive:true });
  const jobFiles = (await readdir(fullPublicationJobDir)).filter(name => name.endsWith(".json"));
  for (const filename of jobFiles) {
    try {
      const job = JSON.parse(await readFile(path.join(fullPublicationJobDir, filename), "utf8"));
      if (["accepted", "processing"].includes(job?.status) && safeBatchId(job.jobId)) enqueueFullPublicationJob(job.jobId);
    } catch (error) {
      console.error(`[BYOU Intel] Could not resume full publication job ${filename}:`, error.message);
    }
  }
}

async function acceptFullPublication(text, req) {
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  const requestedJobId = String(req.headers["x-byou-publication-job-id"] || "").trim();
  const jobId = requestedJobId ? safeBatchId(requestedJobId) : `full-${hash.slice(0, 32)}`;
  if (!jobId) throw Object.assign(new Error("Invalid full-publication job ID."), { status:400, code:"FULL_PUBLICATION_JOB_ID_INVALID" });
  const expectedPublishedAt = req.headers["x-byou-expected-published-at"] === undefined
    ? undefined
    : String(req.headers["x-byou-expected-published-at"] || "");
  const allowHistoryReplacement = String(req.headers["x-byou-allow-history-replacement"] || "").toLowerCase() === "true";
  if (allowHistoryReplacement) {
    if (!historyReplacementToken || safeCompareText(historyReplacementToken, adminToken)) {
      throw Object.assign(new Error("Historical replacement is disabled until a separate history-replacement secret is configured."), { status:503, code:"HISTORY_REPLACEMENT_DISABLED" });
    }
    if (!safeCompareText(req.headers["x-byou-history-replacement-token"], historyReplacementToken)) {
      throw Object.assign(new Error("A valid history-replacement token is required for historical replacement."), { status:403, code:"HISTORY_REPLACEMENT_AUTH_REQUIRED" });
    }
  }
  const expectedSummary = {};
  const expectedHeaders = {
    warehouses:"x-byou-expected-warehouses",
    products:"x-byou-expected-products",
    campaigns:"x-byou-expected-campaigns",
    productRows:"x-byou-expected-product-rows",
    warehouseDates:"x-byou-expected-warehouse-dates",
    inlineTotalRows:"x-byou-expected-inline-total-rows",
    inlineDates:"x-byou-expected-inline-dates",
    onlineRows:"x-byou-expected-online-rows",
    onlineDates:"x-byou-expected-online-dates",
    ownerSalesCorrections:"x-byou-expected-sales-corrections",
  };
  for (const [field, header] of Object.entries(expectedHeaders)) {
    if (req.headers[header] === undefined) {
      throw Object.assign(new Error(`Missing ${field} publication expectation.`), { status:400, code:"FULL_PUBLICATION_EXPECTATION_REQUIRED" });
    }
    const value = Number(req.headers[header]);
    if (!Number.isInteger(value) || value < 0) throw Object.assign(new Error(`Invalid ${field} publication expectation.`), { status:400, code:"FULL_PUBLICATION_EXPECTATION_INVALID" });
    expectedSummary[field] = value;
  }
  for (const [field, header] of Object.entries({
    warehouseStart:"x-byou-expected-warehouse-start",
    warehouseEnd:"x-byou-expected-warehouse-end",
    inlineStart:"x-byou-expected-inline-start",
    inlineEnd:"x-byou-expected-inline-end",
    onlineStart:"x-byou-expected-online-start",
    onlineEnd:"x-byou-expected-online-end",
  })) {
    if (req.headers[header] === undefined) {
      throw Object.assign(new Error(`Missing ${field} publication expectation.`), { status:400, code:"FULL_PUBLICATION_EXPECTATION_REQUIRED" });
    }
    const value = String(req.headers[header] || "");
    const parsedDate = value ? new Date(`${value}T00:00:00Z`) : null;
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== value)) {
      throw Object.assign(new Error(`Invalid ${field} publication expectation.`), { status:400, code:"FULL_PUBLICATION_EXPECTATION_INVALID" });
    }
    expectedSummary[field] = value;
  }
  for (const lane of ["warehouse", "inline", "online"]) {
    const dates = expectedSummary[`${lane}Dates`];
    const start = expectedSummary[`${lane}Start`];
    const end = expectedSummary[`${lane}End`];
    if ((dates === 0 && (start || end)) || (dates > 0 && (!start || !end || start > end))) {
      throw Object.assign(new Error(`The ${lane} publication coverage expectation is inconsistent.`), { status:400, code:"FULL_PUBLICATION_EXPECTATION_INVALID" });
    }
  }
  const candidate = JSON.parse(text);
  const targetPublishedAt = String(candidate?.publishedAt || "");
  if (!Number.isFinite(Date.parse(targetPublishedAt))) throw Object.assign(new Error("The full dataset requires a valid publishedAt timestamp."), { status:422, code:"DATASET_PUBLICATION_INVALID" });
  // Corrections are intentionally carried forward from the active generation
  // later in the worker; every immutable fact-lane expectation is exact now.
  const preSideEffectExpectedSummary = { ...expectedSummary };
  delete preSideEffectExpectedSummary.ownerSalesCorrections;
  assertExpectedPublicationSummary(summarizeDataset(validateFullDatasetCandidate(candidate), 0), preSideEffectExpectedSummary);
  let existing = null;
  try { existing = await readFullPublicationJob(jobId); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (existing) {
    if (existing.hash !== hash
      || existing.expectedPublishedAt !== expectedPublishedAt
      || JSON.stringify(existing.expectedSummary || {}) !== JSON.stringify(expectedSummary)
      || !!existing.allowHistoryReplacement !== allowHistoryReplacement) {
      throw Object.assign(new Error("The full-publication job ID is already associated with different inputs."), { status:409, code:"FULL_PUBLICATION_JOB_COLLISION" });
    }
    if (["accepted", "processing"].includes(existing.status)) enqueueFullPublicationJob(jobId);
    return existing;
  }
  await mkdir(fullPublicationJobDir, { recursive:true });
  const paths = fullPublicationJobPaths(jobId);
  const tempPayload = `${paths.payload}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPayload, text, "utf8");
  await replaceFileWithRetry(tempPayload, paths.payload);
  const job = await saveFullPublicationJob({
    schema:"byou-full-publication-job-v1",
    kind:"full-publication",
    jobId,
    publicationId:crypto.randomUUID(),
    hash,
    expectedPublishedAt,
    expectedSummary,
    allowHistoryReplacement,
    targetPublishedAt,
    status:"accepted",
    acceptedAt:new Date().toISOString(),
    startedAt:"",
    finishedAt:"",
    publishedAt:"",
    dataset:null,
  });
  enqueueFullPublicationJob(jobId);
  return job;
}

async function handlePostDataset(req, res) {
  if (!adminToken) {
    sendJson(res, 500, { error:"BYOU_ADMIN_TOKEN is not configured on the server, so publishing is disabled." });
    return;
  }
  if (!adminAuthorized(req)) {
    sendJson(res, 401, { error:"Admin token required." });
    return;
  }
  const dir = path.join(uploadDir, `direct-${crypto.randomUUID()}`);
  try {
    await mkdir(dir, { recursive:true });
    const payloadPath = path.join(dir, "payload.json");
    await streamUploadToFile(req, payloadPath, { limit:maxBodyBytes, encoding:req.headers["content-encoding"] });
    const body = await readFile(payloadPath, "utf8");
    sendFullPublicationJob(res, await acceptFullPublication(body, req));
  } catch (error) {
    sendJson(res, error.status || 500, { error:error.message || "Could not publish dataset.", code:error.code || "DATASET_PUBLISH_FAILED" });
  } finally {
    await rm(dir, { recursive:true, force:true }).catch(() => {});
  }
}

async function handleGetFullPublicationStatus(req, res, reqUrl) {
  if (!adminToken) return sendJson(res, 500, { error:"BYOU_ADMIN_TOKEN is not configured on the server, so publishing is disabled." });
  if (!adminAuthorized(req)) return sendJson(res, 401, { error:"Admin token required." });
  const jobId = safeBatchId(reqUrl?.searchParams?.get("jobId") || "");
  if (!jobId) return sendJson(res, 400, { error:"Invalid full-publication job ID." });
  try {
    return sendJson(res, 200, { ok:true, ...publicFullPublicationJob(await readFullPublicationJob(jobId)) });
  } catch (error) {
    return sendJson(res, error?.code === "ENOENT" ? 404 : 500, { error:error?.code === "ENOENT" ? "Full-publication job was not found." : "Could not read full-publication job status." });
  }
}

function decodedUploadFilename(req) {
  const encoded = String(req.headers["x-byou-filename"] || "").slice(0, 500);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

function safeBatchId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9._-]{1,100}$/.test(id) ? id : "";
}

function dailyUpdateHistory(dataset) {
  return Array.isArray(dataset?.dailyUpdateHistory)
    ? dataset.dailyUpdateHistory.filter(entry => entry && typeof entry === "object").slice(-99)
    : [];
}

function correctionHistory(dataset) {
  return Array.isArray(dataset?.correctionHistory)
    ? dataset.correctionHistory.filter(entry => entry && typeof entry === "object").slice(-99)
    : [];
}

function dailyUpdateJobPaths(batchId) {
  return {
    state:path.join(dailyUpdateJobDir, `${batchId}.json`),
    workbook:path.join(dailyUpdateJobDir, `${batchId}.xlsx`),
  };
}

async function replaceFileWithRetry(tempPath, filePath) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rename(tempPath, filePath);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error?.code) || attempt === 19) {
        await rm(tempPath, { force:true }).catch(() => {});
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

async function writeJsonAtomic(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive:true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  await writeFile(tempPath, `${JSON.stringify(payload)}\n`, "utf8");
  await replaceFileWithRetry(tempPath, filePath);
}

async function readDailyUpdateJob(batchId) {
  const { state } = dailyUpdateJobPaths(batchId);
  return JSON.parse(await readFile(state, "utf8"));
}

async function saveDailyUpdateJob(job) {
  const next = { ...job, updatedAt:new Date().toISOString() };
  await writeJsonAtomic(dailyUpdateJobPaths(job.batchId).state, next);
  return next;
}

function publicDailyUpdateJob(job) {
  const status = String(job?.status || "accepted");
  return {
    kind:String(job?.kind || "daily-update"),
    batchId:String(job?.batchId || ""),
    status,
    verified:status === "verified",
    alreadyApplied:!!job?.alreadyApplied,
    acceptedAt:String(job?.acceptedAt || ""),
    startedAt:String(job?.startedAt || ""),
    finishedAt:String(job?.finishedAt || ""),
    publishedAt:String(job?.publishedAt || ""),
    result:job?.result || {},
    ...(status === "failed" ? {
      code:String(job?.code || "DAILY_UPDATE_FAILED"),
      error:String(job?.error || "The daily update job failed."),
    } : {}),
  };
}

function safeDailyUpdateFailure(error) {
  const status = Number(error?.status || 500);
  const safeClientError = status >= 400 && status < 500;
  return {
    code:String(error?.code || "DAILY_UPDATE_FAILED"),
    error:safeClientError ? String(error?.message || "The daily update job failed.") : "The daily update job failed on the server.",
  };
}

function sendDailyUpdateJob(res, job, { alreadyApplied = false } = {}) {
  const publicJob = publicDailyUpdateJob(job);
  if (publicJob.status === "failed") {
    sendJson(res, 409, { ok:false, accepted:false, alreadyApplied:false, ...publicJob });
    return;
  }
  const pending = publicJob.status === "accepted" || publicJob.status === "processing";
  sendJson(res, pending ? 202 : 200, {
    ok:true,
    ...publicJob,
    accepted:pending,
    alreadyApplied:alreadyApplied || !!job.alreadyApplied,
    statusUrl:job?.kind === "correction"
      ? `/api/dataset/correction/status?correctionId=${encodeURIComponent(publicJob.batchId)}`
      : `/api/dataset/daily-update/status?batchId=${encodeURIComponent(publicJob.batchId)}`,
  });
}

function enqueueDailyUpdateJob(batchId) {
  if (!batchId || queuedDailyUpdateJobs.has(batchId)) return;
  queuedDailyUpdateJobs.add(batchId);
  dailyUpdateQueue.push(batchId);
  setImmediate(() => { void processDailyUpdateQueue(); });
}

async function delayForDailyUpdateTest() {
  if (!dailyUpdateTestDelayMs) return;
  await new Promise(resolve => setTimeout(resolve, dailyUpdateTestDelayMs));
}

async function runDailyUpdateJob(batchId) {
  let job = await readDailyUpdateJob(batchId);
  if (job?.kind === "correction") return runCorrectionJob(batchId);
  if (["verified", "failed"].includes(job.status)) return;
  const paths = dailyUpdateJobPaths(batchId);
  job = await saveDailyUpdateJob({
    ...job,
    status:"processing",
    startedAt:job.startedAt || new Date().toISOString(),
    error:"",
    code:"",
  });
  try {
    await delayForDailyUpdateTest();
    const buffer = await readFile(paths.workbook);
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    if (hash !== job.hash) throw Object.assign(new Error("The staged daily-update workbook hash changed."), { status:409, code:"DAILY_UPDATE_HASH_MISMATCH" });
    const current = await readActiveDataset();
    const history = dailyUpdateHistory(current);
    const priorBatch = history.find(entry => entry.batchId === batchId);
    if (priorBatch && priorBatch.hash !== hash) {
      throw Object.assign(new Error("The batch ID is already associated with a different daily update."), { status:409, code:"DAILY_UPDATE_BATCH_COLLISION" });
    }
    const prior = priorBatch || history.find(entry => entry.hash === hash);
    if (prior) {
      await saveDailyUpdateJob({
        ...job,
        status:"verified",
        alreadyApplied:true,
        publishedAt:prior.publishedAt || current.publishedAt || "",
        result:prior.result || {},
        finishedAt:new Date().toISOString(),
      });
      await rm(paths.workbook, { force:true }).catch(() => {});
      return;
    }
    const sheets = await readDailyUpdateWorkbook(buffer);
    const merged = mergeDailyUpdateDataset(current, sheets, dailyUpdateMergeOptions(batchId, hash));
    const masterLineage = verifyDailyUpdateMasterLineage(current, merged, sheets, batchId);
    merged.result.masterLineage = masterLineage;
    if (!merged.changed) {
      await saveDailyUpdateJob({
        ...job,
        status:"verified",
        alreadyApplied:true,
        publishedAt:current.publishedAt || "",
        result:merged.result,
        finishedAt:new Date().toISOString(),
      });
      await rm(paths.workbook, { force:true }).catch(() => {});
      return;
    }
    const publishedAt = new Date().toISOString();
    const historyEntry = { hash, batchId, publishedAt, dataThrough:merged.result.dataThrough, result:merged.result };
    const nextDataset = {
      ...merged.dataset,
      publishedAt,
      dailyUpdateHistory:[...history, historyEntry],
    };
    const summary = await savePublishedDataset(nextDataset, { expectedPublishedAt:String(current.publishedAt || "") });
    await saveDailyUpdateJob({
      ...job,
      status:"verified",
      alreadyApplied:false,
      publishedAt,
      result:merged.result,
      dataset:summary,
      finishedAt:new Date().toISOString(),
    });
    await rm(paths.workbook, { force:true }).catch(() => {});
  } catch (error) {
    const failure = safeDailyUpdateFailure(error);
    console.error(`[BYOU Intel] Daily update job ${batchId} failed:`, error?.message || error);
    await saveDailyUpdateJob({
      ...job,
      status:"failed",
      ...failure,
      finishedAt:new Date().toISOString(),
    });
    await rm(paths.workbook, { force:true }).catch(() => {});
  }
}

function correctionKey(value) {
  const collection = String(value?.collection || "");
  const pid = String(value?.pid || "").trim();
  const cid = String(value?.cid || "").trim();
  const date = String(value?.date || "").trim();
  if (!["onlineSales", "prodSales"].includes(collection) || !pid || !cid || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { collection, pid, cid, date };
}

function correctionPayload(value) {
  const key = correctionKey(value?.key);
  if (key?.collection === "prodSales") {
    const records = value?.records;
    const expected = value?.expected;
    if (!Array.isArray(records) || !records.length || records.length > 1_000 || records.some(row => !row || typeof row !== "object" || Array.isArray(row))) return null;
    if (!expected || typeof expected !== "object" || !Number.isInteger(Number(expected.existingRows)) || !Number.isInteger(Number(expected.replacementRows)) || !Number.isFinite(Number(expected.revenue)) || !Number.isFinite(Number(expected.units))) return null;
    return {
      key,
      records:records.map(record => ({ ...record })),
      expected:{
        existingRows:Number(expected.existingRows),
        replacementRows:Number(expected.replacementRows),
        revenue:Number(expected.revenue),
        units:Number(expected.units),
      },
    };
  }
  const record = value?.record;
  if (!key || !record || typeof record !== "object" || Array.isArray(record)) return null;
  if (String(record.pid || "").trim() !== key.pid || String(record.cid || "").trim() !== key.cid || String(record.date || "").trim() !== key.date) return null;
  return { key, record:{ ...record, pid:key.pid, cid:key.cid, date:key.date } };
}

async function runCorrectionJob(batchId) {
  let job = await readDailyUpdateJob(batchId);
  if (["verified", "failed"].includes(job.status)) return;
  job = await saveDailyUpdateJob({
    ...job,
    status:"processing",
    startedAt:job.startedAt || new Date().toISOString(),
    error:"",
    code:"",
  });
  try {
    await delayForDailyUpdateTest();
    const payload = correctionPayload(job);
    if (!payload) throw Object.assign(new Error("The correction record does not match its immutable business key."), { status:422, code:"CORRECTION_KEY_MISMATCH" });
    const current = await readActiveDataset();
    const history = correctionHistory(current);
    const priorId = history.find(entry => entry.correctionId === batchId);
    if (priorId && priorId.hash !== job.hash) throw Object.assign(new Error("The correction ID is already associated with a different record."), { status:409, code:"CORRECTION_ID_COLLISION" });
    const prior = priorId || history.find(entry => entry.hash === job.hash);
    if (prior) {
      await saveDailyUpdateJob({ ...job, status:"verified", alreadyApplied:true, publishedAt:prior.publishedAt || current.publishedAt || "", result:prior.result || {}, finishedAt:new Date().toISOString() });
      return;
    }
    if (payload.key.collection === "prodSales") {
      const replaced = replaceWarehouseDailySlice(current, payload);
      if (!replaced.changed) {
        await saveDailyUpdateJob({ ...job, status:"verified", alreadyApplied:true, publishedAt:current.publishedAt || "", result:replaced.result, finishedAt:new Date().toISOString() });
        return;
      }
      const publishedAt = new Date().toISOString();
      const nextDataset = {
        ...replaced.dataset,
        publishedAt,
        correctionHistory:[...history, { correctionId:batchId, hash:job.hash, publishedAt, result:replaced.result }],
      };
      const summary = await savePublishedDataset(nextDataset, { expectedPublishedAt:String(current.publishedAt || "") });
      await saveDailyUpdateJob({ ...job, status:"verified", alreadyApplied:false, publishedAt, result:replaced.result, dataset:summary, finishedAt:new Date().toISOString() });
      return;
    }
    const rows = current.onlineSales || [];
    const matches = rows.map((row, index) => ({ row, index })).filter(({ row }) => row?.date === payload.key.date && row?.pid === payload.key.pid && row?.cid === payload.key.cid);
    if (matches.length !== 1) throw Object.assign(new Error("The immutable online-sales business key must match exactly one published record."), { status:409, code:"CORRECTION_KEY_NOT_UNIQUE" });
    const replacement = payload.record;
    const existing = matches[0].row;
    const result = { collection:"onlineSales", key:payload.key, replacedRows:existing && JSON.stringify(existing) === JSON.stringify(replacement) ? 0 : 1 };
    if (!result.replacedRows) {
      const publishedAt = current.publishedAt || "";
      await saveDailyUpdateJob({ ...job, status:"verified", alreadyApplied:true, publishedAt, result, finishedAt:new Date().toISOString() });
      return;
    }
    const publishedAt = new Date().toISOString();
    const nextOnlineSales = [...rows];
    nextOnlineSales[matches[0].index] = replacement;
    const nextDataset = {
      ...current,
      onlineSales:nextOnlineSales,
      publishedAt,
      correctionHistory:[...history, { correctionId:batchId, hash:job.hash, publishedAt, result }],
    };
    const summary = await savePublishedDataset(nextDataset, { expectedPublishedAt:String(current.publishedAt || "") });
    await saveDailyUpdateJob({ ...job, status:"verified", alreadyApplied:false, publishedAt, result, dataset:summary, finishedAt:new Date().toISOString() });
  } catch (error) {
    const failure = safeDailyUpdateFailure(error);
    console.error(`[BYOU Intel] Correction job ${batchId} failed:`, error?.message || error);
    await saveDailyUpdateJob({ ...job, status:"failed", ...failure, finishedAt:new Date().toISOString() });
  }
}

async function processDailyUpdateQueue() {
  if (dailyUpdateProcessorRunning) return;
  dailyUpdateProcessorRunning = true;
  try {
    while (dailyUpdateQueue.length) {
      const batchId = dailyUpdateQueue.shift();
      try {
        await runDailyUpdateJob(batchId);
      } catch (error) {
        console.error(`[BYOU Intel] Daily update job ${batchId} could not be processed:`, error.message);
      } finally {
        queuedDailyUpdateJobs.delete(batchId);
      }
    }
  } finally {
    dailyUpdateProcessorRunning = false;
    if (dailyUpdateQueue.length) setImmediate(() => { void processDailyUpdateQueue(); });
  }
}

async function resumeDailyUpdateJobs() {
  await mkdir(dailyUpdateJobDir, { recursive:true });
  const jobFiles = (await readdir(dailyUpdateJobDir)).filter(name => name.endsWith(".json"));
  for (const filename of jobFiles) {
    try {
      const job = JSON.parse(await readFile(path.join(dailyUpdateJobDir, filename), "utf8"));
      if (["accepted", "processing"].includes(job?.status) && safeBatchId(job.batchId)) enqueueDailyUpdateJob(job.batchId);
    } catch (error) {
      console.error(`[BYOU Intel] Could not resume daily update job ${filename}:`, error.message);
    }
  }
}

async function handlePostDailyUpdate(req, res) {
  if (!adminToken) {
    sendJson(res, 500, { error:"BYOU_ADMIN_TOKEN is not configured on the server, so daily publishing is disabled." });
    return;
  }
  if (!adminAuthorized(req)) {
    sendJson(res, 401, { error:"Admin token required." });
    return;
  }
  const filename = decodedUploadFilename(req);
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  const contentLength = Number(req.headers["content-length"] || 0);
  if (!/\.xlsx$/i.test(filename)) {
    sendJson(res, 400, { error:"Daily update must be an .xlsx workbook." });
    return;
  }
  if (!contentType.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") &&
      !contentType.includes("application/octet-stream")) {
    sendJson(res, 415, { error:"Unsupported daily-update content type." });
    return;
  }
  if (contentLength > maxDailyUpdateBytes) {
    sendJson(res, 413, { error:"Daily update is larger than the configured compact-upload limit." });
    return;
  }
  try {
    const buffer = await readBodyBuffer(req, maxDailyUpdateBytes, "Daily update is larger than the configured compact-upload limit.");
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    const batchId = safeBatchId(req.headers["x-byou-batch-id"]) || `daily-${hash.slice(0, 24)}`;
    let existing = null;
    try { existing = await readDailyUpdateJob(batchId); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (existing) {
      if (existing.hash !== hash) {
        sendJson(res, 409, { error:"The batch ID is already associated with a different daily update.", code:"DAILY_UPDATE_BATCH_COLLISION" });
        return;
      }
      if (existing.status === "failed" && Object.keys(dailyUpdateMergeOptions(batchId, hash)).length) {
        await mkdir(dailyUpdateJobDir, { recursive:true });
        const paths = dailyUpdateJobPaths(batchId);
        const tempWorkbook = `${paths.workbook}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(tempWorkbook, buffer);
        await replaceFileWithRetry(tempWorkbook, paths.workbook);
        const retried = await saveDailyUpdateJob({
          ...existing,
          filename,
          status:"accepted",
          acceptedAt:new Date().toISOString(),
          startedAt:"",
          finishedAt:"",
          publishedAt:"",
          error:"",
          code:"",
          result:{},
          alreadyApplied:false,
        });
        enqueueDailyUpdateJob(batchId);
        sendDailyUpdateJob(res, retried);
        return;
      }
      if (["accepted", "processing"].includes(existing.status)) enqueueDailyUpdateJob(batchId);
      sendDailyUpdateJob(res, existing, { alreadyApplied:existing.status === "verified" });
      return;
    }
    await mkdir(dailyUpdateJobDir, { recursive:true });
    const paths = dailyUpdateJobPaths(batchId);
    const tempWorkbook = `${paths.workbook}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempWorkbook, buffer);
    await replaceFileWithRetry(tempWorkbook, paths.workbook);
    const acceptedAt = new Date().toISOString();
    const job = await saveDailyUpdateJob({
      schema:"byou-daily-update-job-v1",
      batchId,
      hash,
      filename,
      status:"accepted",
      acceptedAt,
      startedAt:"",
      finishedAt:"",
      publishedAt:"",
      result:{},
      alreadyApplied:false,
    });
    enqueueDailyUpdateJob(batchId);
    sendDailyUpdateJob(res, job);
  } catch (error) {
    const status = error?.code === "ENOENT" ? 404 : error.status || 500;
    sendJson(res, status, { error:error.message || "Could not apply the daily update.", code:error.code || "DAILY_UPDATE_FAILED" });
  }
}

async function handleGetDailyUpdateStatus(req, res, reqUrl) {
  if (!adminToken) {
    sendJson(res, 500, { error:"BYOU_ADMIN_TOKEN is not configured on the server, so daily publishing is disabled." });
    return;
  }
  if (!adminAuthorized(req)) {
    sendJson(res, 401, { error:"Admin token required." });
    return;
  }
  try {
    const batchIdValue = reqUrl?.searchParams?.get("batchId") || "";
    if (batchIdValue) {
      const batchId = safeBatchId(batchIdValue);
      if (!batchId) {
        sendJson(res, 400, { error:"Invalid daily-update batch ID." });
        return;
      }
      try {
        const job = await readDailyUpdateJob(batchId);
        sendJson(res, 200, { ok:true, ...publicDailyUpdateJob(job) });
      } catch (error) {
        sendJson(res, error?.code === "ENOENT" ? 404 : 500, { error:error?.code === "ENOENT" ? "Daily-update batch was not found." : "Could not read daily-update job status." });
      }
      return;
    }
    const current = await readActiveDataset();
    const latest = dailyUpdateHistory(current).at(-1) || null;
    const acceptedRelease = current?.workbookSales?.meta?.acceptedSalesRelease;
    sendJson(res, 200, {
      ok:true,
      publishedAt:current.publishedAt || "",
      dataThrough:[latest?.dataThrough, current?.workbookSales?.meta?.end].filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value || "")).sort().at(-1) || "",
      acceptedSalesRelease:acceptedRelease ? {
        batchId:acceptedRelease.masterLineage?.batchId || "",
        publishedAt:acceptedRelease.publishedAt || "",
        dataThrough:acceptedRelease.masterLineage?.dataThrough || "",
        correctionCount:acceptedRelease.correctionCount || 0,
      } : null,
      latestDailyUpdate:latest ? {
        batchId:latest.batchId || "",
        publishedAt:latest.publishedAt || "",
        dataThrough:latest.dataThrough || "",
        result:latest.result || {},
      } : null,
      dataset:summarizeDataset(current, 0),
    });
  } catch (error) {
    sendJson(res, error?.code === "ENOENT" ? 404 : 500, { error:error.message || "Could not read daily-update status." });
  }
}

async function handlePostCorrection(req, res) {
  if (!adminToken) return sendJson(res, 500, { error:"BYOU_ADMIN_TOKEN is not configured on the server, so correction publishing is disabled." });
  if (!adminAuthorized(req)) return sendJson(res, 401, { error:"Admin token required." });
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) return sendJson(res, 415, { error:"Correction requests must be JSON." });
  try {
    const body = JSON.parse(await readBody(req));
    const batchId = safeBatchId(body?.correctionId);
    const payload = correctionPayload(body);
    if (!batchId || !payload) return sendJson(res, 422, { error:"A correction ID and a valid immutable-key correction payload are required.", code:"CORRECTION_INVALID" });
    const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    let existing = null;
    try { existing = await readDailyUpdateJob(batchId); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (existing) {
      if (existing.kind !== "correction" || existing.hash !== hash) return sendJson(res, 409, { error:"The correction ID is already associated with a different request.", code:"CORRECTION_ID_COLLISION" });
      if (["accepted", "processing"].includes(existing.status)) enqueueDailyUpdateJob(batchId);
      return sendDailyUpdateJob(res, existing, { alreadyApplied:existing.status === "verified" });
    }
    const job = await saveDailyUpdateJob({
      schema:"byou-correction-job-v1",
      kind:"correction",
      batchId,
      hash,
      ...payload,
      status:"accepted",
      acceptedAt:new Date().toISOString(),
      startedAt:"",
      finishedAt:"",
      publishedAt:"",
      result:{},
      alreadyApplied:false,
    });
    enqueueDailyUpdateJob(batchId);
    return sendDailyUpdateJob(res, job);
  } catch (error) {
    return sendJson(res, error?.status || 400, { error:error?.message || "Could not accept the correction.", code:error?.code || "CORRECTION_INVALID" });
  }
}

async function handleGetCorrectionStatus(req, res, reqUrl) {
  if (!adminToken) return sendJson(res, 500, { error:"BYOU_ADMIN_TOKEN is not configured on the server, so correction publishing is disabled." });
  if (!adminAuthorized(req)) return sendJson(res, 401, { error:"Admin token required." });
  const batchId = safeBatchId(reqUrl?.searchParams?.get("correctionId") || "");
  if (!batchId) return sendJson(res, 400, { error:"Invalid correction ID." });
  try {
    const job = await readDailyUpdateJob(batchId);
    if (job?.kind !== "correction") return sendJson(res, 404, { error:"Correction job was not found." });
    return sendJson(res, 200, { ok:true, ...publicDailyUpdateJob(job) });
  } catch (error) {
    return sendJson(res, error?.code === "ENOENT" ? 404 : 500, { error:error?.code === "ENOENT" ? "Correction job was not found." : "Could not read correction job status." });
  }
}
function safeUploadId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{6,78}[a-zA-Z0-9]$/.test(id) ? id : "";
}

async function partFileBytes(dir, partFiles) {
  const sizes = await Promise.all(partFiles.map(async name => {
    const info = await stat(path.join(dir, name));
    return info.isFile() ? info.size : 0;
  }));
  return sizes.reduce((sum, size) => sum + size, 0);
}

async function handlePostDatasetChunk(req, res) {
  if (!adminToken) {
    sendJson(res, 500, { error:"BYOU_ADMIN_TOKEN is not configured on the server, so publishing is disabled." });
    return;
  }
  if (!adminAuthorized(req)) {
    sendJson(res, 401, { error:"Admin token required." });
    return;
  }
  const uploadId = safeUploadId(req.headers["x-upload-id"]);
  const chunkIndex = Number(req.headers["x-chunk-index"]);
  const chunkTotal = Number(req.headers["x-chunk-total"]);
  if (!uploadId || !Number.isInteger(chunkIndex) || !Number.isInteger(chunkTotal) || chunkIndex < 0 || chunkTotal < 1 || chunkIndex >= chunkTotal || chunkTotal > 500) {
    sendJson(res, 400, { error:"Invalid dataset upload chunk metadata." });
    return;
  }
  const dir = path.join(uploadDir, uploadId);
  let lock;
  try {
    await mkdir(dir, { recursive:true });
    try { lock = await open(path.join(dir, "active.lock"), "wx"); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      return sendJson(res, 409, { error:"Another chunk is active for this upload. Retry with a new upload ID if the previous upload was interrupted.", code:"UPLOAD_BUSY" });
    }
    const encoding = String(req.headers["x-dataset-encoding"] || "").toLowerCase();
    const metadata = JSON.stringify({ total:chunkTotal, encoding, expectations:Object.fromEntries(Object.entries(req.headers).filter(([key]) => key.startsWith("x-byou-expected-") || key === "x-byou-publication-job-id").sort(([a],[b]) => a.localeCompare(b))) });
    const metadataPath = path.join(dir, "metadata.json");
    try { await writeFile(metadataPath, metadata, { flag:"wx" }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await readFile(metadataPath, "utf8") !== metadata) throw Object.assign(new Error("Upload metadata changed. Start a new upload."), { status:409 });
    }
    const partPath = path.join(dir, `${String(chunkIndex).padStart(6, "0")}.part`);
    const incomingPath = path.join(dir, "incoming.part-tmp");
    await streamUploadToFile(req, incomingPath, { limit:maxBodyBytes });
    const existing = await stat(partPath).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
    if (existing) {
      const [before, after] = await Promise.all([inspectJsonPublicationFile(partPath), inspectJsonPublicationFile(incomingPath)]);
      if (before.sha256 !== after.sha256) throw Object.assign(new Error("A chunk with different content already exists. Start a new upload."), { status:409 });
      await rm(incomingPath);
    } else await rename(incomingPath, partPath);
    const partFiles = (await readdir(dir)).filter(name => name.endsWith(".part"));
    const encodedBytes = await partFileBytes(dir, partFiles);
    if (encodedBytes > maxBodyBytes) throw datasetLimitError();
    if (partFiles.length < chunkTotal) {
      sendJson(res, 200, { ok:true, complete:false, received:partFiles.length, total:chunkTotal });
      return;
    }
    const parts = Array.from({ length:chunkTotal }, (_, i) => path.join(dir, `${String(i).padStart(6, "0")}.part`));
    const payloadPath = path.join(dir, "payload.json");
    await streamUploadToFile(streamUploadParts(parts), payloadPath, { limit:maxBodyBytes, encoding });
    const job = await acceptFullPublication(await readFile(payloadPath, "utf8"), req);
    await lock.close();
    lock = null;
    await rm(dir, { recursive:true, force:true });
    const publicJob = publicFullPublicationJob(job);
    const pending = ["accepted", "processing"].includes(publicJob.status);
    sendJson(res, pending ? 202 : 200, {
      ok:true,
      complete:true,
      accepted:pending,
      ...publicJob,
      statusUrl:`/api/dataset/publish/status?jobId=${encodeURIComponent(publicJob.jobId)}`,
    });
  } catch (error) {
    await lock?.close().catch(() => {});
    lock = null;
    try { await rm(dir, { recursive:true, force:true }); } catch {}
    sendJson(res, error.status || 500, { error:error.message || "Could not publish dataset chunk.", code:error.code || "DATASET_PUBLISH_FAILED" });
  } finally {
    if (lock) {
      await lock.close().catch(() => {});
      await rm(path.join(dir, "active.lock"), { force:true }).catch(() => {});
    }
  }
}

async function pnlRequestIdentity(req) {
  const verified = await verifiedSupabaseIdentity(req);
  if (verified) return verified;
  const legacy = await currentSession(req);
  if (!legacy.authenticated) return null;
  return { authenticated:true, provider:"legacy", ...pnlPermissionsForEmail("") };
}

async function handleGetPnlView(req, res, reqUrl) {
  const identity = await pnlRequestIdentity(req);
  if (!identity?.canView) return sendJson(res, 401, { error:"Login required." });
  try {
    const view = await getPnlView({
      asOf:reqUrl.searchParams.get("asOf") || "",
      pid:reqUrl.searchParams.get("pid") || "",
      cid:reqUrl.searchParams.get("cid") || "",
      permissions:identity,
    });
    return sendJson(res, 200, view);
  } catch (error) {
    return sendJson(res, error.statusCode || 500, { error:error.message || "Could not load campaign P&L." });
  }
}

async function handlePostPnlImport(req, res, reqUrl) {
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) return sendJson(res, 415, { error:"P&L imports must use JSON." });
  if (!sameOriginMutation(req)) return sendJson(res, 403, { error:"P&L imports require a same-origin request." });
  const identity = await pnlRequestIdentity(req);
  if (!identity) return sendJson(res, 401, { error:"Supabase sign-in required." });
  if (!identity.canEdit) return sendJson(res, 403, { error:"This account cannot import financial data." });
  try {
    const payload = JSON.parse(await readBody(req, maxPnlImportBytes, "Normalized P&L import is larger than the configured limit."));
    const validation = validatePnlImportEnvelope(payload);
    if (!validation.valid) return sendJson(res, 422, { error:"P&L import validation failed.", ...validation });
    const dryRun = String(reqUrl.searchParams.get("dryRun") || "true").toLowerCase() !== "false";
    if (dryRun) {
      const preview = createPnlPreviewReceipt({ normalized:validation.normalized, email:identity.email, secret:sessionSecret });
      return sendJson(res, 200, { ok:true, dryRun:true, ...validation, previewReceipt:preview.token, previewExpiresAt:new Date(preview.expiresAt).toISOString() });
    }
    if (!verifyPnlPreviewReceipt({ token:payload.previewReceipt, normalized:validation.normalized, email:identity.email, secret:sessionSecret })) {
      return sendJson(res, 409, { error:"This import no longer matches its validated preview. Preview the exact payload again before confirming.", code:"PNL_PREVIEW_REQUIRED" });
    }
    const result = await savePnlImport(validation.normalized, identity.email);
    return sendJson(res, 200, { ...result, dryRun:false });
  } catch (error) {
    return sendJson(res, error.statusCode || 400, {
      error:error.message || "Could not import P&L data.",
      code:error.code || "PNL_IMPORT_FAILED",
      details:error.details,
    });
  }
}

async function handlePostPnlOverride(req, res) {
  if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) return sendJson(res, 415, { error:"P&L overrides must use JSON." });
  if (!sameOriginMutation(req)) return sendJson(res, 403, { error:"P&L overrides require a same-origin request." });
  const identity = await pnlRequestIdentity(req);
  if (!identity) return sendJson(res, 401, { error:"Supabase sign-in required." });
  if (!identity.canEdit) return sendJson(res, 403, { error:"This account cannot change financial overrides." });
  try {
    const payload = JSON.parse(await readBody(req));
    return sendJson(res, 200, await savePnlOverride(payload, identity.email));
  } catch (error) {
    return sendJson(res, error.statusCode || 400, {
      error:error.message || "Could not record the P&L override.",
      code:error.code || "PNL_OVERRIDE_FAILED",
      details:error.details,
    });
  }
}

async function serveStatic(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (benchmarkColdPage(reqUrl)) res.setHeader("referrer-policy","same-origin");
  let pathname = "";
  try {
    pathname = decodeURIComponent(reqUrl.pathname);
  } catch {
    sendJson(res, 400, { error:"Invalid request path." });
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const candidate = path.normalize(path.join(distDir, pathname));
  const relative = path.relative(distDir, candidate);
  const safe = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  const filePath = safe && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
    ? candidate
    : path.join(distDir, "index.html");
  try {
    const ext = path.extname(filePath).toLowerCase();
    const info = await stat(filePath);
    const isIndex = filePath.endsWith("index.html");
    // Vite hashes /assets/* filenames, so those are safely immutable. Files under /data/ and at the
    // root keep stable names and change between builds, so browsers must revalidate them.
    const hashedAsset = path.relative(distDir, filePath).replace(/\\/g, "/").startsWith("assets/");
    // Weak validator: the same file may be delivered gzipped or raw depending on the client.
    const etag = `W/${datasetEtag(info)}`;
    const baseHeaders = {
      "content-type":mimeTypes[ext] || "application/octet-stream",
      "cache-control":isIndex ? "no-store" : hashedAsset ? "public, max-age=31536000, immutable" : "public, no-cache",
      ...(isIndex ? {} : { etag, "last-modified":info.mtime.toUTCString() }),
      vary:"accept-encoding",
    };
    if (!isIndex && requestHasCurrentDataset(req, info, etag)) {
      res.writeHead(304, baseHeaders);
      res.end();
      return;
    }
    const body = await readFile(filePath);
    const acceptsGzip = /(?:^|,)\s*gzip(?:\s*;|\s*,|\s*$)/i.test(String(req.headers["accept-encoding"] || ""));
    let responseBody = body;
    let encodingHeaders = {};
    if (acceptsGzip && compressibleExtensions.has(ext) && body.length >= 1024) {
      const cacheKey = `${filePath}|${info.size}|${Math.trunc(info.mtimeMs)}`;
      let compressed = staticGzipCache.get(cacheKey);
      if (!compressed) {
        compressed = await new Promise(resolve => zlib.gzip(body, { level:6 }, (error, output) => resolve(error ? null : output)));
        if (compressed) {
          if (staticGzipCache.size >= STATIC_GZIP_CACHE_MAX) staticGzipCache.delete(staticGzipCache.keys().next().value);
          staticGzipCache.set(cacheKey, compressed);
        }
      }
      if (compressed) {
        responseBody = compressed;
        encodingHeaders = { "content-encoding":"gzip" };
      }
    }
    res.writeHead(200, {
      ...baseHeaders,
      ...encodingHeaders,
      "content-length":responseBody.length,
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(responseBody);
  } catch {
    sendJson(res, 404, { error:"Build output not found. Run npm run build first." });
  }
}

// Any handler that throws outside its own try/catch must become a safe 500, never an
// unhandled rejection that could take down the process mid-publication.
const server = http.createServer((req, res) => {
 if(!['127.0.0.1:4293','localhost:4293'].includes(req.headers.host)){res.writeHead(403);res.end('Local sample host required');return;}
 if(!['GET','HEAD'].includes(req.method)||String(req.url).startsWith('/api/internal')){res.writeHead(403);res.end('Imports and production operations are disabled in this sample');return;}

  dispatchRequest(req, res).catch(error => {
    console.error("[BYOU Intel] Unhandled request error:", error?.stack || error?.message || error);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const authUnavailable = error.code === "AUTH_STATE_UNAVAILABLE";
    try { sendJson(res, authUnavailable ? 503 : 500, { error:authUnavailable ? error.message : "The server could not complete this request.", code:authUnavailable ? error.code : "INTERNAL_ERROR" }); } catch { res.destroy(); }
  });
});

// Observe fatal exceptions without overriding Node's default fail-fast behavior.
// Continuing after an uncaught exception can leave process state corrupted; Railway
// can restart the service and the publication jobs are designed to recover safely.
process.on("uncaughtExceptionMonitor", (error, origin) => {
  console.error(`[BYOU Intel] Fatal ${origin || "uncaught exception"}:`, error?.stack || error?.message || error);
});

async function dispatchRequest(req, res) {
  applySecurityHeaders(res);
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (reqUrl.pathname === "/api/session" && req.method === "GET") return handleGetSession(req, res);
  if (reqUrl.pathname === "/api/competitors/import" && req.method === "POST") {
    if (!adminAuthorized(req) || !originAllowedIfPresent(req)) return sendJson(res, 401, { error:"Administrator token required." });
    try {
      const payload = JSON.parse(await readBody(req, 20 * 1024 * 1024));
      const { marketStores } = await loadAnalysisReferenceData();
      return sendJson(res, 200, await competitorStore.publish(payload, marketStores));
    } catch (error) { return sendJson(res, error.status || 400, { error:error.message }); }
  }
  if (reqUrl.pathname === "/api/competitors/status" && req.method === "GET") {
    if (!adminAuthorized(req) && !internalReadAuthorized(req)) return sendJson(res, 401, { error:"Read token required." });
    const snapshots = await competitorStore.snapshots();
    const latest = snapshots.sort((a,b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))[0];
    return sendJson(res, 200, latest ? { id:latest.id, completedAt:latest.completedAt, sha256:competitorHash(JSON.stringify(latest)), coverage:latest.coverage } : { id:null });
  }
  if (reqUrl.pathname === "/api/competitors" && req.method === "GET") {
    if (!(await requireUserAuth(req, res))) return;
    const warehouseNo = reqUrl.searchParams.get('warehouseNo') || '';
    if (!/^\d{1,5}$/.test(warehouseNo)) return sendJson(res, 400, { error:"Exact warehouse number required." });
    try {
      const days = reqUrl.searchParams.get('days') || '90';
      if (!['30','90','0'].includes(days)) return sendJson(res, 400, { error:"Invalid history window." });
      const result = competitorView(await competitorStore.snapshots(), { warehouseNo, pids:(reqUrl.searchParams.get('pids') || '').split(',').filter(Boolean), asOf:reqUrl.searchParams.get('asOf') || '', itemId:reqUrl.searchParams.get('itemId') || '', days:Number(days) });
      res.setHeader('Cache-Control', 'no-store');
      return sendJson(res, 200, result);
    } catch (error) { return sendJson(res, error.status || 503, { error:error.status ? error.message : 'Competitor research is temporarily unavailable.' }); }
  }
  if (reqUrl.pathname === "/api/login" && req.method === "POST") return handlePostLogin(req, res);
  if (reqUrl.pathname === "/api/logout" && req.method === "POST") return handlePostLogout(req, res);
  if (reqUrl.pathname === "/api/pnl/view" && req.method === "GET") return handleGetPnlView(req, res, reqUrl);
  if (reqUrl.pathname === "/api/pnl/imports" && req.method === "POST") return handlePostPnlImport(req, res, reqUrl);
  if (reqUrl.pathname === "/api/pnl/overrides" && req.method === "POST") return handlePostPnlOverride(req, res);
  if (reqUrl.pathname === "/api/internal/dataset" && req.method === "GET") {
    if (!internalReadAuthorized(req)) return sendJson(res, 401, { error:"Read token required." });
    return handleGetDataset(req, res);
  }
  if (reqUrl.pathname === "/api/internal/inventory-approvals/migrate-reviewed" && req.method === "POST") {
    return handlePostOwnerReviewedInventoryMigration(req, res);
  }
if ((reqUrl.pathname === "/api/v2/bootstrap" || reqUrl.pathname === "/api/dataset/startup") && req.method === "GET") return (await requireUserAuth(req, res)) && handleGetStartupDataset(req, res);
  if (reqUrl.pathname === "/api/v2/view" && req.method === "GET") return (await requireUserAuth(req, res)) && handleGetRuntimeView(req, res, reqUrl);
  if (reqUrl.pathname === "/api/dataset/details" && req.method === "GET") return (await requireUserAuth(req, res)) && handleGetDataset(req, res);
  if (reqUrl.pathname === "/api/dataset" && req.method === "GET") return (await requireUserAuth(req, res)) && handleGetDataset(req, res);
  if (reqUrl.pathname === "/api/inventory-approvals" && req.method === "GET") return (await requireUserAuth(req, res)) && handleGetInventoryApprovals(req, res);
  if (reqUrl.pathname === "/api/inventory-approvals" && req.method === "POST") return (await requireUserAuth(req, res)) && handlePostInventoryApproval(req, res);
  if (reqUrl.pathname === "/api/inventory-approvals" && req.method === "DELETE") return (await requireUserAuth(req, res)) && handleDeleteInventoryApproval(req, res);
  if (reqUrl.pathname === "/api/dataset" && req.method === "POST") return (await requireUserOrAdminAuth(req, res)) && handlePostDataset(req, res);
  if (reqUrl.pathname === "/api/dataset/chunk" && req.method === "POST") return (await requireUserOrAdminAuth(req, res)) && handlePostDatasetChunk(req, res);
  if (reqUrl.pathname === "/api/dataset/publish/status" && req.method === "GET") return handleGetFullPublicationStatus(req, res, reqUrl);
  if (reqUrl.pathname === "/api/dataset/daily-update/status" && req.method === "GET") return handleGetDailyUpdateStatus(req, res, reqUrl);
  if (reqUrl.pathname === "/api/dataset/daily-update" && req.method === "POST") return (await requireUserOrAdminAuth(req, res)) && handlePostDailyUpdate(req, res);
  if (reqUrl.pathname === "/api/dataset/correction/status" && req.method === "GET") return handleGetCorrectionStatus(req, res, reqUrl);
  if (reqUrl.pathname === "/api/dataset/correction" && req.method === "POST") return (await requireUserOrAdminAuth(req, res)) && handlePostCorrection(req, res);
  if (reqUrl.pathname === "/api/health") {
    if (!adminAuthorized(req)) return sendJson(res, 200, { ok:true });
    return sendJson(res, 200, {
      ok:true,
      buildCommit:buildCommit.slice(0, 12),
      sharedDataset:fs.existsSync(datasetPath),
      startupDataset:fs.existsSync(startupDatasetPath),
      adminPublishEnabled:!!adminToken,
      inventoryApprovalEnabled:!!inventoryApprovalPassword && databaseConfigured(),
      loginEnabled:!!getAccessSettings().configured,
      authMisconfigured:!!getAccessSettings().misconfigured,
      authenticationState:authState.mode,
      database:await databaseHealth(),
      pnlAuthConfigured:pnlAuthConfigured(),
      pnlDatabase:await pnlDatabaseHealth(),
    });
  }
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
  sendJson(res, 405, { error:"Method not allowed." });
}

const ABANDONED_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Chunked publishes that never send their final part would otherwise leave staging
// directories on the Railway volume forever.
async function sweepAbandonedUploads(now = Date.now()) {
  let entries = [];
  try { entries = await readdir(uploadDir, { withFileTypes:true }); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(uploadDir, entry.name);
    try {
      const info = await stat(dir);
      if (now - info.mtimeMs < ABANDONED_UPLOAD_MAX_AGE_MS) continue;
      await rm(dir, { recursive:true, force:true });
      removed += 1;
    } catch {}
  }
  if (removed) console.log(`[BYOU Intel] Removed ${removed} abandoned dataset upload staging director${removed === 1 ? "y" : "ies"}.`);
  return removed;
}

async function sweepExpiredState() {
  await sweepAbandonedUploads().catch(() => {});
  const now = Date.now();
  await authState.sweep().catch(() => console.warn("[BYOU Intel] Authentication-state cleanup unavailable; authentication remains fail-closed."));
  for (const [key, attempt] of inventoryApprovalAttempts) {
    if (!attempt || attempt.resetAt <= now) inventoryApprovalAttempts.delete(key);
  }
}
await sweepExpiredState();
const sweepTimer = setInterval(sweepExpiredState, 10 * 60 * 1000);
sweepTimer.unref?.();

let databaseBackfillPromise = null;
async function backfillDatabaseFromPublishedFile() {
  if (!databaseConfigured()) return;
  if (!databaseBackfillPromise) databaseBackfillPromise = (async () => {
    const existing = await getDatabaseBootstrap();
    if (runtimeBootstrapHasRevenueDoorSummary(existing)) {
      const inventoryWarmed = await warmDatabaseInventoryCompactView();
      if (inventoryWarmed.warmed) console.log(`[BYOU Intel] Warmed the default compact Inventory view in ${inventoryWarmed.elapsedMs} ms.`);
      const analysisWarmed = await warmDatabaseAnalysisCompactView();
      if (analysisWarmed.warmed) console.log(`[BYOU Intel] Warmed ${analysisWarmed.warmed} default compact Analysis views in ${analysisWarmed.elapsedMs} ms.`);
      const warmed = await warmDatabaseCampaignViews();
      if (warmed.warmed) console.log(`[BYOU Intel] Warmed ${warmed.warmed} recent Campaign views in ${warmed.elapsedMs} ms.`);
      return;
    }
    const publication = await readActivePublication();
    const datasetText = await readFile(publication.dataset, "utf8");
    const startupText = await readFile(publication.startup, "utf8");
    const dataset = normalizeDatasetRows(JSON.parse(datasetText));
    const summaries = buildPublishedSummaries(dataset);
    const bootstrap = buildRuntimeBootstrap(dataset, summaries);
    const operation = datasetWriteQueue.then(() => publishDatasetToDatabase(dataset, {
      summaries,
      bootstrap,
      publicationId:publication.manifest?.publicationId || "",
      versionId:publication.manifest?.databaseVersionId || publication.manifest?.publicationId || "",
      datasetSha256:sha256Text(datasetText),
      startupSha256:sha256Text(startupText),
    }));
    datasetWriteQueue = operation.catch(() => {});
    const result = await operation;
    console.log(`[BYOU Intel] Migrated published dataset to PostgreSQL version ${result.versionId}.`);
    const inventoryWarmed = await warmDatabaseInventoryCompactView();
    if (inventoryWarmed.warmed) console.log(`[BYOU Intel] Warmed the default compact Inventory view in ${inventoryWarmed.elapsedMs} ms.`);
    const analysisWarmed = await warmDatabaseAnalysisCompactView();
    if (analysisWarmed.warmed) console.log(`[BYOU Intel] Warmed ${analysisWarmed.warmed} default compact Analysis views in ${analysisWarmed.elapsedMs} ms.`);
    const warmed = await warmDatabaseCampaignViews();
    if (warmed.warmed) console.log(`[BYOU Intel] Warmed ${warmed.warmed} recent Campaign views in ${warmed.elapsedMs} ms.`);
  })().catch(error => {
    databaseBackfillPromise = null;
    console.error("[BYOU Intel] PostgreSQL backfill did not complete:", error.message);
  });
  return databaseBackfillPromise;
}
server.listen(port, "127.0.0.1", () => {
  console.log(`BYOU Intel listening on http://127.0.0.1:${port}`);
  void (async () => {


    await backfillDatabaseFromPublishedFile();
  })().catch(error => console.error("[BYOU Intel] Publication recovery/backfill could not start:", error.message));
  startDailyWarmScheduler({
    time:process.env.BYOU_ANALYSIS_WARM_AT,
    run:() => warmDatabaseAnalysisCompactView(),
  });
});
