import { inventoryRowHasKnownBalance } from "./dashboardScope.js";

function finiteNumber(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function marketDemographicSourceRows({
  portfolioSales = [],
  productSales = [],
  selectedProduct = "",
  selectedCampaign = "",
} = {}) {
  if (selectedProduct || selectedCampaign) return productSales;
  return portfolioSales;
}

export function marketWarehouseSalesContext(rows = [], {
  warehouseId = "",
  start = "",
  end = "",
} = {}) {
  const selectedWarehouseId = String(warehouseId || "");
  const scopedRows = rows.filter(row => {
    const rowWarehouseId = String(row?.wid || "");
    const date = String(row?.date || "");
    const summaryType = String(row?.summaryType || "");
    return rowWarehouseId === selectedWarehouseId &&
      !["warehouse-portfolio-period", "warehouse-campaign-period"].includes(summaryType) &&
      (!start || date >= start) &&
      (!end || date <= end);
  });
  const reportingDates = new Set(scopedRows
    .filter(row => finiteNumber(row?.rev) > 0 || finiteNumber(row?.units) > 0)
    .map(row => String(row?.date || ""))
    .filter(Boolean));
  const reportingPeriods = reportingDates.size;
  const revenue = scopedRows.reduce((total, row) => total + finiteNumber(row?.rev), 0);
  const units = scopedRows.reduce((total, row) => total + Math.max(0, finiteNumber(row?.units)), 0);
  const inventorySeries = new Map();
  for (const row of scopedRows) {
    const seriesKey = [row?.pid, row?.cid, row?.channel].map(value => String(value || "")).join("\u001f");
    const series = inventorySeries.get(seriesKey) || { latestKnown:null };
    if (inventoryRowHasKnownBalance(row)) {
      const date = String(row?.date || "");
      if (!series.latestKnown || date >= series.latestKnown.date) {
        series.latestKnown = { date, value:Math.max(0, finiteNumber(row?.inv)) };
      }
    }
    inventorySeries.set(seriesKey, series);
  }
  const inventoryKnown = inventorySeries.size === 1 && [...inventorySeries.values()].every(series => series.latestKnown);
  const inventory = inventoryKnown
    ? [...inventorySeries.values()].reduce((total, series) => total + series.latestKnown.value, 0)
    : null;
  return {
    hasRows:scopedRows.length > 0,
    revenue,
    units,
    revenuePeriod:reportingPeriods ? revenue / reportingPeriods : 0,
    unitsPeriod:reportingPeriods ? units / reportingPeriods : 0,
    inventory,
    reportingPeriods,
  };
}
