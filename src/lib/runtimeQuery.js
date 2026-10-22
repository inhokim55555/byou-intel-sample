function uniqueValues(values) {
  return [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))];
}

export function buildRankingsPacingScope({
  baselinePid = "",
  baselineCid = "",
  comparisonPid = "",
  comparisonCid = "",
} = {}) {
  const pids = uniqueValues([baselinePid, comparisonPid]);
  const hasComparison = !!String(comparisonPid || "").trim();
  const hasCompleteCampaignPair = !!String(baselineCid || "").trim() && !!String(comparisonCid || "").trim();
  const cids = hasComparison && !hasCompleteCampaignPair
    ? []
    : uniqueValues([baselineCid, comparisonCid]);
  return { pids, cids };
}

export function buildRankingsRuntimeQuery({
  selectedRange = {},
  publishedRange = {},
  warehouseId = "",
  ...scopeOptions
} = {}) {
  const scope = buildRankingsPacingScope(scopeOptions);
  const hasComparison = scope.pids.length > 1 || (!!scopeOptions.comparisonPid && scope.cids.length > 1);
  const range = hasComparison && publishedRange.start && publishedRange.end
    ? publishedRange
    : selectedRange;
  return {
    from:range.start || "",
    to:range.end || "",
    ...scope,
    ...(String(warehouseId || "").trim() ? { wid:String(warehouseId).trim() } : {}),
  };
}

export function selectPacingCampaignRows(rows = [], {
  baselineCid = "",
  baselinePid = "",
  comparisonCid = "",
  comparisonPid = "",
} = {}) {
  const findByCampaign = cid => cid ? rows.find(row => String(row?.id || "") === String(cid)) : null;
  const findByProduct = (pid, excludedId = "") => pid
    ? rows.find(row => String(row?.pid || "") === String(pid) && String(row?.id || "") !== String(excludedId || ""))
    : null;
  const baseline = findByCampaign(baselineCid) || findByProduct(baselinePid) || rows[0] || null;
  const comparison = findByCampaign(comparisonCid) || findByProduct(comparisonPid, baseline?.id) || null;
  return [baseline, comparison].filter((row, index, selected) => row && selected.findIndex(candidate => candidate.id === row.id) === index);
}
