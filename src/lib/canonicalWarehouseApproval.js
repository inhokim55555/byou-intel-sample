import { isInventoryCoverageWarehouse } from "./dashboardScope.js";
import { normalizeStoreText, warehouseNumberFromText } from "./storeLookup.js";

function text(value) {
  return String(value ?? "");
}

export function canonicalWarehouseDirectoryFromStores(stores = []) {
  const byNumber = new Map();
  for (const store of stores || []) {
    const number = warehouseNumberFromText(store?.warehouseNo);
    if (!number) continue;
    const rows = byNumber.get(number) || [];
    rows.push(store);
    byNumber.set(number, rows);
  }
  return byNumber;
}

export function canonicalWarehouseMatches(warehouse, directory) {
  const number = warehouseNumberFromText(warehouse?.warehouseNo || warehouse?.name || warehouse?.id);
  const candidateName = normalizeStoreText(warehouse?.name);
  const candidateState = text(warehouse?.st || warehouse?.state).trim().toUpperCase();
  if (!number || !candidateName || !candidateState || !(directory instanceof Map)) return false;
  return (directory.get(number) || []).some(store => {
    const canonicalName = normalizeStoreText(store?.name);
    const canonicalState = text(store?.state).trim().toUpperCase();
    return !!canonicalName && candidateState === canonicalState && candidateName === canonicalName;
  });
}

export function canonicalWarehouseIsUnique(warehouse, warehouses, directory) {
  if (!canonicalWarehouseMatches(warehouse, directory)) return false;
  const number = warehouseNumberFromText(warehouse?.warehouseNo || warehouse?.name || warehouse?.id);
  const matchingRuntimeWarehouses = (warehouses || []).filter(candidate => (
    isInventoryCoverageWarehouse(candidate)
    && warehouseNumberFromText(candidate?.warehouseNo || candidate?.name || candidate?.id) === number
  ));
  return matchingRuntimeWarehouses.length === 1
    && text(matchingRuntimeWarehouses[0]?.id) === text(warehouse?.id);
}
