import { warehouseIdentityType } from "./warehouseIdentity.js";
import { campaignChannelSupports } from "./campaignChannel.js";
const INVENTORY_COVERAGE_MIN_RECORDED_INVENTORY = 2;
export const INVENTORY_MANUAL_REVIEW_THRESHOLD = 1000;
export const INVENTORY_WATCH_THRESHOLD = 700;
export const INVENTORY_ADDITION_REVIEW_THRESHOLD = 250;
export const INVENTORY_REMOVAL_REVIEW_THRESHOLD = 250;
export const INVENTORY_REVIEW_LOOKBACK_DAYS = 14;
export const INVENTORY_REFUND_PROXY_LOOKBACK_DAYS = 30;
export const INVENTORY_REFUND_PROXY_MAX_ON_HAND = 2;
export const ONLINE_INVENTORY_ADDITION_MINIMUM = 500;
export const ONLINE_INVENTORY_ADDITION_RATIO = 0.25;
export const ONLINE_INVENTORY_REVIEW_LOOKBACK_DAYS = 30;

export const INVENTORY_ELIGIBILITY_STATES = Object.freeze({
  NON_STORE:"non-store",
  UNKNOWN:"unknown",
  NEVER_STOCKED:"never-stocked",
  TOKEN_OR_PHANTOM:"token-or-phantom",
  REFUND_PROXY:"refund-proxy",
  UNVERIFIED_ALLOCATION:"unverified-allocation",
  CURRENT_STOCKED:"current-stocked",
  SOLD_THROUGH:"sold-through",
  UNSUPPORTED_ZERO:"unsupported-zero",
});

export function campaignRevenueDoorDenominatorSources(portfolioRows = [], productRows = [], selection = {}) {
  const normalizedPortfolioRows = Array.isArray(portfolioRows) ? portfolioRows : [];
  const normalizedProductRows = Array.isArray(productRows) ? productRows : [];
  const focusedCampaign = !!(selection.campaignPid || selection.campaignCid);
  return {
    overallRows:!focusedCampaign && normalizedPortfolioRows.length ? normalizedPortfolioRows : normalizedProductRows,
    productRows:normalizedProductRows,
  };
}

function warehouseText(warehouse = {}) {
  return [
    warehouse.name,
    warehouse.city,
    warehouse.st,
    warehouse.region,
    warehouse.id,
    warehouse.warehouseNo,
  ].filter(Boolean).join(" ");
}

function uniqueWarehouseRows(rows = []) {
  const seen = new Set();
  return rows.filter((row, index) => {
    const id = String(row?.id || row?.wid || "").trim().toLowerCase();
    const fallback = warehouseText(row).trim().toLowerCase();
    const key = id ? `id:${id}` : fallback ? `text:${fallback}` : `row:${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isNonStoreWarehouse(warehouse = {}) {
  return warehouseIdentityType(warehouse) === "facility";
}

export function isInventoryCoverageWarehouse(warehouse = {}) {
  return !!warehouse?.id && !isNonStoreWarehouse(warehouse);
}

export function inventoryCampaignScopeKey(row = {}) {
  return [row?.wid, row?.pid, row?.cid].map(value => String(value || "")).join("|");
}

export function inventoryProductWarehouseKey(row = {}) {
  return [row?.wid ?? row?.warehouseId, row?.pid ?? row?.productId].map(value => String(value || "")).join("|");
}

export function inventoryCampaignActiveAt(campaign = {}, product = {}, options = {}) {
  const asOfDate = String(options.asOfDate || "").slice(0, 10);
  const grain = String(options.grain || "physical_warehouse");
  const requestedChannel = grain === "online_aggregate" ? "online" : "inline";
  const campaignId = String(campaign?.id || "").trim();
  const productId = String(product?.id || "").trim();
  const campaignProductId = String(campaign?.pid || "").trim();
  const campaignChannel = String(campaign?.channel || campaign?.salesChannel || "").trim();
  if (!campaignId || !productId || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) return false;
  if (!campaignChannel) return false;
  if (campaign?.active === false || product?.active === false) return false;
  if (campaignProductId && campaignProductId.toLowerCase() !== productId.toLowerCase()) return false;
  if (campaign?.start && asOfDate < String(campaign.start).slice(0, 10)) return false;
  if (campaign?.end && asOfDate > String(campaign.end).slice(0, 10)) return false;
  return campaignChannelSupports(campaignChannel, requestedChannel);
}

export function dateAwareCampaignOptions(campaigns = [], asOfDate = "", selectedIds = []) {
  const date = String(asOfDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [...(campaigns || [])];
  const selected = new Set((selectedIds || []).map(value => String(value || "").trim()).filter(Boolean));
  return (campaigns || []).filter(campaign => {
    const id = String(campaign?.id || "").trim();
    if (id && selected.has(id)) return true;
    const start = String(campaign?.start || "").slice(0, 10);
    const end = String(campaign?.end || "").slice(0, 10);
    if (start && date < start) return false;
    if (end && date > end) return false;
    return true;
  });
}

function inventoryReviewDispositionScopeMatches(disposition = {}, scope = {}) {
  const grain = String(scope?.grain || "physical_warehouse");
  if (String(disposition?.grain || "") !== grain) return false;
  if (String(disposition?.pid || "") !== String(scope?.pid || "")) return false;
  if (String(disposition?.cid || "") !== String(scope?.cid || "")) return false;
  return grain !== "physical_warehouse" || String(disposition?.wid || "") === String(scope?.wid || "");
}

export function matchingInventoryReviewDisposition(dispositions = [], scope = {}) {
  const matching = (dispositions || []).filter(disposition => inventoryReviewDispositionScopeMatches(disposition, scope));
  const rejected = matching.find(disposition => disposition?.decision === "rejected");
  if (rejected) return rejected;
  const inventoryDate = String(scope?.inventoryDate || "").slice(0, 10);
  const onHand = Number(scope?.onHand);
  if (!inventoryDate || !Number.isFinite(onHand)) return null;
  return matching.find(disposition => (
    disposition?.decision === "reviewed_quarantined"
    && (!disposition?.inventoryDate || inventoryDate >= String(disposition.inventoryDate).slice(0, 10))
    && Number.isFinite(Number(disposition?.onHand))
    && onHand - Number(disposition.onHand) < INVENTORY_ADDITION_REVIEW_THRESHOLD
    && Number(disposition.onHand) - onHand < INVENTORY_REMOVAL_REVIEW_THRESHOLD
  )) || null;
}

export function aggregateOnlineInventoryRows(rows = []) {
  const grouped = new Map();
  for (const row of rows || []) {
    const date = String(row?.date || "").slice(0, 10);
    const pid = String(row?.pid || "");
    const cid = String(row?.cid || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !pid || !cid) continue;
    const key = `${date}|${pid}|${cid}`;
    const current = grouped.get(key) || {
      ...row,
      date,
      pid,
      cid,
      channel:"Online aggregate",
      inv:0,
      invKnown:true,
      units:0,
      rev:0,
      promo:0,
      promoUnits:0,
      refund:0,
      refundUnits:0,
      orders:0,
      sessions:0,
      adSpend:0,
      inbound:0,
      reserved:0,
      inboundKnown:true,
      reservedKnown:true,
      sourceChannels:[],
    };
    const inventoryKnown = inventoryRowHasKnownBalance(row);
    current.invKnown = current.invKnown && inventoryKnown;
    if (inventoryKnown) current.inv += Number(row.inv || 0);
    for (const field of ["units", "rev", "promo", "promoUnits", "refund", "refundUnits", "orders", "sessions", "adSpend"]) {
      current[field] += Number(row?.[field] || 0);
    }
    current.inboundKnown = current.inboundKnown && row?.inboundKnown === true && Number.isFinite(Number(row?.inbound));
    current.reservedKnown = current.reservedKnown && row?.reservedKnown === true && Number.isFinite(Number(row?.reserved));
    if (row?.inboundKnown === true && Number.isFinite(Number(row?.inbound))) current.inbound += Number(row.inbound);
    if (row?.reservedKnown === true && Number.isFinite(Number(row?.reserved))) current.reserved += Number(row.reserved);
    const channel = String(row?.channel || "Online").trim();
    if (channel && !current.sourceChannels.includes(channel)) current.sourceChannels.push(channel);
    grouped.set(key, current);
  }
  return [...grouped.values()].map(row => ({
    ...row,
    inv:row.invKnown ? row.inv : 0,
    sourceChannels:[...row.sourceChannels].sort(),
  })).sort((a, b) => a.date.localeCompare(b.date) || a.pid.localeCompare(b.pid) || a.cid.localeCompare(b.cid));
}

export function crediblePositiveSales({ positiveUnits = 0, positiveRevenue = 0, netUnits = 0, netRevenue = 0, revenue = netRevenue } = {}) {
  const signedRevenue = Number(netRevenue ?? revenue ?? 0);
  const signedUnits = Number(netUnits || 0);
  const hasPositiveGross = Number(positiveUnits || 0) > 0 || Number(positiveRevenue || 0) > 0 || signedUnits > 0 || signedRevenue > 0;
  const hasPositiveNet = signedUnits > 0 || signedRevenue > 0;
  return hasPositiveGross && hasPositiveNet && signedUnits >= 0 && signedRevenue >= 0;
}

export function shouldIncludeInventoryAnalysisItem(warehouse, { onHand = 0, totalUnits = 0, revenue = 0 } = {}) {
  if (!isInventoryCoverageWarehouse(warehouse)) return false;

  const inventory = Math.max(0, Number(onHand || 0));
  const soldUnits = Math.max(0, Number(totalUnits || 0));
  const netRevenue = Number(revenue || 0);
  const isEmptyOrRefundArtifact = inventory <= 1 && soldUnits <= 0 && netRevenue <= 0;

  return !isEmptyOrRefundArtifact;
}

export function shouldIncludeInventoryCoverageItem(warehouse, { onHand = 0, peakOnHand = 0, netUnits = 0, revenue = 0, positiveUnits = 0, positiveRevenue = 0 } = {}) {
  if (!isInventoryCoverageWarehouse(warehouse)) return false;
  const recordedInventory = Math.max(0, Number(onHand || 0), Number(peakOnHand || 0));
  return Number(onHand || 0) > 0
    && recordedInventory >= INVENTORY_COVERAGE_MIN_RECORDED_INVENTORY
    && crediblePositiveSales({ positiveUnits, positiveRevenue, netUnits, netRevenue:revenue });
}

export function inventoryRowHasKnownBalance(row = {}) {
  if (row?.invKnown === false) return false;
  if (row?.invKnown === true) return row?.inv !== null && row?.inv !== undefined && String(row.inv).trim() !== "" && Number.isFinite(Number(row.inv));
  if (!Object.prototype.hasOwnProperty.call(row || {}, "inv")) return false;
  if (row?.inv === null || row?.inv === undefined || String(row.inv).trim() === "") return false;
  return Number.isFinite(Number(row.inv));
}

export function inventoryCoverageEvidence(rows = []) {
  const sorted = [...rows].sort((a, b) => String(a?.date || "").localeCompare(String(b?.date || "")));
  const knownRows = sorted.filter(inventoryRowHasKnownBalance);
  const latest = knownRows[knownRows.length - 1] || {};
  const firstMeaningfulInventory = knownRows.find(row => Number(row?.inv || 0) >= INVENTORY_COVERAGE_MIN_RECORDED_INVENTORY);
  const firstMeaningfulInventoryDate = String(firstMeaningfulInventory?.date || "").slice(0, 10);
  const hasExplicitZeroBeforeAllocation = knownRows.some(row => (
    String(row?.date || "").slice(0, 10) < firstMeaningfulInventoryDate
    && row?.invKnown === true
    && Number(row?.inv || 0) === 0
  ));
  const postAllocationRows = firstMeaningfulInventoryDate && hasExplicitZeroBeforeAllocation
    ? sorted.filter(row => String(row?.date || "").slice(0, 10) >= firstMeaningfulInventoryDate)
    : sorted;
  const positiveUnits = sorted.reduce((sum, row) => sum + Math.max(0, Number(row?.units || 0)), 0);
  const positiveRevenue = sorted.reduce((sum, row) => sum + Math.max(0, Number(row?.rev || 0)), 0);
  const netUnits = sorted.reduce((sum, row) => sum + Number(row?.units || 0), 0);
  const netRevenue = sorted.reduce((sum, row) => sum + Number(row?.rev || 0), 0);
  const postAllocationPositiveUnits = postAllocationRows.reduce((sum, row) => sum + Math.max(0, Number(row?.units || 0)), 0);
  const postAllocationPositiveRevenue = postAllocationRows.reduce((sum, row) => sum + Math.max(0, Number(row?.rev || 0)), 0);
  const postAllocationNetUnits = postAllocationRows.reduce((sum, row) => sum + Number(row?.units || 0), 0);
  const postAllocationNetRevenue = postAllocationRows.reduce((sum, row) => sum + Number(row?.rev || 0), 0);
  const hasPositiveSale = postAllocationPositiveUnits > 0 || postAllocationPositiveRevenue > 0;
  const latestHasExplicitKnownFlag = Object.prototype.hasOwnProperty.call(latest || {}, "invKnown");
  const latestInventoryAmbiguousLegacyZero = knownRows.length > 0
    && !latestHasExplicitKnownFlag
    && Number(latest?.inv || 0) === 0;
  return {
    inventoryKnown:knownRows.length > 0,
    inventoryKnownRows:knownRows.length,
    latestInventoryDate:String(latest?.date || "").slice(0, 10),
    onHand:knownRows.length ? Math.max(0, Number(latest.inv || 0)) : null,
    peakOnHand:knownRows.length ? knownRows.reduce((peak, row) => Math.max(peak, Number(row?.inv || 0)), 0) : null,
    totalUnits:sorted.reduce((sum, row) => sum + Math.max(0, Number(row?.units || 0)), 0),
    positiveUnits,
    netUnits,
    positiveRevenue,
    revenue:netRevenue,
    netRevenue,
    postAllocationPositiveUnits,
    postAllocationNetUnits,
    postAllocationPositiveRevenue,
    postAllocationNetRevenue,
    firstMeaningfulInventoryDate,
    latestInventoryAmbiguousLegacyZero,
    crediblePositiveSales:hasPositiveSale && crediblePositiveSales({
      positiveUnits:postAllocationPositiveUnits,
      positiveRevenue:postAllocationPositiveRevenue,
      netUnits:postAllocationNetUnits,
      netRevenue:postAllocationNetRevenue,
    }),
  };
}

export function inventoryRefundProxyEvidence(rows = [], options = {}) {
  const lookbackDays = Math.max(1, Number(options.lookbackDays || INVENTORY_REFUND_PROXY_LOOKBACK_DAYS));
  const datedRows = [...rows]
    .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(String(row?.date || "").slice(0, 10)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const requestedEnd = String(options.asOfDate || "").slice(0, 10);
  const endDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedEnd)
    ? requestedEnd
    : String(datedRows.at(-1)?.date || "").slice(0, 10);
  const endDateValue = isoDateAtUtc(endDate);
  const startDate = endDateValue
    ? new Date(endDateValue.getTime() - (lookbackDays - 1) * 864e5).toISOString().slice(0, 10)
    : "";
  const recentRows = datedRows.filter(row => {
    const date = String(row.date).slice(0, 10);
    return (!startDate || date >= startDate) && (!endDate || date <= endDate);
  });
  const positiveUnits = recentRows.reduce((sum, row) => sum + Math.max(0, Number(row?.units || 0)), 0);
  const positiveRevenue = recentRows.reduce((sum, row) => sum + Math.max(0, Number(row?.rev || 0)), 0);
  const netUnits = recentRows.reduce((sum, row) => sum + Number(row?.units || 0), 0);
  const netRevenue = recentRows.reduce((sum, row) => sum + Number(row?.rev || 0), 0);
  const refundUnits = recentRows.reduce((sum, row) => sum + Math.abs(Number(row?.refundUnits || 0)), 0);
  const refundRevenue = recentRows.reduce((sum, row) => sum + Math.abs(Number(row?.refund || 0)), 0);
  const hasPositiveSale = positiveUnits > 0 || positiveRevenue > 0;
  const hasReturnMovement = netUnits < 0 || netRevenue < 0 || refundUnits > 0 || refundRevenue > 0;
  return {
    isRefundProxy:recentRows.length > 0 && !hasPositiveSale && hasReturnMovement,
    lookbackDays,
    startDate,
    endDate,
    positiveUnits,
    positiveRevenue,
    netUnits,
    netRevenue,
    refundUnits,
    refundRevenue,
  };
}

function validInventoryApproval(attestation, evidence, evaluationDate) {
  if (!attestation || typeof attestation !== "object") return false;
  const evaluatedOn = String(evaluationDate || evidence?.latestInventoryDate || "").slice(0, 10);
  const approvalDate = String(attestation.approvalDate || "").slice(0, 10);
  const expiresOn = String(attestation.expiresOn || "").slice(0, 10);
  const inventoryStatus = String(attestation.inventoryStatus || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return attestation.approved === true
    && inventoryStatus === "onhand"
    && String(attestation.inventoryDate || "").slice(0, 10) === evidence?.latestInventoryDate
    && Number(attestation.onHand) === Math.max(0, Number(evidence?.onHand || 0))
    && /^\d{4}-\d{2}-\d{2}$/.test(approvalDate)
    && approvalDate <= evaluatedOn
    && /^\d{4}-\d{2}-\d{2}$/.test(expiresOn)
    && expiresOn >= evaluatedOn;
}

export function matchingInventoryApproval(approvals = [], scope = {}, evaluationDate = "") {
  const evaluatedOn = String(evaluationDate || "").slice(0, 10);
  const grain = String(scope?.grain || "physical_warehouse");
  return (approvals || []).find(attestation => (
    attestation?.approved === true
    && String(attestation?.inventoryStatus || "").toLowerCase().replace(/[^a-z0-9]+/g, "") === "onhand"
    && String(attestation?.grain || "") === grain
    && (grain !== "physical_warehouse" || String(attestation?.wid || "") === String(scope?.wid || ""))
    && String(attestation?.pid || "") === String(scope?.pid || "")
    && String(attestation?.cid || "") === String(scope?.cid || "")
    && String(attestation?.inventoryDate || "").slice(0, 10) === String(scope?.inventoryDate || "").slice(0, 10)
    && Number(attestation?.onHand) === Number(scope?.onHand)
    && /^\d{4}-\d{2}-\d{2}$/.test(String(attestation?.approvalDate || "").slice(0, 10))
    && String(attestation.approvalDate).slice(0, 10) <= evaluatedOn
    && /^\d{4}-\d{2}-\d{2}$/.test(String(attestation?.expiresOn || "").slice(0, 10))
    && String(attestation.expiresOn).slice(0, 10) >= evaluatedOn
  )) || null;
}

export function inventoryEligibilityState(rows = [], warehouse = {}, options = {}) {
  const stateResult = (state, evidence, extra = {}) => ({
    state,
    evidence,
    countsAsStocked:false,
    soldThrough:false,
    flowEligible:false,
    requiresReview:false,
    suppressed:true,
    reasonCodes:[],
    ...extra,
  });
  const evidence = options.coverageEvidence || inventoryCoverageEvidence(rows);
  const grain = String(options.grain || "physical_warehouse");
  if (grain === "physical_warehouse" && !isInventoryCoverageWarehouse(warehouse)) {
    return stateResult(INVENTORY_ELIGIBILITY_STATES.NON_STORE, evidence);
  }
  if (!evidence.inventoryKnown) {
    return stateResult(INVENTORY_ELIGIBILITY_STATES.UNKNOWN, evidence);
  }

  const onHand = Math.max(0, Number(evidence.onHand || 0));
  const peakOnHand = Math.max(0, Number(evidence.peakOnHand || 0));
  const hasMeaningfulAllocation = peakOnHand >= INVENTORY_COVERAGE_MIN_RECORDED_INVENTORY;
  const asOfDate = String(options.asOfDate || evidence.latestInventoryDate || "").slice(0, 10);
  const evaluationDate = String(options.evaluationDate || asOfDate).slice(0, 10);
  const approvedAllocation = validInventoryApproval(options.approvedAllocation, evidence, evaluationDate);
  const credibleAllocation = evidence.crediblePositiveSales || approvedAllocation;

  if (!hasMeaningfulAllocation) {
    if (peakOnHand <= 0) return stateResult(INVENTORY_ELIGIBILITY_STATES.NEVER_STOCKED, evidence);
    return stateResult(INVENTORY_ELIGIBILITY_STATES.TOKEN_OR_PHANTOM, evidence);
  }

  if (onHand <= 0) {
    if (evidence.latestInventoryAmbiguousLegacyZero) {
      return stateResult(INVENTORY_ELIGIBILITY_STATES.UNSUPPORTED_ZERO, evidence);
    }
    if (evidence.crediblePositiveSales) {
      return stateResult(INVENTORY_ELIGIBILITY_STATES.SOLD_THROUGH, evidence, {
        soldThrough:true,
        flowEligible:true,
        suppressed:false,
      });
    }
    return stateResult(INVENTORY_ELIGIBILITY_STATES.UNSUPPORTED_ZERO, evidence);
  }

  const refundProxyEvidence = grain === "physical_warehouse"
    ? inventoryRefundProxyEvidence(rows, { asOfDate, lookbackDays:options.refundProxyLookbackDays })
    : null;
  if (!approvedAllocation
    && onHand <= INVENTORY_REFUND_PROXY_MAX_ON_HAND
    && refundProxyEvidence?.isRefundProxy) {
    return stateResult(INVENTORY_ELIGIBILITY_STATES.REFUND_PROXY, evidence, {
      reasonCodes:["refund-proxy"],
      refundProxyEvidence,
    });
  }

  if (!credibleAllocation) {
    return stateResult(INVENTORY_ELIGIBILITY_STATES.UNVERIFIED_ALLOCATION, evidence, {
      requiresReview:true,
      suppressed:false,
      reasonCodes:["unverified-allocation"],
    });
  }

  return stateResult(INVENTORY_ELIGIBILITY_STATES.CURRENT_STOCKED, evidence, {
    countsAsStocked:true,
    flowEligible:true,
    suppressed:false,
  });
}

function inventoryFlowBlockingDate(sortedRows = [], knownRows = [], options = {}, grain = "physical_warehouse") {
  if (knownRows.length < 2) return "";
  const unitsByDate = new Map();
  for (const row of sortedRows) {
    const date = String(row?.date || "").slice(0, 10);
    const units = grain === "online_aggregate"
      ? Number(row?.units || row?.orders || 0)
      : Number(row?.units || 0);
    unitsByDate.set(date, Number(unitsByDate.get(date) || 0) + units);
  }
  const unitsThroughDate = new Map();
  let runningUnits = 0;
  for (const date of [...unitsByDate.keys()].sort()) {
    runningUnits += Number(unitsByDate.get(date) || 0);
    unitsThroughDate.set(date, runningUnits);
  }
  const unitsAfter = (priorDate, currentDate) => (
    Number(unitsThroughDate.get(currentDate) || 0) - Number(unitsThroughDate.get(priorDate) || 0)
  );
  const events = [];
  const physicalLookbackDays = Math.max(1, Number(options.lookbackDays || INVENTORY_REVIEW_LOOKBACK_DAYS));
  const onlineLookbackDays = Math.max(1, Number(options.lookbackDays || ONLINE_INVENTORY_REVIEW_LOOKBACK_DAYS));
  const removalThreshold = Number(options.removalReviewThreshold || INVENTORY_REMOVAL_REVIEW_THRESHOLD);
  const minimumAddition = Math.max(0, Number(options.minimumAddition ?? ONLINE_INVENTORY_ADDITION_MINIMUM));
  const additionRatio = Math.max(0, Number(options.additionRatio ?? ONLINE_INVENTORY_ADDITION_RATIO));
  for (let index = 1; index < knownRows.length; index += 1) {
    const prior = knownRows[index - 1];
    const current = knownRows[index];
    const priorDate = String(prior?.date || "").slice(0, 10);
    const currentDate = String(current?.date || "").slice(0, 10);
    const priorDateValue = isoDateAtUtc(priorDate);
    const currentDateValue = isoDateAtUtc(currentDate);
    if (!priorDateValue || !currentDateValue || currentDateValue <= priorDateValue) continue;
    const gapDays = Math.round((currentDateValue.getTime() - priorDateValue.getTime()) / 864e5);
    const impliedAddition = Number(current?.inv || 0) - Number(prior?.inv || 0) + unitsAfter(priorDate, currentDate);
    if (grain === "online_aggregate") {
      const threshold = Math.max(minimumAddition, Math.abs(Number(prior?.inv || 0)) * additionRatio);
      if (impliedAddition >= threshold) events.push({ priorDate, currentDate });
    } else if (gapDays < physicalLookbackDays && Math.max(0, -impliedAddition) >= removalThreshold) {
      events.push({ priorDate, currentDate });
    }
  }
  if (!events.length) return "";
  const firstEventDate = events.reduce((earliest, event) => !earliest || event.currentDate < earliest ? event.currentDate : earliest, "");

  const knownDates = [...new Set(knownRows.map(row => String(row?.date || "").slice(0, 10)))];
  for (const date of knownDates) {
    if (date < firstEventDate) continue;
    const dateValue = isoDateAtUtc(date);
    if (!dateValue) continue;
    const lookbackDays = grain === "online_aggregate" ? onlineLookbackDays : physicalLookbackDays;
    const reviewStart = new Date(dateValue.getTime() - (lookbackDays - 1) * 864e5).toISOString().slice(0, 10);
    const mayRequireReview = grain === "online_aggregate"
      ? events.some(event => event.currentDate >= reviewStart && event.currentDate <= date)
      : events.some(event => event.currentDate <= date && event.priorDate >= reviewStart);
    if (!mayRequireReview) continue;
    const prefix = sortedRows.filter(row => String(row?.date || "").slice(0, 10) <= date);
    const validation = grain === "online_aggregate"
      ? onlineInventoryValidationEvidence(prefix, { ...options, asOfDate:date })
      : inventoryValidationEvidence(prefix, { ...options, asOfDate:date });
    if (validation.requiresReview) return date;
  }
  return "";
}

export function inventoryFlowEligibleRows(rows = [], warehouse = {}, options = {}) {
  const grain = String(options.grain || "physical_warehouse");
  if (grain === "physical_warehouse" && !isInventoryCoverageWarehouse(warehouse)) return [];
  const sorted = [...rows]
    .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(String(row?.date || "").slice(0, 10)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const knownRows = sorted.filter(inventoryRowHasKnownBalance);
  if (!knownRows.length) return [];
  if (!inventoryEligibilityState(sorted, warehouse, options).flowEligible) return [];

  const firstBlockingDate = inventoryFlowBlockingDate(sorted, knownRows, options, grain);

  const fullEvidence = inventoryCoverageEvidence(sorted);
  const evaluationDate = String(options.evaluationDate || options.asOfDate || fullEvidence.latestInventoryDate || "").slice(0, 10);
  const currentApprovalValid = validInventoryApproval(options.approvedAllocation, fullEvidence, evaluationDate);
  const validSegment = firstBlockingDate
    ? sorted.filter(row => {
        const date = String(row.date).slice(0, 10);
        return date < firstBlockingDate || (currentApprovalValid && date >= fullEvidence.latestInventoryDate);
      })
    : sorted;
  const evidence = inventoryCoverageEvidence(validSegment);
  const allocationVerified = evidence.crediblePositiveSales || validInventoryApproval(options.approvedAllocation, evidence, evaluationDate);
  if (!allocationVerified || !evidence.firstMeaningfulInventoryDate) return [];

  return validSegment.filter(row => inventoryRowHasKnownBalance(row)
    && String(row.date).slice(0, 10) >= evidence.firstMeaningfulInventoryDate
    && !(Number(row?.inv || 0) === 0 && !Object.prototype.hasOwnProperty.call(row || {}, "invKnown")));
}

export function inventorySellThrough(totalUnits = 0, onHand = 0) {
  const sold = Math.max(0, Number(totalUnits || 0));
  const inventory = Math.max(0, Number(onHand || 0));
  return sold + inventory > 0 ? (sold / (sold + inventory)) * 100 : 0;
}

export function filterWarehouseMatches(rows = [], query = "") {
  const uniqueRows = uniqueWarehouseRows(rows);
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return uniqueRows;
  return uniqueRows.filter(row => warehouseText(row).toLowerCase().includes(normalizedQuery));
}

export function scopeRowsToWarehouseMatches(rows = [], matches = [], query = "") {
  if (!String(query || "").trim()) return rows;
  const matchedIds = new Set(matches.map(row => row?.id || row?.wid).filter(Boolean));
  return rows.filter(row => matchedIds.has(row?.id || row?.wid));
}

export function verifiedSellingWarehouseStats(rows = [], warehouses = []) {
  const warehouseById = new Map(warehouses.map(warehouse => [warehouse?.id, warehouse]));
  const totalsByWarehouse = new Map();

  rows.forEach(row => {
    const wid = row?.wid;
    if (!wid || !warehouseById.has(wid)) return;
    const current = totalsByWarehouse.get(wid) || {
      netRevenue:0,
      netUnits:0,
      positiveRevenue:0,
      positiveUnits:0,
    };
    const revenue = Number(row?.rev || 0);
    const units = Number(row?.units || 0);
    current.netRevenue += Number.isFinite(revenue) ? revenue : 0;
    current.netUnits += Number.isFinite(units) ? units : 0;
    current.positiveRevenue += Number.isFinite(revenue) ? Math.max(0, revenue) : 0;
    current.positiveUnits += Number.isFinite(units) ? Math.max(0, units) : 0;
    totalsByWarehouse.set(wid, current);
  });

  const seenWarehouseIds = new Set();
  const locations = warehouses.map(warehouse => {
    if (!warehouse?.id || seenWarehouseIds.has(warehouse.id)) return null;
    seenWarehouseIds.add(warehouse.id);
    const totals = totalsByWarehouse.get(warehouse?.id);
    if (!totals || isNonStoreWarehouse(warehouse)) return null;
    return crediblePositiveSales(totals)
      ? { warehouseId:warehouse.id, ...totals }
      : null;
  }).filter(Boolean);

  return {
    count:locations.length,
    warehouseIds:locations.map(location => location.warehouseId),
    locations,
  };
}

function isoDateAtUtc(date) {
  const value = new Date(`${String(date || "").slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(value.getTime()) ? null : value;
}

export const CAMPAIGN_DEFAULT_START = "2024-05-07";

export function chartDateDomain(dateRange = {}, rows = [], options = {}) {
  const rowDates = (rows || [])
    .map(row => String(row?.date || "").slice(0, 10))
    .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  const fitToRows = options.fitToRows === true && rowDates.length > 0;
  const start = isoDateAtUtc(fitToRows ? rowDates[0] : dateRange.start || rowDates[0]);
  const end = isoDateAtUtc(fitToRows ? rowDates[rowDates.length - 1] : dateRange.end || rowDates[rowDates.length - 1]);
  if (!start || !end) return ["auto", "auto"];
  return [start.getTime(), end.getTime()];
}

export function salesTrendDateLabel(value, options = {}) {
  const date = typeof value === "number"
    ? new Date(value).toISOString().slice(0, 10)
    : String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return String(value || "");
  return options.spansYears === true
    ? `${date.slice(5, 7)}/${date.slice(2, 4)}`
    : `${date.slice(5, 7)}/${date.slice(8, 10)}`;
}

export function campaignMetricDateBounds(inlineRows = [], onlineRows = [], fallback = {}) {
  const validDates = rows => (rows || [])
    .map(row => String(row?.date || "").slice(0, 10))
    .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  const inlineDates = validDates(inlineRows);
  const chartDates = inlineDates.length ? inlineDates : validDates(onlineRows);
  return {
    start:chartDates[0] || String(fallback.start || "").slice(0, 10),
    end:chartDates[chartDates.length - 1] || String(fallback.end || "").slice(0, 10),
  };
}

export function inventoryValidationEvidence(rows = [], options = {}) {
  const manualReviewThreshold = Number(options.manualReviewThreshold || INVENTORY_MANUAL_REVIEW_THRESHOLD);
  const watchThreshold = Number(options.watchThreshold || INVENTORY_WATCH_THRESHOLD);
  const additionReviewThreshold = Number(options.additionReviewThreshold || INVENTORY_ADDITION_REVIEW_THRESHOLD);
  const removalReviewThreshold = Number(options.removalReviewThreshold || INVENTORY_REMOVAL_REVIEW_THRESHOLD);
  const lookbackDays = Math.max(1, Number(options.lookbackDays || INVENTORY_REVIEW_LOOKBACK_DAYS));
  const asOfDate = String(options.asOfDate || "").slice(0, 10);
  const datedRows = [...rows]
    .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(String(row?.date || "").slice(0, 10)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const cumulativeUnitsByDate = new Map();
  let cumulativeUnits = 0;
  for (const row of datedRows) {
    cumulativeUnits += Number(row?.units || 0);
    cumulativeUnitsByDate.set(String(row.date).slice(0, 10), cumulativeUnits);
  }
  const sorted = datedRows.filter(inventoryRowHasKnownBalance);
  const latest = sorted[sorted.length - 1] || {};
  const latestDate = String(latest.date || "").slice(0, 10);
  const latestOnHand = Math.max(0, Number(latest.inv || 0));
  const latestDateValue = isoDateAtUtc(latestDate);
  const recentStart = latestDateValue
    ? new Date(latestDateValue.getTime() - (lookbackDays - 1) * 864e5).toISOString().slice(0, 10)
    : "";
  const recentRows = recentStart ? sorted.filter(row => String(row.date).slice(0, 10) >= recentStart) : sorted;
  const recentPeakOnHand = recentRows.reduce((peak, row) => Math.max(peak, Number(row?.inv || 0)), 0);
  let largestAddition = 0;
  let largestAdditionDate = "";
  let largestAdditionGapDays = 0;
  let largestRemoval = 0;
  let largestRemovalDate = "";
  let largestRemovalGapDays = 0;

  for (let index = 1; index < recentRows.length; index += 1) {
    const prior = recentRows[index - 1];
    const current = recentRows[index];
    const priorDate = isoDateAtUtc(prior?.date);
    const currentDate = isoDateAtUtc(current?.date);
    if (!priorDate || !currentDate || currentDate <= priorDate) continue;
    const gapDays = Math.round((currentDate.getTime() - priorDate.getTime()) / 864e5);
    const interveningUnits = (cumulativeUnitsByDate.get(String(current.date).slice(0, 10)) || 0)
      - (cumulativeUnitsByDate.get(String(prior.date).slice(0, 10)) || 0);
    const impliedAddition = Number(current?.inv || 0) - Number(prior?.inv || 0) + interveningUnits;
    if (impliedAddition > largestAddition) {
      largestAddition = impliedAddition;
      largestAdditionDate = String(current.date).slice(0, 10);
      largestAdditionGapDays = gapDays;
    }
    const impliedRemoval = Math.max(0, -impliedAddition);
    if (impliedRemoval > largestRemoval) {
      largestRemoval = impliedRemoval;
      largestRemovalDate = String(current.date).slice(0, 10);
      largestRemovalGapDays = gapDays;
    }
  }

  const reasonCodes = [];
  const staleInventoryBalance = latestOnHand > 0 && /^\d{4}-\d{2}-\d{2}$/.test(asOfDate) && latestDate < asOfDate;
  if (staleInventoryBalance) reasonCodes.push("stale-inventory-balance");
  // Owner policy: multiple pallets and store-requested replenishment are routine.
  // Quantity and increases remain diagnostics, never review triggers on their own.
  if (largestRemoval >= removalReviewThreshold) reasonCodes.push("recent-large-inventory-removal");
  const coverageEvidence = options.coverageEvidence || inventoryCoverageEvidence(rows);
  const evaluationDate = String(options.evaluationDate || asOfDate).slice(0, 10);
  const approvalApplied = validInventoryApproval(options.approvedAllocation, coverageEvidence, evaluationDate)
    && (!staleInventoryBalance || String(options.approvedAllocation?.approvalDate || "").slice(0, 10) > latestDate);
  const reviewReasonCodes = approvalApplied
    ? []
    : reasonCodes;
  const requiresReview = reviewReasonCodes.length > 0;
  const watchRequired = false;

  return {
    latestDate,
    latestOnHand,
    recentPeakOnHand,
    largestAddition,
    largestAdditionDate,
    largestAdditionGapDays,
    largestRemoval,
    largestRemovalDate,
    largestRemovalGapDays,
    asOfDate,
    staleInventoryBalance,
    requiresReview,
    watchRequired,
    approvalApplied,
    reasonCodes:reviewReasonCodes,
  };
}

export function onlineInventoryValidationEvidence(rows = [], options = {}) {
  const minimumAddition = Math.max(0, Number(options.minimumAddition ?? ONLINE_INVENTORY_ADDITION_MINIMUM));
  const additionRatio = Math.max(0, Number(options.additionRatio ?? ONLINE_INVENTORY_ADDITION_RATIO));
  const lookbackDays = Math.max(1, Number(options.lookbackDays || ONLINE_INVENTORY_REVIEW_LOOKBACK_DAYS));
  const asOfDate = String(options.asOfDate || "").slice(0, 10);
  const datedRows = [...rows]
    .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(String(row?.date || "").slice(0, 10)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const knownRows = datedRows.filter(inventoryRowHasKnownBalance);
  const latest = knownRows[knownRows.length - 1] || {};
  const latestDate = String(latest.date || "").slice(0, 10);
  const latestOnHand = Math.max(0, Number(latest.inv || 0));
  const asOfDateValue = isoDateAtUtc(asOfDate || latestDate);
  const reviewStart = asOfDateValue
    ? new Date(asOfDateValue.getTime() - (lookbackDays - 1) * 864e5).toISOString().slice(0, 10)
    : "";
  let largestAddition = 0;
  let largestAdditionDate = "";
  let largestAdditionThreshold = minimumAddition;
  let largestAdditionGapDays = 0;

  for (let index = 1; index < knownRows.length; index += 1) {
    const prior = knownRows[index - 1];
    const current = knownRows[index];
    const currentDate = String(current.date).slice(0, 10);
    if (reviewStart && currentDate < reviewStart) continue;
    const priorDateValue = isoDateAtUtc(prior?.date);
    const currentDateValue = isoDateAtUtc(current?.date);
    if (!priorDateValue || !currentDateValue || currentDateValue <= priorDateValue) continue;
    const interveningUnits = datedRows
      .filter(row => String(row.date).slice(0, 10) > String(prior.date).slice(0, 10) && String(row.date).slice(0, 10) <= currentDate)
      .reduce((sum, row) => sum + Number(row?.units || row?.orders || 0), 0);
    const impliedAddition = Number(current?.inv || 0) - Number(prior?.inv || 0) + interveningUnits;
    const threshold = Math.max(minimumAddition, Math.abs(Number(prior?.inv || 0)) * additionRatio);
    if (impliedAddition >= threshold && impliedAddition > largestAddition) {
      largestAddition = impliedAddition;
      largestAdditionDate = currentDate;
      largestAdditionThreshold = threshold;
      largestAdditionGapDays = Math.round((currentDateValue.getTime() - priorDateValue.getTime()) / 864e5);
    }
  }

  const staleInventoryBalance = latestOnHand > 0 && /^\d{4}-\d{2}-\d{2}$/.test(asOfDate) && latestDate < asOfDate;
  const reasonCodes = [];
  if (staleInventoryBalance) reasonCodes.push("stale-inventory-balance");
  if (largestAddition > 0) reasonCodes.push("online-inventory-replenishment");
  const coverageEvidence = inventoryCoverageEvidence(rows);
  const evaluationDate = String(options.evaluationDate || asOfDate).slice(0, 10);
  const approvalApplied = validInventoryApproval(options.approvedAllocation, coverageEvidence, evaluationDate)
    && (!staleInventoryBalance || String(options.approvedAllocation?.approvalDate || "").slice(0, 10) > latestDate);
  const reviewReasonCodes = approvalApplied ? [] : reasonCodes;

  return {
    latestDate,
    latestOnHand,
    largestAddition,
    largestAdditionDate,
    largestAdditionThreshold,
    largestAdditionGapDays,
    asOfDate,
    staleInventoryBalance,
    requiresReview:reviewReasonCodes.length > 0,
    watchRequired:false,
    approvalApplied,
    reasonCodes:reviewReasonCodes,
  };
}

export function campaignAutomaticDateRange(bounds = {}, preferredStart = CAMPAIGN_DEFAULT_START) {
  const start = String(bounds.start || "").slice(0, 10);
  const end = String(bounds.end || "").slice(0, 10);
  const preferred = String(preferredStart || "").slice(0, 10);
  if (!start || !end || start > end) return bounds;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(preferred) || preferred > end) return { start, end };
  return { start:preferred > start ? preferred : start, end };
}

export function averageWeeklyUnits(totalUnits = 0, reportingDays = 0) {
  const units = Number(totalUnits || 0);
  const days = Number(reportingDays || 0);
  if (!Number.isFinite(units) || !Number.isFinite(days) || days <= 0) return 0;
  return (units / days) * 7;
}

function offsetIsoDateValue(date, days) {
  const parsed = isoDateAtUtc(date);
  if (!parsed) return "";
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function inclusiveIsoDays(start, end) {
  const from = isoDateAtUtc(start);
  const to = isoDateAtUtc(end);
  if (!from || !to || to < from) return 0;
  return Math.floor((to - from) / 864e5) + 1;
}

export function averageWeeklyRevenueDoorStats(revenueRows = [], denominatorRows = [], warehouses = [], options = {}) {
  const datedRevenueRows = [];
  let firstRevenueDate = "";
  let lastRevenueDate = "";
  for (const row of revenueRows || []) {
    const date = String(row?.date || "").slice(0, 10);
    const rev = Number(row?.rev || 0);
    if (!date || rev <= 0) continue;
    datedRevenueRows.push({ row, date, rev });
    if (!firstRevenueDate || date < firstRevenueDate) firstRevenueDate = date;
    if (!lastRevenueDate || date > lastRevenueDate) lastRevenueDate = date;
  }
  const start = String(options.start || firstRevenueDate || "").slice(0, 10);
  const end = String(options.end || lastRevenueDate || start).slice(0, 10);
  const totalDays = inclusiveIsoDays(start, end);
  if (!totalDays) return { revenuePerDoor:0, weekly:[], start, end };

  const periodCount = Math.ceil(totalDays / 7);
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const revenueByPeriod = Array(periodCount).fill(0);
  const denominatorByPeriod = Array.from({ length:periodCount }, () => []);
  const periodByDate = new Map();
  const periodIndexForDate = date => {
    if (periodByDate.has(date)) return periodByDate.get(date);
    const time = Date.parse(`${date}T00:00:00Z`);
    const index = Math.floor((time - startTime) / (7 * 864e5));
    const period = Number.isFinite(time) && index >= 0 && index < periodCount ? index : -1;
    periodByDate.set(date, period);
    return period;
  };
  for (const entry of datedRevenueRows) {
    const periodIndex = periodIndexForDate(entry.date);
    if (periodIndex >= 0 && entry.date <= end) revenueByPeriod[periodIndex] += entry.rev;
  }
  for (const row of denominatorRows || []) {
    const date = String(row?.date || "").slice(0, 10);
    const periodIndex = periodIndexForDate(date);
    if (periodIndex >= 0 && date <= end) denominatorByPeriod[periodIndex].push(row);
  }

  const weekly = [];
  for (let periodIndex = 0; periodIndex < periodCount; periodIndex += 1) {
    const periodStart = offsetIsoDateValue(start, periodIndex * 7);
    const fullPeriodEnd = offsetIsoDateValue(periodStart, 6);
    const periodEnd = fullPeriodEnd > end ? end : fullPeriodEnd;
    const periodDays = inclusiveIsoDays(periodStart, periodEnd);
    const periodRevenue = revenueByPeriod[periodIndex];
    const doorStats = verifiedSellingWarehouseStats(denominatorByPeriod[periodIndex], warehouses);
    if (periodRevenue <= 0 || doorStats.count <= 0) continue;
    const observedRevenuePerDoor = periodRevenue / doorStats.count;
    const revenuePerDoor = observedRevenuePerDoor * (7 / periodDays);
    weekly.push({
      periodIndex,
      start:periodStart,
      end:periodEnd,
      days:periodDays,
      rev:periodRevenue,
      activeDoors:doorStats.count,
      verifiedWarehouseIds:doorStats.warehouseIds,
      observedRevenuePerDoor,
      revenuePerDoor,
    });
  }

  return {
    revenuePerDoor:weekly.length ? weekly.reduce((sum, period) => sum + period.revenuePerDoor, 0) / weekly.length : 0,
    weekly,
    start,
    end,
  };
}

function offsetIsoDate(date, days) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function comparisonValueState(current, prior, options = {}) {
  const currentValue = Number(current);
  const priorValue = Number(prior);
  const hasEligiblePriorData = typeof options === "boolean"
    ? options
    : options?.hasEligiblePriorData !== false;
  if (!hasEligiblePriorData) return { kind:"insufficient-history" };
  if (!Number.isFinite(currentValue) || currentValue <= 0) return { kind:"no-current" };
  if (!Number.isFinite(priorValue)) return { kind:"insufficient-history" };
  if (priorValue === 0) return { kind:"zero-prior" };
  if (priorValue < 0) return { kind:"nonpositive-prior" };
  return {
    kind:"comparable",
    percent:((currentValue - priorValue) / priorValue) * 100,
  };
}

export function rollingDatePreset(preset, endDate, minDate = "") {
  const end = String(endDate || "").slice(0, 10);
  const offset = preset === "lastWeek" ? -6 : preset === "lastMonth" ? -29 : 0;
  const calculatedStart = offsetIsoDate(end, offset);
  const start = minDate && calculatedStart < minDate ? minDate : calculatedStart;
  return { start:start || end, end };
}

export function dateRangeAfterBoundsRefresh(current = {}, bounds = {}, automatic = true) {
  const minDate = String(bounds.start || "").slice(0, 10);
  const maxDate = String(bounds.end || "").slice(0, 10);
  if (!minDate || !maxDate || minDate > maxDate) return current;
  if (automatic) return { start:minDate, end:maxDate };

  const clamp = value => {
    const date = String(value || "").slice(0, 10) || minDate;
    if (date < minDate) return minDate;
    if (date > maxDate) return maxDate;
    return date;
  };
  const next = { start:clamp(current.start), end:clamp(current.end || maxDate) };
  return next.start <= next.end ? next : { start:minDate, end:maxDate };
}
