import { resolveOwnerInventoryDecision } from "./ownerInventoryDecisions.js";
import {
  averageWeeklyRevenueDoorStats,
  inventoryCoverageEvidence,
  inventoryEligibilityState,
  inventoryValidationEvidence,
  isInventoryCoverageWarehouse,
  matchingInventoryApproval,
  matchingInventoryReviewDisposition,
} from "./dashboardScope.js";

export const REPORTING_EVIDENCE_VERSION = "byou-reporting-evidence-v1";
export const DEFAULT_REVIEW_INVENTORY_THRESHOLD = 10_000;
export const MEANINGFUL_SALES_WINDOW_DAYS = 7;
export const MEANINGFUL_SALES_MIN_REVENUE = 1_000;
export const MEANINGFUL_SALES_MIN_UNITS = 100;
export const MEANINGFUL_SALES_MIN_DAILY_REVENUE = 250;
export const MEANINGFUL_SALES_MIN_DAILY_UNITS = 10;

const DAY_MS = 86_400_000;

function isoDate(value) {
  const text = String(value || "").slice(0, 10);
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function dateValue(value) {
  const parsed = isoDate(value);
  return parsed ? new Date(`${parsed}T00:00:00Z`) : null;
}

function offsetDate(value, days) {
  const parsed = dateValue(value);
  if (!parsed) return "";
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  const from = dateValue(start);
  const to = dateValue(end);
  if (!from || !to) return 0;
  return Math.floor((to - from) / DAY_MS);
}

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

function numberFrom(row, keys, fallback = 0) {
  for (const key of keys) {
    if (row?.[key] === "" || row?.[key] == null) continue;
    const value = Number(row[key]);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function rowDate(row) {
  return isoDate(row?.date ?? row?.Date ?? row?.day ?? row?.Day);
}

function rowProductId(row) {
  return String(row?.pid ?? row?.Product_ID ?? row?.productId ?? row?.Product ?? row?.product ?? "").trim();
}

function rowCampaignId(row) {
  return String(row?.cid ?? row?.Campaign_ID ?? row?.campaignId ?? "").trim();
}

function rowWarehouseId(row) {
  return String(row?.wid ?? row?.Warehouse_ID ?? row?.warehouseId ?? row?.Warehouse ?? row?.warehouse ?? "").trim();
}

function rowRevenue(row) {
  return numberFrom(row, ["rev", "revenue", "Revenue", "Sales", "sales"]);
}

function rowUnits(row) {
  return numberFrom(row, ["units", "Units", "unitSales", "Unit Sales"]);
}

function rowInventory(row) {
  return Math.max(0, numberFrom(row, ["inv", "inventory", "Inventory", "onHand", "On Hand"]));
}

function rowInventoryKnown(row) {
  if (Object.prototype.hasOwnProperty.call(row || {}, "invKnown")) return row?.invKnown === true && row?.inv !== "" && row?.inv != null && Number.isFinite(Number(row.inv));
  if (Object.prototype.hasOwnProperty.call(row || {}, "inventoryKnown")) return row?.inventoryKnown === true && row?.inventory !== "" && row?.inventory != null && Number.isFinite(Number(row.inventory));
  return ["inv", "inventory", "Inventory", "onHand", "On Hand"].some(key => row?.[key] !== "" && row?.[key] != null && Number.isFinite(Number(row[key])) && Number(row[key]) !== 0);
}

function rowCoverageDays(row) {
  const days = numberFrom(row, ["periodDays", "coverageDays"], 1);
  return Math.max(1, Math.min(MEANINGFUL_SALES_WINDOW_DAYS, Math.round(days)));
}

function isOnlineRow(row) {
  return /online|e[\s-]?commerce|\.com/i.test(String(row?.channel ?? row?.Channel ?? row?.type ?? ""));
}

function inRange(row, start, end) {
  const date = rowDate(row);
  return !!date && date >= start && date <= end;
}

function sumRows(rows) {
  return rows.reduce((totals, row) => ({
    revenue:totals.revenue + rowRevenue(row),
    units:totals.units + rowUnits(row),
  }), { revenue:0, units:0 });
}

function metaValues(meta) {
  if (Array.isArray(meta)) return meta;
  return Object.entries(meta || {}).map(([key, value]) => ({ id:key, ...(value || {}) }));
}

function productId(meta = {}) {
  return String(meta.id ?? meta.pid ?? meta.Product_ID ?? meta.productId ?? meta.name ?? "").trim();
}

function campaignId(meta = {}) {
  return String(meta.id ?? meta.cid ?? meta.Campaign_ID ?? meta.campaignId ?? "").trim();
}

function campaignProductId(meta = {}) {
  return String(meta.pid ?? meta.Product_ID ?? meta.productId ?? "").trim();
}

function productName(meta = {}, fallback = "") {
  return String(meta.short ?? meta.name ?? meta.product ?? meta.Product ?? fallback).trim();
}

function productBrand(meta = {}) {
  return String(meta.brand ?? meta.Brand ?? "").trim();
}

function productCategory(meta = {}) {
  return String(meta.category ?? meta.Category ?? "").trim();
}

function productComparableGroup(meta = {}) {
  return String(meta.comparableGroup ?? meta.comparable_group ?? meta.subcategory ?? "").trim();
}

function warehouseId(meta = {}) {
  return String(meta.id ?? meta.wid ?? meta.Warehouse_ID ?? meta.warehouseNo ?? "").trim();
}

function warehouseLabel(meta = {}, fallback = "") {
  return String(meta.name ?? meta.warehouseName ?? meta.city ?? fallback).trim();
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction)));
  return sorted[index];
}

function latestDate(rows) {
  return rows.map(rowDate).filter(Boolean).sort().at(-1) || "";
}

function uniqueDates(rows) {
  return [...new Set(rows.map(rowDate).filter(Boolean))].sort();
}

export function reportingWeekFor(runDate) {
  const run = dateValue(runDate);
  if (!run) throw new Error(`Invalid run date: ${runDate}`);
  const day = run.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const currentMonday = offsetDate(run.toISOString().slice(0, 10), -daysSinceMonday);
  const start = offsetDate(currentMonday, -7);
  return { start, end:offsetDate(start, 6) };
}

export function campaignHealthForRevenueDoor(revenuePerDoor) {
  const value = Number(revenuePerDoor || 0);
  if (value >= 1_000) return "on_target";
  if (value > 500) return "watch";
  return "under_target";
}

export function meaningfulSalesStart(rows = [], options = {}) {
  const through = isoDate(options.through) || "9999-12-31";
  const dailyByDate = new Map();
  rows.forEach(row => {
    const date = rowDate(row);
    if (!date || date > through) return;
    const current = dailyByDate.get(date) || { date, rev:0, units:0 };
    current.rev += rowRevenue(row);
    current.units += rowUnits(row);
    dailyByDate.set(date, current);
  });
  const dailyRows = [...dailyByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const positiveRows = dailyRows.filter(row => Math.max(0, row.rev) > 0 || Math.max(0, row.units) > 0);
  const firstPositiveDate = positiveRows[0]?.date || "";
  if (!firstPositiveDate) return "";
  const maxDailyRevenue = Math.max(0, ...positiveRows.map(row => Math.max(0, row.rev)));
  const maxDailyUnits = Math.max(0, ...positiveRows.map(row => Math.max(0, row.units)));
  const minDailyRevenue = Math.min(MEANINGFUL_SALES_MIN_DAILY_REVENUE, maxDailyRevenue * 0.2);
  const minDailyUnits = Math.min(MEANINGFUL_SALES_MIN_DAILY_UNITS, maxDailyUnits * 0.2);
  let firstQualifiedWindowDate = "";
  for (const row of positiveRows) {
    const candidate = row.date;
    const end = offsetDate(candidate, MEANINGFUL_SALES_WINDOW_DAYS - 1);
    const windowRows = dailyRows.filter(item => item.date >= candidate && item.date <= end);
    const netRevenue = windowRows.reduce((sum, item) => sum + item.rev, 0);
    const positiveRevenue = windowRows.reduce((sum, item) => sum + Math.max(0, item.rev), 0);
    const positiveUnits = windowRows.reduce((sum, item) => sum + Math.max(0, item.units), 0);
    if (!(netRevenue > 0 && (positiveRevenue >= MEANINGFUL_SALES_MIN_REVENUE || positiveUnits >= MEANINGFUL_SALES_MIN_UNITS))) continue;
    if (!firstQualifiedWindowDate) firstQualifiedWindowDate = candidate;
    if ((minDailyRevenue > 0 && Math.max(0, row.rev) >= minDailyRevenue) || (minDailyUnits > 0 && Math.max(0, row.units) >= minDailyUnits)) return candidate;
  }
  return firstQualifiedWindowDate || firstPositiveDate;
}

function campaignKey(pid, cid) {
  return `${pid}\u0000${cid}`;
}

function rowsForCampaign(rows, pid, cid, { allowBlankCampaign = false } = {}) {
  return rows.filter(row => {
    if (rowProductId(row) !== pid) return false;
    const rowCid = rowCampaignId(row);
    return cid ? rowCid === cid || (allowBlankCampaign && !rowCid) : !rowCid;
  });
}

function buildProductInventory(dataset, pid, cid, reportingStart, reportingEnd, warehouseById, allowBlankCampaign, evaluationDate) {
  const productRows = rowsForCampaign(dataset.prodSales || [], pid, cid, { allowBlankCampaign })
    .filter(row => rowDate(row) <= reportingEnd);
  const verifiedRows = [];
  const unverifiedRows = [];
  const observedRows = [];
  const rowsByWarehouse = new Map();
  productRows.forEach(row => {
    const wid = rowWarehouseId(row);
    const warehouse = warehouseById.get(wid);
    if (!wid || !warehouse) return;
    const rows = rowsByWarehouse.get(wid) || [];
    rows.push(row);
    rowsByWarehouse.set(wid, rows);
  });
  rowsByWarehouse.forEach((rows, wid) => {
    const warehouse = warehouseById.get(wid);
    const ownerResult = resolveOwnerInventoryDecision(dataset.ownerInventoryDecisions || [], { pid, cid, wid, grain:"physical_warehouse" }, rows, reportingEnd);
    if (ownerResult?.conflict) {
      const observation = { wid, date:ownerResult.date, onHand:ownerResult.onHand, state:"unresolved", validationReasonCodes:[ownerResult.conflict], reviewDisposition:"owner_decision_conflict", consumerEligible:ownerResult.consumerEligible };
      observedRows.push(observation);
      unverifiedRows.push(observation);
      return;
    }
    if (ownerResult?.applied) {
      const observation = { wid, date:ownerResult.date, onHand:ownerResult.onHand, state:ownerResult.decision.state, validationReasonCodes:[], reviewDisposition:"owner_business_decision", consumerEligible:ownerResult.consumerEligible };
      observedRows.push(observation);
      if (ownerResult.includeInTotals && ownerResult.onHand > 0) verifiedRows.push(observation);
      return;
    }
    if (!isInventoryCoverageWarehouse(warehouse)) return;
    const evidence = inventoryCoverageEvidence(rows);
    const approvedAllocation = matchingInventoryApproval(dataset.inventoryApprovals || [], {
      wid,
      pid,
      cid,
      inventoryDate:evidence.latestInventoryDate,
      onHand:evidence.onHand,
    }, evaluationDate);
    const reviewDisposition = matchingInventoryReviewDisposition(dataset.inventoryReviewDispositions || [], {
      grain:"physical_warehouse",
      wid,
      pid,
      cid,
      inventoryDate:evidence.latestInventoryDate,
      onHand:evidence.onHand,
    });
    const validationOptions = { asOfDate:reportingEnd, evaluationDate, approvedAllocation };
    const eligibility = inventoryEligibilityState(rows, warehouse, validationOptions);
    if (!eligibility.evidence.inventoryKnown) return;
    const validation = inventoryValidationEvidence(rows, validationOptions);
    const dispositionExcludesVerifiedInventory = reviewDisposition?.decision === "rejected"
      || (reviewDisposition?.decision === "reviewed_quarantined" && !validation.approvalApplied);
    const observation = {
      wid,
      date:eligibility.evidence.latestInventoryDate,
      onHand:Math.max(0, Number(eligibility.evidence.onHand || 0)),
      state:eligibility.state,
      validationReasonCodes:validation.reasonCodes,
      reviewDisposition:reviewDisposition?.decision || "",
    };
    observedRows.push(observation);
    if (eligibility.countsAsStocked && !validation.requiresReview && !dispositionExcludesVerifiedInventory) verifiedRows.push(observation);
    else if (observation.onHand > 0 && (eligibility.state === "unverified-allocation" || validation.requiresReview || dispositionExcludesVerifiedInventory)) unverifiedRows.push(observation);
  });
  const latestInventoryDate = observedRows.map(row => row.date).sort().at(-1) || "";
  return {
    known:observedRows.length > 0 && latestInventoryDate >= reportingStart,
    totalOnHand:verifiedRows.reduce((sum, row) => sum + row.onHand, 0),
    unverifiedOnHand:unverifiedRows.reduce((sum, row) => sum + row.onHand, 0),
    latestDate:latestInventoryDate,
    warehouseCount:verifiedRows.filter(row => row.consumerEligible !== false).length,
    unverifiedWarehouseCount:unverifiedRows.length,
    observedWarehouseCount:observedRows.length,
    rows:verifiedRows,
    unverifiedRows,
  };
}

function buildWarehouseDiagnostics({ dataset, pid, cid, reportingWeek, warehouseById, productInventory, allowBlankCampaign }) {
  const weekRows = rowsForCampaign(dataset.prodSales || [], pid, cid, { allowBlankCampaign }).filter(row => inRange(row, reportingWeek.start, reportingWeek.end));
  const rowsByWarehouse = new Map();
  weekRows.forEach(row => {
    const wid = rowWarehouseId(row);
    if (!wid) return;
    const rows = rowsByWarehouse.get(wid) || [];
    rows.push(row);
    rowsByWarehouse.set(wid, rows);
  });
  const currentInventoryByWarehouse = new Map(productInventory.rows.map(row => [row.wid, row]));
  const candidateWarehouseIds = new Set([...rowsByWarehouse.keys(), ...currentInventoryByWarehouse.keys()]);
  const diagnostics = [];

  candidateWarehouseIds.forEach(wid => {
    const warehouse = warehouseById.get(wid);
    if (!warehouse || !isInventoryCoverageWarehouse(warehouse)) return;
    const rows = rowsByWarehouse.get(wid) || [];
    const currentInventory = currentInventoryByWarehouse.get(wid);
    const inventoryRows = rowsForCampaign(dataset.prodSales || [], pid, cid, { allowBlankCampaign })
      .filter(row => rowWarehouseId(row) === wid && rowDate(row) <= reportingWeek.end && rowInventoryKnown(row));
    const peakOnHand = inventoryRows.reduce((peak, row) => Math.max(peak, rowInventory(row)), 0);
    const onHand = currentInventory?.onHand ?? 0;
    const totals = sumRows(rows);
    const hasPositiveGross = rows.some(row => rowRevenue(row) > 0 || rowUnits(row) > 0);
    const credibleWeekMovement = hasPositiveGross
      && totals.revenue >= 0
      && totals.units >= 0
      && (totals.revenue > 0 || totals.units > 0);
    if (!currentInventory && !credibleWeekMovement) return;
    const observedDays = uniqueDates(rows).length;
    const coveredDays = Math.min(MEANINGFUL_SALES_WINDOW_DAYS, rows.reduce((sum, row) => sum + rowCoverageDays(row), 0));
    const sellingDays = new Set(rows.filter(row => rowRevenue(row) > 0 || rowUnits(row) > 0).map(rowDate)).size;
    const revenuePerObservedDay = coveredDays ? totals.revenue / coveredDays : 0;
    const currentInventoryObserved = !!currentInventory && currentInventory.date >= reportingWeek.start;
    const inventoryConstraint = currentInventoryObserved && onHand <= 1;
    diagnostics.push({
      warehouseId:wid,
      warehouseName:warehouseLabel(warehouse, wid),
      region:String(warehouse.region || "Unknown"),
      state:String(warehouse.st || warehouse.state || ""),
      revenue:totals.revenue,
      units:totals.units,
      coveredDays,
      observedDays,
      sellingDays,
      revenuePerObservedDay,
      onHand,
      peakOnHand,
      latestInventoryDate:currentInventory?.date || "",
      currentInventoryObserved,
      inventoryConstraint,
      status:"typical",
      reason:"Within the current peer range.",
    });
  });

  const peerRows = diagnostics.filter(row => row.coveredDays >= 3 && row.currentInventoryObserved && row.onHand >= 2 && !row.inventoryConstraint && row.revenue > 0);
  const peerValues = peerRows.map(row => row.revenuePerObservedDay);
  const lowCutoff = percentile(peerValues, 0.25);
  const highCutoff = percentile(peerValues, 0.75);

  diagnostics.forEach(row => {
    if (row.inventoryConstraint) {
      row.status = "inventory_constrained";
      row.reason = "Current inventory is depleted or nearly depleted, so current movement cannot be read as a conversion result.";
    } else if (row.currentInventoryObserved && row.onHand >= 2 && row.revenue <= 0 && row.units <= 0) {
      row.status = "at_risk";
      row.reason = "Current inventory is available but no positive movement was recorded during the Reporting Week.";
    } else if (row.coveredDays < 3) {
      row.status = "insufficient_history";
      row.reason = "Fewer than three covered warehouse days prevent a fair current-week performance classification.";
    } else if (row.currentInventoryObserved && row.onHand >= 2 && peerValues.length >= 4 && row.revenuePerObservedDay <= lowCutoff) {
      row.status = "at_risk";
      row.reason = "Revenue per observed day is in the bottom peer quartile with inventory available.";
    } else if (row.currentInventoryObserved && row.onHand >= 2 && peerValues.length >= 4 && row.revenuePerObservedDay >= highCutoff) {
      row.status = "strong";
      row.reason = "Revenue per observed day is in the top peer quartile with sufficient operating evidence.";
    }
  });

  const sortedStrong = diagnostics.filter(row => row.status === "strong").sort((a, b) => b.revenuePerObservedDay - a.revenuePerObservedDay || b.revenue - a.revenue);
  const sortedRisk = diagnostics.filter(row => row.status === "at_risk").sort((a, b) => a.revenuePerObservedDay - b.revenuePerObservedDay || b.onHand - a.onHand);

  const regionMap = new Map();
  diagnostics.forEach(row => {
    const current = regionMap.get(row.region) || { region:row.region, revenue:0, units:0, onHand:0, warehouseCount:0, sellingWarehouseCount:0, strongWarehouseCount:0, atRiskWarehouseCount:0 };
    current.revenue += row.revenue;
    current.units += row.units;
    current.onHand += row.onHand;
    current.warehouseCount += 1;
    current.sellingWarehouseCount += row.revenue > 0 || row.units > 0 ? 1 : 0;
    current.strongWarehouseCount += row.status === "strong" ? 1 : 0;
    current.atRiskWarehouseCount += row.status === "at_risk" ? 1 : 0;
    regionMap.set(row.region, current);
  });
  const regions = [...regionMap.values()].map(region => ({
    ...region,
    revenuePerSellingWarehouse:region.sellingWarehouseCount ? region.revenue / region.sellingWarehouseCount : 0,
    status:"typical",
  }));
  const comparableRegions = regions.filter(region => region.warehouseCount >= 2 && region.sellingWarehouseCount > 0);
  const regionValues = comparableRegions.map(region => region.revenuePerSellingWarehouse);
  const regionLow = percentile(regionValues, 0.25);
  const regionHigh = percentile(regionValues, 0.75);
  regions.forEach(region => {
    if (regionValues.length >= 4 && region.revenuePerSellingWarehouse <= regionLow && region.onHand > 0) region.status = "at_risk";
    else if (regionValues.length >= 4 && region.revenuePerSellingWarehouse >= regionHigh) region.status = "strong";
    else if (region.atRiskWarehouseCount > 0) region.status = "watch";
  });

  return {
    methodology:{ minimumCoveredDaysForPeerRanking:3, peerLowPercentile:0.25, peerHighPercentile:0.75 },
    warehouses:diagnostics.sort((a, b) => b.revenue - a.revenue),
    strongestWarehouses:sortedStrong,
    atRiskWarehouses:sortedRisk,
    regions:regions.sort((a, b) => b.revenuePerSellingWarehouse - a.revenuePerSellingWarehouse),
    strongestRegions:regions.filter(row => row.status === "strong"),
    atRiskRegions:regions.filter(row => row.status === "at_risk" || row.status === "watch"),
  };
}

function buildCampaignHistories(dataset, reportingEnd) {
  const productMeta = new Map(metaValues(dataset.productMeta).map(meta => [productId(meta), meta]));
  const campaignMeta = new Map(metaValues(dataset.campaignMeta).map(meta => [campaignId(meta), meta]));
  const grouped = new Map();
  (dataset.inlineTotalSales || []).filter(row => !isOnlineRow(row) && rowDate(row) <= reportingEnd).forEach(row => {
    const pid = rowProductId(row);
    const cid = rowCampaignId(row);
    if (!pid) return;
    const key = campaignKey(pid, cid);
    const rows = grouped.get(key) || [];
    rows.push(row);
    grouped.set(key, rows);
  });
  return [...grouped.entries()].map(([key, rows]) => {
    const [pid, cid] = key.split("\u0000");
    const pMeta = productMeta.get(pid) || {};
    const cMeta = campaignMeta.get(cid) || {};
    const start = meaningfulSalesStart(rows, { through:reportingEnd });
    return {
      pid,
      cid,
      productName:productName(pMeta, pid),
      brand:productBrand(pMeta),
      category:productCategory(pMeta),
      comparableGroup:productComparableGroup(pMeta),
      campaignName:String(cMeta.name ?? cMeta.campaign ?? (cid || productName(pMeta, pid))),
      meaningfulSalesStart:start,
      rows,
    };
  });
}

function selectLifecycleBenchmark(active, histories, reportingWeek) {
  if (!active.meaningfulSalesStart) return null;
  const campaignWeek = Math.floor(daysBetween(active.meaningfulSalesStart, reportingWeek.start) / 7) + 1;
  if (campaignWeek < 1) return null;
  const candidates = histories.filter(candidate => !(candidate.pid === active.pid && candidate.cid === active.cid) && candidate.meaningfulSalesStart && candidate.meaningfulSalesStart < active.meaningfulSalesStart);
  const sameProduct = candidates.filter(candidate => candidate.pid === active.pid);
  const comparatorMatches = candidate => !active.comparableGroup
    || normalized(candidate.comparableGroup) === normalized(active.comparableGroup);
  const sameBrandCategory = active.brand && active.category
    ? candidates.filter(candidate => candidate.pid !== active.pid && normalized(candidate.brand) === normalized(active.brand) && normalized(candidate.category) === normalized(active.category) && comparatorMatches(candidate))
    : [];
  const sameCategory = active.category
    ? candidates.filter(candidate => candidate.pid !== active.pid && normalized(candidate.category) === normalized(active.category) && comparatorMatches(candidate))
    : [];
  const pools = [
    ["same_product_previous_campaign", sameProduct],
    ["same_brand_and_category", sameBrandCategory],
    ["same_category_across_brands", sameCategory],
  ];
  for (const [relationship, pool] of pools) {
    const sorted = [...pool].sort((a, b) => b.meaningfulSalesStart.localeCompare(a.meaningfulSalesStart));
    for (const candidate of sorted) {
      const start = offsetDate(candidate.meaningfulSalesStart, (campaignWeek - 1) * 7);
      const end = offsetDate(start, 6);
      const rows = candidate.rows.filter(row => inRange(row, start, end));
      const totals = sumRows(rows);
      if (rows.length && (totals.revenue > 0 || totals.units > 0)) {
        return { relationship, pid:candidate.pid, cid:candidate.cid, productName:candidate.productName, campaignName:candidate.campaignName, campaignWeek, start, end, revenue:totals.revenue, units:totals.units };
      }
    }
  }
  return null;
}

export function buildReportingEvidencePackage(dataset = {}, options = {}) {
  const runDate = isoDate(options.runDate || new Date().toISOString().slice(0, 10));
  const reportingWeek = options.reportingWeek || reportingWeekFor(runDate);
  const inventoryThreshold = Number(options.inventoryThreshold ?? DEFAULT_REVIEW_INVENTORY_THRESHOLD);
  const officialRows = (dataset.inlineTotalSales || []).filter(row => !isOnlineRow(row));
  const warehouseRows = dataset.prodSales || [];
  const warehouseMeta = metaValues(dataset.whs);
  const warehouseById = new Map(warehouseMeta.map(meta => [warehouseId(meta), { ...meta, id:warehouseId(meta) }]));
  const productMeta = new Map(metaValues(dataset.productMeta).map(meta => [productId(meta), meta]));
  const campaignMeta = new Map(metaValues(dataset.campaignMeta).map(meta => [campaignId(meta), meta]));
  const officialLatest = latestDate(officialRows);
  const warehouseLatest = latestDate(warehouseRows);
  const coverage = {
    officialInline:{ latestDate:officialLatest, complete:officialLatest >= reportingWeek.end },
    warehouse:{ latestDate:warehouseLatest, complete:warehouseLatest >= reportingWeek.end },
  };
  const coreDataComplete = coverage.officialInline.complete && coverage.warehouse.complete;
  const weekOfficialRows = officialRows.filter(row => inRange(row, reportingWeek.start, reportingWeek.end) && (rowRevenue(row) > 0 || rowUnits(row) > 0));
  const activeMap = new Map();
  weekOfficialRows.forEach(row => {
    const pid = rowProductId(row);
    const cid = rowCampaignId(row);
    if (!pid || rowRevenue(row) <= 0) return;
    const key = campaignKey(pid, cid);
    const rows = activeMap.get(key) || [];
    rows.push(row);
    activeMap.set(key, rows);
  });
  const activeByProduct = new Map();
  [...activeMap.keys()].forEach(key => {
    const [pid] = key.split("\u0000");
    const list = activeByProduct.get(pid) || [];
    list.push(key);
    activeByProduct.set(pid, list);
  });
  const histories = buildCampaignHistories(dataset, reportingWeek.end);
  const warnings = [];
  activeByProduct.forEach((keys, pid) => {
    if (keys.length > 1) warnings.push({ code:"multiple_active_campaigns", pid, message:"More than one campaign has positive official inline sales for this product during the Reporting Week." });
  });

  const campaigns = [...activeMap.entries()].map(([key, weekRows]) => {
    const [pid, cid] = key.split("\u0000");
    const pMeta = productMeta.get(pid) || {};
    const cMeta = campaignMeta.get(cid) || {};
    const allowBlankCampaign = (activeByProduct.get(pid) || []).length === 1;
    const allRows = rowsForCampaign(officialRows, pid, cid, { allowBlankCampaign });
    const start = meaningfulSalesStart(allRows, { through:reportingWeek.end });
    const campaignToDateRows = start ? allRows.filter(row => inRange(row, start, reportingWeek.end)) : [];
    const reportingTotals = sumRows(weekRows);
    const campaignToDate = sumRows(campaignToDateRows);
    const denominatorRows = rowsForCampaign(warehouseRows, pid, cid, { allowBlankCampaign }).filter(row => inRange(row, reportingWeek.start, reportingWeek.end));
    const revenueDoor = averageWeeklyRevenueDoorStats(weekRows, denominatorRows, warehouseMeta.map(meta => ({ ...meta, id:warehouseId(meta) })), reportingWeek);
    const inventory = buildProductInventory(dataset, pid, cid, reportingWeek.start, reportingWeek.end, warehouseById, allowBlankCampaign, runDate);
    const unresolvedCouldChangeEligibility = inventory.totalOnHand <= inventoryThreshold
      && inventory.totalOnHand + inventory.unverifiedOnHand > inventoryThreshold;
    const eligibility = !inventory.known || unresolvedCouldChangeEligibility
      ? "unknown"
      : inventory.totalOnHand > inventoryThreshold ? "eligible" : "tail_end";
    if (eligibility === "unknown") warnings.push({ code:"inventory_eligibility_unknown", pid, cid, message:"Eligibility Could Not Be Determined because current verified physical-store inventory is missing or unresolved inventory could change the threshold result." });
    const activeHistory = {
      pid,
      cid,
      brand:productBrand(pMeta),
      category:productCategory(pMeta),
      meaningfulSalesStart:start,
      comparableGroup:productComparableGroup(pMeta),
    };
    const benchmark = selectLifecycleBenchmark(activeHistory, histories, reportingWeek);
    const distribution = buildWarehouseDiagnostics({ dataset, pid, cid, reportingWeek, warehouseById, productInventory:inventory, allowBlankCampaign });
    return {
      pid,
      cid,
      productName:productName(pMeta, pid),
      brand:productBrand(pMeta),
      category:productCategory(pMeta),
      campaignName:String(cMeta.name ?? cMeta.campaign ?? (cid || productName(pMeta, pid))),
      comparableGroup:productComparableGroup(pMeta),
      active:true,
      eligibility,
      reviewEligible:coreDataComplete && eligibility === "eligible",
      reportingWeek:{ ...reportingWeek, revenue:reportingTotals.revenue, units:reportingTotals.units },
      meaningfulSalesStart:start,
      campaignToDate:{ through:reportingWeek.end, revenue:campaignToDate.revenue, units:campaignToDate.units },
      revenuePerDoor:revenueDoor.revenuePerDoor,
      verifiedSellingDoors:revenueDoor.weekly[0]?.activeDoors || 0,
      campaignHealth:revenueDoor.weekly.length ? campaignHealthForRevenueDoor(revenueDoor.revenuePerDoor) : "unavailable",
      inventory,
      distribution,
      lifecycleBenchmark:benchmark,
    };
  }).sort((a, b) => b.reportingWeek.revenue - a.reportingWeek.revenue);

  if (!coverage.officialInline.complete) warnings.unshift({ code:"official_inline_incomplete", latestDate:coverage.officialInline.latestDate, requiredThrough:reportingWeek.end, message:"Official inline data does not cover the Reporting Week through Sunday." });
  if (!coverage.warehouse.complete) warnings.unshift({ code:"warehouse_incomplete", latestDate:coverage.warehouse.latestDate, requiredThrough:reportingWeek.end, message:"Warehouse data does not cover the Reporting Week through Sunday." });

  return {
    schema:REPORTING_EVIDENCE_VERSION,
    generatedAt:String(options.generatedAt || new Date().toISOString()),
    runDate,
    reportingWeek,
    coreDataComplete,
    coverage,
    inventoryThreshold,
    warnings,
    campaigns,
    reviewEligibleCampaigns:campaigns.filter(campaign => campaign.reviewEligible).map(campaign => ({ pid:campaign.pid, cid:campaign.cid })),
  };
}
