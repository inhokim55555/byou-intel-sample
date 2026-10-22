// Pure calculation module: no React, DOM, browser globals, clocks, or localization.

import {
  aggregateOnlineInventoryRows,
  averageWeeklyUnits,
  filterWarehouseMatches,
  inventoryCampaignActiveAt,
  inventoryCampaignScopeKey,
  inventoryCoverageEvidence,
  inventoryEligibilityState,
  inventorySellThrough,
  inventoryValidationEvidence,
  isNonStoreWarehouse,
  matchingInventoryApproval,
  matchingInventoryReviewDisposition,
  onlineInventoryValidationEvidence,
} from "./dashboardScope.js";
import { buildInventoryFlowChart } from "./inventoryFlow.js";
import {
  applyOwnerInventoryResult,
  resolveOwnerInventoryDecision,
} from "./ownerInventoryDecisions.js";
import { ownerSalesTotalsForScope } from "./ownerSalesCorrections.js";
import { warehouseLocationLabel, warehouseNumberFromText } from "./storeLookup.js";

export const INVENTORY_VIEW_MODEL_SCHEMA = "byou-intel-inventory-compact-v1";
export const INVENTORY_VIEW_REPRESENTATION = "inventory-compact-v1";

export const INVENTORY_STATUS = Object.freeze({
  SOLD_THROUGH:"sold_through",
  NO_CURRENT_INVENTORY:"no_current_inventory",
  NO_MOVEMENT:"no_movement",
  CRITICAL:"critical",
  WATCH:"watch",
  SOLD_OUT:"sold_out",
  HEALTHY:"healthy",
  LAST_KNOWN:"last_known_inventory",
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(value) {
  return String(value ?? "").trim();
}

function isoDate(value) {
  const date = text(value).slice(0, 10);
  return ISO_DATE.test(date) ? date : "";
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sum(rows, selector) {
  return (rows || []).reduce((total, row) => total + number(selector(row)), 0);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function groupBy(rows, keyFor) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = keyFor(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function metadataById(metadata = {}, id = "") {
  const direct = metadata?.[id];
  if (direct) return { ...direct, id:direct.id || id };
  const entry = Object.entries(metadata || {}).find(([, value]) => text(value?.id) === text(id));
  return entry ? { ...entry[1], id:entry[1]?.id || entry[0] } : null;
}

function warehouseNameSort(a, b, warehouseById) {
  const aName = text(warehouseById.get(a.warehouseId)?.name || a.warehouseId);
  const bName = text(warehouseById.get(b.warehouseId)?.name || b.warehouseId);
  return aName.localeCompare(bName);
}

function statusFor(onHand, totalUnits, sellThrough, expectedSellThrough, inventoryState = "") {
  if (inventoryState === "sold-through") return { code:INVENTORY_STATUS.SOLD_THROUGH, severity:4 };
  if (onHand <= 0 && totalUnits <= 0) return { code:INVENTORY_STATUS.NO_CURRENT_INVENTORY, severity:5 };
  if (totalUnits <= 0 && onHand > 0) return { code:INVENTORY_STATUS.NO_MOVEMENT, severity:0 };
  if (sellThrough < expectedSellThrough * 0.5 && onHand > 0) return { code:INVENTORY_STATUS.CRITICAL, severity:1 };
  if (sellThrough < expectedSellThrough * 0.8 && onHand > 0) return { code:INVENTORY_STATUS.WATCH, severity:2 };
  if (onHand <= 0 && totalUnits > 0) return { code:INVENTORY_STATUS.SOLD_OUT, severity:4 };
  return { code:INVENTORY_STATUS.HEALTHY, severity:3 };
}

function campaignEligible(row, grain, scope, campaignMeta, productMeta) {
  if (scope.campaignIds.length) return true;
  const campaign = metadataById(campaignMeta, text(row?.cid));
  const product = metadataById(productMeta, text(row?.pid));
  return inventoryCampaignActiveAt(campaign || {}, product || {}, {
    asOfDate:scope.end,
    grain,
  });
}

function rowMatchesScope(row, scope) {
  if (!isoDate(row?.date) || row.date > scope.end) return false;
  if (scope.productIds.length && !scope.productIds.includes(text(row?.pid))) return false;
  if (scope.campaignIds.length && !scope.campaignIds.includes(text(row?.cid))) return false;
  return true;
}

function inventoryScope(input = {}) {
  const start = isoDate(input?.dateRange?.start);
  const end = isoDate(input?.dateRange?.end);
  if (!start || !end || start > end) throw new TypeError("Inventory selected view requires a valid inclusive date range.");
  const productIds = unique([
    ...(Array.isArray(input?.scope?.productIds) ? input.scope.productIds : []),
    input?.scope?.productId,
  ].map(text));
  const campaignIds = unique([
    ...(Array.isArray(input?.scope?.campaignIds) ? input.scope.campaignIds : []),
    input?.scope?.campaignId,
  ].map(text));
  const inventoryType = ["inline", "online"].includes(input?.scope?.inventoryType)
    ? input.scope.inventoryType
    : "both";
  return {
    start,
    end,
    productIds,
    campaignIds,
    inventoryType,
    warehouseId:text(input?.scope?.warehouseId),
    region:text(input?.scope?.region),
    state:text(input?.scope?.state),
    storeSearch:text(input?.scope?.storeSearch),
    approvalEvaluationDate:isoDate(input?.approvalEvaluationDate) || end,
  };
}

function validationForInline(sorted, warehouse, evidence, input, scope) {
  const approvalScope = {
    grain:"physical_warehouse",
    wid:text(sorted.at(-1)?.wid),
    pid:text(sorted.at(-1)?.pid),
    cid:text(sorted.at(-1)?.cid),
    inventoryDate:evidence.latestInventoryDate,
    onHand:evidence.onHand,
  };
  const approvedAllocation = matchingInventoryApproval(
    input.inventoryApprovals || [],
    approvalScope,
    scope.approvalEvaluationDate,
  );
  const reviewDisposition = matchingInventoryReviewDisposition(
    input.inventoryReviewDispositions || [],
    approvalScope,
  );
  const validationOptions = {
    asOfDate:scope.end,
    evaluationDate:scope.approvalEvaluationDate,
    approvedAllocation,
  };
  const eligibility = inventoryEligibilityState(sorted, warehouse, validationOptions);
  const rawValidation = inventoryValidationEvidence(sorted, validationOptions);
  const dispositionExcludesVerifiedInventory = reviewDisposition?.decision === "rejected"
    || (reviewDisposition?.decision === "reviewed_quarantined" && !rawValidation.approvalApplied);
  const materialAdjustment = rawValidation.reasonCodes.some(code => (
    code === "recent-large-inventory-addition" || code === "recent-large-inventory-removal"
  ));
  const suppressRoutineNoise = ["unknown", "never-stocked", "token-or-phantom", "refund-proxy"].includes(eligibility.state)
    && !materialAdjustment;
  const eligibilityReview = eligibility.requiresReview && !suppressRoutineNoise;
  const validationReview = rawValidation.requiresReview && (!suppressRoutineNoise || materialAdjustment);
  const watchRequired = eligibility.countsAsStocked && rawValidation.watchRequired;
  const reasonCodes = unique([
    ...(validationReview || watchRequired ? rawValidation.reasonCodes : []),
    ...(eligibilityReview ? eligibility.reasonCodes : []),
  ]);
  return {
    approvalScope,
    approvedAllocation,
    reviewDisposition,
    validationOptions,
    eligibility,
    rawValidation,
    dispositionExcludesVerifiedInventory,
    inventoryValidation:{
      ...rawValidation,
      requiresReview:eligibilityReview || validationReview,
      watchRequired,
      reasonCodes,
    },
  };
}

function physicalWarehousesForScope(input, scope) {
  return (input.whs || [])
    .filter(warehouse => !isNonStoreWarehouse(warehouse)
      && (!scope.region || warehouse?.region === scope.region)
      && (!scope.state || warehouse?.st === scope.state)
      && (!scope.warehouseId || warehouse?.id === scope.warehouseId));
}

function scopedInlineHistory(input, scope, allowedWarehouseIds) {
  return (input.prodSales || []).filter(row => (
    rowMatchesScope(row, scope)
    && allowedWarehouseIds.has(text(row?.wid))
    && campaignEligible(row, "physical_warehouse", scope, input.campaignMeta, input.productMeta)
  ));
}

function buildInlineAggregateItems(input, scope, warehouseById, allowedWarehouseIds) {
  const rows = scopedInlineHistory(input, scope, allowedWarehouseIds);
  const groupedRows = groupBy(rows, inventoryCampaignScopeKey);
  return [...groupedRows.entries()].map(([key, groupRows]) => {
    const sorted = [...groupRows].sort((a, b) => text(a?.date).localeCompare(text(b?.date)));
    const periodRows = sorted.filter(row => row.date >= scope.start && row.date <= scope.end);
    const latest = sorted.at(-1) || {};
    const warehouse = warehouseById.get(text(latest.wid));
    const reportingPeriods = Math.max(1, new Set(periodRows.map(row => row.date)).size);
    const coverageEvidence = inventoryCoverageEvidence(sorted);
    const periodEvidence = inventoryCoverageEvidence(periodRows);
    const validation = validationForInline(sorted, warehouse, coverageEvidence, input, scope);
    const totalUnits = periodEvidence.totalUnits;
    const netUnits = periodEvidence.netUnits;
    const onHand = coverageEvidence.onHand;
    const available = Math.max(0, number(onHand));
    const sellThrough = inventorySellThrough(totalUnits, onHand);
    const expectedSellThrough = Math.min(85, Math.max(25, reportingPeriods * 8));
    const item = {
      key,
      warehouseId:text(latest.wid),
      productId:text(latest.pid),
      campaignId:text(latest.cid),
      warehouseKey:text(warehouseNumberFromText(warehouse?.warehouseNo || warehouse?.name || "") || latest.wid),
      type:"inline",
      date:coverageEvidence.latestInventoryDate || text(latest.date),
      lastKnownSale:sorted.findLast(row => number(row?.units) > 0)?.date || "",
      onHand:available,
      peakOnHand:coverageEvidence.peakOnHand,
      available,
      totalUnits,
      netUnits,
      reportingPeriods,
      revenue:periodEvidence.revenue,
      weeklyUnits:averageWeeklyUnits(totalUnits, reportingPeriods),
      sellThrough,
      expectedSellThrough,
      status:statusFor(available, totalUnits, sellThrough, expectedSellThrough, validation.eligibility.state),
      eligibility:validation.eligibility,
      lifecycleState:validation.eligibility.state,
      countsAsStocked:validation.eligibility.countsAsStocked && !validation.dispositionExcludesVerifiedInventory,
      soldThrough:validation.eligibility.soldThrough && !validation.dispositionExcludesVerifiedInventory,
      flowEligible:validation.eligibility.flowEligible && !validation.dispositionExcludesVerifiedInventory,
      flowRequest:validation.dispositionExcludesVerifiedInventory ? null : {
        type:"inline",
        rows:sorted,
        warehouse,
        options:validation.validationOptions,
        latestDate:coverageEvidence.latestInventoryDate || text(latest.date),
        campaignId:text(latest.cid),
      },
      reviewEligible:(validation.inventoryValidation.requiresReview || validation.inventoryValidation.watchRequired)
        && !validation.reviewDisposition,
      inventoryValidation:validation.inventoryValidation,
      approvedAllocation:validation.approvedAllocation,
      reviewDisposition:validation.reviewDisposition,
      sourceRows:sorted,
      sidebarEligibility:validation.eligibility,
      sidebarValidation:validation.rawValidation,
      sidebarReviewDisposition:validation.reviewDisposition,
    };
    return applyOwnerInventoryResult(item, resolveOwnerInventoryDecision(
      input.ownerInventoryDecisions || [],
      { pid:item.productId, cid:item.campaignId, wid:item.warehouseId, grain:"physical_warehouse" },
      sorted,
      scope.end,
    ));
  }).filter(item => item?.date)
    .sort((a, b) => a.status.severity - b.status.severity || a.sellThrough - b.sellThrough);
}

function acceptedInventoryTotals(input, scope) {
  const totals = ownerSalesTotalsForScope(
    input.ownerSalesHistory || [],
    { to:scope.end },
    input.whs || [],
  );
  return new Map(totals.rows.flatMap(row => (
    row.cids.map(cid => [`${row.wid}|${row.pid}|${cid}`, row.correctedUnits])
  )));
}

function buildInlineTables(inlineAggregateItems, acceptedTotals, warehouseById) {
  const current = inlineAggregateItems
    .filter(item => item.countsAsStocked)
    .filter(item => !item.inventoryValidation?.requiresReview)
    .map(item => {
      const totalUnits = acceptedTotals.get(item.key) ?? Math.max(0, number(item.netUnits));
      const sellThrough = inventorySellThrough(totalUnits, item.onHand);
      return {
        ...item,
        totalUnits,
        weeklyUnits:averageWeeklyUnits(Math.max(0, number(item.netUnits)), item.reportingPeriods),
        sellThrough,
        status:statusFor(item.onHand, totalUnits, sellThrough, item.expectedSellThrough, item.lifecycleState),
      };
    })
    .sort((a, b) => a.status.severity - b.status.severity || a.sellThrough - b.sellThrough);
  const stocked = current.filter(item => (
    item.ownerInventoryResult?.consumerEligible !== false
    && !isNonStoreWarehouse(warehouseById.get(item.warehouseId))
  ));
  const soldThrough = inlineAggregateItems
    .filter(item => item.soldThrough && !item.inventoryValidation?.requiresReview)
    .filter(item => item.ownerInventoryResult?.consumerEligible !== false
      && !isNonStoreWarehouse(warehouseById.get(item.warehouseId)))
    .map(item => {
      const totalUnits = acceptedTotals.get(item.key) ?? Math.max(0, number(item.netUnits));
      return {
        ...item,
        totalUnits,
        weeklyUnits:averageWeeklyUnits(Math.max(0, number(item.netUnits)), item.reportingPeriods),
        sellThrough:100,
        status:statusFor(0, totalUnits, 100, item.expectedSellThrough, "sold-through"),
      };
    })
    .filter(item => item.totalUnits >= 100)
    .sort((a, b) => text(b.lastKnownSale).localeCompare(text(a.lastKnownSale))
      || warehouseNameSort(a, b, warehouseById));
  return { current, stocked, soldThrough };
}

function validationForOnline(sorted, evidence, input, scope) {
  const approvalScope = {
    grain:"online_aggregate",
    pid:text(sorted.at(-1)?.pid),
    cid:text(sorted.at(-1)?.cid),
    inventoryDate:evidence.latestInventoryDate,
    onHand:evidence.onHand,
  };
  const approvedAllocation = matchingInventoryApproval(
    input.inventoryApprovals || [],
    approvalScope,
    scope.approvalEvaluationDate,
  );
  const reviewDisposition = matchingInventoryReviewDisposition(
    input.inventoryReviewDispositions || [],
    approvalScope,
  );
  const validationOptions = {
    grain:"online_aggregate",
    asOfDate:scope.end,
    evaluationDate:scope.approvalEvaluationDate,
    approvedAllocation,
  };
  const eligibility = inventoryEligibilityState(sorted, {}, validationOptions);
  const rawValidation = onlineInventoryValidationEvidence(sorted, validationOptions);
  const dispositionExcludesVerifiedInventory = reviewDisposition?.decision === "rejected"
    || (reviewDisposition?.decision === "reviewed_quarantined" && !rawValidation.approvalApplied);
  const replenishmentReview = rawValidation.reasonCodes.includes("online-inventory-replenishment");
  const suppressRoutineNoise = ["unknown", "never-stocked", "token-or-phantom", "refund-proxy"].includes(eligibility.state)
    && !replenishmentReview;
  const eligibilityReview = eligibility.requiresReview && !suppressRoutineNoise;
  const validationReview = rawValidation.requiresReview && (!suppressRoutineNoise || replenishmentReview);
  return {
    approvedAllocation,
    reviewDisposition,
    validationOptions,
    eligibility,
    dispositionExcludesVerifiedInventory,
    inventoryValidation:{
      ...rawValidation,
      requiresReview:eligibilityReview || validationReview,
      watchRequired:false,
      reasonCodes:unique([
        ...(validationReview ? rawValidation.reasonCodes : []),
        ...(eligibilityReview ? eligibility.reasonCodes : []),
      ]),
    },
  };
}

function buildOnlineAggregateItems(input, scope) {
  const scopedRows = (input.onlineSales || []).filter(row => (
    rowMatchesScope(row, scope)
    && campaignEligible(row, "online_aggregate", scope, input.campaignMeta, input.productMeta)
  ));
  const rows = aggregateOnlineInventoryRows(scopedRows);
  const groupedRows = groupBy(rows, row => `${text(row?.pid || row?.product)}|${text(row?.cid)}`);
  return [...groupedRows.entries()].map(([key, groupRows]) => {
    const sorted = [...groupRows].sort((a, b) => text(a?.date).localeCompare(text(b?.date)));
    const periodRows = sorted.filter(row => row.date >= scope.start && row.date <= scope.end);
    const latest = sorted.at(-1) || {};
    const coverageEvidence = inventoryCoverageEvidence(sorted);
    if (!coverageEvidence.inventoryKnown) return null;
    const periodEvidence = inventoryCoverageEvidence(periodRows);
    const validation = validationForOnline(sorted, coverageEvidence, input, scope);
    const reportingPeriods = Math.max(1, new Set(periodRows.map(row => row.date)).size);
    const totalUnits = Math.max(0, number(periodEvidence.netUnits));
    const onHand = Math.max(0, number(coverageEvidence.onHand));
    const sellThrough = inventorySellThrough(totalUnits, onHand);
    const expectedSellThrough = Math.min(85, Math.max(25, reportingPeriods * 8));
    const item = {
      key,
      warehouseId:"",
      productId:text(latest.pid),
      campaignId:text(latest.cid),
      type:"online",
      date:coverageEvidence.latestInventoryDate || text(latest.date),
      lastKnownSale:sorted.findLast(row => number(row?.units) > 0)?.date || "",
      onHand,
      available:onHand,
      totalUnits,
      netUnits:periodEvidence.netUnits,
      reportingPeriods,
      weeklyUnits:averageWeeklyUnits(totalUnits, reportingPeriods),
      sellThrough,
      expectedSellThrough,
      status:statusFor(onHand, totalUnits, sellThrough, expectedSellThrough, validation.eligibility.state),
      eligibility:validation.eligibility,
      lifecycleState:validation.eligibility.state,
      countsAsStocked:validation.eligibility.countsAsStocked && !validation.dispositionExcludesVerifiedInventory,
      soldThrough:validation.eligibility.soldThrough && !validation.dispositionExcludesVerifiedInventory,
      flowRequest:validation.dispositionExcludesVerifiedInventory ? null : {
        type:"online",
        rows:sorted,
        warehouse:{},
        options:validation.validationOptions,
        latestDate:coverageEvidence.latestInventoryDate || text(latest.date),
        campaignId:text(latest.cid),
      },
      reviewEligible:validation.inventoryValidation.requiresReview && !validation.reviewDisposition,
      inventoryValidation:validation.inventoryValidation,
      approvedAllocation:validation.approvedAllocation,
      reviewDisposition:validation.reviewDisposition,
    };
    return applyOwnerInventoryResult(item, resolveOwnerInventoryDecision(
      input.ownerInventoryDecisions || [],
      { pid:item.productId, cid:item.campaignId, wid:"", grain:"online_aggregate" },
      sorted,
      scope.end,
    ));
  }).filter(Boolean)
    .sort((a, b) => a.status.severity - b.status.severity || a.sellThrough - b.sellThrough);
}

function buildOnlineTables(onlineAggregateItems) {
  const stocked = onlineAggregateItems.filter(item => (
    item.countsAsStocked && !item.inventoryValidation?.requiresReview
  ));
  const soldThrough = onlineAggregateItems
    .filter(item => item.soldThrough && !item.inventoryValidation?.requiresReview)
    .map(item => ({
      ...item,
      sellThrough:100,
      status:statusFor(0, item.totalUnits, 100, item.expectedSellThrough, "sold-through"),
    }));
  return { stocked, soldThrough };
}

function buildSidebarRows(input, scope, warehouseById, inlineAggregateItems) {
  const warehouses = physicalWarehousesForScope(input, scope);
  const byWarehouse = groupBy(inlineAggregateItems, item => item.warehouseId);
  return warehouses.map(warehouse => {
    const campaignGroups = (byWarehouse.get(text(warehouse.id)) || [])
      .map(item => {
        const eligibility = {
          ...item.sidebarEligibility,
          evidence:{ ...(item.sidebarEligibility?.evidence || {}) },
        };
        let validation = { ...item.sidebarValidation };
        const ownerResult = item.ownerInventoryResult;
        const reviewDisposition = item.sidebarReviewDisposition;
        if (ownerResult?.conflict) {
          eligibility.countsAsStocked = false;
          validation = { ...validation, requiresReview:true };
        }
        if (ownerResult?.applied) {
          eligibility.countsAsStocked = ownerResult.includeInTotals
            && ownerResult.consumerEligible
            && ownerResult.onHand > 0;
          eligibility.evidence = { ...eligibility.evidence, onHand:ownerResult.onHand };
          validation = { ...validation, requiresReview:false };
        }
        const dispositionExcludesVerifiedInventory = !ownerResult?.applied
          && (reviewDisposition?.decision === "rejected"
            || (reviewDisposition?.decision === "reviewed_quarantined" && !validation.approvalApplied));
        return { rows:item.sourceRows, eligibility, validation, dispositionExcludesVerifiedInventory };
      });
    const eligibleGroups = campaignGroups.filter(group => (
      group.eligibility.countsAsStocked
      && !group.validation.requiresReview
      && !group.dispositionExcludesVerifiedInventory
    ));
    const available = sum(eligibleGroups, group => group.eligibility.evidence.onHand);
    const periodRows = eligibleGroups.flatMap(group => (
      group.rows.filter(row => row.date >= scope.start)
    ));
    const evidence = inventoryCoverageEvidence(periodRows);
    const sellThrough = inventorySellThrough(evidence.totalUnits, available);
    return {
      warehouseId:text(warehouse.id),
      available,
      soldUnits:evidence.totalUnits,
      netUnits:evidence.netUnits,
      peakOnHand:Math.max(0, ...eligibleGroups.map(group => number(group.eligibility.evidence.peakOnHand))),
      revenue:evidence.revenue,
      sellThrough,
      hasCurrentInventory:eligibleGroups.length > 0,
    };
  }).filter(row => row.hasCurrentInventory)
    .sort((a, b) => a.sellThrough - b.sellThrough || warehouseNameSort(a, b, warehouseById));
}

function compactTableRow(item, input, warehouseById) {
  const warehouse = warehouseById.get(item.warehouseId);
  const product = metadataById(input.productMeta, item.productId);
  const campaign = metadataById(input.campaignMeta, item.campaignId);
  return {
    key:item.key,
    type:item.type === "online" ? "Online" : "Inline",
    warehouseId:item.warehouseId,
    productId:item.productId,
    campaignId:item.campaignId,
    date:item.date,
    lastKnownSale:item.lastKnownSale,
    name:item.type === "online" ? "Online aggregate" : text(warehouse?.name || item.warehouseId),
    location:item.type === "online" ? "Ecommerce aggregate" : warehouseLocationLabel(warehouse || {}),
    region:item.type === "online" ? "Online" : text(warehouse?.region),
    product:text(product?.short || product?.name || item.productId || "Product"),
    campaign:text(campaign?.short || campaign?.name || item.campaignId),
    available:number(item.available),
    totalUnits:number(item.totalUnits),
    netUnits:number(item.netUnits),
    revenue:number(item.revenue),
    reportingPeriods:number(item.reportingPeriods),
    weeklyUnits:number(item.weeklyUnits),
    sellThrough:number(item.sellThrough),
    expectedSellThrough:number(item.expectedSellThrough),
    statusCode:item.status.code,
    statusSeverity:item.status.severity,
    displayStatusCode:item.ownerInventoryResult?.lastKnown ? INVENTORY_STATUS.LAST_KNOWN : item.status.code,
    lifecycleState:item.lifecycleState,
    ownerDecisionState:item.ownerInventoryResult?.decision?.state || "",
    ownerDecisionConflict:item.ownerInventoryResult?.conflict || "",
    inventoryReasonCodes:item.inventoryValidation?.reasonCodes || [],
    approvalApplied:item.inventoryValidation?.approvalApplied === true,
    manualApproval:item.approvedAllocation?.approvalSource === "manual_runtime" ? {
      issueId:text(item.approvedAllocation.issueId),
      approvalSource:"manual_runtime",
      inventoryStatus:text(item.approvedAllocation.inventoryStatus),
      inventoryDate:item.approvedAllocation.inventoryDate,
      onHand:item.approvedAllocation.onHand,
      approvalDate:item.approvedAllocation.approvalDate,
      expiresOn:item.approvedAllocation.expiresOn,
    } : null,
  };
}

function kpisFor(scope, inlineCurrent, onlineStocked, warehouseById) {
  const visible = [
    ...(scope.inventoryType !== "online" ? inlineCurrent : []),
    ...(scope.inventoryType !== "inline" ? onlineStocked : []),
  ];
  const available = sum(visible, row => row.available);
  const sold = sum(visible, row => row.totalUnits);
  const totalWarehouses = new Set(inlineCurrent
    .filter(item => item.ownerInventoryResult?.consumerEligible !== false
      && !isNonStoreWarehouse(warehouseById.get(item.warehouseId)))
    .map(item => item.warehouseKey)
    .filter(Boolean)).size;
  return {
    availableUnits:available,
    inlineUnits:sum(inlineCurrent, row => row.available),
    onlineUnits:sum(onlineStocked, row => row.available),
    verifiedStockedWarehouses:totalWarehouses,
    riskCount:visible.filter(row => (
      row.status.code !== INVENTORY_STATUS.NO_MOVEMENT && row.status.severity <= 2
    )).length,
    sellThrough:sold + available > 0 ? (sold / (sold + available)) * 100 : 0,
    weeklyVelocity:sum(visible, row => row.weeklyUnits),
  };
}

/**
 * Build the exact Inventory calculation from complete, already-authorized history.
 *
 * Required contract:
 * - prodSales and onlineSales contain every applicable row through dateRange.end.
 * - selected product aliases are expanded into scope.productIds before this call.
 * - explicit campaigns are supplied in scope.campaignIds; an empty list applies
 *   the existing end-date campaign activity rule.
 * - approvalEvaluationDate is explicit so the result is reproducible and cacheable.
 * - the selected start limits period metrics only; lifecycle, validation, owner
 *   decisions, sold-through classification, and flow eligibility receive all history.
 */
export function buildInventoryViewModel(input = {}, options = {}) {
  const normalizedInput = {
    ...input,
    dateRange:{ start:options.from, end:options.to },
    scope:{
      productIds:options.pids || [],
      campaignIds:options.cids?.length ? options.cids : options.cid ? [options.cid] : [],
      inventoryType:options.inventoryType,
      warehouseId:options.wid,
      region:options.region,
      state:options.state,
      storeSearch:options.storeSearch,
    },
    approvalEvaluationDate:options.evaluationDate,
    ownerSalesHistory:input.ownerSalesHistory || input.ownerSalesCorrectionHistory || [],
  };
  const scope = inventoryScope(normalizedInput);
  const warehouseById = new Map((normalizedInput.whs || []).map(warehouse => [text(warehouse?.id), warehouse]));
  const physicalWarehouses = physicalWarehousesForScope(normalizedInput, scope);
  const physicalWarehouseIds = new Set(physicalWarehouses.map(warehouse => text(warehouse?.id)));
  const searchedWarehouseIds = scope.storeSearch
    ? new Set(filterWarehouseMatches(physicalWarehouses, scope.storeSearch).map(warehouse => text(warehouse?.id)))
    : physicalWarehouseIds;
  const allInlineAggregateItems = buildInlineAggregateItems(normalizedInput, scope, warehouseById, physicalWarehouseIds);
  const allSidebarRows = buildSidebarRows(normalizedInput, scope, warehouseById, allInlineAggregateItems).map(row => {
    const warehouse = warehouseById.get(row.warehouseId) || {};
    return {
      id:row.warehouseId,
      warehouseNo:text(warehouse.warehouseNo),
      name:text(warehouse.name || row.warehouseId),
      city:text(warehouse.city),
      st:text(warehouse.st || warehouse.state),
      region:text(warehouse.region),
      total:row.available,
      units:row.available,
      available:row.available,
      soldUnits:row.soldUnits,
      netUnits:row.netUnits,
      peakOnHand:row.peakOnHand,
      revenue:row.revenue,
      pct:row.sellThrough,
      sellThrough:row.sellThrough,
      hasCurrentInventory:row.hasCurrentInventory,
    };
  });
  const sidebarRows = scope.storeSearch
    ? allSidebarRows.filter(row => searchedWarehouseIds.has(row.id))
    : allSidebarRows;
  const inlineAggregateItems = scope.storeSearch
    ? allInlineAggregateItems.filter(item => searchedWarehouseIds.has(item.warehouseId))
    : allInlineAggregateItems;
  const inlineTables = buildInlineTables(inlineAggregateItems, acceptedInventoryTotals(normalizedInput, scope), warehouseById);
  const onlineAggregateItems = buildOnlineAggregateItems(normalizedInput, scope);
  const onlineTables = buildOnlineTables(onlineAggregateItems);
  const flowJobs = [
    ...(scope.inventoryType === "online" ? [] : inlineAggregateItems),
    ...(scope.inventoryType === "inline" ? [] : onlineAggregateItems),
  ].filter(item => (
    item.flowRequest
    && !item.ownerInventoryResult?.applied
    && !item.ownerInventoryResult?.conflict
  )).map(item => item.flowRequest);
  const flowPoints = buildInventoryFlowChart(flowJobs, { start:scope.start, end:scope.end })
    .map(({ date, inline, online }) => ({ date, inline, online }));
  const inlineRows = scope.inventoryType === "online"
    ? []
    : inlineTables.stocked.map(item => compactTableRow(item, normalizedInput, warehouseById));
  const inlineSoldThroughRows = scope.inventoryType === "online"
    ? []
    : inlineTables.soldThrough.map(item => compactTableRow(item, normalizedInput, warehouseById));
  const onlineRows = scope.inventoryType === "inline"
    ? []
    : onlineTables.stocked.map(item => compactTableRow(item, normalizedInput, warehouseById));
  const onlineSoldThroughRows = scope.inventoryType === "inline"
    ? []
    : onlineTables.soldThrough.map(item => compactTableRow(item, normalizedInput, warehouseById));
  const sourceInlineRows = scope.inventoryType === "online"
    ? []
    : inlineAggregateItems.flatMap(item => item.sourceRows);
  const sourceOnlineRows = scope.inventoryType === "inline"
    ? []
    : (normalizedInput.onlineSales || []).filter(row => (
        rowMatchesScope(row, scope)
        && campaignEligible(row, "online_aggregate", scope, normalizedInput.campaignMeta, normalizedInput.productMeta)
      ));
  let firstInputDate = "";
  let lastInputDate = "";
  for (const row of [...sourceInlineRows, ...sourceOnlineRows]) {
    const date = isoDate(row?.date);
    if (!date) continue;
    if (!firstInputDate || date < firstInputDate) firstInputDate = date;
    if (!lastInputDate || date > lastInputDate) lastInputDate = date;
  }
  return {
    schema:INVENTORY_VIEW_MODEL_SCHEMA,
    representation:INVENTORY_VIEW_REPRESENTATION,
    view:"inventory",
    modelVersion:1,
    versionId:text(options.versionId),
    publishedAt:text(normalizedInput.publishedAt),
    historyThrough:scope.end,
    evaluationDate:scope.approvalEvaluationDate,
    approvalRevision:text(options.approvalRevision),
    filters:{ from:scope.start, to:scope.end, pids:scope.productIds, cids:scope.campaignIds, cid:scope.campaignIds.length === 1 ? scope.campaignIds[0] : "", wid:scope.warehouseId, region:scope.region, state:scope.state, inventoryType:scope.inventoryType === "both" ? "" : scope.inventoryType, storeSearch:scope.storeSearch },
    history:{
      firstInputDate,
      lastInputDate,
      prodSalesRows:sourceInlineRows.length,
      onlineSalesRows:sourceOnlineRows.length,
    },
    totals:kpisFor(scope, inlineTables.current, onlineTables.stocked, warehouseById),
    sidebarRows,
    inlineRows,
    inlineSoldThroughRows,
    onlineRows,
    onlineSoldThroughRows,
    onlineAggregateCount:onlineAggregateItems.length,
    chartData:flowPoints.map(point => ({ ...point, label:point.date.slice(5) })),
  };
}
