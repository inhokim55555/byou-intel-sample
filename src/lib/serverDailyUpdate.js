import readXlsxFile from "read-excel-file/node";
import crypto from "node:crypto";
import { allocateWarehouseIdentity, facilityKeyFor, warehouseIdentityType } from "./warehouseIdentity.js";
import { findStore } from "./storeLookup.js";
import { canonicalWarehouseIsUnique } from "./canonicalWarehouseApproval.js";
import { inventoryApprovalCampaignCoversObservation } from "./manualInventoryApproval.js";
import { OWNER_INVENTORY_SHEET, OWNER_INVENTORY_FIELDS, ownerInventoryDecisionsFromSheet, mergeOwnerInventoryDecisions, normalizeOwnerInventoryDecisions } from "./ownerInventoryDecisions.js";
import { OWNER_SALES_CORRECTION_HEADERS, OWNER_SALES_CORRECTION_SHEET, ownerSalesCorrectionsFromSheet, mergeOwnerSalesCorrections, buildOwnerSalesCorrectionHistory } from "./ownerSalesCorrections.js";

export const DAILY_UPDATE_HEADERS = {
  [OWNER_INVENTORY_SHEET]:OWNER_INVENTORY_FIELDS,
  [OWNER_SALES_CORRECTION_SHEET]:OWNER_SALES_CORRECTION_HEADERS,
  In_Line_Sales_Raw:[
    "Product", "Venue", "Time", "Dollar Sales", "Unit Sales", "Promoted Dollars",
    "Promoted Units", "Refund Dollars", "Refund Units", "Inventory On Hand", "Campaign_ID",
  ],
  Costco_Daily_Totals:[
    "Product", "Time", "Venue", "Number of Warehouses", "Warehouses Selling", "Dollar Sales",
    "Dollar Sales % Change Prior Period", "Unit Sales", "Promoted Dollars", "Promoted Units",
    "Inventory On Hand", "Refund Dollars", "Refund Units", "Campaign_ID",
  ],
  Online_Sales_Raw:[
    "Product", "Date", "Dollar Sales", "Unit Sales", "Promoted Dollars", "Promoted Units",
    "Refund Dollars", "Refund Units", "Inventory On Hand", "Campaign_ID",
  ],
  Products_Master:[
    "Product_ID", "Short Name", "Category", "Brand Color", "Active", "Online/In-Line", "Total Warehouses",
  ],
  Campaigns_Master:[
    "Campaign_ID", "Campaign", "Product_ID", "Start Date", "End Date", "Online/In-Line", "Total Warehouses",
  ],
  Inventory_Approval_Attestations:[
    "Issue ID", "Issue Code", "Product", "Campaign ID", "Grain", "Location",
    "Inventory Date", "Inventory On Hand", "Inventory Status", "Receipt Date",
    "Approval Date", "Expires On",
  ],
  Inventory_Review_Dispositions:[
    "Issue ID", "Issue Code", "Decision", "Product", "Campaign ID", "Grain", "Location",
    "Inventory Date", "Inventory On Hand", "Disposition Date",
  ],
  Master_Lineage:[
    "Schema", "Batch ID", "Approved Master Filename", "Approved Master SHA256",
    "Base Master Filename", "Base Master SHA256", "Data Through",
    "Base Warehouse Rows", "Base Warehouse SHA256", "Approved Warehouse Rows", "Approved Warehouse SHA256",
    "Base Official Total Rows", "Base Official Total SHA256", "Approved Official Total Rows", "Approved Official Total SHA256",
    "Base Online Rows", "Base Online SHA256", "Approved Online Rows", "Approved Online SHA256", "Created At",
  ],
};

const DAILY_UPDATE_SALES_SHEETS = ["In_Line_Sales_Raw", "Costco_Daily_Totals", "Online_Sales_Raw"];
const DAILY_UPDATE_METADATA_SHEETS = ["Products_Master", "Campaigns_Master"];
const DAILY_UPDATE_APPROVAL_SHEET = "Inventory_Approval_Attestations";
const DAILY_UPDATE_DISPOSITION_SHEET = "Inventory_Review_Dispositions";
const DAILY_UPDATE_LINEAGE_SHEET = "Master_Lineage";
const DAILY_UPDATE_REQUIRED_SHEETS = [...DAILY_UPDATE_SALES_SHEETS, ...DAILY_UPDATE_METADATA_SHEETS, DAILY_UPDATE_APPROVAL_SHEET, DAILY_UPDATE_LINEAGE_SHEET];
const DAILY_UPDATE_OPTIONAL_SHEETS = [OWNER_INVENTORY_SHEET, DAILY_UPDATE_DISPOSITION_SHEET, OWNER_SALES_CORRECTION_SHEET];
const DAILY_UPDATE_ALL_SHEETS = [...DAILY_UPDATE_REQUIRED_SHEETS, ...DAILY_UPDATE_OPTIONAL_SHEETS];
const MAX_ROWS_PER_SHEET = 50_000;
const INVENTORY_APPROVAL_CODE_GRAINS = new Map([
  ["physical_inventory_review", "physical_warehouse"],
  ["high_warehouse_inventory", "physical_warehouse"],
  ["online_inventory_replenishment", "online_aggregate"],
  ["online_inventory_review", "online_aggregate"],
]);

function httpError(status, message, code = "DAILY_UPDATE_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function normalizedKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function text(value) {
  return String(value ?? "").trim();
}

function dateKey(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const raw = text(value);
  const iso = raw.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  const us = raw.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/);
  if (iso || us) {
    const year = Number(iso?.[1] || (Number(us[3]) < 100 ? 2000 + Number(us[3]) : us[3]));
    const month = Number(iso?.[2] || us[1]);
    const day = Number(iso?.[3] || us[2]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return "";
  }
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return "";
  const year = parsed.getUTCFullYear();
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function numeric(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  let raw = text(value);
  if (!raw) return 0;
  const negative = /^\(.*\)$/.test(raw);
  raw = raw.replace(/[,$%()]/g, "");
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return negative ? -parsed : parsed;
}

function numericKnown(value) {
  if (typeof value === "number") return Number.isFinite(value);
  let raw = text(value);
  if (!raw) return false;
  raw = raw.replace(/[,$%()]/g, "").trim();
  return raw !== "" && Number.isFinite(Number(raw));
}

function integer(value) {
  return Math.round(numeric(value));
}

function ingestionNumber(row, column, sheetName, { integerOnly = false, required = false } = {}) {
  const raw = row?.[column];
  if (raw === undefined || raw === null || text(raw) === "") {
    if (required) {
      throw httpError(422, `${sheetName} row ${row?.__row || "?"} is missing required numeric value ${column}.`, "DAILY_UPDATE_NUMERIC");
    }
    return { value:0, known:false };
  }
  const value = numeric(raw);
  if (!numericKnown(raw)) {
    throw httpError(422, `${sheetName} row ${row?.__row || "?"} has an invalid numeric value in ${column}.`, "DAILY_UPDATE_NUMERIC");
  }
  if (integerOnly && !Number.isInteger(value)) {
    throw httpError(422, `${sheetName} row ${row?.__row || "?"} has a fractional value in integer field ${column}.`, "DAILY_UPDATE_NUMERIC");
  }
  return { value, known:true };
}

function lineageNumber(value) {
  const parsed = numeric(value);
  if (Math.abs(parsed) < 0.00000000005) return "0";
  const rendered = parsed.toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
  return rendered === "-0" ? "0" : rendered;
}

function lineageDigest(lines) {
  return crypto.createHash("sha256").update([...lines].sort().join("\n"), "utf8").digest("hex");
}

function lineageSummary(lines) {
  return { rows:lines.length, sha256:lineageDigest(lines) };
}

export function datasetLineageSummary(dataset = {}) {
  const warehouseNames = new Map((dataset.whs || []).map(row => [text(row?.id), text(row?.name || row?.id)]));
  const warehouse = (dataset.prodSales || []).map(row => JSON.stringify([
    normalizedKey(row?.pid),
    normalizedKey(warehouseNames.get(text(row?.wid)) || row?.wid),
    dateKey(row?.date),
    normalizedKey(row?.cid),
    lineageNumber(row?.rev),
    lineageNumber(row?.units),
    lineageNumber(row?.promo),
    lineageNumber(row?.refund),
    lineageNumber(row?.inv),
    inventoryBalanceKnown(row),
  ]));
  const totals = rows => (rows || []).map(row => {
    const activeDoorsKnown = Object.prototype.hasOwnProperty.call(row || {}, "activeDoorsKnown")
      ? row?.activeDoorsKnown === true
      : numericKnown(row?.activeDoors);
    return JSON.stringify([
      normalizedKey(row?.pid),
      dateKey(row?.date),
      normalizedKey(row?.cid),
      lineageNumber(row?.rev),
      lineageNumber(row?.units),
      lineageNumber(row?.promo),
      lineageNumber(row?.promoUnits),
      lineageNumber(row?.refund),
      lineageNumber(row?.refundUnits),
      lineageNumber(row?.inv),
      inventoryBalanceKnown(row),
      lineageNumber(row?.activeDoors),
      activeDoorsKnown,
    ]);
  });
  return {
    warehouse:lineageSummary(warehouse),
    official:lineageSummary(totals(dataset.inlineTotalSales)),
    online:lineageSummary(totals(dataset.onlineSales)),
  };
}

function requireLineageInteger(row, field) {
  const value = Number(row[field]);
  if (!Number.isInteger(value) || value < 0) {
    throw httpError(422, `Master_Lineage has an invalid ${field}.`, "DAILY_UPDATE_MASTER_LINEAGE");
  }
  return value;
}

function requireLineageHash(row, field) {
  const value = text(row[field]).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw httpError(422, `Master_Lineage has an invalid ${field}.`, "DAILY_UPDATE_MASTER_LINEAGE");
  }
  return value;
}

export function parseMasterLineage(sheets = {}) {
  const rows = sheets[DAILY_UPDATE_LINEAGE_SHEET] || [];
  if (rows.length !== 1) {
    throw httpError(422, "Master_Lineage must contain exactly one approved-master record.", "DAILY_UPDATE_MASTER_LINEAGE");
  }
  const row = rows[0];
  if (text(row.Schema) !== "byou-master-lineage-v1") {
    throw httpError(422, "Master_Lineage schema is not supported.", "DAILY_UPDATE_MASTER_LINEAGE");
  }
  const approvedMasterFilename = text(row["Approved Master Filename"]);
  const baseMasterFilename = text(row["Base Master Filename"]);
  const dataThrough = dateKey(row["Data Through"]);
  if (!approvedMasterFilename.startsWith("BYOU INTEL MASTER") || !approvedMasterFilename.toLowerCase().endsWith(".xlsx") ||
      !baseMasterFilename.startsWith("BYOU INTEL MASTER") || !baseMasterFilename.toLowerCase().endsWith(".xlsx") || !dataThrough) {
    throw httpError(422, "Master_Lineage has an invalid master filename or data-through date.", "DAILY_UPDATE_MASTER_LINEAGE");
  }
  return {
    schema:text(row.Schema),
    batchId:text(row["Batch ID"]),
    approvedMasterFilename,
    approvedMasterSha256:requireLineageHash(row, "Approved Master SHA256"),
    baseMasterFilename,
    baseMasterSha256:requireLineageHash(row, "Base Master SHA256"),
    dataThrough,
    base:{
      warehouse:{ rows:requireLineageInteger(row, "Base Warehouse Rows"), sha256:requireLineageHash(row, "Base Warehouse SHA256") },
      official:{ rows:requireLineageInteger(row, "Base Official Total Rows"), sha256:requireLineageHash(row, "Base Official Total SHA256") },
      online:{ rows:requireLineageInteger(row, "Base Online Rows"), sha256:requireLineageHash(row, "Base Online SHA256") },
    },
    approved:{
      warehouse:{ rows:requireLineageInteger(row, "Approved Warehouse Rows"), sha256:requireLineageHash(row, "Approved Warehouse SHA256") },
      official:{ rows:requireLineageInteger(row, "Approved Official Total Rows"), sha256:requireLineageHash(row, "Approved Official Total SHA256") },
      online:{ rows:requireLineageInteger(row, "Approved Online Rows"), sha256:requireLineageHash(row, "Approved Online SHA256") },
    },
    createdAt:text(row["Created At"]),
  };
}

function assertLineageSummary(actual, expected, code, label) {
  for (const lane of ["warehouse", "official", "online"]) {
    if (actual[lane].rows !== expected[lane].rows || actual[lane].sha256 !== expected[lane].sha256) {
      throw httpError(409, `${label} ${lane} history does not match the approved master lineage. Rebuild the shared dataset from the approved master before applying another compact update.`, code);
    }
  }
}

function lineageSummaryMatches(actual, expected) {
  return ["warehouse", "official", "online"].every(lane =>
    actual[lane].rows === expected[lane].rows && actual[lane].sha256 === expected[lane].sha256);
}

export function verifyDailyUpdateMasterLineage(current, merged, sheets, batchId) {
  const lineage = parseMasterLineage(sheets);
  if (!lineage.batchId || lineage.batchId !== batchId) {
    throw httpError(409, "Master_Lineage batch ID does not match the durable publish job.", "DAILY_UPDATE_MASTER_LINEAGE");
  }
  const currentSummary = datasetLineageSummary(current);
  const currentAlreadyMatchesApproved = lineageSummaryMatches(currentSummary, lineage.approved);
  if (!currentAlreadyMatchesApproved) {
    assertLineageSummary(
      currentSummary,
      lineage.base,
      "DAILY_UPDATE_MASTER_BASE_MISMATCH",
      "Current shared",
    );
  }
  assertLineageSummary(
    datasetLineageSummary(merged.dataset),
    lineage.approved,
    "DAILY_UPDATE_MASTER_RESULT_MISMATCH",
    "Merged shared",
  );
  if (merged.result.dataThrough !== lineage.dataThrough) {
    throw httpError(409, "Compact update coverage does not match the approved master data-through date.", "DAILY_UPDATE_MASTER_RESULT_MISMATCH");
  }
  return {
    verified:true,
    schema:lineage.schema,
    batchId:lineage.batchId,
    approvedMasterFilename:lineage.approvedMasterFilename,
    approvedMasterSha256:lineage.approvedMasterSha256,
    baseMasterFilename:lineage.baseMasterFilename,
    baseMasterSha256:lineage.baseMasterSha256,
    dataThrough:lineage.dataThrough,
    approved:lineage.approved,
    currentAlreadyMatchesApproved,
  };
}

function rowsToObjects(sheetName, data) {
  if (!Array.isArray(data) || !data.length) {
    throw httpError(400, `${sheetName} is empty.`);
  }
  const expected = DAILY_UPDATE_HEADERS[sheetName];
  const headers = (data[0] || []).map(text);
  if (headers.length !== expected.length || headers.some((header, index) => header !== expected[index])) {
    throw httpError(400, `${sheetName} headers do not match the approved compact daily-update format.`);
  }
  if (data.length - 1 > MAX_ROWS_PER_SHEET) {
    throw httpError(413, `${sheetName} contains too many rows for a compact daily update.`);
  }
  return data.slice(1).filter(row => (row || []).some(value => text(value) !== "")).map((row, rowIndex) => {
    const object = {};
    headers.forEach((header, index) => { object[header] = row?.[index] ?? ""; });
    object.__row = rowIndex + 2;
    return object;
  });
}

export async function readDailyUpdateWorkbook(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw httpError(400, "Daily update must be an intact .xlsx workbook.");
  }
  let sheets;
  try {
    sheets = await readXlsxFile(buffer);
  } catch {
    throw httpError(400, "Daily update workbook could not be opened.");
  }
  const names = (sheets || []).map(sheet => sheet.sheet);
  const hasApprovedStructure = DAILY_UPDATE_REQUIRED_SHEETS.every(name => names.includes(name));
  if (!hasApprovedStructure || names.some(name => !DAILY_UPDATE_ALL_SHEETS.includes(name))) {
    throw httpError(400, "Daily update workbook must contain the approved sales, metadata, inventory-attestation, optional review-disposition, and master-lineage sheets.");
  }
  return Object.fromEntries(sheets.map(sheet => [sheet.sheet, rowsToObjects(sheet.sheet, sheet.data)]));
}

function uniqueMetadataRows(metadata = {}) {
  const byId = new Map();
  Object.entries(metadata || {}).forEach(([key, value]) => {
    if (!value || typeof value !== "object") return;
    const id = text(value.id || key);
    if (id && !byId.has(id)) byId.set(id, { ...value, id });
  });
  return [...byId.values()];
}

function productResolver(productMeta = {}) {
  const rows = uniqueMetadataRows(productMeta);
  const lookup = new Map();
  const add = (value, row) => {
    const key = normalizedKey(value);
    if (!key) return;
    const matches = lookup.get(key) || new Map();
    matches.set(row.id, row);
    lookup.set(key, matches);
  };
  Object.entries(productMeta || {}).forEach(([key, value]) => {
    if (!value || typeof value !== "object") return;
    const id = text(value.id || key);
    const row = rows.find(candidate => candidate.id === id) || { ...value, id };
    [key, row.id, row.name, row.short, row.product].forEach(candidate => add(candidate, row));
  });
  return value => {
    const matches = lookup.get(normalizedKey(value));
    if (!matches?.size) throw httpError(422, `Unknown product in daily update: ${text(value) || "blank"}.`, "DAILY_UPDATE_PRODUCT");
    if (matches.size !== 1) throw httpError(422, `Ambiguous product in daily update: ${text(value)}.`, "DAILY_UPDATE_PRODUCT");
    return [...matches.values()][0];
  };
}

function warehouseNumber(value) {
  const match = text(value).match(/(?:warehouse|wh|#)?\s*(\d{2,5})\b/i);
  return match?.[1] ? String(Number(match[1])) : "";
}

function repairWarehouseIdCollisions(warehouses = []) {
  const rows = (warehouses || []).map(row => {
    const identityType = warehouseIdentityType(row);
    return {
      ...row,
      identityType,
      ...(identityType === "facility" ? { facilityKey:facilityKeyFor(row) } : {}),
    };
  });
  const groupedById = new Map();
  rows.forEach((row, index) => {
    const id = text(row?.id);
    if (!id) return;
    const group = groupedById.get(id) || [];
    group.push({ row, index });
    groupedById.set(id, group);
  });
  groupedById.forEach(group => {
    if (group.length < 2) return;
    const retail = group.filter(item => item.row.identityType === "retail");
    const keeper = retail[0] || group[0];
    const identityKeyFor = row => {
      const number = [row?.warehouseNo, row?.number, row?.name]
        .map(warehouseNumber).find(Boolean) || "";
      return row.identityType === "facility"
        ? `facility:${row.facilityKey}`
        : `retail:${number || normalizedKey(row.name)}`;
    };
    const usedIdentities = new Set([identityKeyFor(keeper.row)]);
    group.forEach(item => {
      if (item === keeper) return;
      const identityKey = identityKeyFor(item.row);
      if (usedIdentities.has(identityKey)) return;
      const identity = allocateWarehouseIdentity(item.row, rows, null);
      rows[item.index] = { ...item.row, ...identity };
      usedIdentities.add(identityKey);
    });
  });
  return rows;
}

function warehouseResolver(warehouses = []) {
  const rows = repairWarehouseIdCollisions(warehouses);
  const resolve = value => {
    const raw = text(value);
    const key = normalizedKey(raw);
    const number = warehouseNumber(raw);
    const requestedIdentityType = warehouseIdentityType(raw);
    const exactMatches = rows.filter(warehouse =>
      warehouseIdentityType(warehouse) === requestedIdentityType &&
      [warehouse.id, warehouse.name].some(candidate => normalizedKey(candidate) === key));
    const numberMatches = rows.filter(warehouse => {
      if (warehouseIdentityType(warehouse) !== requestedIdentityType) return false;
      const warehouseNumbers = [warehouse.warehouseNo, warehouse.number, warehouse.name]
        .map(warehouseNumber).filter(Boolean);
      return number && warehouseNumbers.includes(number);
    });
    const matches = exactMatches.length
      ? exactMatches
      : requestedIdentityType === "facility"
        ? numberMatches.filter(warehouse => facilityKeyFor(warehouse) === facilityKeyFor(raw))
        : numberMatches;
    const byId = new Map(matches.map(row => [row.id, row]));
    if (!byId.size) {
      if (requestedIdentityType !== "facility" && (!number || !/^warehouse\b/i.test(raw))) {
        throw httpError(422, `Unknown warehouse in daily update: ${raw || "blank"}.`, "DAILY_UPDATE_WAREHOUSE");
      }
      const identity = allocateWarehouseIdentity(raw, rows, null);
      const created = { ...identity, name:raw, warehouseNo:number, city:raw, st:"", region:"Unassigned", lat:39.5, lng:-98.35, base:0 };
      rows.push(created);
      return created;
    }
    if (byId.size !== 1) throw httpError(422, `Ambiguous warehouse in daily update: ${raw}.`, "DAILY_UPDATE_WAREHOUSE");
    return [...byId.values()][0];
  };
  resolve.rows = rows;
  return resolve;
}

function channelAllowed(campaign, expectedChannel) {
  const channel = normalizedKey(campaign.channel || campaign.salesChannel || "inline");
  if (expectedChannel === "online") return channel.includes("online") || channel.includes("both");
  return channel.includes("inline") || channel.includes("both") || channel === "";
}

function campaignResolver(campaignMeta = {}) {
  const rows = uniqueMetadataRows(campaignMeta);
  const byId = new Map(rows.map(row => [text(row.id), row]));
  return (value, product, date, expectedChannel) => {
    const id = text(value);
    if (!id) throw httpError(422, "Campaign_ID is required on every compact daily-update row.", "DAILY_UPDATE_CAMPAIGN");
    const campaign = byId.get(id);
    if (!campaign) throw httpError(422, `Unknown Campaign_ID in daily update: ${id}.`, "DAILY_UPDATE_CAMPAIGN");
    if (campaign.pid && normalizedKey(campaign.pid) !== normalizedKey(product.id)) {
      throw httpError(422, `Campaign_ID ${id} does not belong to ${product.id}.`, "DAILY_UPDATE_CAMPAIGN");
    }
    if ((campaign.start && date < campaign.start) || (campaign.end && date > campaign.end)) {
      throw httpError(422, `Campaign_ID ${id} does not cover ${date}.`, "DAILY_UPDATE_CAMPAIGN");
    }
    if (!channelAllowed(campaign, expectedChannel)) {
      throw httpError(422, `Campaign_ID ${id} is not valid for ${expectedChannel} sales.`, "DAILY_UPDATE_CAMPAIGN");
    }
    return campaign;
  };
}

function normalizedChannel(value) {
  const key = normalizedKey(value);
  if (key === "onlineonly") return "online";
  if (key === "inlineonly") return "inline";
  return key;
}

function activeValue(value) {
  const key = normalizedKey(value);
  return !["no", "false", "inactive", "ended", "complete", "completed", "0"].includes(key);
}

function campaignChannelLabel(value) {
  if (value === "inline") return "In-Line";
  if (value === "both") return "Both";
  return "Online";
}

function campaignChannelCoversReferences(channel, references) {
  const referenceChannels = new Set(references.map(reference => reference.channel));
  if (channel === "both") {
    return referenceChannels.size === 2 && referenceChannels.has("inline") && referenceChannels.has("online");
  }
  return referenceChannels.size === 1 && referenceChannels.has(channel);
}

const OWNER_APPROVED_DAILY_UPDATES = Object.freeze([]);

export function dailyUpdateMergeOptions(batchId, sha256) {
  const approved = OWNER_APPROVED_DAILY_UPDATES.find(entry =>
    text(batchId) === entry.batchId && text(sha256).toLowerCase() === entry.sha256);
  if (!approved) return {};
  return {
    approvedNewCampaignIds:[...approved.approvedNewCampaignIds],
    approvedCampaignMetadataUpdateIds:[...approved.approvedCampaignMetadataUpdateIds],
  };
}

function rowsById(rows, idColumn, label) {
  const byId = new Map();
  for (const row of rows || []) {
    const id = text(row[idColumn]);
    if (!id) throw httpError(422, `${label} contains a blank ${idColumn}.`, "DAILY_UPDATE_METADATA");
    if (byId.has(id)) throw httpError(409, `${label} contains duplicate ${idColumn} ${id}.`, "DAILY_UPDATE_METADATA_COLLISION");
    byId.set(id, row);
  }
  return byId;
}

function incomingReferences(sheets, options = {}) {
  const products = new Map();
  const campaigns = new Map();
  const add = (row, channel, dateColumn, sheetName) => {
    const productRaw = text(row.Product);
    const productKey = normalizedKey(productRaw);
    if (!productKey) throw httpError(422, `${sheetName} row ${row.__row} has a blank Product.`, "DAILY_UPDATE_PRODUCT");
    const product = products.get(productKey) || { raw:productRaw, channels:new Set() };
    product.channels.add(channel);
    products.set(productKey, product);
    const campaignId = text(row.Campaign_ID);
    const date = requireDate(row, dateColumn, sheetName);
    if (!campaignId) {
      if (options.allowUnlabeledHistoricalRows === true && sheetName === "In_Line_Sales_Raw") return;
      throw httpError(422, "Campaign_ID is required on every compact daily-update row.", "DAILY_UPDATE_CAMPAIGN");
    }
    const references = campaigns.get(campaignId) || [];
    references.push({ productRaw, productKey, channel, date });
    campaigns.set(campaignId, references);
  };
  for (const row of sheets.In_Line_Sales_Raw || []) add(row, "inline", "Time", "In_Line_Sales_Raw");
  for (const row of sheets.Costco_Daily_Totals || []) add(row, "inline", "Time", "Costco_Daily_Totals");
  for (const row of sheets.Online_Sales_Raw || []) add(row, "online", "Date", "Online_Sales_Raw");
  return { products, campaigns };
}

function optionalProduct(resolve, value) {
  try {
    return resolve(value);
  } catch (error) {
    if (error?.code === "DAILY_UPDATE_PRODUCT" && /^Unknown product/.test(error.message)) return null;
    throw error;
  }
}

function mergeDailyUpdateMetadata(dataset, sheets, options = {}) {
  const productRows = sheets.Products_Master;
  const campaignRows = sheets.Campaigns_Master;
  if (!productRows && !campaignRows) {
    return { productMeta:dataset.productMeta, campaignMeta:dataset.campaignMeta, productsAdded:0, campaignsAdded:0, campaignsUpdated:0 };
  }
  if (!productRows || !campaignRows) {
    throw httpError(400, "Products_Master and Campaigns_Master must be supplied together.", "DAILY_UPDATE_METADATA");
  }

  const references = incomingReferences(sheets, options);
  const incomingProducts = rowsById(productRows, "Product_ID", "Products_Master");
  const incomingCampaigns = rowsById(campaignRows, "Campaign_ID", "Campaigns_Master");
  const nextProductMeta = { ...(dataset.productMeta || {}) };
  let resolveProduct = productResolver(nextProductMeta);
  const usedProductIds = new Set();
  const correctionProductIds = new Set();
  const correctionCampaignIds = new Set();
  for (const row of sheets[OWNER_SALES_CORRECTION_SHEET] || []) {
    const product = optionalProduct(resolveProduct, row.Product_ID);
    if (product) correctionProductIds.add(product.id);
    let campaignIds;
    try { campaignIds = JSON.parse(text(row.Campaign_IDs)); } catch {
      throw httpError(422, "Owner_Sales_Corrections has invalid Campaign_IDs JSON.", "OWNER_SALES_CORRECTION_INVALID");
    }
    if (!Array.isArray(campaignIds)) {
      throw httpError(422, "Owner_Sales_Corrections Campaign_IDs must be an array.", "OWNER_SALES_CORRECTION_INVALID");
    }
    campaignIds.forEach(id => correctionCampaignIds.add(text(id)));
  }
  let productsAdded = 0;

  for (const reference of references.products.values()) {
    let product = optionalProduct(resolveProduct, reference.raw);
    if (!product) {
      const key = normalizedKey(reference.raw);
      const matches = [...incomingProducts.values()].filter(row =>
        [row.Product_ID, row["Short Name"]].some(value => normalizedKey(value) === key));
      if (matches.length !== 1) {
        throw httpError(422, `Unknown product in daily update: ${reference.raw}.`, "DAILY_UPDATE_PRODUCT");
      }
      const row = matches[0];
      const productId = text(row.Product_ID);
      const channel = normalizedChannel(row["Online/In-Line"]);
      if (reference.channels.size !== 1 || !reference.channels.has("online") || channel !== "online") {
        throw httpError(422, `New product ${productId} may be initialized only as an online-only product.`, "DAILY_UPDATE_METADATA");
      }
      if (!activeValue(row.Active)) {
        throw httpError(422, `New product ${productId} must be active.`, "DAILY_UPDATE_METADATA");
      }
      if (integer(row["Total Warehouses"]) !== 0) {
        throw httpError(422, `Online-only product ${productId} must have Total Warehouses set to 0 or blank.`, "DAILY_UPDATE_METADATA");
      }
      const color = text(row["Brand Color"]);
      if (color && !/^#[0-9a-f]{3,8}$/i.test(color)) {
        throw httpError(422, `New product ${productId} has an invalid Brand Color.`, "DAILY_UPDATE_METADATA");
      }
      nextProductMeta[productId] = {
        id:productId,
        name:productId,
        short:text(row["Short Name"]) || productId,
        category:text(row.Category),
        col:color || "#60A5FA",
        active:true,
        salesChannel:"Online",
        totalWarehouses:0,
      };
      productsAdded += 1;
      resolveProduct = productResolver(nextProductMeta);
      product = resolveProduct(reference.raw);
    }
    usedProductIds.add(product.id);
  }

  for (const row of incomingProducts.values()) {
    const product = optionalProduct(resolveProduct, row.Product_ID);
    if (!product || (!usedProductIds.has(product.id) && !correctionProductIds.has(product.id))) {
      throw httpError(422, `Products_Master contains unreferenced product ${text(row.Product_ID)}.`, "DAILY_UPDATE_METADATA");
    }
  }

  const nextCampaignMeta = { ...(dataset.campaignMeta || {}) };
  const existingCampaigns = new Map(uniqueMetadataRows(nextCampaignMeta).map(row => [text(row.id), row]));
  const approvedNewCampaignIds = new Set(options.approvedNewCampaignIds || []);
  const approvedCampaignMetadataUpdateIds = new Set(options.approvedCampaignMetadataUpdateIds || []);
  let campaignsAdded = 0;
  let campaignsUpdated = 0;
  for (const [campaignId, campaignReferences] of references.campaigns) {
    const existing = existingCampaigns.get(campaignId);
    const incoming = incomingCampaigns.get(campaignId);
    if (existing) {
      if (incoming) {
        const product = resolveProduct(incoming.Product_ID);
        const incomingStart = dateKey(incoming["Start Date"]);
        const incomingEnd = dateKey(incoming["End Date"]);
        const incomingChannel = normalizedChannel(incoming["Online/In-Line"]);
        const existingChannel = normalizedChannel(existing.channel || existing.salesChannel || "inline");
        const identityCollision = (existing.pid && normalizedKey(existing.pid) !== normalizedKey(product.id)) ||
            (incomingStart && existing.start && incomingStart !== existing.start) ||
            ((incomingEnd || existing.end) && incomingEnd !== text(existing.end));
        const channelChanged = incomingChannel && incomingChannel !== existingChannel;
        if (identityCollision || (channelChanged && !approvedCampaignMetadataUpdateIds.has(campaignId))) {
          throw httpError(409, `Campaigns_Master conflicts with existing Campaign_ID ${campaignId}.`, "DAILY_UPDATE_METADATA_COLLISION");
        }
        if (approvedCampaignMetadataUpdateIds.has(campaignId)) {
          if (!campaignChannelCoversReferences(incomingChannel, campaignReferences)) {
            throw httpError(422, `Campaign_ID ${campaignId} channel does not match its supplied sales lanes.`, "DAILY_UPDATE_CAMPAIGN");
          }
          const campaignName = text(incoming.Campaign) || existing.name || campaignId;
          const updated = {
            ...existing,
            id:campaignId,
            name:campaignName,
            short:campaignName,
            pid:product.id,
            product:product.short || product.name || product.id,
            start:incomingStart || existing.start,
            end:incomingEnd,
            channel:campaignChannelLabel(incomingChannel),
            active:activeValue(incoming.Status || incoming.Active),
          };
          if (JSON.stringify(updated) !== JSON.stringify(existing)) campaignsUpdated += 1;
          nextCampaignMeta[campaignId] = updated;
          existingCampaigns.set(campaignId, updated);
        }
      }
      continue;
    }
    if (!incoming) {
      throw httpError(422, `Unknown Campaign_ID in daily update: ${campaignId}.`, "DAILY_UPDATE_CAMPAIGN");
    }
    const product = resolveProduct(incoming.Product_ID);
    if (campaignReferences.some(reference => resolveProduct(reference.productRaw).id !== product.id)) {
      throw httpError(422, `Campaign_ID ${campaignId} does not belong to ${product.id}.`, "DAILY_UPDATE_CAMPAIGN");
    }
    const incomingChannel = normalizedChannel(incoming["Online/In-Line"]);
    const approvedNewCampaign = approvedNewCampaignIds.has(campaignId) &&
      campaignChannelCoversReferences(incomingChannel, campaignReferences);
    const ordinaryOnlineCampaign = incomingChannel === "online" &&
      campaignReferences.every(reference => reference.channel === "online");
    if (!ordinaryOnlineCampaign && !approvedNewCampaign) {
      throw httpError(422, `New Campaign_ID ${campaignId} may be initialized only for online sales.`, "DAILY_UPDATE_METADATA");
    }
    if (!activeValue(incoming.Status || incoming.Active)) {
      throw httpError(422, `New Campaign_ID ${campaignId} must be active.`, "DAILY_UPDATE_METADATA");
    }
    const start = dateKey(incoming["Start Date"]);
    const end = dateKey(incoming["End Date"]);
    if (!start || (end && end < start) || campaignReferences.some(reference => reference.date < start || (end && reference.date > end))) {
      throw httpError(422, `Campaign_ID ${campaignId} does not cover all supplied online dates.`, "DAILY_UPDATE_CAMPAIGN");
    }
    nextCampaignMeta[campaignId] = {
      id:campaignId,
      name:text(incoming.Campaign) || campaignId,
      short:text(incoming.Campaign) || campaignId,
      pid:product.id,
      product:product.short || product.name || product.id,
      start,
      end,
      channel:campaignChannelLabel(incomingChannel),
      active:true,
    };
    existingCampaigns.set(campaignId, nextCampaignMeta[campaignId]);
    campaignsAdded += 1;
  }

  for (const campaignId of incomingCampaigns.keys()) {
    if (!references.campaigns.has(campaignId) &&
        !(correctionCampaignIds.has(campaignId) && existingCampaigns.has(campaignId))) {
      throw httpError(422, `Campaigns_Master contains unreferenced Campaign_ID ${campaignId}.`, "DAILY_UPDATE_METADATA");
    }
  }

  return { productMeta:nextProductMeta, campaignMeta:nextCampaignMeta, productsAdded, campaignsAdded, campaignsUpdated };
}

function requireDate(row, column, sheetName) {
  const value = dateKey(row[column]);
  if (!value) throw httpError(422, `${sheetName} row ${row.__row} has an invalid ${column}.`, "DAILY_UPDATE_DATE");
  return value;
}

function warehouseRows(rows, context, options = {}) {
  return rows.map(row => {
    const date = requireDate(row, "Time", "In_Line_Sales_Raw");
    const product = context.product(row.Product);
    const warehouse = context.warehouse(row.Venue);
    const campaign = !text(row.Campaign_ID) && options.allowUnlabeledHistoricalRows === true
      ? { id:"", short:"", name:"" }
      : context.campaign(row.Campaign_ID, product, date, "inline");
    const revenue = ingestionNumber(row, "Dollar Sales", "In_Line_Sales_Raw", { required:true });
    const units = ingestionNumber(row, "Unit Sales", "In_Line_Sales_Raw", { integerOnly:true, required:true });
    const promoted = ingestionNumber(row, "Promoted Dollars", "In_Line_Sales_Raw");
    const refunds = ingestionNumber(row, "Refund Dollars", "In_Line_Sales_Raw");
    const inventory = ingestionNumber(row, "Inventory On Hand", "In_Line_Sales_Raw", { integerOnly:true });
    return {
      wid:warehouse.id,
      pid:product.id,
      cid:campaign.id,
      product:product.short || product.name || product.id,
      campaign:campaign.short || campaign.name || campaign.id,
      date,
      rev:revenue.value,
      units:units.value,
      promo:promoted.value,
      refund:refunds.value,
      inv:inventory.value,
      invKnown:inventory.known,
      isDemo:false,
    };
  });
}

function totalRow(row, context, channel, dateColumn, sheetName) {
  const date = requireDate(row, dateColumn, sheetName);
  const product = context.product(row.Product);
  const campaign = context.campaign(row.Campaign_ID, product, date, channel.toLowerCase());
  const field = (column, { integerOnly = false, required = false } = {}) => ingestionNumber(row, column, sheetName, { integerOnly, required });
  const revenue = field("Dollar Sales", { required:true });
  const units = field("Unit Sales", { integerOnly:true, required:true });
  const promoted = field("Promoted Dollars");
  const promotedUnits = field("Promoted Units", { integerOnly:true });
  const refunds = field("Refund Dollars");
  const refundUnits = field("Refund Units", { integerOnly:true });
  const inventory = field("Inventory On Hand", { integerOnly:true });
  const doorColumn = text(row["Warehouses Selling"]) !== "" ? "Warehouses Selling" : "Number of Warehouses";
  const activeDoors = field(doorColumn, { integerOnly:true });
  return {
    date,
    pid:product.id,
    cid:campaign.id,
    product:product.short || product.name || product.id,
    campaign:campaign.short || campaign.name || campaign.id,
    channel,
    rev:revenue.value,
    units:units.value,
    promo:promoted.value,
    promoUnits:promotedUnits.value,
    refund:refunds.value,
    refundUnits:refundUnits.value,
    orders:0,
    sessions:0,
    adSpend:0,
    inv:inventory.value,
    inbound:0,
    reserved:0,
    activeDoors:activeDoors.value,
    activeDoorsKnown:activeDoors.known,
    invKnown:inventory.known,
    inboundKnown:false,
    reservedKnown:false,
    notes:"",
    source:"Server daily update",
  };
}

function comparable(row, keys) {
  return keys.map(key => key === "invKnown" ? inventoryBalanceKnown(row) : row?.[key] ?? "");
}

function inventoryBalanceKnown(row = {}) {
  if (Object.prototype.hasOwnProperty.call(row || {}, "invKnown")) return row?.invKnown === true && row?.inv !== "" && row?.inv != null && Number.isFinite(Number(row.inv));
  return Object.prototype.hasOwnProperty.call(row || {}, "inv") && row?.inv !== "" && row?.inv != null && Number.isFinite(Number(row.inv)) && Number(row.inv) > 0;
}

function approvalBusinessKey(row = {}) {
  const locationKey = row.grain === "online_aggregate" ? "online_aggregate" : row.wid || row.location;
  return [row.grain, row.pid, row.cid, locationKey, row.inventoryDate].map(value => text(value).toLowerCase()).join("|");
}

function exactMetadataValue(map = {}, id = "") {
  if (map?.[id] && text(map[id]?.id) === text(id)) return map[id];
  return Object.values(map || {}).find(row => text(row?.id) === text(id)) || null;
}

function onlineAggregateMatchesApproval(facts = [], scope = {}) {
  const matchingFacts = (facts || []).filter(fact => (
    fact?.pid === scope.pid
    && fact?.cid === scope.cid
    && fact?.date === scope.inventoryDate
  ));
  return matchingFacts.length > 0
    && matchingFacts.every(inventoryBalanceKnown)
    && matchingFacts.reduce((sum, fact) => sum + Number(fact.inv || 0), 0) === Number(scope.onHand);
}

function normalizeInventoryApprovals(rows, context, datasetRows, today = dateKey(new Date())) {
  const byIssueId = new Set();
  const byBusinessKey = new Set();
  return (rows || []).map(row => {
    const issueId = text(row["Issue ID"]);
    const issueCode = text(row["Issue Code"]);
    const productText = text(row.Product);
    const campaignText = text(row["Campaign ID"]);
    if (!productText || !campaignText) throw httpError(422, `${DAILY_UPDATE_APPROVAL_SHEET} row ${row.__row} must identify a product and campaign.`, "DAILY_UPDATE_APPROVAL");
    const product = context.product(productText);
    const inventoryDate = requireDate(row, "Inventory Date", DAILY_UPDATE_APPROVAL_SHEET);
    const rawGrain = normalizedKey(row.Grain);
    const grain = rawGrain.includes("online") ? "online_aggregate" : rawGrain.includes("physical") ? "physical_warehouse" : "";
    const requiredGrain = INVENTORY_APPROVAL_CODE_GRAINS.get(issueCode);
    if (!issueId || !requiredGrain || grain !== requiredGrain) throw httpError(422, `${DAILY_UPDATE_APPROVAL_SHEET} row ${row.__row} has an invalid inventory issue code or grain.`, "DAILY_UPDATE_APPROVAL");
    const campaign = context.campaign(campaignText, product, inventoryDate, grain === "online_aggregate" ? "online" : "inline");
    const onHand = integer(row["Inventory On Hand"]);
    if (!numericKnown(row["Inventory On Hand"]) || onHand < 0) throw httpError(422, `${DAILY_UPDATE_APPROVAL_SHEET} row ${row.__row} has invalid inventory.`, "DAILY_UPDATE_APPROVAL");
    const inventoryStatus = text(row["Inventory Status"]);
    if (!["onhand", "receiving", "intransit"].includes(normalizedKey(inventoryStatus))) throw httpError(422, `${DAILY_UPDATE_APPROVAL_SHEET} row ${row.__row} has an invalid inventory status.`, "DAILY_UPDATE_APPROVAL");
    const receiptDate = requireDate(row, "Receipt Date", DAILY_UPDATE_APPROVAL_SHEET);
    const approvalDate = requireDate(row, "Approval Date", DAILY_UPDATE_APPROVAL_SHEET);
    const expiresOn = requireDate(row, "Expires On", DAILY_UPDATE_APPROVAL_SHEET);
    const approvalTime = new Date(`${approvalDate}T00:00:00Z`).getTime();
    const expirationTime = new Date(`${expiresOn}T00:00:00Z`).getTime();
    const receiptTime = new Date(`${receiptDate}T00:00:00Z`).getTime();
    if (approvalDate > today || expiresOn < today || expirationTime < approvalTime || expirationTime - approvalTime > 14 * 864e5) {
      throw httpError(422, `${DAILY_UPDATE_APPROVAL_SHEET} row ${row.__row} is future-dated, expired, or exceeds the 14-day approval policy.`, "DAILY_UPDATE_APPROVAL");
    }
    if (normalizedKey(inventoryStatus) === "onhand"
      && (receiptDate < inventoryDate || receiptDate > approvalDate || approvalTime - receiptTime > 14 * 864e5)) {
      throw httpError(422, `${DAILY_UPDATE_APPROVAL_SHEET} row ${row.__row} needs fresh On hand evidence dated on or after the inventory fact and within 14 days of approval.`, "DAILY_UPDATE_APPROVAL");
    }
    let wid = "";
    const location = grain === "online_aggregate" ? "Online aggregate" : text(row.Location);
    if (grain === "physical_warehouse") {
      if (!location) throw httpError(422, `${DAILY_UPDATE_APPROVAL_SHEET} row ${row.__row} must identify a physical warehouse.`, "DAILY_UPDATE_APPROVAL");
      const warehouse = findStore(location, context.warehouse.rows);
      if (!warehouse) throw httpError(422, `${DAILY_UPDATE_APPROVAL_SHEET} row ${row.__row} names an unknown warehouse.`, "DAILY_UPDATE_APPROVAL");
      wid = warehouse.id;
      const exact = (datasetRows.prodSales || []).find(fact => fact?.wid === wid && fact?.pid === product.id && fact?.cid === campaign.id && fact?.date === inventoryDate && inventoryBalanceKnown(fact) && Number(fact.inv) === onHand);
      if (!exact) throw httpError(422, `${DAILY_UPDATE_APPROVAL_SHEET} row ${row.__row} does not exactly match a warehouse inventory fact.`, "DAILY_UPDATE_APPROVAL_MISMATCH");
    } else {
      const aggregateMatches = onlineAggregateMatchesApproval(datasetRows.onlineSales, {
        pid:product.id,
        cid:campaign.id,
        inventoryDate,
        onHand,
      });
      if (!aggregateMatches) throw httpError(422, `${DAILY_UPDATE_APPROVAL_SHEET} row ${row.__row} does not exactly match the complete online inventory aggregate.`, "DAILY_UPDATE_APPROVAL_MISMATCH");
    }
    const attestation = {
      issueId,
      issueCode,
      approved:true,
      pid:product.id,
      cid:campaign.id,
      grain,
      wid,
      location,
      inventoryDate,
      onHand,
      inventoryStatus,
      receiptDate,
      approvalDate,
      expiresOn,
    };
    const businessKey = approvalBusinessKey(attestation);
    if (byIssueId.has(issueId) || byBusinessKey.has(businessKey)) throw httpError(422, `${DAILY_UPDATE_APPROVAL_SHEET} contains duplicate attestations.`, "DAILY_UPDATE_APPROVAL_DUPLICATE");
    byIssueId.add(issueId);
    byBusinessKey.add(businessKey);
    return attestation;
  });
}

export function validateInventoryApprovalsForDataset(dataset = {}, { today = dateKey(new Date()), canonicalWarehouseDirectory = null } = {}) {
  const byIssueId = new Set();
  const byBusinessKey = new Set();
  const result = [];
  for (const source of dataset.inventoryApprovals || []) {
    if (!source || typeof source !== "object") throw httpError(422, "Published inventory approval is malformed.", "DATASET_APPROVAL");
    const approvalDate = dateKey(source.approvalDate);
    const expiresOn = dateKey(source.expiresOn);
    const inventoryDate = dateKey(source.inventoryDate);
    const receiptDate = dateKey(source.receiptDate);
    if (expiresOn && expiresOn < today) continue;
    const approvalTime = approvalDate ? new Date(`${approvalDate}T00:00:00Z`).getTime() : NaN;
    const expirationTime = expiresOn ? new Date(`${expiresOn}T00:00:00Z`).getTime() : NaN;
    const receiptTime = receiptDate ? new Date(`${receiptDate}T00:00:00Z`).getTime() : NaN;
    const grain = source.grain === "online_aggregate" ? "online_aggregate" : source.grain === "physical_warehouse" ? "physical_warehouse" : "";
    const requiredGrain = INVENTORY_APPROVAL_CODE_GRAINS.get(text(source.issueCode));
    const inventoryStatus = text(source.inventoryStatus);
    if (!text(source.issueId) || !requiredGrain || grain !== requiredGrain || !text(source.pid) || !text(source.cid) || (grain === "physical_warehouse" && !text(source.wid)) || source.approved !== true || !inventoryDate || !numericKnown(source.onHand) || Number(source.onHand) < 0 || !receiptDate || !approvalDate || !expiresOn || approvalDate > today || expirationTime < approvalTime || expirationTime - approvalTime > 14 * 864e5 || !["onhand", "receiving", "intransit"].includes(normalizedKey(inventoryStatus))) {
      throw httpError(422, "Published inventory approval violates the exact-match or 14-day policy.", "DATASET_APPROVAL");
    }
    if (normalizedKey(inventoryStatus) === "onhand"
      && (receiptDate < inventoryDate || receiptDate > approvalDate || approvalTime - receiptTime > 14 * 864e5)) {
      throw httpError(422, "Published On hand inventory approval evidence is stale or predates the source fact.", "DATASET_APPROVAL");
    }
    const normalized = {
      issueId:text(source.issueId),
      issueCode:text(source.issueCode),
      approved:true,
      pid:text(source.pid),
      cid:text(source.cid),
      grain,
      wid:grain === "physical_warehouse" ? text(source.wid) : "",
      location:grain === "online_aggregate" ? "Online aggregate" : text(source.location),
      inventoryDate,
      onHand:integer(source.onHand),
      inventoryStatus,
      receiptDate,
      approvalDate,
      expiresOn,
    };
    const product = exactMetadataValue(dataset.productMeta, normalized.pid);
    const campaign = exactMetadataValue(dataset.campaignMeta, normalized.cid);
    if (!product || !campaign || !inventoryApprovalCampaignCoversObservation(campaign, product, inventoryDate, grain)) {
      throw httpError(422, "Published inventory approval campaign does not cover the exact product, channel, and observation date.", "DATASET_APPROVAL_CAMPAIGN");
    }
    const matchingPhysicalFacts = grain === "physical_warehouse"
      ? (dataset.prodSales || [])
        .filter(fact => fact?.pid === normalized.pid && fact?.cid === normalized.cid && fact?.wid === normalized.wid && inventoryBalanceKnown(fact))
        .sort((a, b) => text(a?.date).localeCompare(text(b?.date)))
      : [];
    const latestPhysicalFact = matchingPhysicalFacts.at(-1);
    const latestPhysicalFacts = latestPhysicalFact
      ? matchingPhysicalFacts.filter(fact => fact?.date === latestPhysicalFact.date)
      : [];
    const exact = grain === "physical_warehouse"
      ? latestPhysicalFact?.date === inventoryDate
        && latestPhysicalFacts.length > 0
        && latestPhysicalFacts.every(fact => Number(fact?.inv) === normalized.onHand)
      : onlineAggregateMatchesApproval(dataset.onlineSales, normalized);
    if (!exact) throw httpError(422, "Published inventory approval does not exactly match the complete inventory fact or online aggregate.", "DATASET_APPROVAL_MISMATCH");
    if (grain === "physical_warehouse" && canonicalWarehouseDirectory) {
      const warehouse = (dataset.whs || []).find(row => text(row?.id) === normalized.wid);
      if (!warehouse || !canonicalWarehouseIsUnique(warehouse, dataset.whs || [], canonicalWarehouseDirectory)) {
        throw httpError(422, "Published inventory approval warehouse is not a unique exact match in the canonical Costco directory.", "DATASET_APPROVAL_WAREHOUSE");
      }
      normalized.location = text(warehouse.name);
    }
    const businessKey = approvalBusinessKey(normalized);
    if (byIssueId.has(normalized.issueId) || byBusinessKey.has(businessKey)) throw httpError(422, "Published inventory approvals contain duplicates.", "DATASET_APPROVAL_DUPLICATE");
    byIssueId.add(normalized.issueId);
    byBusinessKey.add(businessKey);
    result.push(normalized);
  }
  return sorted(result, ["pid", "cid", "grain", "wid", "inventoryDate", "issueId"]);
}

function dispositionBusinessKey(row = {}) {
  const locationKey = row.grain === "online_aggregate" ? "online_aggregate" : row.wid || row.location;
  return [row.grain, row.pid, row.cid, locationKey, row.inventoryDate, row.onHand]
    .map(value => text(value).toLowerCase())
    .join("|");
}

function dispositionScopeKey(row = {}) {
  const locationKey = row.grain === "online_aggregate" ? "online_aggregate" : row.wid || row.location;
  return [row.grain, row.pid, row.cid, locationKey]
    .map(value => text(value).toLowerCase())
    .join("|");
}

function normalizeDispositionDecision(value) {
  const decision = normalizedKey(value);
  if (decision === "approved" || decision === "reviewedquarantined") return "reviewed_quarantined";
  if (decision === "rejected") return "rejected";
  return "";
}

function normalizeInventoryReviewDispositions(rows, context, datasetRows, today = dateKey(new Date())) {
  const byIssueId = new Set();
  const byBusinessKey = new Set();
  const byScopeKey = new Set();
  return (rows || []).map(row => {
    const issueId = text(row["Issue ID"]);
    const issueCode = text(row["Issue Code"]);
    const requiredGrain = INVENTORY_APPROVAL_CODE_GRAINS.get(issueCode);
    const productText = text(row.Product);
    const campaignText = text(row["Campaign ID"]);
    const rawGrain = normalizedKey(row.Grain);
    const grain = rawGrain.includes("online") ? "online_aggregate" : rawGrain.includes("physical") ? "physical_warehouse" : "";
    const decision = normalizeDispositionDecision(row.Decision);
    if (!issueId || !requiredGrain || grain !== requiredGrain || !decision || !productText || !campaignText) {
      throw httpError(422, `${DAILY_UPDATE_DISPOSITION_SHEET} row ${row.__row} has an invalid issue identity, decision, or grain.`, "DAILY_UPDATE_DISPOSITION");
    }
    const product = context.product(productText);
    const inventoryDate = requireDate(row, "Inventory Date", DAILY_UPDATE_DISPOSITION_SHEET);
    const campaign = context.campaign(campaignText, product, inventoryDate, grain === "online_aggregate" ? "online" : "inline");
    const onHand = integer(row["Inventory On Hand"]);
    if (!numericKnown(row["Inventory On Hand"]) || onHand < 0) {
      throw httpError(422, `${DAILY_UPDATE_DISPOSITION_SHEET} row ${row.__row} has invalid inventory.`, "DAILY_UPDATE_DISPOSITION");
    }
    const dispositionDate = requireDate(row, "Disposition Date", DAILY_UPDATE_DISPOSITION_SHEET);
    if (dispositionDate > today) {
      throw httpError(422, `${DAILY_UPDATE_DISPOSITION_SHEET} row ${row.__row} is future-dated.`, "DAILY_UPDATE_DISPOSITION");
    }
    let wid = "";
    const location = grain === "online_aggregate" ? "Online aggregate" : text(row.Location);
    if (grain === "physical_warehouse") {
      if (!location) throw httpError(422, `${DAILY_UPDATE_DISPOSITION_SHEET} row ${row.__row} must identify a physical warehouse.`, "DAILY_UPDATE_DISPOSITION");
      const warehouse = findStore(location, context.warehouse.rows);
      if (!warehouse) throw httpError(422, `${DAILY_UPDATE_DISPOSITION_SHEET} row ${row.__row} names an unknown warehouse.`, "DAILY_UPDATE_DISPOSITION");
      wid = warehouse.id;
      const exact = (datasetRows.prodSales || []).find(fact => fact?.wid === wid && fact?.pid === product.id && fact?.cid === campaign.id && fact?.date === inventoryDate && inventoryBalanceKnown(fact) && Number(fact.inv) === onHand);
      if (!exact) throw httpError(422, `${DAILY_UPDATE_DISPOSITION_SHEET} row ${row.__row} does not exactly match a warehouse inventory fact.`, "DAILY_UPDATE_DISPOSITION_MISMATCH");
    } else if (!onlineAggregateMatchesApproval(datasetRows.onlineSales, {
      pid:product.id,
      cid:campaign.id,
      inventoryDate,
      onHand,
    })) {
      throw httpError(422, `${DAILY_UPDATE_DISPOSITION_SHEET} row ${row.__row} does not exactly match the complete online inventory aggregate.`, "DAILY_UPDATE_DISPOSITION_MISMATCH");
    }
    const disposition = {
      issueId,
      issueCode,
      decision,
      pid:product.id,
      cid:campaign.id,
      grain,
      wid,
      location,
      inventoryDate,
      onHand,
      dispositionDate,
    };
    const businessKey = dispositionBusinessKey(disposition);
    const scopeKey = dispositionScopeKey(disposition);
    if (byIssueId.has(issueId) || byBusinessKey.has(businessKey) || byScopeKey.has(scopeKey)) {
      throw httpError(422, `${DAILY_UPDATE_DISPOSITION_SHEET} contains duplicate dispositions.`, "DAILY_UPDATE_DISPOSITION_DUPLICATE");
    }
    byIssueId.add(issueId);
    byBusinessKey.add(businessKey);
    byScopeKey.add(scopeKey);
    return disposition;
  });
}

export function validateInventoryReviewDispositionsForDataset(dataset = {}, { today = dateKey(new Date()) } = {}) {
  const byIssueId = new Set();
  const byBusinessKey = new Set();
  const byScopeKey = new Set();
  const result = [];
  for (const source of dataset.inventoryReviewDispositions || []) {
    if (!source || typeof source !== "object") throw httpError(422, "Published inventory review disposition is malformed.", "DATASET_DISPOSITION");
    const issueId = text(source.issueId);
    const issueCode = text(source.issueCode);
    const requiredGrain = INVENTORY_APPROVAL_CODE_GRAINS.get(issueCode);
    const grain = source.grain === "online_aggregate" ? "online_aggregate" : source.grain === "physical_warehouse" ? "physical_warehouse" : "";
    const decision = normalizeDispositionDecision(source.decision);
    const inventoryDate = dateKey(source.inventoryDate);
    const dispositionDate = dateKey(source.dispositionDate);
    const pid = text(source.pid);
    const cid = text(source.cid);
    const wid = grain === "physical_warehouse" ? text(source.wid) : "";
    if (!issueId || !requiredGrain || grain !== requiredGrain || !decision || !pid || !cid || (grain === "physical_warehouse" && !wid) || !inventoryDate || !numericKnown(source.onHand) || Number(source.onHand) < 0 || !dispositionDate || dispositionDate > today) {
      throw httpError(422, "Published inventory review disposition violates the exact-scope policy.", "DATASET_DISPOSITION");
    }
    const normalized = {
      issueId,
      issueCode,
      decision,
      pid,
      cid,
      grain,
      wid,
      location:grain === "online_aggregate" ? "Online aggregate" : text(source.location),
      inventoryDate,
      onHand:integer(source.onHand),
      dispositionDate,
    };
    const exact = grain === "physical_warehouse"
      ? (dataset.prodSales || []).find(fact => fact?.pid === pid && fact?.cid === cid && fact?.date === inventoryDate && fact?.wid === wid && inventoryBalanceKnown(fact) && Number(fact.inv) === normalized.onHand)
      : onlineAggregateMatchesApproval(dataset.onlineSales, normalized);
    if (!exact) throw httpError(422, "Published inventory review disposition does not exactly match its recorded inventory fact.", "DATASET_DISPOSITION_MISMATCH");
    const businessKey = dispositionBusinessKey(normalized);
    const scopeKey = dispositionScopeKey(normalized);
    if (byIssueId.has(issueId) || byBusinessKey.has(businessKey) || byScopeKey.has(scopeKey)) throw httpError(422, "Published inventory review dispositions contain duplicates.", "DATASET_DISPOSITION_DUPLICATE");
    byIssueId.add(issueId);
    byBusinessKey.add(businessKey);
    byScopeKey.add(scopeKey);
    result.push(normalized);
  }
  return sorted(result, ["pid", "cid", "grain", "wid", "inventoryDate", "issueId"]);
}

function sameFacts(a, b, keys) {
  return JSON.stringify(comparable(a, keys)) === JSON.stringify(comparable(b, keys));
}

function maxDate(rows = []) {
  return rows.reduce((latest, row) => row?.date && row.date > latest ? row.date : latest, "");
}

function sorted(rows, keys) {
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const result = String(a?.[key] ?? "").localeCompare(String(b?.[key] ?? ""));
      if (result) return result;
    }
    return 0;
  });
}

export function replaceWarehouseDailySlice(dataset, payload = {}) {
  if (dataset?.schema !== "byou-intel-dataset-v1") {
    throw httpError(500, "The current shared dataset is not compatible with warehouse corrections.", "CORRECTION_DATASET");
  }
  const key = payload.key || {};
  const expected = payload.expected || {};
  const records = Array.isArray(payload.records) ? payload.records : [];
  if (key.collection !== "prodSales" || !text(key.pid) || !text(key.cid) || !dateKey(key.date) || !records.length) {
    throw httpError(422, "The warehouse correction key or replacement rows are invalid.", "CORRECTION_INVALID");
  }
  const context = {
    product:productResolver(dataset.productMeta),
    warehouse:warehouseResolver(dataset.whs),
    campaign:campaignResolver(dataset.campaignMeta),
  };
  const replacementRows = warehouseRows(records.map((row, index) => ({ ...row, __row:index + 2 })), context);
  if (replacementRows.some(row => row.pid !== key.pid || row.cid !== key.cid || row.date !== key.date)) {
    throw httpError(422, "A replacement warehouse row does not match the immutable correction key.", "CORRECTION_KEY_MISMATCH");
  }
  const replacementWarehouseIds = new Set(replacementRows.map(row => row.wid));
  if (replacementWarehouseIds.size !== replacementRows.length) {
    throw httpError(422, "The replacement warehouse slice contains duplicate warehouses.", "CORRECTION_DUPLICATE_WAREHOUSE");
  }

  const currentProdSales = dataset.prodSales || [];
  const currentSlice = currentProdSales.filter(row => row?.pid === key.pid && row?.cid === key.cid && row?.date === key.date);
  const expectedExistingRows = Number(expected.existingRows);
  const expectedReplacementRows = Number(expected.replacementRows);
  if (!Number.isInteger(expectedExistingRows) || currentSlice.length !== expectedExistingRows) {
    throw httpError(409, `The published warehouse slice has ${currentSlice.length} rows; expected ${expectedExistingRows}.`, "CORRECTION_EXISTING_COUNT");
  }
  if (!Number.isInteger(expectedReplacementRows) || replacementRows.length !== expectedReplacementRows) {
    throw httpError(422, `The replacement warehouse slice has ${replacementRows.length} rows; expected ${expectedReplacementRows}.`, "CORRECTION_REPLACEMENT_COUNT");
  }
  const replacementRevenue = replacementRows.reduce((sum, row) => sum + Number(row.rev || 0), 0);
  const replacementUnits = replacementRows.reduce((sum, row) => sum + Number(row.units || 0), 0);
  const expectedRevenue = Number(expected.revenue);
  const expectedUnits = Number(expected.units);
  if (!Number.isFinite(expectedRevenue) || Math.abs(replacementRevenue - expectedRevenue) > 0.005) {
    throw httpError(422, `Replacement revenue is ${replacementRevenue.toFixed(2)}; expected ${expectedRevenue.toFixed(2)}.`, "CORRECTION_REVENUE");
  }
  if (!Number.isFinite(expectedUnits) || replacementUnits !== expectedUnits) {
    throw httpError(422, `Replacement units are ${replacementUnits}; expected ${expectedUnits}.`, "CORRECTION_UNITS");
  }
  const officialRows = (dataset.inlineTotalSales || []).filter(row => row?.pid === key.pid && row?.cid === key.cid && row?.date === key.date);
  if (officialRows.length !== 1 || Math.abs(Number(officialRows[0]?.rev || 0) - replacementRevenue) > 0.005 || Number(officialRows[0]?.units || 0) !== replacementUnits) {
    throw httpError(409, "The replacement warehouse totals do not reconcile to the single published official total.", "CORRECTION_OFFICIAL_RECONCILIATION");
  }

  const facts = row => [row.wid, row.pid, row.cid, row.date, row.rev, row.units, row.promo, row.refund, row.inv, inventoryBalanceKnown(row)];
  const currentFacts = sorted(currentSlice, ["wid"]).map(facts);
  const replacementFacts = sorted(replacementRows, ["wid"]).map(facts);
  const result = {
    collection:"prodSales",
    key,
    removedRows:currentSlice.length,
    addedRows:replacementRows.length,
    netRows:replacementRows.length - currentSlice.length,
    revenue:+replacementRevenue.toFixed(2),
    units:replacementUnits,
  };
  if (JSON.stringify(currentFacts) === JSON.stringify(replacementFacts)) {
    return { dataset, changed:false, result:{ ...result, removedRows:0, addedRows:0, netRows:0 } };
  }

  const nextProdSales = currentProdSales.filter(row => !(row?.pid === key.pid && row?.cid === key.cid && row?.date === key.date));
  nextProdSales.push(...replacementRows);
  const touchedAggregateKeys = new Set([...currentSlice, ...replacementRows].map(row => `${row.date}|${row.wid}`));
  const aggregateRows = new Map();
  nextProdSales.forEach(row => {
    const aggregateKey = `${row.date}|${row.wid}`;
    if (!touchedAggregateKeys.has(aggregateKey)) return;
    const aggregate = aggregateRows.get(aggregateKey) || { wid:row.wid, date:row.date, rev:0, units:0, promo:0, refund:0, inv:0, invKnown:true, isDemo:false };
    aggregate.rev += Number(row.rev || 0);
    aggregate.units += Number(row.units || 0);
    aggregate.promo += Number(row.promo || 0);
    aggregate.refund += Number(row.refund || 0);
    aggregate.inv += Number(row.inv || 0);
    aggregate.invKnown = aggregate.invKnown && inventoryBalanceKnown(row);
    aggregateRows.set(aggregateKey, aggregate);
  });
  const nextSales = (dataset.sales || []).filter(row => !touchedAggregateKeys.has(`${row?.date}|${row?.wid}`));
  nextSales.push(...aggregateRows.values());
  return {
    dataset:{
      ...dataset,
      whs:context.warehouse.rows,
      sales:sorted(nextSales, ["wid", "date"]),
      prodSales:sorted(nextProdSales, ["wid", "pid", "date", "cid"]),
      workbookSales:{
        ...(dataset.workbookSales || {}),
        meta:{
          ...(dataset.workbookSales?.meta || {}),
          source:"Server warehouse slice correction",
          rows:nextProdSales.length,
        },
      },
    },
    changed:true,
    result,
  };
}

export function mergeDailyUpdateDataset(dataset, sheets, options = {}) {
  if (dataset?.schema !== "byou-intel-dataset-v1") {
    throw httpError(500, "The current shared dataset is not compatible with daily updates.");
  }
  const metadata = mergeDailyUpdateMetadata(dataset, sheets, options);
  const workingDataset = {
    ...dataset,
    productMeta:metadata.productMeta,
    campaignMeta:metadata.campaignMeta,
  };
  const context = {
    product:productResolver(workingDataset.productMeta),
    warehouse:warehouseResolver(workingDataset.whs),
    campaign:campaignResolver(workingDataset.campaignMeta),
  };
  const parsedIncomingWarehouse = warehouseRows(sheets.In_Line_Sales_Raw || [], context, options);
  const officialSourceRows = sheets.Costco_Daily_Totals || [];
  const officialTotalRows = officialSourceRows.filter(row => normalizedKey(row.Venue) === "totalusbyregion");
  if (officialSourceRows.length && !officialTotalRows.length) {
    throw httpError(422, "Costco_Daily_Totals contains no exact Total US by Region rows.", "DAILY_UPDATE_TOTALS");
  }
  const incomingOfficial = officialTotalRows.map(row => totalRow(row, context, "Inline", "Time", "Costco_Daily_Totals"));
  const incomingOnline = (sheets.Online_Sales_Raw || []).map(row => totalRow(row, context, "Online", "Date", "Online_Sales_Raw"));
  const assertNoConflictingSourceDuplicates = (rows, keyFor, factKeys, label, rejectAllDuplicates = false) => {
    const seen = new Map();
    rows.forEach(row => {
      const key = keyFor(row);
      const prior = seen.get(key);
      if (prior && (rejectAllDuplicates || !sameFacts(prior, row, factKeys))) {
        throw httpError(422, `${label} contains duplicate source rows for ${key}.`, "DAILY_UPDATE_SOURCE_DUPLICATE");
      }
      if (!prior) seen.set(key, row);
    });
  };
  const warehouseSourceKey = row => `${row.date}|${row.wid}|${row.pid}|${row.cid || ""}`;
  assertNoConflictingSourceDuplicates(parsedIncomingWarehouse, warehouseSourceKey, ["rev", "units", "promo", "refund", "inv", "invKnown"], "In_Line_Sales_Raw");
  assertNoConflictingSourceDuplicates(incomingOfficial, row => `${row.date}|${row.pid}|${row.cid || ""}|Inline`, [], "Costco_Daily_Totals", true);
  const incomingWarehouse = [...new Map(parsedIncomingWarehouse.map(row => [warehouseSourceKey(row), row])).values()];
  const committedDates = [maxDate(workingDataset.inlineTotalSales), maxDate(workingDataset.onlineSales)].filter(Boolean).sort();
  const committedThrough = committedDates[0] || "";

  const nextProdSales = [...(workingDataset.prodSales || [])];
  const productIndex = new Map(nextProdSales.map((row, index) => [`${row.date}|${row.wid}|${row.pid}|${row.cid || ""}`, index]));
  const nextSales = [...(workingDataset.sales || [])];
  const salesIndex = new Map(nextSales.map((row, index) => [`${row.date}|${row.wid}`, index]));
  const touchedAggregateKeys = new Set();
  let warehouseMerged = 0;
  let warehouseReplaced = 0;
  let skipped = 0;
  const warehouseFactKeys = ["cid", "rev", "units", "promo", "refund", "inv", "invKnown"];
  incomingWarehouse.forEach(row => {
    const productKey = `${row.date}|${row.wid}|${row.pid}|${row.cid || ""}`;
    const existingIndex = productIndex.get(productKey);
    if (existingIndex !== undefined) {
      if (sameFacts(nextProdSales[existingIndex], row, warehouseFactKeys)) { skipped += 1; return; }
      if (!committedThrough || row.date <= committedThrough) {
        throw httpError(409, `Warehouse daily-update collision for ${row.pid} on ${row.date}.`, "DAILY_UPDATE_COLLISION");
      }
      nextProdSales[existingIndex] = row;
      touchedAggregateKeys.add(`${row.date}|${row.wid}`);
      warehouseReplaced += 1;
      return;
    }
    productIndex.set(productKey, nextProdSales.length);
    nextProdSales.push(row);
    touchedAggregateKeys.add(`${row.date}|${row.wid}`);
    warehouseMerged += 1;
  });

  const touchedAggregates = new Map([...touchedAggregateKeys].map(aggregateKey => {
    const [date, wid] = aggregateKey.split("|");
    return [aggregateKey, { wid, date, rev:0, units:0, promo:0, refund:0, inv:0, invKnown:true, isDemo:false }];
  }));
  nextProdSales.forEach(row => {
    const aggregate = touchedAggregates.get(`${row.date}|${row.wid}`);
    if (!aggregate) return;
    aggregate.rev += Number(row.rev || 0);
    aggregate.units += Number(row.units || 0);
    aggregate.promo += Number(row.promo || 0);
    aggregate.refund += Number(row.refund || 0);
    aggregate.inv += Number(row.inv || 0);
    aggregate.invKnown = aggregate.invKnown && inventoryBalanceKnown(row);
  });
  touchedAggregates.forEach((aggregate, aggregateKey) => {
    const aggregateIndex = salesIndex.get(aggregateKey);
    if (aggregateIndex === undefined) {
      salesIndex.set(aggregateKey, nextSales.length);
      nextSales.push(aggregate);
    } else {
      nextSales[aggregateIndex] = aggregate;
    }
  });

  const totalFactKeys = ["cid", "rev", "units", "promo", "promoUnits", "refund", "refundUnits", "inv", "invKnown", "activeDoors", "activeDoorsKnown"];
  const mergeTotals = (existingRows, incomingRows, channel) => {
    const next = [...(existingRows || [])];
    const index = new Map(next.map((row, rowIndex) => [`${row.date}|${row.pid}|${row.cid || ""}|${channel}`, rowIndex]));
    let merged = 0;
    incomingRows.forEach(row => {
      const key = `${row.date}|${row.pid}|${row.cid || ""}|${channel}`;
      const existingIndex = index.get(key);
      if (existingIndex !== undefined) {
        if (sameFacts(next[existingIndex], row, totalFactKeys)) { skipped += 1; return; }
        throw httpError(409, `${channel} daily-update collision for ${row.pid} on ${row.date}.`, "DAILY_UPDATE_COLLISION");
      }
      index.set(key, next.length);
      next.push(row);
      merged += 1;
    });
    return { rows:next, merged };
  };

  const officialMerge = mergeTotals(workingDataset.inlineTotalSales, incomingOfficial, "Inline");
  const onlineMerge = mergeTotals(workingDataset.onlineSales, incomingOnline, "Online");
  const today = dateKey(new Date());
  const existingApprovals = validateInventoryApprovalsForDataset(workingDataset, { today });
  const incomingApprovals = normalizeInventoryApprovals(sheets[DAILY_UPDATE_APPROVAL_SHEET] || [], context, {
    prodSales:nextProdSales,
    onlineSales:onlineMerge.rows,
  }, today);
  const incomingIssueIds = new Set(incomingApprovals.map(row => row.issueId));
  const incomingBusinessKeys = new Set(incomingApprovals.map(approvalBusinessKey));
  const nextApprovals = existingApprovals.filter(row => !incomingIssueIds.has(row.issueId) && !incomingBusinessKeys.has(approvalBusinessKey(row)));
  nextApprovals.push(...incomingApprovals);
  const sortedApprovals = validateInventoryApprovalsForDataset({
    ...workingDataset,
    whs:context.warehouse.rows,
    prodSales:nextProdSales,
    onlineSales:onlineMerge.rows,
    inventoryApprovals:nextApprovals,
  }, { today });
  const approvalChanged = JSON.stringify(sorted(existingApprovals, ["pid", "cid", "grain", "wid", "inventoryDate", "issueId"])) !== JSON.stringify(sortedApprovals);
  const existingDispositions = validateInventoryReviewDispositionsForDataset(workingDataset, { today });
  const incomingDispositions = normalizeInventoryReviewDispositions(sheets[DAILY_UPDATE_DISPOSITION_SHEET] || [], context, {
    prodSales:nextProdSales,
    onlineSales:onlineMerge.rows,
  }, today);
  const incomingDispositionIssueIds = new Set(incomingDispositions.map(row => row.issueId));
  const incomingDispositionScopeKeys = new Set(incomingDispositions.map(dispositionScopeKey));
  const nextDispositions = existingDispositions.filter(row =>
    !incomingDispositionIssueIds.has(row.issueId) && !incomingDispositionScopeKeys.has(dispositionScopeKey(row)));
  nextDispositions.push(...incomingDispositions);
  const sortedDispositions = validateInventoryReviewDispositionsForDataset({
    ...workingDataset,
    whs:context.warehouse.rows,
    prodSales:nextProdSales,
    onlineSales:onlineMerge.rows,
    inventoryReviewDispositions:nextDispositions,
  }, { today });
  const dispositionChanged = JSON.stringify(existingDispositions) !== JSON.stringify(sortedDispositions);
  const correctionContext = { ...workingDataset, whs:context.warehouse.rows };
  const incomingInventory = ownerInventoryDecisionsFromSheet(sheets[OWNER_INVENTORY_SHEET] || [], correctionContext);
  const ownerInventoryDecisions = mergeOwnerInventoryDecisions(workingDataset.ownerInventoryDecisions, incomingInventory, correctionContext);
  const inventoryDecisionsChanged = JSON.stringify(workingDataset.ownerInventoryDecisions || []) !== JSON.stringify(ownerInventoryDecisions);
  const incomingCorrections = ownerSalesCorrectionsFromSheet(sheets[OWNER_SALES_CORRECTION_SHEET] || [], correctionContext, { today });
  const ownerSalesCorrections = mergeOwnerSalesCorrections(workingDataset.ownerSalesCorrections, incomingCorrections, correctionContext, { today });
  const correctionsChanged = JSON.stringify(workingDataset.ownerSalesCorrections || []) !== JSON.stringify(ownerSalesCorrections);
  const ownerSalesCorrectionHistory = buildOwnerSalesCorrectionHistory({ ...correctionContext, ownerSalesCorrections, prodSales:nextProdSales, onlineSales:onlineMerge.rows });
  const dataThrough = maxDate([...incomingWarehouse, ...incomingOfficial, ...incomingOnline]) ||
    ((incomingCorrections.length || incomingInventory.length) ? maxDate([...nextProdSales, ...officialMerge.rows, ...onlineMerge.rows]) : "");
  const changedRows = warehouseMerged + warehouseReplaced + officialMerge.merged + onlineMerge.merged;
  const workbookSales = {
    ...(workingDataset.workbookSales || {}),
    meta:{
      ...(workingDataset.workbookSales?.meta || {}),
      source:"Server daily update",
      rows:nextProdSales.length,
      end:maxDate([...nextProdSales, ...officialMerge.rows, ...onlineMerge.rows]) || workingDataset.workbookSales?.meta?.end || "",
    },
  };
  return {
    dataset:{
      ...workingDataset,
      whs:context.warehouse.rows,
      sales:sorted(nextSales, ["wid", "date"]),
      prodSales:sorted(nextProdSales, ["wid", "pid", "date", "cid"]),
      inlineTotalSales:sorted(officialMerge.rows, ["date", "pid", "cid"]),
      onlineSales:sorted(onlineMerge.rows, ["date", "pid", "cid"]),
      inventoryApprovals:sortedApprovals,
      inventoryReviewDispositions:sortedDispositions,
      ownerInventoryDecisions,
      ownerSalesCorrections,
      ownerSalesCorrectionHistory,
      workbookSales,
    },
    changed:changedRows > 0 || metadata.productsAdded > 0 || metadata.campaignsAdded > 0 || metadata.campaignsUpdated > 0 || approvalChanged || dispositionChanged || correctionsChanged || inventoryDecisionsChanged,
    result:{
      sourceRows:{
        In_Line_Sales_Raw:(sheets.In_Line_Sales_Raw || []).length,
        Costco_Daily_Totals:officialSourceRows.length,
        Online_Sales_Raw:(sheets.Online_Sales_Raw || []).length,
      },
      sourceReconciliation:{
        warehouse:{
          received:(sheets.In_Line_Sales_Raw || []).length,
          accepted:incomingWarehouse.length,
          filtered:(sheets.In_Line_Sales_Raw || []).length - incomingWarehouse.length,
          published:warehouseMerged + warehouseReplaced,
          retainedMasterOnly:Math.max(0, nextProdSales.length - incomingWarehouse.length),
        },
        official:{
          received:officialSourceRows.length,
          accepted:incomingOfficial.length,
          filtered:officialSourceRows.length - incomingOfficial.length,
          published:officialMerge.merged,
          retainedMasterOnly:Math.max(0, officialMerge.rows.length - incomingOfficial.length),
        },
        online:{
          received:(sheets.Online_Sales_Raw || []).length,
          accepted:incomingOnline.length,
          filtered:0,
          published:onlineMerge.merged,
          retainedMasterOnly:Math.max(0, onlineMerge.rows.length - incomingOnline.length),
        },
      },
      mergedRows:{ warehouse:warehouseMerged, inlineTotal:officialMerge.merged, online:onlineMerge.merged },
      metadataAdded:{ products:metadata.productsAdded, campaigns:metadata.campaignsAdded },
      metadataUpdated:{ campaigns:metadata.campaignsUpdated },
      approvalAttestations:incomingApprovals.length,
      reviewDispositions:incomingDispositions.length,
      ownerSalesCorrections:incomingCorrections.length,
      replacedRows:{ warehouse:warehouseReplaced },
      skippedRows:skipped,
      dataThrough,
    },
  };
}
