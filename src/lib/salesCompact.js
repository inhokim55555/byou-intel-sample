import { campaignChannelSupports } from "./campaignChannel.js";
import {
  averageWeeklyRevenueDoorStats,
  filterWarehouseMatches,
  inventoryRowHasKnownBalance,
  isNonStoreWarehouse,
  shouldIncludeInventoryCoverageItem,
  verifiedSellingWarehouseStats,
} from "./dashboardScope.js";
import { consumerWarehouseSales, consumerWarehouseHiddenScopes } from "./ownerInventoryDecisions.js";
import { weeklyRows } from "./runtimeViews.js";

export const SALES_COMPACT_SCHEMA = "byou-intel-sales-compact-v1";
export const SALES_COMPACT_REPRESENTATION = "sales-compact-v1";
export const SALES_COMPACT_MAX_PRODUCT_IDS = 64;

// These published-summary fields do not enter any Sales output or matching rule.
// Delete only known-unused fields; retain unknown fields and structural nulls.
export const SALES_UNUSED_WAREHOUSE_FIELDS = [
  "campaign", "source", "summaryStart", "summaryEnd", "summaryType",
  "promoUnits", "refundUnits", "orders", "sessions", "adSpend",
  "inbound", "inboundKnown", "reserved", "reservedKnown",
];

export function salesWarehouseReadScope(dataset = {}, options = {}) {
  // Without a published active-directory, Sales derives activity from the full
  // source before exclusions. Do not prune evidence needed by that fallback.
  if (!dataset.activeWarehouseIds?.length) return { warehouseIds:null, hiddenScopes:[] };
  const active = new Set(dataset.activeWarehouseIds.map(text));
  const productScoped = normalizedValues(options.pids).length > 0 || campaignIds(options).length > 0;
  const hiddenScopes = productScoped ? [...consumerWarehouseHiddenScopes(dataset.ownerInventoryDecisions || [])] : [];
  // Region/state charts deliberately include rows that fail sidebar screening.
  // Exact store/search charts instead use the eligible-store weekly series.
  const eligibleStoresOnly = !(options.region || options.state) || !!(options.wid || text(options.storeSearch));
  if (!eligibleStoresOnly) return { warehouseIds:null, hiddenScopes };
  const warehouses = dataset.whs || [];
  const matches = text(options.storeSearch)
    ? new Set(filterWarehouseMatches(warehouses, options.storeSearch).map(warehouse => text(warehouse?.id)))
    : null;
  return {
    warehouseIds:[...new Set(warehouses.filter(warehouse => active.has(text(warehouse?.id)) && (!matches || matches.has(text(warehouse?.id))) && !isNonStoreWarehouse(warehouse)).map(warehouse => text(warehouse?.id)))],
    hiddenScopes,
  };
}

function text(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function key(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isoDate(value) {
  const candidate = text(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : "";
}

function normalizedValues(values = []) {
  return [...new Set((values || []).map(text).filter(Boolean))].sort();
}

function campaignIds(options = {}) {
  return normalizedValues(options.cids?.length ? options.cids : options.cid ? [options.cid] : []);
}

function productIndex(productMeta = {}) {
  const aliases = new Map();
  for (const [metadataKey, value] of Object.entries(productMeta || {})) {
    const id = text(value?.id || metadataKey);
    for (const candidate of [metadataKey.replace(/^name:/, ""), id, value?.short, value?.name]) {
      const alias = key(candidate);
      if (alias && !aliases.has(alias)) aliases.set(alias, id);
    }
  }
  return aliases;
}

function canonicalProduct(value, aliases) {
  const raw = text(value);
  return aliases.get(key(raw)) || raw;
}

function uniqueCampaigns(campaignMeta = {}, aliases) {
  const campaigns = new Map();
  for (const [metadataKey, value] of Object.entries(campaignMeta || {})) {
    const id = text(value?.id || metadataKey);
    if (!id || campaigns.has(id)) continue;
    campaigns.set(id, {
      ...value,
      id,
      pid:canonicalProduct(value?.pid, aliases),
      start:isoDate(value?.start),
      end:isoDate(value?.end),
    });
  }
  return [...campaigns.values()];
}

function campaignMatchesDate(campaign, date) {
  return !!campaign && !!date
    && (!campaign.start || date >= campaign.start)
    && (!campaign.end || date <= campaign.end);
}

function campaignMatchesRowChannel(campaign, row = {}) {
  const rowChannel = text(row.channel || row.sourceType || row.salesChannel).toLowerCase() || (row.wid ? "inline" : "");
  return !rowChannel || campaignChannelSupports(campaign?.channel, rowChannel);
}

function compileCampaignMatcher(campaignMeta, productMeta, options) {
  const aliases = productIndex(productMeta);
  const campaigns = uniqueCampaigns(campaignMeta, aliases);
  const requested = campaignIds(options);
  const requestedSet = new Set(requested);
  const requestedCampaignPids = normalizedValues(campaigns.filter(campaign => requestedSet.has(campaign.id)).map(campaign => campaign.pid));
  const requestedCampaignPid = requestedCampaignPids.length === 1 ? requestedCampaignPids[0] : "";
  const byProduct = new Map();
  for (const campaign of campaigns) {
    if (!byProduct.has(campaign.pid)) byProduct.set(campaign.pid, []);
    byProduct.get(campaign.pid).push(campaign);
  }
  return {
    aliases,
    matches(row) {
      if (!requested.length) return true;
      const explicit = text(row?.cid || row?.campaignId || row?.Campaign_ID || row?.["Campaign ID"]);
      if (explicit) return requestedSet.has(explicit);
      const pid = canonicalProduct(row?.pid || row?.product || row?.name || requestedCampaignPid, aliases);
      const date = isoDate(row?.date || row?.snapshotEnd || row?.snapshotStart);
      const matches = (byProduct.get(pid) || []).filter(campaign => campaignMatchesDate(campaign, date) && campaignMatchesRowChannel(campaign, row));
      return matches.length === 1 && requestedSet.has(matches[0].id);
    },
  };
}

function inDateRange(row, options) {
  const date = isoDate(row?.date);
  return !!date && (!options.from || date >= options.from) && (!options.to || date <= options.to);
}

function overlapsDateRange(row, options) {
  const start = isoDate(row?.snapshotStart || row?.date || row?.snapshotEnd);
  const end = isoDate(row?.snapshotEnd || row?.date || row?.snapshotStart);
  if (!start && !end) return true;
  return (!options.from || (end || start) >= options.from)
    && (!options.to || (start || end) <= options.to);
}

function rowProductMatches(row, requestedPids, aliases) {
  if (!requestedPids.size) return true;
  return requestedPids.has(canonicalProduct(row?.pid || row?.product || row?.name, aliases));
}

function aggregateDaily(rows = []) {
  const grouped = new Map();
  for (const row of rows || []) {
    const date = isoDate(row?.date);
    if (!date) continue;
    const current = grouped.get(date) || { date, rev:0, units:0, promo:0, refund:0, inv:0, invKnown:false };
    current.rev += number(row?.rev);
    current.units += number(row?.units);
    current.promo += number(row?.promo);
    current.refund += number(row?.refund);
    current.inv += number(row?.inv);
    current.invKnown ||= row?.invKnown === true || row?.inv !== undefined && row?.inv !== null && text(row.inv) !== "";
    grouped.set(date, current);
  }
  return [...grouped.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function groupRows(rows = [], valueFor) {
  const groups = new Map();
  for (const row of rows || []) {
    const value = valueFor(row);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}

function rowsAreDateOrdered(rows) {
  let previous = "";
  for (const row of rows) {
    const date = text(row?.date);
    if (date !== previous && date.localeCompare(previous) < 0) return false;
    previous = date;
  }
  return true;
}

function warehouseDisplayStats(rows = [], warehouse, dateOrdered = false) {
  const sorted = dateOrdered ? rows : [...rows].sort((left, right) => text(left?.date).localeCompare(text(right?.date)));
  let positiveRev = 0, positiveUnits = 0, netRev = 0, netUnits = 0, maxInventory = 0;
  for (const row of sorted) {
    const revenue = number(row?.rev), units = number(row?.units);
    positiveRev += Math.max(0, revenue);
    positiveUnits += Math.max(0, units);
    netRev += revenue;
    netUnits += units;
    maxInventory = Math.max(maxInventory, number(row?.inv));
  }
  const reason = !warehouse || isNonStoreWarehouse(warehouse)
    ? "non-store"
    : (positiveRev <= 0 && positiveUnits <= 0) || (netRev <= 0 && netUnits <= 0)
      ? "returns-only"
      : positiveRev < 1000 && positiveUnits < 100 && maxInventory < 100
        ? "low-volume"
        : "";
  return { eligible:!reason, netRev, netUnits };
}

function compactWarehouse(warehouse = {}, stats = {}) {
  return {
    id:text(warehouse.id),
    name:text(warehouse.name),
    warehouseNo:text(warehouse.warehouseNo),
    city:text(warehouse.city),
    st:text(warehouse.st || warehouse.state),
    region:text(warehouse.region),
    total:number(stats.netRev),
    units:number(stats.netUnits),
  };
}

function salesSellThrough(rows = [], warehouseById = new Map(), dateOrdered = false) {
  const items = [];
  for (const group of groupRows(rows, row => `${text(row?.wid)}|${text(row?.pid)}`).values()) {
    const sorted = dateOrdered ? group : [...group].sort((left, right) => text(left?.date).localeCompare(text(right?.date)));
    let latest = null;
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      if (!inventoryRowHasKnownBalance(sorted[index])) continue;
      latest = sorted[index];
      break;
    }
    if (!latest) continue;
    const onHand = number(latest.inv);
    let sold = 0, revenue = 0;
    for (const row of sorted) {
      sold += Math.max(0, number(row?.units));
      revenue += number(row?.rev);
    }
    if (shouldIncludeInventoryCoverageItem(warehouseById.get(text(latest.wid)), { onHand, totalUnits:sold, revenue })) {
      items.push({ sold, onHand });
    }
  }
  const sold = items.reduce((sum, item) => sum + item.sold, 0);
  const onHand = items.reduce((sum, item) => sum + item.onHand, 0);
  return {
    available:items.length > 0 && sold + onHand > 0,
    rate:sold + onHand > 0 ? (sold / (sold + onHand)) * 100 : 0,
  };
}

function contextRows(rows, options, requestedPids, matcher, warehouseById, { strictDate = false, geography = false, intervalDates = false, allowedWarehouseIds = null, allowBlankProduct = false } = {}) {
  const productMatches = new Map();
  return (rows || []).filter(row => {
    const date = isoDate(row?.date);
    if (strictDate && !date) return false;
    if (intervalDates ? !overlapsDateRange(row, options) : date && !inDateRange(row, options)) return false;
    const rowProduct = text(row?.pid || row?.product || row?.name);
    if (!productMatches.has(rowProduct)) productMatches.set(rowProduct, (allowBlankProduct && !rowProduct) || rowProductMatches(row, requestedPids, matcher.aliases));
    if (!productMatches.get(rowProduct)) return false;
    if (!matcher.matches(row)) return false;
    if (!geography) return true;
    if (allowedWarehouseIds && !allowedWarehouseIds.has(text(row?.wid))) return false;
    if (options.wid && text(row?.wid) !== text(options.wid)) return false;
    const warehouse = warehouseById.get(text(row?.wid));
    if (options.region && text(warehouse?.region || row?.region) !== text(options.region)) return false;
    if (options.state && text(warehouse?.st || warehouse?.state || row?.st || row?.state) !== text(options.state)) return false;
    return true;
  });
}

export function salesCompactCacheKey(versionId = "", options = {}) {
  return `${text(versionId)}|sales-compact|${JSON.stringify({
    from:text(options.from),
    to:text(options.to),
    pids:normalizedValues(options.pids),
    cids:campaignIds(options),
    wid:text(options.wid),
    region:text(options.region),
    state:text(options.state),
    storeSearch:text(options.storeSearch),
  })}`;
}

export function buildSalesCompactResult(dataset = {}, options = {}) {
  const matcher = compileCampaignMatcher(dataset.campaignMeta || {}, dataset.productMeta || {}, options);
  const requestedPids = new Set(normalizedValues(options.pids).map(value => canonicalProduct(value, matcher.aliases)));
  const productScoped = requestedPids.size > 0 || campaignIds(options).length > 0;
  const warehouses = Array.isArray(dataset.whs) ? dataset.whs : [];
  const warehouseById = new Map(warehouses.map(warehouse => [text(warehouse?.id), warehouse]));
  const storeSearchWarehouseIds = text(options.storeSearch)
    ? new Set(filterWarehouseMatches(warehouses, options.storeSearch).map(warehouse => text(warehouse?.id)))
    : null;
  const warehouseHistory = productScoped
    ? dataset.summaries?.campaign?.warehouseDaily || dataset.prodSales || []
    : dataset.summaries?.campaign?.portfolioWarehouseDaily || dataset.sales || dataset.prodSales || [];
  const activeWarehouseIds = new Set((dataset.activeWarehouseIds?.length
    ? dataset.activeWarehouseIds
    : (dataset.sales?.length ? dataset.sales : warehouseHistory).filter(row => number(row?.rev) > 0).map(row => text(row?.wid)))
    .map(text).filter(Boolean));
  const scopedSourceRows = contextRows(warehouseHistory, options, requestedPids, matcher, warehouseById, {
    strictDate:true,
    geography:true,
    allowedWarehouseIds:storeSearchWarehouseIds,
  });
  const scopedWarehouseRows = productScoped
    ? consumerWarehouseSales(scopedSourceRows, dataset.ownerInventoryDecisions || [])
    : scopedSourceRows;
  const displayRows = scopedWarehouseRows.filter(row => activeWarehouseIds.has(text(row?.wid)));
  // Published history is usually ordered already. Filtering/grouping preserves
  // that order, including equal-date ties; unordered imports keep the old sort.
  const dateOrdered = rowsAreDateOrdered(displayRows);
  const rowsByWarehouse = groupRows(displayRows, row => text(row?.wid));
  const sidebarRows = [];
  const eligibleWarehouseIds = new Set();
  for (const warehouse of warehouses) {
    if (!activeWarehouseIds.has(text(warehouse?.id))) continue;
    if (storeSearchWarehouseIds && !storeSearchWarehouseIds.has(text(warehouse?.id))) continue;
    if (options.wid && text(warehouse?.id) !== text(options.wid)) continue;
    if (options.region && text(warehouse?.region) !== text(options.region)) continue;
    if (options.state && text(warehouse?.st || warehouse?.state) !== text(options.state)) continue;
    const stats = warehouseDisplayStats(rowsByWarehouse.get(text(warehouse.id)) || [], warehouse, dateOrdered);
    if (!stats.eligible || stats.netRev <= 0) continue;
    eligibleWarehouseIds.add(text(warehouse.id));
    sidebarRows.push(compactWarehouse(warehouse, stats));
  }
  sidebarRows.sort((left, right) => right.total - left.total || left.name.localeCompare(right.name));
  const eligibleRows = displayRows.filter(row => eligibleWarehouseIds.has(text(row?.wid)));

  const officialRows = contextRows(
    dataset.summaries?.campaign?.dailyInline || dataset.inlineTotalSales || [],
    options,
    requestedPids,
    matcher,
    warehouseById,
    { strictDate:true },
  );
  const warehouseScoped = !!(options.wid || options.region || options.state || text(options.storeSearch));
  const useInlineTotals = !warehouseScoped;
  const exactWarehouseSubset = !!(options.wid || text(options.storeSearch));
  const weeklyWarehouseRows = exactWarehouseSubset
    ? weeklyRows(eligibleRows, options.from, productScoped ? ["wid", "pid", "cid"] : ["wid"]).filter(row => number(row?.rev) > 0)
    : [];
  const chartSourceRows = useInlineTotals
    ? officialRows
    : exactWarehouseSubset
      ? weeklyWarehouseRows
      : options.region || options.state
      ? scopedWarehouseRows
      : eligibleRows.filter(row => number(row?.rev) > 0);
  const chartRows = aggregateDaily(chartSourceRows);
  const period = {
    rev:chartRows.reduce((sum, row) => sum + number(row.rev), 0),
    units:chartRows.reduce((sum, row) => sum + number(row.units), 0),
    promo:chartRows.reduce((sum, row) => sum + number(row.promo), 0),
    refund:chartRows.reduce((sum, row) => sum + number(row.refund), 0),
    inv:chartRows[chartRows.length - 1]?.inv || 0,
  };
  const weekly = averageWeeklyRevenueDoorStats(
    chartRows.filter(row => number(row.rev) > 0),
    eligibleRows,
    warehouses,
    { start:options.from, end:options.to },
  );
  const verified = verifiedSellingWarehouseStats(eligibleRows, warehouses);
  const revenueDoor = {
    activeDoors:weekly.weekly.length ? verified.count : 0,
    revenuePerDoor:weekly.revenuePerDoor,
    weeklyPeriodCount:weekly.weekly.length,
  };
  const onlineRows = contextRows(
    dataset.summaries?.campaign?.dailyOnline || dataset.onlineSales || [],
    options,
    requestedPids,
    matcher,
    warehouseById,
    { strictDate:true },
  );
  const ppcRows = contextRows(dataset.ppcRows || [], options, requestedPids, matcher, warehouseById, { intervalDates:true });
  const footnotes = contextRows(dataset.footnotes || [], options, requestedPids, matcher, warehouseById, { strictDate:true, allowBlankProduct:true })
    .filter(note => {
      const warehouseId = text(note?.wid);
      if (!warehouseId) return true;
      if (options.wid && warehouseId !== text(options.wid)) return false;
      if (storeSearchWarehouseIds && !storeSearchWarehouseIds.has(warehouseId)) return false;
      const warehouse = warehouseById.get(warehouseId);
      if (options.region && text(warehouse?.region || note?.region) !== text(options.region)) return false;
      if (options.state && text(warehouse?.st || warehouse?.state || note?.st || note?.state) !== text(options.state)) return false;
      return true;
    });

  return {
    schema:SALES_COMPACT_SCHEMA,
    modelVersion:1,
    representation:SALES_COMPACT_REPRESENTATION,
    view:"analytics",
    publishedAt:text(dataset.publishedAt),
    versionId:text(dataset.versionId),
    source:text(dataset.source),
    filters:{
      from:text(options.from), to:text(options.to), pids:normalizedValues(options.pids), cids:campaignIds(options),
      wid:text(options.wid), region:text(options.region), state:text(options.state), storeSearch:text(options.storeSearch),
    },
    sidebarRows,
    chartRows,
    period,
    sellThrough:salesSellThrough(eligibleRows, warehouseById, dateOrdered),
    revenueDoor,
    useInlineTotals,
    officialInlineTotalsMissing:useInlineTotals && officialRows.length === 0,
    inlineSourceLabel:useInlineTotals ? "Costco Daily Totals" : options.region || options.state ? "Published Analysis Summary" : "Warehouse Master",
    onlineRows,
    ppcRows,
    footnotes,
  };
}
