import { normalizeStoreText, warehouseNumberFromText } from "./storeLookup.js";

function normalizedWarehouseNumber(value) {
  const explicit = String(value?.warehouseNo || "").trim();
  const parsed = explicit || warehouseNumberFromText(value?.name);
  const digits = String(parsed || "").match(/\d+/)?.[0] || "";
  return digits ? String(Number(digits)) : "";
}

function normalizedState(value) {
  return String(value || "").trim().toUpperCase();
}

export function createMarketDirectoryIndex(stores = []) {
  const byWarehouseNumber = new Map();
  const byName = new Map();
  const byNameState = new Map();
  for (const store of stores || []) {
    const warehouseNo = store?.warehouseNo === undefined || store?.warehouseNo === null ? "" : String(store.warehouseNo);
    const name = normalizeStoreText(store?.name);
    const state = normalizedState(store?.state);
    if (warehouseNo && !byWarehouseNumber.has(warehouseNo)) byWarehouseNumber.set(warehouseNo, store);
    if (name && !byName.has(name)) byName.set(name, store);
    if (name && !byNameState.has(`${name}|${state}`)) byNameState.set(`${name}|${state}`, store);
  }
  return { byWarehouseNumber, byName, byNameState };
}

export function matchWarehouseDirectoryStore(warehouse, index) {
  if (!warehouse) return null;
  const warehouseNo = normalizedWarehouseNumber(warehouse);
  const numberMatch = warehouseNo ? index?.byWarehouseNumber?.get(warehouseNo) : null;
  if (numberMatch) return numberMatch;
  const name = normalizeStoreText(warehouse?.name);
  if (!name) return null;
  const state = normalizedState(warehouse?.st || warehouse?.state);
  return (state ? index?.byNameState?.get(`${name}|${state}`) : index?.byName?.get(name)) || null;
}
