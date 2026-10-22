import { facilityKeyFor, warehouseIdentityType } from "./warehouseIdentity.js";

const lookupCache = new WeakMap();

export function warehouseNumberFromText(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const warehouse = value.match(/\b(?:warehouse|whse|wh|store)\s*#?\s*0*(\d{1,5})\b/i);
  if (warehouse) return warehouse[1];
  if (/^\d{1,5}$/.test(value)) return String(Number(value));
  return "";
}

export function normalizeStoreText(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/\b(?:warehouse|whse|store)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^\d{1,5}\s+/, "")
    .replace(/\s+/g, " ");
}

function normalizeLocationText(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function cityFromWarehouseName(name, state) {
  const value = String(name || "").trim();
  if (!warehouseNumberFromText(value)) return "";
  let city = value
    .replace(/^\s*(?:warehouse|whse|wh|store)\s*#?\s*0*\d{1,5}\b[\s,:-]*/i, "")
    .trim();
  const stateValue = String(state || "").trim();
  if (city && stateValue) {
    const trailingState = new RegExp(`(?:,?\\s+)${stateValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    city = city.replace(trailingState, "").trim();
  }
  return city;
}

export function warehouseLocationLabel(warehouse) {
  if (!warehouse) return "";
  const name = String(warehouse.name || "").trim();
  const state = String(warehouse.st || warehouse.state || "").trim();
  let city = String(warehouse.city || "").trim();

  if (!city || normalizeLocationText(city) === normalizeLocationText(name)) {
    city = cityFromWarehouseName(name, state) || city;
  }

  return [city, state].filter(Boolean).join(", ") || String(warehouse.region || "").trim();
}

function storeLookupFor(whList) {
  if (!Array.isArray(whList)) return null;
  const cached = lookupCache.get(whList);
  if (cached) return cached;

  const byName = new Map();
  const byNormalizedName = new Map();
  const byNumber = new Map();
  for (const warehouse of whList) {
    const name = String(warehouse?.name || "");
    const lowerName = name.toLowerCase();
    const normalizedName = normalizeStoreText(name);
    const number = warehouseNumberFromText(warehouse?.warehouseNo || name);
    if (lowerName && !byName.has(lowerName)) byName.set(lowerName, warehouse);
    if (normalizedName && !byNormalizedName.has(normalizedName)) byNormalizedName.set(normalizedName, warehouse);
    if (number) {
      const matches = byNumber.get(number) || [];
      matches.push(warehouse);
      byNumber.set(number, matches);
    }
  }
  const lookup = { byName, byNormalizedName, byNumber };
  lookupCache.set(whList, lookup);
  return lookup;
}

export function findStore(raw, whList) {
  const value = String(raw || "").trim();
  if (!value || !Array.isArray(whList)) return null;
  const lowerValue = value.toLowerCase();
  const normalized = normalizeStoreText(value);
  const requestedIdentityType = warehouseIdentityType(value);
  const lookup = storeLookupFor(whList);
  const exactName = lookup?.byName.get(lowerValue);
  if (exactName && warehouseIdentityType(exactName) === requestedIdentityType) return exactName;
  const normalizedName = lookup?.byNormalizedName.get(normalized);
  if (normalizedName && warehouseIdentityType(normalizedName) === requestedIdentityType) return normalizedName;

  const number = warehouseNumberFromText(value);
  if (number) {
    const numberMatches = (lookup?.byNumber.get(number) || [])
      .filter(warehouse => warehouseIdentityType(warehouse) === requestedIdentityType);
    const identityMatches = requestedIdentityType === "facility"
      ? numberMatches.filter(warehouse => facilityKeyFor(warehouse) === facilityKeyFor(value))
      : numberMatches;
    if (identityMatches.length === 1) return identityMatches[0];
    const namedNumberMatch = identityMatches.find(warehouse => {
      const candidate = normalizeStoreText(warehouse.name);
      return candidate.includes(normalized) || normalized.includes(candidate);
    });
    if (namedNumberMatch) return namedNumberMatch;
  }

  return whList.find(warehouse => {
    if (warehouseIdentityType(warehouse) !== requestedIdentityType) return false;
    const candidate = String(warehouse?.name || "").toLowerCase();
    return candidate.includes(lowerValue) || lowerValue.includes(candidate);
  });
}
