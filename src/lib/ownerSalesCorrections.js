import { allocateWarehouseIdentity, warehouseNumberForIdentity } from "./warehouseIdentity.js";

// Cumulative positive-unit corrections are not dated POS transactions or net sales.
export const OWNER_SALES_CORRECTION_SHEET = "Owner_Sales_Corrections";
export const OWNER_SALES_CORRECTION_HEADERS = [
  "Correction_ID", "Version", "Product_ID", "Warehouse_ID", "Channel", "Campaign_IDs",
  "Start_Date", "Cutoff_Date", "Measure", "Corrected_Units", "Decision",
];
const FIELDS = ["id", "version", "pid", "wid", "channel", "cids", "startDate", "cutoffDate", "measure", "correctedUnits", "decision"];
const str = value => String(value ?? "").trim();
const key = value => str(value).toLowerCase();
const numericScalar = value => typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()));

function fail(message) {
  const error = new Error(`Accepted sales corrections: ${message}`);
  error.status = 422;
  error.code = "OWNER_SALES_CORRECTION_INVALID";
  throw error;
}

function date(value) {
  const result = str(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) return "";
  const parsed = new Date(`${result}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === result ? result : "";
}

function metadataValues(metadata) {
  return Object.entries(metadata || {}).map(([id, value]) => ({ ...value, id:str(value?.id || id) }));
}

function exactProducts(value, metadata = {}) {
  const matches = Object.entries(metadata).filter(([alias, item]) =>
    [alias, item?.id, item?.name, item?.short].some(candidate => candidate && key(candidate) === key(value)));
  return [...new Map(matches.map(([alias, item]) => {
    const product = { ...item, id:str(item?.id || alias) };
    return [product.id, product];
  })).values()];
}

export function normalizeOwnerSalesCorrections(rows = [], dataset = {}, { today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!Array.isArray(rows) || rows.length > 10000) fail("expected an array with at most 10,000 records.");
  const products = metadataValues(dataset.productMeta);
  const campaigns = metadataValues(dataset.campaignMeta);
  const warehouses = dataset.whs || [];
  const byId = new Map();
  const versions = new Map();
  for (const input of rows) {
    if (!input || typeof input !== "object" || Object.keys(input).some(field => !FIELDS.includes(field))) fail("record contains unsupported fields.");
    const id = str(input.id);
    const version = Number(input.version);
    const correctedUnits = Number(input.correctedUnits);
    const product = products.find(item => item.id === str(input.pid));
    const cids = Array.isArray(input.cids) ? input.cids.map(str).sort() : [];
    const startDate = date(input.startDate);
    const cutoffDate = date(input.cutoffDate);
    const channel = str(input.channel);
    const wid = str(input.wid);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !numericScalar(input.version) || !Number.isSafeInteger(version) || version < 1) fail("invalid correction identity/version.");
    if (!product) fail(`unknown product for ${id}.`);
    if (!["Inline", "Online"].includes(channel) || (channel === "Inline" ? warehouses.filter(item => str(item.id) === wid).length !== 1 : wid !== "")) fail(`invalid channel/location for ${id}.`);
    if (!startDate || !cutoffDate || startDate > cutoffDate || cutoffDate > today) fail(`invalid covered dates for ${id}.`);
    if (!cids.length || new Set(cids).size !== cids.length) fail(`invalid campaign scope for ${id}.`);
    for (const cid of cids) {
      const campaign = campaigns.find(item => item.id === cid);
      const campaignChannel = key(campaign?.channel).replace(/[^a-z]/g, "");
      if (!campaign || key(campaign.pid || campaign.product) !== key(product.id)) fail(`campaign/product mismatch for ${id}.`);
      if (campaignChannel && campaignChannel !== "both" && campaignChannel !== key(channel)) fail(`campaign/channel mismatch for ${id}.`);
      if ((date(campaign.start) && campaign.start > cutoffDate) || (date(campaign.end) && campaign.end < startDate)) fail(`campaign outside covered interval for ${id}.`);
    }
    if (input.measure !== "positive_units" || !numericScalar(input.correctedUnits) || !Number.isSafeInteger(correctedUnits) || correctedUnits < 0) fail(`invalid positive-unit total for ${id}.`);
    if (!["accepted", "revoked"].includes(input.decision)) fail(`invalid decision for ${id}.`);
    const record = { id, version, pid:product.id, wid, channel, cids, startDate, cutoffDate, measure:"positive_units", correctedUnits, decision:input.decision };
    const versionKey = `${id}|${version}`;
    const signature = JSON.stringify(record);
    if (versions.has(versionKey) && versions.get(versionKey) !== signature) fail(`conflicting copies of ${id}.`);
    versions.set(versionKey, signature);
    const previous = byId.get(id);
    if (previous && previous.version === version && JSON.stringify(previous) !== JSON.stringify(record)) fail(`conflicting copies of ${id}.`);
    if (previous && (previous.pid !== record.pid || previous.wid !== record.wid || previous.channel !== record.channel)) fail(`identity changed for ${id}.`);
    if (!previous || version > previous.version) byId.set(id, record);
  }
  const result = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const active = result.filter(record => record.decision === "accepted");
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      if (a.pid === b.pid && a.wid === b.wid && a.channel === b.channel && a.cids.some(cid => b.cids.includes(cid))) fail(`overlapping cumulative scopes ${a.id} and ${b.id}; use a newer version of the same correction.`);
    }
  }
  return result;
}

export function ownerSalesCorrectionsFromSheet(rows = [], dataset = {}, options = {}) {
  return normalizeOwnerSalesCorrections(rows.map(row => {
    if (Object.keys(row).some(field => field !== "__row" && !OWNER_SALES_CORRECTION_HEADERS.includes(field))) fail("sheet contains unsupported columns; keep private notes in the private review workbook.");
    let cids;
    try { cids = JSON.parse(str(row.Campaign_IDs)); } catch { fail("Campaign_IDs must be a JSON array."); }
    const uniqueProducts = exactProducts(row.Product_ID, dataset.productMeta);
    if (uniqueProducts.length !== 1) fail("sheet product must match exactly one known product.");
    const locations = (dataset.whs || []).filter(item => [item.id, item.name].some(value => value && key(value).replace(/\s+/g, " ") === key(row.Warehouse_ID).replace(/\s+/g, " ")));
    if (row.Channel === "Inline" && locations.length !== 1) fail("sheet location must match exactly one complete warehouse identity.");
    return {
      id:row.Correction_ID, version:row.Version, pid:uniqueProducts[0].id, wid:row.Channel === "Inline" ? locations[0].id : row.Warehouse_ID,
      channel:row.Channel, cids, startDate:row.Start_Date, cutoffDate:row.Cutoff_Date,
      measure:row.Measure, correctedUnits:row.Corrected_Units, decision:row.Decision,
    };
  }), dataset, options);
}

export function completeOwnerCorrectionDirectory(rows = [], warehouses = [], sourceVenues = [], previous = {}) {
  const nameKey = value => key(value).replace(/\s+/g, " ");
  const next = [...warehouses];
  const sourceNames = new Set(sourceVenues.map(nameKey));
  const retained = (previous.ownerSalesCorrections || []).filter(record => record.channel === "Inline").map(record => ({
    Channel:"Inline", Warehouse_ID:(previous.whs || []).find(item => str(item.id) === str(record.wid))?.name,
  }));
  for (const row of [...rows, ...retained]) {
    if (row.Channel !== "Inline") continue;
    const name = str(row.Warehouse_ID);
    if (next.some(item => [item.id, item.name].some(value => nameKey(value) === nameKey(name)))) continue;
    if (!name || !sourceNames.has(nameKey(name))) fail("the reviewed warehouse is missing from both the directory and exact raw venue names.");
    next.push({ ...allocateWarehouseIdentity(name, next), name, warehouseNo:warehouseNumberForIdentity(name), city:name, st:"", region:"Unassigned", lat:39.5, lng:-98.35, base:0 });
  }
  return next;
}

export function mergeOwnerSalesCorrections(existing, incoming, dataset, options = {}) {
  return normalizeOwnerSalesCorrections([...(existing || []), ...(incoming || [])], dataset, options);
}

// Legacy workbook imports can reallocate opaque Wxxx IDs. Keep the reviewed venue,
// not an accidentally reused ID, when a full upload replaces the directory.
export function rebindOwnerSalesCorrections(records = [], previous = {}, next = {}, options = {}) {
  const rebound = normalizeOwnerSalesCorrections(records, previous, options).map(record => {
    const aliases = new Set([record.pid, ...Object.entries(previous.productMeta || {})
      .filter(([alias, product]) => str(product?.id || alias) === record.pid)
      .flatMap(([alias, product]) => [alias, product?.name, product?.short]).filter(Boolean)]);
    const priorProduct = metadataValues(previous.productMeta).find(product => product.id === record.pid);
    const retained = metadataValues(next.productMeta).filter(product => product.id === record.pid);
    // An unchanged canonical ID/name takes precedence over a legacy short-name
    // collision. An ID reused for a different product must still fail closed.
    if (retained.some(product => key(product.name || product.id) !== key(priorProduct.name || priorProduct.id))) {
      fail(`cannot preserve the exact product identity for ${record.id}.`);
    }
    const products = retained.length ? [retained[0]] : [...new Map([...aliases].flatMap(alias => exactProducts(alias, next.productMeta)).map(product => [product.id, product])).values()];
    if (products.length !== 1) fail(`cannot preserve the exact product identity for ${record.id}.`);
    const productBound = { ...record, pid:products[0].id };
    if (record.channel === "Online") return productBound;
    const location = (previous.whs || []).find(item => str(item.id) === record.wid);
    const name = key(location?.name).replace(/\s+/g, " ");
    const matches = (next.whs || []).filter(item => name && key(item.name).replace(/\s+/g, " ") === name);
    if (matches.length !== 1) fail(`cannot preserve the exact warehouse identity for ${record.id}.`);
    return { ...productBound, wid:str(matches[0].id) };
  });
  return normalizeOwnerSalesCorrections(rebound, next, options);
}

// Build only from complete daily facts. Weekly/period summaries lose positive-unit information.
export function buildOwnerSalesCorrectionHistory(dataset = {}) {
  const records = normalizeOwnerSalesCorrections(dataset.ownerSalesCorrections || [], dataset);
  if (!records.some(record => record.decision === "accepted")) return [];
  const groups = new Map();
  const histories = records.filter(record => record.decision === "accepted").map(record => {
    const history = { ...record, recordedUnits:0, coveredSourceRows:0, sourceThrough:"", postCutoff:[] };
    const groupKey = [record.channel, record.pid, record.wid].join("\u001f");
    const matches = groups.get(groupKey) || [];
    matches.push({ history, cids:new Set(record.cids), daily:new Map() });
    groups.set(groupKey, matches);
    return history;
  });
  for (const [channel, rows] of [["Inline", dataset.prodSales], ["Online", dataset.onlineSales]]) {
    const seen = new Map();
    for (const row of rows || []) {
      if (row?.summaryType) continue;
      const matches = groups.get([channel, str(row?.pid), channel === "Online" ? "" : str(row?.wid)].join("\u001f"));
      if (!matches) continue;
      const day = date(row.date);
      const units = Number(row.units);
      if (!day || row.units == null || row.units === "" || !Number.isFinite(units)) continue;
      const eligible = matches.filter(match => match.cids.has(str(row.cid)) && day >= match.history.startDate);
      if (!eligible.length) continue;
      const factKey = [str(row.pid), str(row.wid), str(row.cid), day, channel === "Online" ? str(row.channel) : ""].join("\u001f");
      if (seen.has(factKey)) {
        if (seen.get(factKey) !== units) fail("conflicting daily unit facts in a corrected scope.");
        continue;
      }
      seen.set(factKey, units);
      for (const match of eligible) {
        const h = match.history;
        const positive = Math.max(0, units);
        if (day > h.sourceThrough) h.sourceThrough = day;
        if (day <= h.cutoffDate) {
          h.recordedUnits += positive;
          h.coveredSourceRows++;
        } else {
          match.daily.set(day, (match.daily.get(day) || 0) + positive);
        }
      }
    }
  }
  for (const matches of groups.values()) for (const match of matches) {
    match.history.postCutoff = [...match.daily].sort(([a], [b]) => a.localeCompare(b)).map(([day, units]) => ({ date:day, units }));
  }
  return histories;
}

// A separate cumulative result: never inject the residual into dated rows, net units or revenue.
export function ownerSalesTotalsForScope(histories = [], options = {}, warehouses = []) {
  const directory = new Map(warehouses.map(warehouse => [str(warehouse.id), warehouse]));
  const cids = options.cids?.length ? options.cids : options.cid ? [options.cid] : [];
  const pids = options.pids?.length ? options.pids : options.pid ? [options.pid] : [];
  const rows = [];
  for (const history of histories || []) {
    if (history.decision !== "accepted") continue;
    if (pids.length && !pids.includes(history.pid)) continue;
    if (cids.length && !history.cids.some(cid => cids.includes(cid))) continue;
    if (options.wid && options.wid !== history.wid) continue;
    if (options.channel && options.channel !== history.channel) continue;
    const warehouse = directory.get(history.wid);
    if (options.region && options.region !== warehouse?.region) continue;
    if (options.state && options.state !== warehouse?.st) continue;
    const to = date(options.to) || [history.sourceThrough, history.cutoffDate].sort().at(-1);
    if (to < history.cutoffDate) continue;
    const laterUnits = (history.postCutoff || []).reduce((sum, row) => sum + (row.date <= to ? row.units : 0), 0);
    const fullPeriodSelected = (!options.from || options.from <= history.startDate) && (!cids.length || history.cids.every(cid => cids.includes(cid)));
    rows.push({
      id:history.id, pid:history.pid, wid:history.wid, channel:history.channel, cids:history.cids,
      warehouse:warehouse?.name || history.wid || "Online", startDate:history.startDate, cutoffDate:history.cutoffDate,
      through:to, recordedUnits:history.recordedUnits + laterUnits, correctionUnits:history.correctedUnits - history.recordedUnits,
      correctedUnits:history.correctedUnits + laterUnits, acceptedCutoffUnits:history.correctedUnits, laterUnits,
      fullPeriodSelected, coveredSourceRows:history.coveredSourceRows,
    });
  }
  return {
    rows,
    recordedUnits:rows.reduce((sum, row) => sum + row.recordedUnits, 0),
    correctionUnits:rows.reduce((sum, row) => sum + row.correctionUnits, 0),
    correctedUnits:rows.reduce((sum, row) => sum + row.correctedUnits, 0),
    partialScope:rows.some(row => !row.fullPeriodSelected),
  };
}
