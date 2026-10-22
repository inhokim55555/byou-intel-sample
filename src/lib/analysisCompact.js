import { buildAnalysisSectionModel, filterAnalysisEventEvidence, selectAnalysisEventNotes } from "./analysisSectionModels.js";
import { consumerWarehouseSales } from "./ownerInventoryDecisions.js";
import { CAMPAIGN_DEFAULT_START, campaignAutomaticDateRange, campaignMetricDateBounds } from "./dashboardScope.js";
import { compareProductFilterText, expandProductFilterIds, groupProductFilterOptions } from "./dashboardFilters.js";

export const ANALYSIS_COMPACT_SCHEMA = "byou-intel-analysis-section-v2";
export const ANALYSIS_COMPACT_REPRESENTATION = "analysis-section-v2";
export const ANALYSIS_COMPACT_MAX_PRODUCT_IDS = 64;
export const ANALYSIS_SECTIONS = Object.freeze(["pacing", "affinity", "demographics", "comparison", "events", "warehouses"]);
export const ANALYSIS_DEFAULT_WARM_SECTIONS = Object.freeze(["pacing", "affinity", "comparison", "events"]);

function text(value) {
  return String(value ?? "").trim();
}

function normalizedSet(values = []) {
  return [...new Set((values || []).map(text).filter(Boolean))].sort();
}

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function integer(value, fallback, allowed = null, label = "numeric control") {
  const raw = text(value);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw inputError(`The requested ${label} must be a whole number.`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || allowed && !allowed.includes(parsed)) {
    throw inputError(`The requested ${label} is not supported.`);
  }
  return parsed;
}

function choice(value, allowed, fallback, label = "control") {
  const normalized = text(value);
  if (!normalized) return fallback;
  if (!allowed.includes(normalized)) throw inputError(`The requested ${label} is not supported.`);
  return normalized;
}

export function normalizeAnalysisCompactOptions(options = {}) {
  const section = text(options.section || "pacing").toLowerCase();
  if (!ANALYSIS_SECTIONS.includes(section)) throw inputError("The requested Analysis section is not supported.");
  const cids = normalizedSet(options.cids?.length ? options.cids : options.cid ? [options.cid] : []);
  const from = text(options.from);
  const to = text(options.to);
  const compareFrom = text(options.compareFrom || from);
  const compareTo = text(options.compareTo || to);
  const pids = normalizedSet(options.pids);
  if (pids.length > ANALYSIS_COMPACT_MAX_PRODUCT_IDS) {
    throw inputError(`The requested Analysis view contains too many product identifiers (maximum ${ANALYSIS_COMPACT_MAX_PRODUCT_IDS}).`);
  }
  if (compareFrom && compareTo && compareFrom > compareTo) {
    throw inputError("The comparison start date must be on or before the comparison end date.");
  }
  return {
    view:"rankings",
    representation:ANALYSIS_COMPACT_REPRESENTATION,
    section,
    from,
    to,
    pids,
    cid:cids.length === 1 ? cids[0] : "",
    cids,
    wid:text(options.wid),
    region:text(options.region),
    state:text(options.state),
    publication:text(options.publication),
    primaryPid:text(options.primaryPid),
    primaryCid:text(options.primaryCid),
    comparisonPid:text(options.comparisonPid),
    comparisonCid:text(options.comparisonCid),
    affinityRegion:text(options.affinityRegion),
    affinityState:text(options.affinityState),
    affinityMinimumPeriods:integer(options.affinityMinimumPeriods, 3, [1, 2, 3, 4, 6], "minimum reporting periods"),
    affinityMinimumUnits:integer(options.affinityMinimumUnits, 5, [0, 5, 10, 25, 50, 100], "minimum affinity units"),
    compareA:text(options.compareA),
    compareB:text(options.compareB),
    compareCampaignA:text(options.compareCampaignA),
    compareCampaignB:text(options.compareCampaignB),
    compareBucket:choice(options.compareBucket, ["warehouse", "state", "region"], "warehouse", "comparison breakdown"),
    compareMetric:choice(options.compareMetric, ["rev", "units", "revDoor", "unitsDoorDay"], "rev", "comparison metric"),
    compareNormMode:choice(options.compareNormMode, ["sellingAge", "calendar"], "sellingAge", "comparison normalization"),
    compareMinUnits:integer(options.compareMinUnits, 100, [0, 100, 200], "minimum comparison units"),
    compareRegion:text(options.compareRegion),
    compareState:text(options.compareState),
    compareFrom,
    compareTo,
  };
}

export function restoreAnalysisCompactEvidence(view = {}, source = {}, section = "") {
  if (section === "pacing") {
    return { ...view, footnotes:source.footnotes || [], videos:source.videos || [] };
  }
  if (section === "events") {
    return {
      ...view,
      prodSales:source.summaries?.campaign?.warehouseDaily || [],
      onlineSales:source.onlineSales || [],
    };
  }
  if (section === "warehouses") {
    return {
      ...view,
      prodSales:source.summaries?.campaign?.warehouseDaily || source.prodSales || [],
      inlineTotalSales:source.summaries?.campaign?.dailyInline || source.inlineTotalSales || [],
    };
  }
  return view;
}

export function analysisCompactCacheKey(versionId, options = {}) {
  return `${text(versionId)}|${JSON.stringify(normalizeAnalysisCompactOptions(options))}`;
}

export function analysisComparisonProductOptions(productMeta = {}, inlineTotalSales = []) {
  const products = [];
  const positiveSalesIds = new Set();
  for (const [key, meta] of Object.entries(productMeta || {})) {
    const rawKey = key.startsWith("name:") ? key.slice(5) : key;
    const id = text(meta?.id || meta?.name || meta?.short || rawKey);
    if (!id) continue;
    products.push({
      id,
      short:text(meta?.short || meta?.name || id),
      name:text(meta?.name || meta?.short || id),
      active:meta?.active !== false,
      totalWarehouses:Math.max(0, Number(meta?.totalWarehouses || 0)),
    });
  }
  for (const row of inlineTotalSales || []) {
    if (!(Number(row?.rev || 0) > 0 || Number(row?.units || 0) > 0)) continue;
    const id = text(row?.pid || row?.product);
    if (!id) continue;
    positiveSalesIds.add(id);
    const meta = productMeta?.[id] || Object.values(productMeta || {}).find(product => text(product?.id) === id) || {};
    products.push({ id, short:text(meta?.short || meta?.name || row?.product || id), name:text(meta?.name || meta?.short || row?.product || id), active:meta?.active !== false });
  }
  products.sort((a, b) => compareProductFilterText(a.short || a.name, b.short || b.name) || compareProductFilterText(a.id, b.id));
  return groupProductFilterOptions(products).map(product => {
    const positiveId = (product.productIds || []).filter(id => positiveSalesIds.has(id)).sort()[0];
    return positiveId && !positiveSalesIds.has(product.id) ? { ...product, id:positiveId } : product;
  });
}

export function analysisComparisonDefaults(productMeta = {}, inlineTotalSales = []) {
  const options = analysisComparisonProductOptions(productMeta, inlineTotalSales);
  const salesIds = new Set((inlineTotalSales || [])
    .filter(row => Number(row?.rev || 0) > 0 || Number(row?.units || 0) > 0)
    .map(row => text(row?.pid || row?.product)).filter(Boolean));
  const withOfficialSales = options.filter(product => product.productIds?.some(id => salesIds.has(id)));
  const activeWithOfficialSales = withOfficialSales.filter(product => product.active !== false);
  const candidates = [...activeWithOfficialSales, ...withOfficialSales.filter(product => product.active === false)];
  const compareA = candidates[0]?.id || "";
  const compareB = candidates.find(product => product.id !== compareA)?.id || "";
  return {
    compareA,
    compareB,
    primaryPid:compareA,
    comparisonPid:compareB,
    pids:expandProductFilterIds([compareA, compareB].filter(Boolean), options),
  };
}

export function analysisCompactWarmOptions(bootstrap = {}, section = "pacing") {
  const bounds = bootstrap.summaries?.bounds || {};
  const campaignBounds = campaignMetricDateBounds(bootstrap.inlineTotalSales || [], bootstrap.onlineSales || [], bounds);
  const selectedRange = campaignAutomaticDateRange(campaignBounds, CAMPAIGN_DEFAULT_START);
  const comparison = section === "comparison" ? analysisComparisonDefaults(bootstrap.productMeta || {}, bootstrap.inlineTotalSales || []) : {};
  return normalizeAnalysisCompactOptions({
    section,
    from:section === "comparison" ? bounds.start : selectedRange.start,
    to:section === "comparison" ? bounds.end : selectedRange.end,
    compareFrom:bounds.start,
    compareTo:bounds.end,
    publication:bootstrap.publishedAt,
    ...comparison,
  });
}

export function analysisCompactWarmOptionsBySection(bootstrap = {}) {
  return ANALYSIS_DEFAULT_WARM_SECTIONS
    .map(section => analysisCompactWarmOptions(bootstrap, section))
    .filter(options => options.section !== "comparison" || options.compareA && options.compareB);
}

export function buildAnalysisCompactResult(dataset = {}, options = {}, referenceData = {}) {
  const normalized = normalizeAnalysisCompactOptions(options);
  const { view, representation, section, publication, ...filters } = normalized;
  const eventNotes = section === "events" ? selectAnalysisEventNotes(dataset, normalized) : null;
  const eventWarehouseRows = eventNotes
    ? filterAnalysisEventEvidence(dataset.prodSales || [], eventNotes, dataset.productMeta || {}, false)
    : dataset.prodSales || [];
  const modelDataset = section === "events"
    ? {
      ...dataset,
      analysisEventNotes:eventNotes,
      footnotes:eventNotes,
      prodSales:consumerWarehouseSales(eventWarehouseRows, dataset.ownerInventoryDecisions || []),
      onlineSales:filterAnalysisEventEvidence(dataset.onlineSales || [], eventNotes, dataset.productMeta || {}, true),
    }
    : section === "warehouses"
      ? dataset
      : {
      ...dataset,
      prodSales:consumerWarehouseSales(dataset.prodSales || [], dataset.ownerInventoryDecisions || []),
      };
  return {
    schema:ANALYSIS_COMPACT_SCHEMA,
    representation:ANALYSIS_COMPACT_REPRESENTATION,
    modelVersion:2,
    section:normalized.section,
    publishedAt:text(dataset.publishedAt),
    versionId:text(dataset.versionId),
    filters,
    result:buildAnalysisSectionModel(modelDataset, normalized, referenceData),
    source:text(dataset.source),
    queryMs:Number(dataset.queryMs || 0),
    serverCached:!!dataset.serverCached,
  };
}
