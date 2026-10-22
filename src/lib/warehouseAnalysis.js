import { campaignChannelSupports } from "./campaignChannel.js";
import {
  inventoryCoverageEvidence,
  inventoryEligibilityState,
  inventoryRowHasKnownBalance,
  inventoryValidationEvidence,
  isNonStoreWarehouse,
  matchingInventoryApproval,
  matchingInventoryReviewDisposition,
} from "./dashboardScope.js";
import { resolveOwnerInventoryDecision } from "./ownerInventoryDecisions.js";
import { meaningfulSalesStart } from "./reportingEvidence.js";

const DAY_MS = 86400000;

function text(value) {
  return String(value ?? "").trim();
}

function finite(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedKey(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isoDate(value) {
  const match = text(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return "";
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1] ? match[0] : "";
}

function offsetDate(value, days) {
  const date = isoDate(value);
  if (!date) return "";
  return new Date(Date.parse(`${date}T00:00:00Z`) + Number(days || 0) * DAY_MS).toISOString().slice(0, 10);
}

function dayDistance(start, end) {
  return Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS);
}

function median(values = []) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value, digits = 2) {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function groupBy(values = [], keyFor) {
  const groups = new Map();
  for (const value of values) {
    const key = keyFor(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function physicalScopeKey(value = {}) {
  return [text(value.pid), text(value.cid), text(value.wid)].join("\u001f");
}

function physicalEvidenceByScope(values = []) {
  return groupBy((values || []).filter(value => !value?.grain || value.grain === "physical_warehouse"), physicalScopeKey);
}

function compactWarehouse(warehouse = {}) {
  return {
    id:text(warehouse.id),
    name:text(warehouse.name),
    warehouseNo:text(warehouse.warehouseNo),
    city:text(warehouse.city),
    st:text(warehouse.st || warehouse.state),
    region:text(warehouse.region),
  };
}

function productIndex(productMeta = {}) {
  const byId = new Map();
  const aliasToId = new Map();
  for (const [key, value] of Object.entries(productMeta || {})) {
    const id = text(value?.id || (key.startsWith("name:") ? "" : key));
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, { ...value, id });
    for (const candidate of [id, key.replace(/^name:/, ""), value?.short, value?.name]) {
      const alias = normalizedKey(candidate);
      if (alias && !aliasToId.has(alias)) aliasToId.set(alias, id);
    }
  }
  return { byId, aliasToId };
}

function canonicalProductId(value, products) {
  const raw = text(value);
  return products.aliasToId.get(normalizedKey(raw)) || raw;
}

function productLabel(pid, products) {
  const product = products.byId.get(canonicalProductId(pid, products));
  return text(product?.short || product?.name || pid);
}

function campaignCatalog(campaignMeta = {}, products) {
  const byId = new Map();
  for (const [key, value] of Object.entries(campaignMeta || {})) {
    const id = text(value?.id || (key.startsWith("name:") ? "" : key));
    if (!id || byId.has(id)) continue;
    const campaign = { ...value, id, pid:canonicalProductId(value?.pid, products) };
    if (!campaign.pid || !text(campaign.channel) || !campaignChannelSupports(campaign.channel, "inline")) continue;
    byId.set(id, campaign);
  }
  return [...byId.values()].sort((a, b) => text(a.start).localeCompare(text(b.start)) || a.id.localeCompare(b.id));
}

function campaignContainsDate(campaign, date) {
  return !!date && (!campaign.start || date >= isoDate(campaign.start)) && (!campaign.end || date <= isoDate(campaign.end));
}

function buildStrictCampaignResolver(campaigns, products) {
  const byId = new Map(campaigns.map(campaign => [campaign.id, campaign]));
  return row => {
    const explicit = text(row?.cid || row?.campaignId || row?.Campaign_ID || row?.["Campaign ID"]);
    if (explicit) return byId.get(explicit) || null;
    const pid = canonicalProductId(row?.pid || row?.product || row?.name, products);
    const date = isoDate(row?.date);
    const matches = campaigns.filter(campaign => campaign.pid === pid && campaignContainsDate(campaign, date));
    return matches.length === 1 ? matches[0] : null;
  };
}

function selectedCampaignsFor(campaigns, options, products) {
  const requestedCid = text(options.primaryCid || (options.cids?.length === 1 ? options.cids[0] : options.cid));
  const requestedPids = new Set([options.primaryPid, ...(options.pids || [])]
    .map(value => canonicalProductId(value, products)).filter(Boolean));
  return campaigns.filter(campaign => (!requestedCid || campaign.id === requestedCid)
    && (!requestedPids.size || requestedPids.has(campaign.pid)));
}

function warehouseSourceBounds(dataset, campaigns) {
  const publishedStart = isoDate(dataset.summaries?.bounds?.start);
  const publishedEnd = isoDate(dataset.summaries?.bounds?.end);
  if (publishedStart && publishedEnd) return { start:publishedStart, end:publishedEnd };
  const dates = [];
  for (const rows of [dataset.prodSales, dataset.analysisOfficialRows, dataset.inlineTotalSales]) {
    for (const row of rows || []) {
      const date = isoDate(row?.date);
      if (date) dates.push(date);
    }
  }
  for (const campaign of campaigns || []) {
    const start = isoDate(campaign?.start);
    const end = isoDate(campaign?.end);
    if (start) dates.push(start);
    if (end) dates.push(end);
  }
  dates.sort();
  return {
    start:publishedStart || dates[0] || "",
    end:publishedEnd || dates.at(-1) || "",
  };
}

function assertWarehouseScopeWithinBounds(options, bounds) {
  const requestedFrom = isoDate(options.from);
  const requestedTo = isoDate(options.to);
  const outside = requestedFrom && (bounds.start && requestedFrom < bounds.start || bounds.end && requestedFrom > bounds.end)
    || requestedTo && (bounds.start && requestedTo < bounds.start || bounds.end && requestedTo > bounds.end);
  if (!outside) return;
  const error = new Error(`Warehouse Analysis dates must remain within published data coverage (${bounds.start || "unknown"} to ${bounds.end || "unknown"}).`);
  error.status = 400;
  error.code = "WAREHOUSE_SCOPE_OUTSIDE_PUBLICATION";
  throw error;
}

function isOwnerSalesCorrectionRow(row = {}) {
  const source = normalizedKey(`${row.source || ""} ${row.summaryType || ""}`);
  return source.includes("owner sales correction") || source.includes("unallocated correction");
}

function bucketStart(anchor, date) {
  const distance = dayDistance(anchor, date);
  return offsetDate(anchor, Math.floor(Math.max(0, distance) / 7) * 7);
}

function campaignAnchor(campaign, warehouseRows, officialRows) {
  const officialStart = meaningfulSalesStart(officialRows);
  if (officialStart) return { date:officialStart, source:"official-inline-sales" };
  const warehouseStart = meaningfulSalesStart(warehouseRows);
  if (warehouseStart) return { date:warehouseStart, source:"warehouse-sales-fallback" };
  const metadataStart = isoDate(campaign.start);
  if (metadataStart) return { date:metadataStart, source:"campaign-metadata" };
  const firstDate = warehouseRows.map(row => isoDate(row.date)).filter(Boolean).sort()[0] || "";
  return { date:firstDate, source:firstDate ? "first-observation" : "unavailable" };
}

function expectedWeekStarts(anchor, start, end) {
  if (!anchor || !start || !end || end < start) return [];
  const starts = [];
  let week = bucketStart(anchor, start < anchor ? anchor : start);
  const last = bucketStart(anchor, end);
  while (week && week <= last) {
    starts.push(week);
    week = offsetDate(week, 7);
  }
  return starts;
}

function expectedWeekSummary(anchor, start, end) {
  if (!anchor || !start || !end || end < start) return { count:0, partial:0 };
  const first = bucketStart(anchor, start < anchor ? anchor : start);
  const last = bucketStart(anchor, end);
  if (!first || !last || last < first) return { count:0, partial:0 };
  const count = Math.floor(dayDistance(first, last) / 7) + 1;
  const firstPartial = first < start || offsetDate(first, 6) > end;
  const lastPartial = last < start || offsetDate(last, 6) > end;
  return { count, partial:Number(firstPartial) + Number(count > 1 && lastPartial) };
}

function inventoryWeekState({ campaign, warehouse, history, weekRows, effectiveAsOf, positiveSale, scopedEvidence = {} }) {
  const scope = { pid:campaign.pid, cid:campaign.id, wid:warehouse.id, grain:"physical_warehouse" };
  const owner = resolveOwnerInventoryDecision(scopedEvidence.ownerDecisions || [], scope, history, effectiveAsOf);
  const afterOwnerCutoff = !!owner?.decision?.cutoffDate && effectiveAsOf > owner.decision.cutoffDate;
  if (afterOwnerCutoff && owner?.conflict) return { state:"unknown", reasonCodes:[owner.conflict] };
  if (afterOwnerCutoff && owner?.applied && owner.consumerEligible === false) {
    return { state:"nonconsumer", reasonCodes:[`owner-${owner.decision.state}`] };
  }
  if (afterOwnerCutoff && owner?.applied && owner.soldThrough) {
    return { state:"sold-through", reasonCodes:["owner-confirmed-sold-through"] };
  }
  if (positiveSale) return { state:"verified-sales", reasonCodes:[] };

  const currentKnown = weekRows.filter(inventoryRowHasKnownBalance);
  if (!currentKnown.length) {
    const historical = inventoryEligibilityState(history, warehouse, { asOfDate:effectiveAsOf, evaluationDate:effectiveAsOf });
    if (historical.soldThrough) return { state:"sold-through", reasonCodes:["confirmed-sold-through"] };
    return { state:"unknown", reasonCodes:["no-dated-week-inventory"] };
  }

  const evidence = inventoryCoverageEvidence(history);
  const evaluationDate = effectiveAsOf;
  if (owner?.applied && owner.includeInTotals && owner.onHand > 0 && currentKnown.some(row => Number(row.inv) > 0)) {
    return { state:"verified-inventory", reasonCodes:[`owner-${owner.decision.state}`] };
  }
  const approvedAllocation = matchingInventoryApproval(scopedEvidence.inventoryApprovals || [], {
    ...scope,
    inventoryDate:evidence.latestInventoryDate,
    onHand:evidence.onHand,
  }, evaluationDate);
  const reviewDisposition = matchingInventoryReviewDisposition(scopedEvidence.inventoryReviewDispositions || [], {
    ...scope,
    inventoryDate:evidence.latestInventoryDate,
    onHand:evidence.onHand,
  });
  const validationOptions = { asOfDate:effectiveAsOf, evaluationDate, approvedAllocation, coverageEvidence:evidence };
  const eligibility = inventoryEligibilityState(history, warehouse, validationOptions);
  if (eligibility.soldThrough) return { state:"sold-through", reasonCodes:["confirmed-sold-through"] };
  const validation = inventoryValidationEvidence(history, validationOptions);
  const quarantined = reviewDisposition?.decision === "rejected"
    || (reviewDisposition?.decision === "reviewed_quarantined" && !validation.approvalApplied);
  if (quarantined || validation.requiresReview) {
    return {
      state:"quarantined",
      reasonCodes:[reviewDisposition?.decision, ...(validation.reasonCodes || [])].filter(Boolean),
    };
  }
  if (eligibility.countsAsStocked && currentKnown.some(row => Number(row.inv) > 0)) {
    return { state:"verified-inventory", reasonCodes:[] };
  }
  return { state:"unknown", reasonCodes:[eligibility.state, ...(eligibility.reasonCodes || [])].filter(Boolean) };
}

function weeklyEvidence({ dataset, campaign, warehouse, pairRows, anchor, scopeStart, scopeEnd, scopedEvidence }) {
  const campaignEnd = isoDate(campaign.end);
  const latestDate = pairRows.reduce((latest, row) => {
    const date = isoDate(row.date);
    return date > latest ? date : latest;
  }, "");
  const start = [anchor, scopeStart].filter(Boolean).sort().at(-1) || anchor;
  const end = [scopeEnd, campaignEnd].filter(Boolean).sort()[0] || scopeEnd || campaignEnd || latestDate;
  const scopedRows = pairRows.filter(row => {
    const date = isoDate(row.date);
    return !!date && (!scopeStart || date >= scopeStart) && (!scopeEnd || date <= scopeEnd)
      && (!anchor || date >= anchor) && (!campaignEnd || date <= campaignEnd);
  });
  const rowsByWeek = groupBy(scopedRows, row => bucketStart(anchor, isoDate(row.date)));
  const historyRows = pairRows
    .filter(row => {
      const date = isoDate(row.date);
      return !!date && (!end || date <= end) && (!campaignEnd || date <= campaignEnd);
    })
    .sort((a, b) => isoDate(a.date).localeCompare(isoDate(b.date)));
  const history = [];
  let historyIndex = 0;
  const unchangedMissingState = new Map();
  return expectedWeekStarts(anchor, start, end).map(weekStart => {
    const weekEnd = offsetDate(weekStart, 6);
    const effectiveAsOf = [weekEnd, end, campaignEnd].filter(Boolean).sort()[0] || weekEnd;
    while (historyIndex < historyRows.length && isoDate(historyRows[historyIndex].date) <= effectiveAsOf) {
      history.push(historyRows[historyIndex]);
      historyIndex += 1;
    }
    const rows = rowsByWeek.get(weekStart) || [];
    const netUnits = rows.reduce((sum, row) => sum + finite(row.units), 0);
    const netRevenue = rows.reduce((sum, row) => sum + finite(row.rev), 0);
    const positiveUnits = rows.reduce((sum, row) => sum + Math.max(0, finite(row.units)), 0);
    const positiveRevenue = rows.reduce((sum, row) => sum + Math.max(0, finite(row.rev)), 0);
    const positiveSale = positiveUnits > 0 || positiveRevenue > 0;
    const cacheableMissing = !positiveSale
      && !(scopedEvidence.ownerDecisions || []).length
      && !rows.some(inventoryRowHasKnownBalance);
    let inventory = cacheableMissing ? unchangedMissingState.get(historyIndex) : null;
    if (!inventory) {
      inventory = inventoryWeekState({
        campaign,
        warehouse,
        history,
        weekRows:rows,
        effectiveAsOf,
        positiveSale,
        scopedEvidence,
      });
      if (cacheableMissing) unchangedMissingState.set(historyIndex, inventory);
    }
    const verified = inventory.state === "verified-sales" || inventory.state === "verified-inventory";
    return {
      weekStart,
      weekEnd,
      netUnits,
      netRevenue,
      positiveUnits,
      positiveRevenue,
      verified,
      availabilityState:inventory.state,
      reasonCodes:inventory.reasonCodes,
      partial:weekStart < start || weekEnd > end,
    };
  });
}

function tiedRanks(rows, valueFor, { descending = true, field = "rank", percentileField = "percentile" } = {}) {
  const comparable = rows.filter(row => {
    const value = valueFor(row);
    return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  });
  comparable.sort((a, b) => {
    const delta = Number(valueFor(a)) - Number(valueFor(b));
    return (descending ? -delta : delta) || text(a.warehouse?.id).localeCompare(text(b.warehouse?.id));
  });
  let previous = null;
  let rank = 0;
  comparable.forEach((row, index) => {
    const value = round(valueFor(row), 8);
    if (previous === null || value !== previous) rank = index + 1;
    row[field] = rank;
    if (percentileField) row[percentileField] = comparable.length === 1
      ? 50
      : round(((comparable.length - rank) / (comparable.length - 1)) * 100, 2);
    previous = value;
  });
  return comparable;
}

function tierFor(score) {
  if (score === null || score === undefined || score === "" || !Number.isFinite(Number(score))) return "insufficient-evidence";
  if (score >= 90) return "top-10";
  if (score >= 75) return "top-25";
  if (score >= 25) return "middle-50";
  if (score >= 10) return "bottom-25";
  return "bottom-10";
}

function confidenceFor(count) {
  return count >= 3 ? "established" : count >= 1 ? "limited-evidence" : "insufficient-evidence";
}

const MIN_WAREHOUSE_CAMPAIGN_NET_UNITS = 10;

function summarizeStates(weeks = []) {
  const result = { expected:0, verified:0, unknown:0, soldThrough:0, quarantined:0, nonconsumer:0, partial:0 };
  for (const week of weeks) {
    if (week.verified) {
      result.verified += 1;
      result.expected += 1;
    } else if (week.availabilityState === "sold-through") result.soldThrough += 1;
    else if (week.availabilityState === "nonconsumer") result.nonconsumer += 1;
    else if (week.availabilityState === "quarantined") {
      result.quarantined += 1;
      result.expected += 1;
    } else {
      result.unknown += 1;
      result.expected += 1;
    }
    if (week.partial) result.partial += 1;
  }
  return result;
}

function buildPair({ dataset, campaign, warehouse, pairRows, anchor, scopeStart, scopeEnd, scopedEvidence }) {
  const durableNonconsumer = (scopedEvidence.ownerDecisions || [])
    .find(decision => decision?.state !== "revoked" && ["retained", "excluded"].includes(decision?.state));
  if (durableNonconsumer) {
    const campaignEnd = isoDate(campaign.end);
    const start = [anchor, scopeStart].filter(Boolean).sort().at(-1) || anchor;
    const end = [scopeEnd, campaignEnd].filter(Boolean).sort()[0] || scopeEnd || campaignEnd || "";
    const weekSummary = expectedWeekSummary(anchor, start, end);
    const scopedRows = pairRows.filter(row => {
      const date = isoDate(row.date);
      return !!date && (!scopeStart || date >= scopeStart) && (!scopeEnd || date <= scopeEnd)
        && (!anchor || date >= anchor) && (!campaignEnd || date <= campaignEnd);
    });
    return {
      warehouse,
      campaign,
      weeks:[],
      states:{ expected:0, verified:0, unknown:0, soldThrough:0, quarantined:0, nonconsumer:weekSummary.count, partial:weekSummary.partial },
      qualifying:false,
      verifiedWeeks:0,
      expectedWeeks:0,
      netUnits:0,
      netRevenue:0,
      rawNetUnits:scopedRows.reduce((sum, row) => sum + finite(row.units), 0),
      rawRevenue:scopedRows.reduce((sum, row) => sum + finite(row.rev), 0),
      velocity:null,
      analyticalEligible:false,
    };
  }
  if (!pairRows.length && !(scopedEvidence.ownerDecisions || []).length) {
    const campaignEnd = isoDate(campaign.end);
    const start = [anchor, scopeStart].filter(Boolean).sort().at(-1) || anchor;
    const end = [scopeEnd, campaignEnd].filter(Boolean).sort()[0] || scopeEnd || campaignEnd || "";
    const weekSummary = expectedWeekSummary(anchor, start, end);
    return {
      warehouse,
      campaign,
      weeks:[],
      states:{ expected:weekSummary.count, verified:0, unknown:weekSummary.count, soldThrough:0, quarantined:0, nonconsumer:0, partial:weekSummary.partial },
      qualifying:false,
      verifiedWeeks:0,
      expectedWeeks:weekSummary.count,
      netUnits:0,
      netRevenue:0,
      rawNetUnits:0,
      rawRevenue:0,
      velocity:null,
      analyticalEligible:false,
    };
  }
  const weeks = weeklyEvidence({ dataset, campaign, warehouse, pairRows, anchor, scopeStart, scopeEnd, scopedEvidence });
  const states = summarizeStates(weeks);
  const verifiedRows = weeks.filter(row => row.verified);
  const netUnits = verifiedRows.reduce((sum, row) => sum + row.netUnits, 0);
  const netRevenue = verifiedRows.reduce((sum, row) => sum + row.netRevenue, 0);
  const allNetUnits = weeks.reduce((sum, row) => sum + row.netUnits, 0);
  const allNetRevenue = weeks.reduce((sum, row) => sum + row.netRevenue, 0);
  const analyticalEligible = netUnits >= MIN_WAREHOUSE_CAMPAIGN_NET_UNITS;
  return {
    warehouse,
    campaign,
    weeks,
    states,
    qualifying:analyticalEligible && states.verified >= 2,
    analyticalEligible,
    verifiedWeeks:states.verified,
    expectedWeeks:states.expected,
    netUnits,
    netRevenue,
    rawNetUnits:allNetUnits,
    rawRevenue:allNetRevenue,
    velocity:states.verified ? netUnits / states.verified : null,
  };
}

function campaignRow(pair, products, anchorInfo) {
  return {
    cid:pair.campaign.id,
    campaign:text(pair.campaign.short || pair.campaign.name || pair.campaign.id),
    pid:pair.campaign.pid,
    product:productLabel(pair.campaign.pid, products),
    score:pair.percentile ?? null,
    percentile:pair.percentile ?? null,
    rank:pair.campaignRank ?? null,
    tier:tierFor(pair.percentile),
    velocity:round(pair.velocity, 2),
    netUnits:round(pair.netUnits, 2),
    revenue:round(pair.netRevenue, 2),
    rawNetUnits:round(pair.rawNetUnits, 2),
    rawRevenue:round(pair.rawRevenue, 2),
    verifiedWeeks:pair.verifiedWeeks,
    expectedWeeks:pair.expectedWeeks,
    unknownWeeks:pair.states.unknown,
    soldThroughWeeks:pair.states.soldThrough,
    quarantinedWeeks:pair.states.quarantined,
    qualifying:pair.qualifying,
    anchor:anchorInfo.date,
    anchorSource:anchorInfo.source,
  };
}

function buildWarehouseRows({ retailWarehouses, selectedCampaigns, pairs, products }) {
  const pairsByWarehouse = groupBy(pairs, pair => pair.warehouse.id);
  const rows = retailWarehouses.map(warehouse => {
    const warehousePairs = pairsByWarehouse.get(warehouse.id) || [];
    const analyticalPairs = warehousePairs.filter(pair => pair.analyticalEligible);
    const qualifying = analyticalPairs.filter(pair => pair.qualifying && Number.isFinite(pair.percentile));
    const score = median(qualifying.map(pair => pair.percentile));
    const verifiedWeeks = warehousePairs.reduce((sum, pair) => sum + pair.verifiedWeeks, 0);
    const expectedWeeks = warehousePairs.reduce((sum, pair) => sum + pair.expectedWeeks, 0);
    const velocityVerifiedWeeks = analyticalPairs.reduce((sum, pair) => sum + pair.verifiedWeeks, 0);
    const netUnits = analyticalPairs.reduce((sum, pair) => sum + pair.netUnits, 0);
    const revenue = analyticalPairs.reduce((sum, pair) => sum + pair.netRevenue, 0);
    const rawNetUnits = warehousePairs.reduce((sum, pair) => sum + pair.rawNetUnits, 0);
    const rawRevenue = warehousePairs.reduce((sum, pair) => sum + pair.rawRevenue, 0);
    const productScores = [...groupBy(qualifying, pair => pair.campaign.pid).entries()].map(([pid, productPairs]) => ({
      pid,
      product:productLabel(pid, products),
      score:median(productPairs.map(pair => pair.percentile)),
      qualifyingCampaigns:productPairs.length,
    })).sort((a, b) => Number(b.score) - Number(a.score) || a.product.localeCompare(b.product));
    return {
      warehouse:compactWarehouse(warehouse),
      score:round(score, 2),
      tier:tierFor(score),
      confidence:confidenceFor(qualifying.length),
      qualifyingCampaigns:qualifying.length,
      selectedCampaigns:selectedCampaigns.length,
      netUnitsPerVerifiedWeek:velocityVerifiedWeeks ? round(netUnits / velocityVerifiedWeeks, 2) : null,
      netUnits:round(netUnits, 2),
      revenue:round(revenue, 2),
      rawNetUnits:round(rawNetUnits, 2),
      rawRevenue:round(rawRevenue, 2),
      verifiedWeeks,
      velocityVerifiedWeeks,
      expectedWeeks,
      coveragePct:expectedWeeks ? round((verifiedWeeks / expectedWeeks) * 100, 1) : 0,
      strongestProduct:productScores[0] || null,
    };
  });
  tiedRanks(rows, row => row.score, { field:"rank", percentileField:null });
  tiedRanks(rows, row => row.rawNetUnits, { field:"rawRank", percentileField:null });
  return rows.sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)
    || (a.rawRank ?? Number.MAX_SAFE_INTEGER) - (b.rawRank ?? Number.MAX_SAFE_INTEGER)
    || a.warehouse.name.localeCompare(b.warehouse.name));
}

function productRowsForWarehouse(warehousePairs, products) {
  const analyticalPairs = warehousePairs.filter(pair => pair.analyticalEligible);
  return [...groupBy(analyticalPairs, pair => pair.campaign.pid).entries()].map(([pid, productPairs]) => {
    const qualifying = productPairs.filter(pair => pair.qualifying && Number.isFinite(pair.percentile));
    const verifiedWeeks = productPairs.reduce((sum, pair) => sum + pair.verifiedWeeks, 0);
    const expectedWeeks = productPairs.reduce((sum, pair) => sum + pair.expectedWeeks, 0);
    const netUnits = productPairs.reduce((sum, pair) => sum + pair.netUnits, 0);
    const revenue = productPairs.reduce((sum, pair) => sum + pair.netRevenue, 0);
    const score = median(qualifying.map(pair => pair.percentile));
    return {
      pid,
      product:productLabel(pid, products),
      score:round(score, 2),
      tier:tierFor(score),
      confidence:confidenceFor(qualifying.length),
      qualifyingCampaigns:qualifying.length,
      verifiedWeeks,
      expectedWeeks,
      coveragePct:expectedWeeks ? round((verifiedWeeks / expectedWeeks) * 100, 1) : 0,
      netUnits:round(netUnits, 2),
      revenue:round(revenue, 2),
      velocity:verifiedWeeks ? round(netUnits / verifiedWeeks, 2) : null,
    };
  }).sort((a, b) => Number(b.score ?? -1) - Number(a.score ?? -1) || a.product.localeCompare(b.product));
}

function dailyProductTrendsForWarehouse({ warehousePairs, resolvedRows, products, scopeStart, scopeEnd }) {
  const eligiblePairs = warehousePairs.filter(pair => pair.analyticalEligible);
  const availablePairs = eligiblePairs.filter(pair => {
    const campaignEnd = isoDate(pair.campaign.end);
    if (campaignEnd && scopeEnd && campaignEnd < scopeEnd) return false;
    const latestWeek = pair.weeks.at(-1);
    return latestWeek?.availabilityState === "verified-sales" || latestWeek?.availabilityState === "verified-inventory";
  });
  const availableByProduct = groupBy(availablePairs, pair => pair.campaign.pid);
  const eligibleCampaignIdsByProduct = new Map();
  for (const pair of eligiblePairs) {
    if (!availableByProduct.has(pair.campaign.pid)) continue;
    if (!eligibleCampaignIdsByProduct.has(pair.campaign.pid)) eligibleCampaignIdsByProduct.set(pair.campaign.pid, new Set());
    eligibleCampaignIdsByProduct.get(pair.campaign.pid).add(pair.campaign.id);
  }
  const rowsByProduct = groupBy((resolvedRows || []).filter(row => {
    const date = isoDate(row.date);
    return availableByProduct.has(row.pid)
      && eligibleCampaignIdsByProduct.get(row.pid)?.has(row.cid)
      && (!scopeStart || date >= scopeStart)
      && (!scopeEnd || date <= scopeEnd);
  }), row => row.pid);

  return [...availableByProduct.entries()].map(([pid, currentPairs]) => {
    const daily = [...groupBy(rowsByProduct.get(pid) || [], row => isoDate(row.date)).entries()]
      .filter(([date]) => !!date)
      .map(([date, rows]) => ({
        date,
        netUnits:round(rows.reduce((sum, row) => sum + finite(row.units), 0), 2),
        revenue:round(rows.reduce((sum, row) => sum + finite(row.rev), 0), 2),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const latestPair = currentPairs.slice().sort((a, b) => {
      const aEnd = a.weeks.at(-1)?.weekEnd || "";
      const bEnd = b.weeks.at(-1)?.weekEnd || "";
      return bEnd.localeCompare(aEnd) || a.campaign.id.localeCompare(b.campaign.id);
    })[0];
    const latestWeek = latestPair?.weeks.at(-1);
    return {
      pid,
      product:productLabel(pid, products),
      availabilityState:latestWeek?.availabilityState || "unknown",
      availableWeekStart:latestWeek?.weekStart || "",
      availableWeekEnd:latestWeek?.weekEnd || "",
      observedDays:daily.length,
      points:daily,
    };
  }).filter(row => row.points.length)
    .sort((a, b) => a.product.localeCompare(b.product));
}

function geographyMatches(row, options) {
  return (!options.region || row.warehouse.region === options.region)
    && (!options.state || row.warehouse.st === options.state);
}

function summaryFor(rows) {
  const established = rows.filter(row => row.confidence === "established");
  return {
    eligibleWarehouses:rows.length,
    established:established.length,
    limitedEvidence:rows.filter(row => row.confidence === "limited-evidence").length,
    insufficientEvidence:rows.filter(row => row.confidence === "insufficient-evidence").length,
    highest:established.slice().sort((a, b) => Number(b.score) - Number(a.score) || a.warehouse.name.localeCompare(b.warehouse.name))[0] || null,
    lowest:established.slice().sort((a, b) => Number(a.score) - Number(b.score) || a.warehouse.name.localeCompare(b.warehouse.name))[0] || null,
  };
}

export function buildWarehouseAnalysisModel(dataset = {}, options = {}) {
  const products = productIndex(dataset.productMeta || {});
  const physicalCampaigns = campaignCatalog(dataset.campaignMeta || {}, products);
  const availableBounds = warehouseSourceBounds(dataset, physicalCampaigns);
  assertWarehouseScopeWithinBounds(options, availableBounds);
  const physicalCampaignIds = new Set(physicalCampaigns.map(campaign => campaign.id));
  const allCampaignsById = new Map();
  for (const [key, value] of Object.entries(dataset.campaignMeta || {})) {
    const id = text(value?.id || (key.startsWith("name:") ? "" : key));
    if (id && !allCampaignsById.has(id)) allCampaignsById.set(id, { ...value, id });
  }
  const selectedCampaigns = selectedCampaignsFor(physicalCampaigns, options, products);
  const selectedIds = new Set(selectedCampaigns.map(campaign => campaign.id));
  const requestedCid = text(options.primaryCid || (options.cids?.length === 1 ? options.cids[0] : options.cid));
  const requestedPids = new Set([options.primaryPid, ...(options.pids || [])]
    .map(value => canonicalProductId(value, products)).filter(Boolean));
  const warehouseById = new Map((dataset.whs || []).map(warehouse => [text(warehouse.id), warehouse]));
  const directoryRetailWarehouses = (dataset.whs || []).filter(warehouse => text(warehouse.id) && !isNonStoreWarehouse(warehouse));
  const retailIds = new Set(directoryRetailWarehouses.map(warehouse => text(warehouse.id)));
  const resolveCampaign = buildStrictCampaignResolver(physicalCampaigns, products);
  const resolvedRows = [];
  let unresolvedCampaignRows = 0;
  let unresolvedWarehouseRows = 0;
  let excludedNonRetailRows = 0;
  let excludedNonPhysicalRows = 0;
  let correctionRowsExcluded = 0;
  const sourceHorizonEnd = isoDate(options.to);
  for (const row of dataset.prodSales || []) {
    const explicitCid = text(row?.cid || row?.campaignId || row?.Campaign_ID || row?.["Campaign ID"]);
    const explicitCampaign = explicitCid ? allCampaignsById.get(explicitCid) : null;
    const sourcePid = canonicalProductId(explicitCampaign?.pid || row?.pid || row?.product || row?.name, products);
    if (requestedCid && explicitCid && explicitCid !== requestedCid) continue;
    if (requestedPids.size && sourcePid && !requestedPids.has(sourcePid)) continue;
    if (isOwnerSalesCorrectionRow(row)) {
      correctionRowsExcluded += 1;
      continue;
    }
    const date = isoDate(row?.date);
    if (sourceHorizonEnd && date && date > sourceHorizonEnd) continue;
    if (explicitCid && allCampaignsById.has(explicitCid) && !physicalCampaignIds.has(explicitCid)) {
      excludedNonPhysicalRows += 1;
      continue;
    }
    const campaign = resolveCampaign(row);
    if (!campaign) {
      unresolvedCampaignRows += 1;
      continue;
    }
    if (!selectedIds.has(campaign.id)) continue;
    const warehouse = warehouseById.get(text(row?.wid));
    if (!warehouse) {
      unresolvedWarehouseRows += 1;
      continue;
    }
    if (!retailIds.has(text(row?.wid))) {
      excludedNonRetailRows += 1;
      continue;
    }
    resolvedRows.push({ ...row, date, pid:campaign.pid, cid:campaign.id, __campaign:campaign, __warehouse:warehouse });
  }

  const resolvedRowsByWarehouse = groupBy(resolvedRows, row => text(row.wid));
  const returnArtifactIds = new Set(directoryRetailWarehouses.filter(warehouse => {
    const rows = resolvedRowsByWarehouse.get(text(warehouse.id)) || [];
    if (!rows.length) return false;
    const positiveUnits = rows.reduce((sum, row) => sum + Math.max(0, finite(row.units)), 0);
    const positiveRevenue = rows.reduce((sum, row) => sum + Math.max(0, finite(row.rev)), 0);
    const netUnits = rows.reduce((sum, row) => sum + finite(row.units), 0);
    const netRevenue = rows.reduce((sum, row) => sum + finite(row.rev), 0);
    const refundMovement = rows.some(row => finite(row.refund) !== 0 || finite(row.refundUnits) !== 0);
    const knownInventory = rows.filter(inventoryRowHasKnownBalance).reduce((peak, row) => Math.max(peak, finite(row.inv)), 0);
    return !(positiveUnits > 0 || positiveRevenue > 0)
      && (netUnits < 0 || netRevenue < 0 || refundMovement)
      && knownInventory <= 1;
  }).map(warehouse => text(warehouse.id)));
  const retailWarehouses = directoryRetailWarehouses.filter(warehouse => !returnArtifactIds.has(text(warehouse.id)));
  if (returnArtifactIds.size) {
    for (let index = resolvedRows.length - 1; index >= 0; index -= 1) {
      if (returnArtifactIds.has(text(resolvedRows[index].wid))) resolvedRows.splice(index, 1);
    }
  }

  const officialRows = dataset.analysisOfficialRows || dataset.inlineTotalSales || [];
  const officialResolver = buildStrictCampaignResolver(physicalCampaigns, products);
  const campaignRows = groupBy(resolvedRows, row => row.cid);
  const anchors = new Map();
  for (const campaign of selectedCampaigns) {
    const campaignOfficialRows = officialRows.filter(row => officialResolver(row)?.id === campaign.id);
    anchors.set(campaign.id, campaignAnchor(campaign, campaignRows.get(campaign.id) || [], campaignOfficialRows));
  }

  const scopeStart = isoDate(options.from) || selectedCampaigns.map(campaign => isoDate(campaign.start)).filter(Boolean).sort()[0] || "";
  const resolvedDataEnd = resolvedRows.reduce((latest, row) => row.date > latest ? row.date : latest, "");
  const scopeEnd = isoDate(options.to)
    || resolvedDataEnd
    || selectedCampaigns.map(campaign => isoDate(campaign.end)).filter(Boolean).sort().at(-1)
    || "";
  const rowsByPair = groupBy(resolvedRows, row => `${row.cid}\u001f${row.wid}`);
  const ownerDecisionsByPair = physicalEvidenceByScope(dataset.ownerInventoryDecisions || []);
  const inventoryApprovalsByPair = physicalEvidenceByScope(dataset.inventoryApprovals || []);
  const inventoryReviewDispositionsByPair = physicalEvidenceByScope(dataset.inventoryReviewDispositions || []);
  const pairs = [];
  for (const campaign of selectedCampaigns) {
    const anchor = anchors.get(campaign.id)?.date;
    if (!anchor) continue;
    for (const warehouse of retailWarehouses) {
      const pairRows = rowsByPair.get(`${campaign.id}\u001f${warehouse.id}`) || [];
      const evidenceKey = physicalScopeKey({ pid:campaign.pid, cid:campaign.id, wid:warehouse.id });
      pairs.push(buildPair({
        dataset,
        campaign,
        warehouse,
        pairRows,
        anchor,
        scopeStart,
        scopeEnd,
        scopedEvidence:{
          ownerDecisions:ownerDecisionsByPair.get(evidenceKey) || [],
          inventoryApprovals:inventoryApprovalsByPair.get(evidenceKey) || [],
          inventoryReviewDispositions:inventoryReviewDispositionsByPair.get(evidenceKey) || [],
        },
      }));
    }
  }

  for (const campaign of selectedCampaigns) {
    const campaignPairs = pairs.filter(pair => pair.campaign.id === campaign.id && pair.qualifying);
    tiedRanks(campaignPairs, pair => pair.velocity, { field:"campaignRank", percentileField:"percentile" });
  }

  const nationalRows = buildWarehouseRows({ retailWarehouses, selectedCampaigns, pairs, products });
  const regionGroups = groupBy(nationalRows.filter(row => Number.isFinite(row.score)), row => row.warehouse.region || "__unassigned__");
  for (const regionalRows of regionGroups.values()) tiedRanks(regionalRows, row => row.score, { field:"regionalRank", percentileField:null });
  const displayedRows = nationalRows.filter(row => geographyMatches(row, options));
  const stateCounts = pairs.reduce((counts, pair) => {
    for (const [key, value] of Object.entries(pair.states)) counts[key] = finite(counts[key]) + finite(value);
    return counts;
  }, {});
  const campaignsWithEvidence = selectedCampaigns.filter(campaign => (campaignRows.get(campaign.id) || []).length).map(campaign => ({
    id:campaign.id,
    pid:campaign.pid,
    campaign:text(campaign.short || campaign.name || campaign.id),
    product:productLabel(campaign.pid, products),
    start:isoDate(campaign.start),
    end:isoDate(campaign.end),
  }));
  const productScope = [...new Map(campaignsWithEvidence.map(campaign => [campaign.pid, { id:campaign.pid, label:campaign.product }])).values()]
    .sort((a, b) => a.label.localeCompare(b.label));
  const scope = {
    from:scopeStart,
    to:scopeEnd,
    availableFrom:availableBounds.start,
    availableTo:availableBounds.end,
    selectedPid:text(options.primaryPid),
    selectedCid:text(options.primaryCid),
    region:text(options.region),
    state:text(options.state),
    comparisonScope:"national",
    products:productScope,
    campaigns:campaignsWithEvidence,
  };
  const coverage = {
    nationalRetailWarehouses:retailWarehouses.length,
    displayedWarehouses:displayedRows.length,
    selectedPhysicalCampaigns:selectedCampaigns.length,
    campaignsWithEvidence:campaignsWithEvidence.length,
    resolvedRows:resolvedRows.length,
    unresolvedCampaignRows,
    unresolvedWarehouseRows,
    excludedNonRetailRows,
    excludedNonPhysicalRows,
    returnArtifactWarehouses:returnArtifactIds.size,
    correctionRowsExcluded,
    expectedWeeks:finite(stateCounts.expected),
    verifiedWeeks:finite(stateCounts.verified),
    unknownWeeks:finite(stateCounts.unknown),
    soldThroughWeeks:finite(stateCounts.soldThrough),
    quarantinedWeeks:finite(stateCounts.quarantined),
    nonconsumerWeeks:finite(stateCounts.nonconsumer),
    partialWeeks:finite(stateCounts.partial),
    belowMinimumNetUnitPairs:pairs.filter(pair => !pair.analyticalEligible).length,
    minimumCampaignNetUnits:MIN_WAREHOUSE_CAMPAIGN_NET_UNITS,
    verifiedWeekPct:stateCounts.expected ? round((finite(stateCounts.verified) / finite(stateCounts.expected)) * 100, 1) : 0,
    anchorSources:Object.fromEntries([...anchors].map(([cid, value]) => [cid, value.source])),
  };

  const selectedWarehouseId = text(options.wid);
  if (!selectedWarehouseId) {
    return {
      kind:"warehouse-ranking-v1",
      scope,
      coverage,
      summary:summaryFor(displayedRows),
      rows:displayedRows,
    };
  }

  const warehouseRow = nationalRows.find(row => row.warehouse.id === selectedWarehouseId && geographyMatches(row, options));
  if (!warehouseRow) {
    return {
      kind:"warehouse-profile-v1",
      scope,
      coverage,
      warehouse:null,
      overall:null,
      productRows:[],
      campaignRows:[],
      dailyProductTrends:[],
      evidence:{ status:"not-found", disclosures:["The selected warehouse is not a retail warehouse in this scope."] },
    };
  }
  const warehousePairs = pairs.filter(pair => pair.warehouse.id === selectedWarehouseId);
  const campaignRowsForProfile = warehousePairs.filter(pair => pair.analyticalEligible)
    .map(pair => campaignRow(pair, products, anchors.get(pair.campaign.id)))
    .sort((a, b) => Number(b.score ?? -1) - Number(a.score ?? -1) || a.campaign.localeCompare(b.campaign));
  const regionalTotal = (regionGroups.get(warehouseRow.warehouse.region || "__unassigned__") || []).length;
  const nationalTotal = nationalRows.filter(row => Number.isFinite(row.score)).length;
  const { warehouse, regionalRank, ...overallRow } = warehouseRow;
  return {
    kind:"warehouse-profile-v1",
    scope,
    coverage,
    warehouse,
    overall:{
      ...overallRow,
      nationalStanding:{ rank:warehouseRow.rank ?? null, total:nationalTotal },
      regionalStanding:{ rank:regionalRank ?? null, total:regionalTotal, region:warehouse.region },
    },
    productRows:productRowsForWarehouse(warehousePairs, products),
    campaignRows:campaignRowsForProfile,
    dailyProductTrends:dailyProductTrendsForWarehouse({
      warehousePairs,
      resolvedRows:resolvedRowsByWarehouse.get(selectedWarehouseId) || [],
      products,
      scopeStart,
      scopeEnd,
    }),
    evidence:{
      status:warehouseRow.confidence,
      verifiedWeeks:warehouseRow.verifiedWeeks,
      expectedWeeks:warehouseRow.expectedWeeks,
      coveragePct:warehouseRow.coveragePct,
      minimumCampaignNetUnits:MIN_WAREHOUSE_CAMPAIGN_NET_UNITS,
      excludedBelowMinimumCampaigns:warehousePairs.filter(pair => !pair.analyticalEligible).length,
      disclosures:[
        "Popularity is a national percentile based on net units per verified availability week.",
        `Campaigns below ${MIN_WAREHOUSE_CAMPAIGN_NET_UNITS} signed net units are excluded from scoring, velocity, Product Mix, and Campaign History.`,
        "Inventory and coverage describe evidence quality and are not treated as causes of performance.",
        "Unknown and confirmed post-sell-through weeks do not enter the velocity denominator.",
      ],
    },
  };
}

export const warehouseAnalysisInternals = Object.freeze({
  bucketStart,
  campaignAnchor,
  confidenceFor,
  expectedWeekStarts,
  tierFor,
  tiedRanks,
  weeklyEvidence,
});
