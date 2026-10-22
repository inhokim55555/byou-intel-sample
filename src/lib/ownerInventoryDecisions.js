import { campaignChannelSupports } from "./campaignChannel.js";
// Durable business decisions, not expiring physical-count attestations or raw transactions.
export const OWNER_INVENTORY_SHEET = "Owner_Inventory_Decisions";
export const OWNER_INVENTORY_FIELDS = ["id", "version", "pid", "wid", "warehouseName", "cid", "grain", "cutoffDate", "basisDate", "basisOnHand", "onHand", "state"];
const states = ["accepted", "sold_out", "retained", "watch", "last_known", "transfer", "excluded", "revoked"];
const text = value => String(value ?? "").trim();
const nameKey = value => text(value).toLowerCase().replace(/\s+/g, " ");
const date = value => { const parsed = new Date(`${value}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(text(value)) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; };
const scopeKey = r => [r.pid, r.cid, r.grain, r.wid].join("|");
function fail(message) { throw Object.assign(new Error(`Owner inventory decisions: ${message}`), { status:422 }); }

export function normalizeOwnerInventoryDecisions(records = [], dataset = {}) {
  if (!Array.isArray(records) || records.length > 10000) fail("invalid record list");
  const byId = new Map();
  const versions = new Map();
  for (const source of records) {
    if (!source || Object.keys(source).some(k => !OWNER_INVENTORY_FIELDS.includes(k))) fail("unsupported fields; private notes must remain private");
    const r = Object.fromEntries(OWNER_INVENTORY_FIELDS.map(k => [k, source[k]]));
    if (!/^[\w-]{1,100}$/.test(r.id) || !Number.isSafeInteger(r.version) || r.version < 1 || !states.includes(r.state)) fail("invalid identity, version or state");
    const product = Object.values(dataset.productMeta || {}).find(p => p.id === r.pid);
    const campaign = Object.values(dataset.campaignMeta || {}).find(c => c.id === r.cid);
    if (!product || !campaign || campaign.pid !== r.pid) fail(`unknown product/campaign for ${r.id}`);
    if (!["physical_warehouse", "online_aggregate"].includes(r.grain)) fail("invalid grain");
    if (!campaignChannelSupports(campaign.channel, r.grain === "online_aggregate" ? "online" : "inline")) fail(`incompatible campaign channel for ${r.id}`);
    const whs = (dataset.whs || []).filter(w => w.id === r.wid && nameKey(w.name) === nameKey(r.warehouseName));
    if (r.grain === "physical_warehouse" ? whs.length !== 1 : r.wid !== "" || r.warehouseName !== "") fail(`warehouse identity changed for ${r.id}`);
    if (!date(r.cutoffDate) || !date(r.basisDate) || r.basisDate > r.cutoffDate || (campaign.start && r.cutoffDate < campaign.start)) fail("invalid dates");
    if (![r.onHand, r.basisOnHand].every(n => Number.isSafeInteger(n) && n >= 0)) fail("invalid quantity");
    if (["excluded", "sold_out"].includes(r.state) && r.onHand !== 0) fail("excluded/sold-out balance must be zero");
    const versionKey = `${r.id}|${r.version}`;
    if (versions.has(versionKey) && versions.get(versionKey) !== JSON.stringify(r)) fail("conflicting same-version decision");
    versions.set(versionKey, JSON.stringify(r));
    const old = byId.get(r.id);
    if (old && (scopeKey(old) !== scopeKey(r) || old.warehouseName !== r.warehouseName)) fail("decision identity changed");
    if (old && old.version === r.version && JSON.stringify(old) !== JSON.stringify(r)) fail("conflicting same-version decision");
    if (!old || r.version > old.version) byId.set(r.id, r);
  }
  const result = [...byId.values()].sort((a,b) => a.id.localeCompare(b.id));
  const scopes = new Set();
  for (const r of result.filter(r => r.state !== "revoked")) {
    if (scopes.has(scopeKey(r))) fail("overlapping decisions; revise the existing record");
    scopes.add(scopeKey(r));
  }
  return result;
}

export function mergeOwnerInventoryDecisions(previous = [], incoming = [], dataset = {}) {
  return normalizeOwnerInventoryDecisions([...previous, ...incoming], dataset);
}

export function ownerInventoryDecisionsFromSheet(rows = [], dataset = {}) {
  return normalizeOwnerInventoryDecisions(rows.map(row => {
    if (Object.keys(row).some(k => k !== "__row" && !OWNER_INVENTORY_FIELDS.includes(k))) fail("unsupported sheet column");
    return Object.fromEntries(OWNER_INVENTORY_FIELDS.map(k => [k, ["version", "basisOnHand", "onHand"].includes(k) ? (row[k] === "" || row[k] == null ? null : Number(row[k])) : text(row[k])]));
  }), dataset);
}

export function matchingOwnerInventoryDecision(records = [], scope = {}, asOfDate = "") {
  return records.find(r => r.state !== "revoked" && scopeKey(r) === scopeKey(scope) && r.cutoffDate <= asOfDate) || null;
}

export function resolveOwnerInventoryDecision(records = [], scope = {}, rows = [], asOfDate = "") {
  const decision = matchingOwnerInventoryDecision(records, scope, asOfDate);
  if (!decision) return null;
  rows = rows.filter(r => r.pid === decision.pid && r.cid === decision.cid && (decision.grain === "online_aggregate" || r.wid === decision.wid));
  const known = rows.filter(r => r.date <= asOfDate && r.invKnown !== false && r.inv !== null && r.inv !== undefined && r.inv !== "" && Number.isFinite(Number(r.inv))).sort((a,b) => a.date.localeCompare(b.date));
  const latest = known.at(-1);
  const post = known.filter(r => r.date > decision.cutoffDate);
  let prior = decision.basisOnHand;
  let priorDate = decision.cutoffDate;
  let conflict = "";
  for (const r of post) {
    const sameDate = post.filter(x => x.date === r.date);
    if (sameDate.some(x => Number(x.inv) !== Number(r.inv))) conflict = "conflicting-latest-source";
    const units = rows.filter(x => x.date > priorDate && x.date <= r.date).reduce((sum,x) => sum + Number(x.units || 0), 0);
    const threshold = decision.grain === "online_aggregate" ? Math.max(500, prior * 0.25) : 250;
    const adjustment = Number(r.inv) - prior + units;
    if (decision.grain === "physical_warehouse" ? adjustment <= -threshold : Math.abs(adjustment) >= threshold) conflict = "material-new-inventory-adjustment";
    prior = Number(r.inv); priorDate = r.date;
  }
  // Exclusions are scope decisions. Later raw rows cannot silently reverse them.
  if (decision.state === "excluded") conflict = "";
  // Historical corrections/backfills that change the reviewed basis need investigation.
  const basis = known.filter(r => r.date === decision.basisDate);
  if (basis.length && basis.some(r => Number(r.inv) !== decision.basisOnHand) && decision.state !== "excluded") conflict = "reviewed-source-fact-changed";
  const onHand = decision.state === "excluded" || decision.state === "sold_out" ? 0 : post.length ? Math.max(0, Number(latest.inv)) : decision.onHand;
  // Sales of the already-reviewed return tail do not reopen the sold-out decision.
  if (decision.state === "sold_out" && post.some(r => Number(r.inv) > Math.max(2, decision.basisOnHand))) conflict = "new-stock-after-sold-out";
  return {
    decision, applied:!conflict, conflict, onHand,
    date:post.length ? latest.date : decision.basisDate,
    soldThrough:decision.state === "sold_out" || (post.length > 0 && onHand === 0 && decision.state !== "excluded"),
    includeInTotals:!conflict && decision.state !== "excluded",
    consumerEligible:!["retained", "transfer", "excluded"].includes(decision.state),
    watch:decision.state === "watch",
    lastKnown:decision.state === "last_known" && (post.length ? latest.date : decision.basisDate) < asOfDate,
  };
}

export function applyOwnerInventoryResult(item, result) {
  if (result?.conflict) return { ...item, ownerInventoryResult:result, countsAsStocked:false, soldThrough:false, flowRows:[], flowEligible:false, reviewEligible:false, inventoryValidation:{ ...item.inventoryValidation, requiresReview:true, reasonCodes:[result.conflict] } };
  if (!result?.applied) return { ...item, ownerInventoryResult:result };
  return {
    ...item, ownerInventoryResult:result, onHand:result.onHand, available:result.onHand, date:result.date,
    countsAsStocked:result.includeInTotals && result.onHand > 0,
    soldThrough:result.soldThrough, lifecycleState:result.soldThrough ? "sold-through" : item.lifecycleState,
    reviewEligible:false, reviewDisposition:null,
    inventoryValidation:{ ...item.inventoryValidation, requiresReview:false, watchRequired:false, ownerDecisionApplied:true },
    // Owner corrections do not create dated inventory movement.
    flowRows:[], flowEligible:false,
  };
}

export function consumerWarehouseHiddenScopes(decisions = []) {
  return new Set(decisions.filter(r => ["retained", "excluded"].includes(r.state) && r.grain === "physical_warehouse").map(r => [r.pid,r.cid,r.wid].join("|")));
}

export function consumerWarehouseSales(rows = [], decisions = []) {
  const hidden = consumerWarehouseHiddenScopes(decisions);
  if (!hidden.size) return rows;
  return rows.filter(r => !hidden.has([r.pid,r.cid,r.wid].join("|")));
}
