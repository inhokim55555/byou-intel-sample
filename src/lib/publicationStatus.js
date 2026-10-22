export function publicationCoverage(dataset) {
  return [
    ["official", dataset?.inlineTotalSales],
    ["warehouse", dataset?.warehouseDailySales],
    ["online", dataset?.onlineSales],
  ].map(([lane, rows]) => {
    if (!Array.isArray(rows)) return { lane, state:"unknown", dates:null, start:"", end:"" };
    const dates = [...new Set(rows.map(row => String(row?.date || "")).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)))].sort();
    return { lane, state:dates.length ? "observed" : rows.length ? "undated" : "empty", dates:dates.length, start:dates[0] || "", end:dates.at(-1) || "" };
  });
}

export function publicationCheckState(status = {}) {
  if (!status.publishedAt) return "unknown";
  if (status.warning || status.state === "error") return "unconfirmed";
  if (status.source === "cache-validated") return "validated";
  if (status.source === "network" && ["loaded", "published"].includes(status.state)) return "downloaded";
  return "unconfirmed";
}
