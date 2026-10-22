export const NON_STORE_WAREHOUSE_PATTERN = /\b(rctr|dctr|depot|fulfillment|logistics|distribution|distr|annex|e[\s-]?commerce|holding|refund|returns?)\b|\bproduce\s*depot\b|\bcross\s*dock\b|\bhome\s*office\b|\btrading\b|\bcentral\s*print\b|\bdry\b|\bwet\b/i;

function text(value) {
  return String(value ?? "").trim();
}

function identityText(value = {}) {
  if (typeof value === "string" || typeof value === "number") return text(value);
  return [value.name, value.city, value.st, value.region, value.id, value.warehouseNo]
    .filter(Boolean)
    .join(" ");
}

export function warehouseNumberForIdentity(value) {
  const raw = identityText(value);
  const match = raw.match(/(?:warehouse|whse|wh|store|#)?\s*0*(\d{1,5})\b/i);
  return match?.[1] ? String(Number(match[1])) : "";
}

export function warehouseIdentityType(value = {}) {
  if (typeof value === "object" && value) {
    const declared = text(value.identityType).toLowerCase();
    if (declared === "facility" || declared === "retail") return declared;
    if (text(value.facilityKey) || /^F:/i.test(text(value.id))) return "facility";
  }
  return NON_STORE_WAREHOUSE_PATTERN.test(identityText(value)) ? "facility" : "retail";
}

function normalizedFacilityName(value) {
  return identityText(value)
    .toLowerCase()
    .replace(/\b(?:warehouse|whse|wh|store)\b/g, " ")
    .replace(/\b\d{1,5}\b/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "facility";
}

export function facilityKeyFor(value) {
  if (typeof value === "object" && text(value?.facilityKey)) return text(value.facilityKey);
  return `${warehouseNumberForIdentity(value) || "na"}:${normalizedFacilityName(value)}`;
}

function nextRetailId(warehouses = []) {
  const used = new Set(warehouses.map(row => text(row?.id)).filter(Boolean));
  let sequence = warehouses.reduce((maximum, row) => {
    const match = text(row?.id).match(/^W(\d+)$/i);
    return Math.max(maximum, Number(match?.[1] || 0));
  }, 0);
  let candidate = "";
  do {
    sequence += 1;
    candidate = `W${String(sequence).padStart(3, "0")}`;
  } while (used.has(candidate));
  return candidate;
}

function nextFacilityId(value, warehouses = []) {
  const used = new Set(warehouses.map(row => text(row?.id)).filter(Boolean));
  const base = `F:${facilityKeyFor(value)}`;
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}:${suffix}`)) suffix += 1;
  return `${base}:${suffix}`;
}

export function allocateWarehouseIdentity(value, warehouses = [], existing = null) {
  const identityType = warehouseIdentityType(value);
  const existingType = existing ? warehouseIdentityType(existing) : "";
  const existingName = text(existing?.name).toLowerCase().replace(/\s+/g, " ");
  const requestedName = text(typeof value === "object" ? value?.name : value).toLowerCase().replace(/\s+/g, " ");
  const occupied = existing?.id ? warehouses.filter(row => text(row?.id) === text(existing.id)) : [];
  const sameExistingIdentity = occupied.every(row => warehouseIdentityType(row) === existingType &&
    existingName && requestedName === existingName && text(row?.name).toLowerCase().replace(/\s+/g, " ") === existingName);
  // A reference directory may offer an ID already allocated to another imported
  // venue. Never conflate those identities while replacing the full workbook.
  const preserveExisting = existing?.id && existingType === identityType && sameExistingIdentity;
  const id = preserveExisting
    ? text(existing.id)
    : identityType === "facility"
      ? nextFacilityId(value, warehouses)
      : nextRetailId(warehouses);
  return {
    id,
    identityType,
    ...(identityType === "facility" ? { facilityKey:facilityKeyFor(value) } : {}),
  };
}
