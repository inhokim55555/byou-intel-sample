export function mapSelectionKey(selection = {}, index = 0) {
  return `map-${index}-${String(selection.pid || "")}-${String(selection.cid || "all")}`;
}

export function buildMapRuntimeScope(selections = []) {
  const active = (selections || []).filter(selection => String(selection?.pid || "").trim());
  const pids = [...new Set(active.map(selection => String(selection.pid).trim()).filter(Boolean))];
  const cids = active.length && active.every(selection => String(selection.cid || "").trim())
    ? [...new Set(active.map(selection => String(selection.cid).trim()).filter(Boolean))]
    : [];
  return { pids, cids };
}

export function mapComparisonStoreIsVisible(breakdown = [], selectionCount = 0) {
  const selectedHits = (breakdown || []).filter(item => (
    Number(item?.rev || 0) > 0 || Number(item?.units || 0) > 0
  )).length;
  return selectedHits > 0;
}

export function mapComparisonMarkers(breakdown = []) {
  const active = (breakdown || []).filter(item => (
    Number(item?.rev || 0) > 0 || Number(item?.units || 0) > 0
  ));
  return active.map((item, index) => ({
    ...item,
    offsetIndex:index - (active.length - 1) / 2,
  }));
}
