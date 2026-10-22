export const AFFINITY_FEATURES = [
  { key:"population", label:"Population", format:"count" },
  { key:"householdIncome", label:"Average household income", format:"currency" },
  { key:"averageAge", label:"Average age", format:"number" },
  { key:"asianPct", label:"Asian share", format:"percent" },
  { key:"whitePct", label:"White / Caucasian share", format:"percent" },
  { key:"blackPct", label:"Black / African American share", format:"percent" },
  { key:"hispanicPct", label:"Hispanic / Latino share", format:"percent" },
  { key:"femalePct", label:"Female share", format:"percent" },
];

const MIN_MODEL_WAREHOUSES = 12;
const MULTIPLE_COMPARISON_TAIL = 0.025 / AFFINITY_FEATURES.length;

export function summarizeSalesAffinityReading(model = {}) {
  const rows = (Array.isArray(model.rows) ? model.rows : [])
    .filter(row => Number.isFinite(Number(row?.affinityIndex)))
    .sort((left, right) => Number(right.affinityIndex) - Number(left.affinityIndex));
  if (model.status !== "ready" || !rows.length) return { available:false };

  const warehouseSummary = row => ({
    id:String(row.warehouseId || row.warehouse?.id || ""),
    name:String(row.warehouse?.name || row.warehouseId || "Warehouse"),
    affinityIndex:Number(row.affinityIndex),
    velocity:Number.isFinite(Number(row.velocity)) ? Number(row.velocity) : 0,
  });
  const aboveExpected = rows.filter(row => Number(row.affinityIndex) >= 110).length;
  const belowExpected = rows.filter(row => Number(row.affinityIndex) <= 90).length;

  return {
    available:true,
    qualifiedWarehouses:rows.length,
    aboveExpected,
    belowExpected,
    nearExpected:Math.max(0, rows.length - aboveExpected - belowExpected),
    leader:warehouseSummary(rows[0]),
    watch:warehouseSummary(rows[rows.length - 1]),
    repeatableSignals:(model.signals || []).filter(signal => signal.confidence !== "exploratory").length,
    testedCharacteristics:Number(model.summary?.testedCharacteristics || 0),
  };
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mean(values = []) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function quantile(values = [], probability = 0.5) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(1, probability)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function median(values = []) {
  return quantile(values, 0.5);
}

function standardDeviation(values = []) {
  if (values.length < 2) return 0;
  const center = mean(values);
  return Math.sqrt(values.reduce((total, value) => total + (value - center) ** 2, 0) / (values.length - 1));
}

function groupBy(values, keyFor) {
  const result = new Map();
  values.forEach(value => {
    const key = keyFor(value);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(value);
  });
  return result;
}

function aggregateWarehouseRows(rows = [], warehouseById = new Map()) {
  return [...groupBy(rows.filter(row => row?.wid && row?.date), row => row.wid).entries()].map(([warehouseId, warehouseRows]) => {
    const periods = new Map();
    warehouseRows.forEach(row => {
      const current = periods.get(row.date) || { units:0, revenue:0, promo:0, refund:0, inventory:0 };
      current.units += Math.max(0, finiteNumber(row.units));
      current.revenue += Math.max(0, finiteNumber(row.rev));
      current.promo += Math.max(0, finiteNumber(row.promo));
      current.refund += Math.abs(finiteNumber(row.refund));
      current.inventory += Math.max(0, finiteNumber(row.inv));
      periods.set(row.date, current);
    });
    const periodRows = [...periods.values()];
    const inventoryObserved = periodRows.some(period => period.inventory > 0);
    const available = inventoryObserved
      ? periodRows.filter(period => period.inventory > 0 || period.units > 0)
      : periodRows;
    const observedPeriods = periodRows.length;
    const availablePeriods = available.length;
    const units = periodRows.reduce((total, period) => total + period.units, 0);
    const revenue = periodRows.reduce((total, period) => total + period.revenue, 0);
    const refunds = periodRows.reduce((total, period) => total + period.refund, 0);
    return {
      warehouseId,
      warehouse:warehouseById.get(warehouseId) || { id:warehouseId, name:warehouseId },
      units,
      revenue,
      refunds,
      observedPeriods,
      availablePeriods,
      availabilityRate:observedPeriods ? availablePeriods / observedPeriods : 0,
      velocity:availablePeriods ? units / availablePeriods : 0,
      promoShare:observedPeriods ? periodRows.filter(period => period.promo > 0).length / observedPeriods : 0,
      inventoryObserved,
    };
  });
}

function aggregatePortfolioFactors({ rows = [], eligibleWarehouseIds, selectedProductKey = "" }) {
  if (!selectedProductKey) return new Map();
  const eligible = new Set(eligibleWarehouseIds);
  const rowsByProduct = groupBy(
    rows.filter(row => row?.wid && row?.date && row?.pid && eligible.has(row.wid) && String(row.pid) !== String(selectedProductKey)),
    row => String(row.pid),
  );
  const productVelocities = new Map();
  for (const [productKey, productRows] of rowsByProduct) {
    const velocities = aggregateWarehouseRows(productRows, new Map())
      .filter(summary => summary.observedPeriods >= 2 && summary.units > 0 && summary.velocity > 0)
      .map(summary => ({ warehouseId:summary.warehouseId, velocity:summary.velocity }));
    if (velocities.length) productVelocities.set(productKey, velocities);
  }

  const ratiosByWarehouse = new Map();
  for (const productRows of productVelocities.values()) {
    if (productRows.length < 5) continue;
    const productMedian = median(productRows.map(row => row.velocity));
    if (!productMedian || productMedian <= 0) continue;
    productRows.forEach(row => {
      if (!ratiosByWarehouse.has(row.warehouseId)) ratiosByWarehouse.set(row.warehouseId, []);
      ratiosByWarehouse.get(row.warehouseId).push(row.velocity / productMedian);
    });
  }

  return new Map([...ratiosByWarehouse.entries()].map(([warehouseId, ratios]) => [warehouseId, {
    factor:ratios.length >= 2 ? Math.exp(median(ratios.map(value => Math.log(Math.max(0.01, value))))) : 1,
    products:ratios.length,
    qualified:ratios.length >= 2,
  }]));
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-10) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let cell = column; cell <= size; cell += 1) augmented[column][cell] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let cell = column; cell <= size; cell += 1) augmented[row][cell] -= factor * augmented[column][cell];
    }
  }
  return augmented.map(row => row[size]);
}

function fitExpectedVelocity(rows, controls, regionLevels = []) {
  const featureValues = row => [
    1,
    ...(controls.includes("portfolio strength") ? [Math.log(Math.max(0.01, row.portfolioFactor || 1))] : []),
    ...(controls.includes("promotion exposure") ? [row.promoShare] : []),
    ...(controls.includes("region mix") ? regionLevels.map(region => row.warehouse?.region === region ? 1 : 0) : []),
  ];
  // Missing cross-product history is scored at the normalized portfolio baseline,
  // but it must not influence the portfolio-strength coefficient itself.
  const fitRows = controls.includes("portfolio strength")
    ? rows.filter(row => row.portfolioQualified)
    : rows;
  const rawY = fitRows.map(row => Math.log(Math.max(0.05, row.velocity)));
  const fitY = rawY;
  const xRows = fitRows.map(featureValues);
  const width = xRows[0]?.length || 1;
  const xtx = Array.from({ length:width }, () => Array(width).fill(0));
  const xty = Array(width).fill(0);
  xRows.forEach((x, rowIndex) => {
    for (let i = 0; i < width; i += 1) {
      xty[i] += x[i] * fitY[rowIndex];
      for (let j = 0; j < width; j += 1) xtx[i][j] += x[i] * x[j];
    }
  });
  for (let index = 1; index < width; index += 1) xtx[index][index] += 1e-6;
  const coefficients = solveLinearSystem(xtx, xty) || [mean(fitY), ...Array(Math.max(0, width - 1)).fill(0)];
  return rows.map(row => {
    const x = featureValues(row);
    const predictedLog = x.reduce((total, value, index) => total + value * coefficients[index], 0);
    const expectedVelocity = Math.max(0.05, Math.exp(predictedLog));
    return {
      ...row,
      expectedVelocity,
      affinityIndex:100 * row.velocity / expectedVelocity,
    };
  });
}

function rankValues(values) {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = Array(values.length).fill(0);
  let start = 0;
  while (start < indexed.length) {
    let end = start;
    while (end + 1 < indexed.length && indexed[end + 1].value === indexed[start].value) end += 1;
    const rank = (start + end) / 2 + 1;
    for (let index = start; index <= end; index += 1) ranks[indexed[index].index] = rank;
    start = end + 1;
  }
  return ranks;
}

function pearsonCorrelation(x, y) {
  if (x.length !== y.length || x.length < 3) return null;
  const xMean = mean(x);
  const yMean = mean(y);
  let numerator = 0;
  let xSquares = 0;
  let ySquares = 0;
  for (let index = 0; index < x.length; index += 1) {
    const xDelta = x[index] - xMean;
    const yDelta = y[index] - yMean;
    numerator += xDelta * yDelta;
    xSquares += xDelta ** 2;
    ySquares += yDelta ** 2;
  }
  return xSquares > 0 && ySquares > 0 ? numerator / Math.sqrt(xSquares * ySquares) : null;
}

function spearmanCorrelation(pairs) {
  if (pairs.length < 3) return null;
  return pearsonCorrelation(rankValues(pairs.map(pair => pair.x)), rankValues(pairs.map(pair => pair.y)));
}

function stringHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapInterval(pairs, samples, seed) {
  if (pairs.length < 8 || samples <= 0) return { low:null, high:null };
  const random = seededRandom(seed);
  const results = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const resampled = Array.from({ length:pairs.length }, () => pairs[Math.floor(random() * pairs.length)]);
    const correlation = spearmanCorrelation(resampled);
    if (Number.isFinite(correlation)) results.push(correlation);
  }
  return {
    // Bonferroni-adjust the two-sided 95% interval across every tested feature.
    low:quantile(results, MULTIPLE_COMPARISON_TAIL),
    high:quantile(results, 1 - MULTIPLE_COMPARISON_TAIL),
  };
}

function buildSignals(rows, bootstrapSamples) {
  if (rows.length < MIN_MODEL_WAREHOUSES || standardDeviation(rows.map(row => row.affinityIndex)) < 0.01) return [];
  const affinityThreshold = quantile(rows.map(row => row.affinityIndex), 0.75);
  return AFFINITY_FEATURES.map(feature => {
    const pairs = rows.map(row => ({
      id:row.warehouseId,
      x:finiteNumber(row.demographics?.[feature.key], Number.NaN),
      y:row.affinityIndex,
    })).filter(pair => Number.isFinite(pair.x) && Number.isFinite(pair.y));
    if (pairs.length < MIN_MODEL_WAREHOUSES) return null;
    const rho = spearmanCorrelation(pairs);
    if (!Number.isFinite(rho)) return null;
    const firstHalf = pairs.filter(pair => stringHash(pair.id) % 2 === 0);
    const secondHalf = pairs.filter(pair => stringHash(pair.id) % 2 === 1);
    const firstRho = spearmanCorrelation(firstHalf);
    const secondRho = spearmanCorrelation(secondHalf);
    const stableAcrossHalves = Number.isFinite(firstRho) && Number.isFinite(secondRho) && Math.sign(firstRho) === Math.sign(secondRho) && Math.abs(firstRho) >= 0.1 && Math.abs(secondRho) >= 0.1;
    const interval = bootstrapInterval(pairs, bootstrapSamples, stringHash(feature.key) + pairs.length);
    const intervalExcludesZero = Number.isFinite(interval.low) && Number.isFinite(interval.high) && (interval.low > 0 || interval.high < 0);
    const abs = Math.abs(rho);
    const confidence = pairs.length >= 36 && abs >= 0.3 && stableAcrossHalves && intervalExcludesZero
      ? "high"
      : pairs.length >= 24 && abs >= 0.2 && stableAcrossHalves
        ? "medium"
        : "exploratory";
    const highValues = rows.filter(row => row.affinityIndex >= affinityThreshold && Number.isFinite(Number(row.demographics?.[feature.key])))
      .map(row => Number(row.demographics[feature.key]));
    const cohortValues = pairs.map(pair => pair.x);
    return {
      ...feature,
      n:pairs.length,
      rho:Math.round(rho * 1000) / 1000,
      ciLow:Number.isFinite(interval.low) ? Math.round(interval.low * 1000) / 1000 : null,
      ciHigh:Number.isFinite(interval.high) ? Math.round(interval.high * 1000) / 1000 : null,
      firstHalfRho:Number.isFinite(firstRho) ? Math.round(firstRho * 1000) / 1000 : null,
      secondHalfRho:Number.isFinite(secondRho) ? Math.round(secondRho * 1000) / 1000 : null,
      stableAcrossHalves,
      intervalExcludesZero,
      confidence,
      direction:rho >= 0 ? "higher in stronger markets" : "lower in stronger markets",
      highAffinityMedian:median(highValues),
      cohortMedian:median(cohortValues),
    };
  }).filter(Boolean).sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
}

export function buildSalesAffinityModel({
  scopeRows = [],
  baselineRows = [],
  warehouses = [],
  demographicsByWarehouseId = {},
  selectedProductKey = "",
  minimumPeriods = 3,
  minimumUnits = 5,
  bootstrapSamples = 200,
} = {}) {
  const warehouseById = new Map(warehouses.map(warehouse => [warehouse.id, warehouse]));
  const summaries = aggregateWarehouseRows(scopeRows.filter(row => warehouseById.has(row.wid)), warehouseById);
  const exclusions = {
    noRows:Math.max(0, warehouses.length - summaries.length),
    noDemographics:0,
    lowPeriods:0,
    lowUnits:0,
    noAvailability:0,
  };
  const eligible = [];
  summaries.forEach(summary => {
    if (summary.observedPeriods < minimumPeriods) {
      exclusions.lowPeriods += 1;
      return;
    }
    if (!summary.availablePeriods) {
      exclusions.noAvailability += 1;
      return;
    }
    if (summary.units < minimumUnits) {
      exclusions.lowUnits += 1;
      return;
    }
    const demographics = demographicsByWarehouseId instanceof Map
      ? demographicsByWarehouseId.get(summary.warehouseId)
      : demographicsByWarehouseId?.[summary.warehouseId];
    if (!demographics) {
      exclusions.noDemographics += 1;
      return;
    }
    eligible.push({ ...summary, demographics });
  });

  const portfolioFactors = aggregatePortfolioFactors({
    rows:baselineRows,
    eligibleWarehouseIds:eligible.map(row => row.warehouseId),
    selectedProductKey,
  });
  let modelRows = eligible.map(row => {
    const portfolio = portfolioFactors.get(row.warehouseId) || { factor:1, products:0, qualified:false };
    return { ...row, portfolioFactor:portfolio.factor, portfolioProducts:portfolio.products, portfolioQualified:portfolio.qualified };
  });
  const portfolioQualified = modelRows.filter(row => row.portfolioQualified);
  const portfolioCoverage = modelRows.length ? portfolioQualified.length / modelRows.length : 0;
  const controls = [];
  if (
    selectedProductKey &&
    portfolioQualified.length >= 10 &&
    portfolioCoverage >= 0.5 &&
    standardDeviation(portfolioQualified.map(row => Math.log(Math.max(0.01, row.portfolioFactor)))) >= 0.02
  ) controls.push("portfolio strength");
  if (modelRows.length >= MIN_MODEL_WAREHOUSES && standardDeviation(modelRows.map(row => row.promoShare)) >= 0.05) controls.push("promotion exposure");
  const regionFitRows = controls.includes("portfolio strength") ? portfolioQualified : modelRows;
  const regionCounts = new Map();
  regionFitRows.forEach(row => {
    const region = String(row.warehouse?.region || "").trim();
    if (region) regionCounts.set(region, (regionCounts.get(region) || 0) + 1);
  });
  const modeledRegions = [...regionCounts.entries()]
    .filter(([, count]) => count >= 4)
    .map(([region]) => region)
    .sort();
  const regionLevels = regionFitRows.length >= 24 && modeledRegions.length >= 2 ? modeledRegions.slice(1) : [];
  if (regionLevels.length) controls.push("region mix");

  if (modelRows.length) modelRows = fitExpectedVelocity(modelRows, controls, regionLevels);
  const affinityRanks = rankValues(modelRows.map(row => row.affinityIndex));
  modelRows = modelRows.map((row, index) => ({
    ...row,
    affinityPercentile:modelRows.length > 1 ? Math.round(((affinityRanks[index] - 1) / (modelRows.length - 1)) * 100) : 50,
  })).sort((a, b) => b.affinityIndex - a.affinityIndex || b.velocity - a.velocity);

  const qualifiedBeforeDemographics = summaries.length - exclusions.lowPeriods - exclusions.lowUnits - exclusions.noAvailability;
  const demographicCoverage = qualifiedBeforeDemographics > 0 ? modelRows.length / qualifiedBeforeDemographics : 0;
  const medianPeriods = median(modelRows.map(row => row.observedPeriods)) || 0;
  const cohortConfidence = modelRows.length >= 50 && demographicCoverage >= 0.8 && medianPeriods >= 4
    ? "high"
    : modelRows.length >= 24 && demographicCoverage >= 0.7
      ? "medium"
      : modelRows.length >= MIN_MODEL_WAREHOUSES
        ? "low"
        : "insufficient";
  const velocities = modelRows.map(row => row.velocity);
  const status = modelRows.length >= MIN_MODEL_WAREHOUSES ? "ready" : "insufficient";
  const reason = status === "ready"
    ? ""
    : `At least ${MIN_MODEL_WAREHOUSES} qualified warehouses with demographic profiles are required; ${modelRows.length} are currently available.`;
  const signals = status === "ready" ? buildSignals(modelRows, bootstrapSamples) : [];

  return {
    status,
    reason,
    rows:modelRows,
    signals,
    exclusions,
    summary:{
      candidateWarehouses:summaries.length,
      eligibleWarehouses:modelRows.length,
      demographicCoverage,
      portfolioCoverage,
      modelControls:controls,
      scopeMode:selectedProductKey ? "selected-product" : "all-products",
      minimumPeriods,
      minimumUnits,
      meanVelocity:mean(velocities) || 0,
      medianVelocity:median(velocities) || 0,
      p25Velocity:quantile(velocities, 0.25) || 0,
      p75Velocity:quantile(velocities, 0.75) || 0,
      medianPeriods,
      cohortConfidence,
      testedCharacteristics:AFFINITY_FEATURES.length,
      qualifiedSignals:signals.filter(signal => signal.confidence !== "exploratory").length,
    },
  };
}
