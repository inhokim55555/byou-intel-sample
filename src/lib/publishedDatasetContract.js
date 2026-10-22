const ROW_COLLECTION_KEYS = [
  "sales", "prodSales", "inlineTotalSales", "onlineSales", "ppcRows",
  "footnotes", "videos", "videoMetrics", "whs", "inventoryApprovals",
  "inventoryReviewDispositions", "ownerSalesCorrections",
];

const REQUIRED_COLLECTION_KEYS = new Set([
  "sales", "prodSales", "inlineTotalSales", "onlineSales", "ppcRows",
  "footnotes", "videos", "videoMetrics", "whs",
]);

function contractError(message, code = "DATASET_CONTRACT_INVALID") {
  return Object.assign(new Error(message), { status:422, code });
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function collectionRows(value, key, required) {
  if (value === undefined || value === null) {
    if (required) throw contractError(`The full dataset is missing the required ${key} collection.`, "DATASET_COLLECTION_MISSING");
    return [];
  }
  let rows = value;
  if (!Array.isArray(rows)) {
    if (!isRecord(rows)) throw contractError(`The ${key} collection must be an array or a row collection.`, "DATASET_COLLECTION_INVALID");
    const wrappers = ["rows", "data", "items"].filter(name => Object.prototype.hasOwnProperty.call(rows, name));
    if (wrappers.length > 1) throw contractError(`The ${key} collection has more than one row wrapper.`, "DATASET_COLLECTION_INVALID");
    rows = wrappers.length ? rows[wrappers[0]] : Object.values(rows);
  }
  if (!Array.isArray(rows)) throw contractError(`The ${key} row wrapper must contain an array.`, "DATASET_COLLECTION_INVALID");
  const malformed = rows.findIndex(row => !isRecord(row));
  if (malformed >= 0) throw contractError(`The ${key} collection contains a malformed row at position ${malformed + 1}.`, "DATASET_ROW_INVALID");
  return rows;
}

export function normalizeDatasetRows(dataset = {}, { requireCollections = false } = {}) {
  if (!isRecord(dataset)) throw contractError("The full dataset payload must be an object.");
  const normalized = { ...dataset };
  for (const key of ROW_COLLECTION_KEYS) {
    normalized[key] = collectionRows(dataset[key], key, requireCollections && REQUIRED_COLLECTION_KEYS.has(key));
  }
  return normalized;
}

function validDate(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw;
}

function exactMetadataRows(metadata = {}) {
  if (!isRecord(metadata)) return [];
  const byId = new Map();
  for (const [key, value] of Object.entries(metadata)) {
    if (!isRecord(value)) throw contractError(`Metadata entry ${key} is malformed.`, "DATASET_METADATA_INVALID");
    const id = String(value.id || key || "").trim();
    if (!id) throw contractError("Metadata entries require stable IDs.", "DATASET_METADATA_INVALID");
    const prior = byId.get(id);
    const normalized = { ...value, id };
    if (prior) {
      const populated = fieldValue => fieldValue !== undefined && fieldValue !== null && fieldValue !== "";
      const conflict = Object.entries(normalized).find(([field, fieldValue]) => (
        populated(fieldValue)
        && populated(prior[field])
        && JSON.stringify(prior[field]) !== JSON.stringify(fieldValue)
      ));
      if (conflict) {
        throw contractError(`Metadata ID ${id} has conflicting ${conflict[0]} definitions.`, "DATASET_METADATA_CONFLICT");
      }
      const merged = { ...prior };
      for (const [field, fieldValue] of Object.entries(normalized)) {
        if (populated(fieldValue) || !Object.prototype.hasOwnProperty.call(merged, field)) merged[field] = fieldValue;
      }
      byId.set(id, merged);
      continue;
    }
    byId.set(id, normalized);
  }
  return [...byId.values()];
}

function assertUniqueRows(rows, keyFor, lane) {
  const seen = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const key = keyFor(rows[index]);
    if (!key || key.split("|").some(part => !part)) {
      throw contractError(`${lane} row ${index + 1} is missing a required business-key field.`, "DATASET_ROW_IDENTITY_INVALID");
    }
    if (seen.has(key)) throw contractError(`${lane} contains duplicate business key ${key}.`, "DATASET_DUPLICATE_BUSINESS_KEY");
    seen.add(key);
  }
}

function assertDateRows(rows, lane) {
  rows.forEach((row, index) => {
    if (!validDate(row?.date)) throw contractError(`${lane} row ${index + 1} has an invalid date.`, "DATASET_DATE_INVALID");
  });
}

function assertFactNumerics(rows, lane, { required = ["rev", "units"], optional = [], integers = ["units"] } = {}) {
  const requiredFields = new Set(required);
  const integerFields = new Set(integers);
  rows.forEach((row, index) => {
    for (const field of [...required, ...optional]) {
      const value = row?.[field];
      if (!requiredFields.has(field) && (value === undefined || value === null || value === "")) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || (integerFields.has(field) && !Number.isInteger(value))) {
        throw contractError(`${lane} row ${index + 1} has an invalid ${field} value.`, "DATASET_NUMERIC_INVALID");
      }
    }
    if (row?.invKnown === true && (typeof row.inv !== "number" || !Number.isFinite(row.inv) || !Number.isInteger(row.inv))) {
      throw contractError(`${lane} row ${index + 1} marks an invalid inventory value as known.`, "DATASET_NUMERIC_INVALID");
    }
    if (row?.activeDoorsKnown === true && (typeof row.activeDoors !== "number" || !Number.isInteger(row.activeDoors) || row.activeDoors < 0)) {
      throw contractError(`${lane} row ${index + 1} marks an invalid active-door value as known.`, "DATASET_NUMERIC_INVALID");
    }
  });
}

function channelKey(value, fallback = "") {
  const raw = String(value || fallback).trim().toLowerCase().replace(/[^a-z]/g, "");
  return raw === "inline" || raw === "inlineonly" ? "inline" : raw === "online" ? "online" : raw === "both" ? "both" : raw;
}

function campaignIsActiveOn(campaign, product, date) {
  const channel = channelKey(campaign.channel || campaign["Online/In-Line"]);
  return product?.active !== false
    && campaign?.active !== false
    && ["inline", "both"].includes(channel)
    && (!campaign.start || campaign.start <= date)
    && (!campaign.end || campaign.end >= date);
}

export function validateFullDatasetCandidate(input = {}) {
  if (input?.schema !== "byou-intel-dataset-v1") throw contractError("Invalid BYOU Intel dataset payload.", "DATASET_SCHEMA_INVALID");
  if (!Number.isFinite(Date.parse(String(input.publishedAt || "")))) {
    throw contractError("The full dataset requires a valid publishedAt timestamp.", "DATASET_PUBLICATION_INVALID");
  }
  const dataset = normalizeDatasetRows(input, { requireCollections:true });
  const products = exactMetadataRows(dataset.productMeta);
  const campaigns = exactMetadataRows(dataset.campaignMeta);
  const productIds = new Set(products.map(row => row.id));
  const campaignById = new Map(campaigns.map(row => [row.id, row]));
  const warehouseIds = new Set();
  dataset.whs.forEach((row, index) => {
    const id = String(row?.id || "").trim();
    if (!id) throw contractError(`whs row ${index + 1} is missing its stable ID.`, "DATASET_ROW_IDENTITY_INVALID");
    if (warehouseIds.has(id)) throw contractError(`whs contains duplicate ID ${id}.`, "DATASET_DUPLICATE_BUSINESS_KEY");
    warehouseIds.add(id);
  });
  for (const campaign of campaigns) {
    if (!productIds.has(String(campaign.pid || ""))) throw contractError(`Campaign ${campaign.id} references an unknown product.`, "DATASET_REFERENCE_INVALID");
    if ((campaign.start && !validDate(campaign.start)) || (campaign.end && !validDate(campaign.end)) || (campaign.start && campaign.end && campaign.start > campaign.end)) {
      throw contractError(`Campaign ${campaign.id} has invalid date boundaries.`, "DATASET_METADATA_INVALID");
    }
  }

  assertDateRows(dataset.sales, "sales");
  assertDateRows(dataset.prodSales, "prodSales");
  assertDateRows(dataset.inlineTotalSales, "inlineTotalSales");
  assertDateRows(dataset.onlineSales, "onlineSales");
  assertFactNumerics(dataset.sales, "sales", { optional:["promo", "refund", "inv"], integers:["units", "inv"] });
  assertFactNumerics(dataset.prodSales, "prodSales", { optional:["promo", "refund", "inv"], integers:["units", "inv"] });
  assertFactNumerics(dataset.inlineTotalSales, "inlineTotalSales", { optional:["promo", "promoUnits", "refund", "refundUnits", "inv", "activeDoors"], integers:["units", "promoUnits", "refundUnits", "inv", "activeDoors"] });
  assertFactNumerics(dataset.onlineSales, "onlineSales", { optional:["promo", "promoUnits", "refund", "refundUnits", "orders", "sessions", "adSpend", "inv", "activeDoors"], integers:["units", "promoUnits", "refundUnits", "orders", "sessions", "inv", "activeDoors"] });
  assertUniqueRows(dataset.sales, row => `${row.date}|${String(row.wid || "").trim()}`, "sales");
  assertUniqueRows(dataset.prodSales, row => `${row.date}|${String(row.wid || "").trim()}|${String(row.pid || "").trim()}|${String(row.cid || "__unmapped__").trim()}`, "prodSales");
  assertUniqueRows(dataset.inlineTotalSales, row => `${row.date}|${String(row.pid || "").trim()}|${String(row.cid || "__unmapped__").trim()}|${channelKey(row.channel, "Inline")}`, "inlineTotalSales");
  assertUniqueRows(dataset.onlineSales, row => `${row.date}|${String(row.pid || "").trim()}|${String(row.cid || "__unmapped__").trim()}|${channelKey(row.channel, "Online")}`, "onlineSales");

  const assertReferences = (rows, lane, { warehouse = false, campaign = false } = {}) => rows.forEach((row, index) => {
    const pid = String(row?.pid || "").trim();
    const cid = String(row?.cid || "").trim();
    if (pid && !productIds.has(pid)) throw contractError(`${lane} row ${index + 1} references unknown product ${pid}.`, "DATASET_REFERENCE_INVALID");
    if (warehouse && !warehouseIds.has(String(row?.wid || "").trim())) throw contractError(`${lane} row ${index + 1} references an unknown warehouse.`, "DATASET_REFERENCE_INVALID");
    if (campaign && cid) {
      const definition = campaignById.get(cid);
      if (!definition || String(definition.pid || "") !== pid) throw contractError(`${lane} row ${index + 1} references an incompatible campaign.`, "DATASET_REFERENCE_INVALID");
    }
  });
  assertReferences(dataset.sales, "sales", { warehouse:true });
  assertReferences(dataset.prodSales, "prodSales", { warehouse:true, campaign:true });
  assertReferences(dataset.inlineTotalSales, "inlineTotalSales", { campaign:true });
  assertReferences(dataset.onlineSales, "onlineSales", { campaign:true });

  const reportingDate = validDate(dataset.workbookSales?.meta?.end)
    ? dataset.workbookSales.meta.end
    : [...dataset.inlineTotalSales.map(row => row.date), ...dataset.onlineSales.map(row => row.date)].sort().at(-1) || "";
  if (reportingDate) {
    const activeInline = campaigns.filter(campaign => campaignIsActiveOn(campaign, products.find(product => product.id === campaign.pid), reportingDate));
    for (const campaign of activeInline) {
      const matches = dataset.inlineTotalSales.filter(row => row.date === reportingDate && row.pid === campaign.pid && row.cid === campaign.id && channelKey(row.channel, "Inline") === "inline");
      if (matches.length !== 1) throw contractError(`Active inline campaign ${campaign.id} requires exactly one official total on ${reportingDate}; found ${matches.length}.`, "DATASET_OFFICIAL_TOTAL_INCOMPLETE");
    }
  }
  return dataset;
}

function knownMeasure(row, field, knownField) {
  const explicitlyKnown = Object.prototype.hasOwnProperty.call(row || {}, knownField)
    ? row?.[knownField] === true
    : row?.[field] !== undefined && row?.[field] !== null && row?.[field] !== "";
  return explicitlyKnown
    ? { known:true, value:Number(row?.[field]) }
    : { known:false, value:null };
}

function factSignature(row = {}, lane = "") {
  const optionalZeroFields = lane === "warehouse"
    ? ["promo", "refund"]
    : lane === "online"
      ? ["promo", "promoUnits", "refund", "refundUnits", "orders", "sessions", "adSpend"]
      : ["promo", "promoUnits", "refund", "refundUnits"];
  const result = {
    rev:Number(row?.rev),
    units:Number(row?.units),
  };
  for (const field of optionalZeroFields) {
    const value = row?.[field];
    result[field] = value === undefined || value === null || value === "" ? 0 : Number(value);
  }
  result.inventory = knownMeasure(row, "inv", "invKnown");
  if (lane !== "warehouse") result.activeDoors = knownMeasure(row, "activeDoors", "activeDoorsKnown");
  return JSON.stringify(result);
}

function factMap(rows = [], keyFor, lane) {
  return new Map(rows.map(row => [keyFor(row), factSignature(row, lane)]));
}

function laneBusinessFacts(dataset = {}) {
  const normalized = normalizeDatasetRows(dataset);
  return {
    official:factMap(normalized.inlineTotalSales, row => `${row.date}|${row.pid}|${row.cid || ""}|${channelKey(row.channel, "Inline")}`, "official"),
    warehouse:factMap(normalized.prodSales, row => `${row.date}|${row.wid}|${row.pid}|${row.cid || ""}`, "warehouse"),
    online:factMap(normalized.onlineSales, row => `${row.date}|${row.pid}|${row.cid || ""}|${channelKey(row.channel, "Online")}`, "online"),
  };
}

export function assertHistoricalFactsRetained(previous = {}, incoming = {}, allowHistoryReplacement = false) {
  if (allowHistoryReplacement) return;
  const before = laneBusinessFacts(previous);
  const after = laneBusinessFacts(incoming);
  for (const lane of Object.keys(before)) {
    const missing = [...before[lane].keys()].filter(key => !after[lane].has(key));
    if (missing.length) {
      throw Object.assign(new Error(`Full dataset publish would remove ${missing.length} historical ${lane} business key${missing.length === 1 ? "" : "s"}; first missing key: ${missing[0]}. Rebuild from the complete approved master or use the separately authorized history-replacement workflow.`), {
        status:409,
        code:"DATASET_HISTORY_SHRINK",
      });
    }
    const changed = [...before[lane].entries()].find(([key, signature]) => after[lane].get(key) !== signature);
    if (changed) {
      throw Object.assign(new Error(`Full dataset publish would change a historical ${lane} fact at business key ${changed[0]}. Use the separately authorized history-replacement workflow for source-backed corrections.`), {
        status:409,
        code:"DATASET_HISTORY_CHANGED",
      });
    }
  }
}
