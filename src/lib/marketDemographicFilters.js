function cleanLocationValue(value) {
  return String(value || "").trim();
}

const CANADIAN_PROVINCE_CODES = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]);
const US_STATE_AND_TERRITORY_CODES = new Set([
  "AK", "AL", "AR", "AS", "AZ", "CA", "CO", "CT", "DC", "DE", "FL", "FM", "GA", "GU", "HI", "IA", "ID", "IL", "IN", "KS", "KY", "LA", "MA", "MD", "ME", "MH", "MI", "MN", "MO", "MP", "MS", "MT", "NC", "ND", "NE", "NH", "NJ", "NM", "NV", "NY", "OH", "OK", "OR", "PA", "PR", "PW", "RI", "SC", "SD", "TN", "TX", "UT", "VA", "VI", "VT", "WA", "WI", "WV", "WY",
]);

function inferredCountryFromState(state) {
  if (CANADIAN_PROVINCE_CODES.has(state)) return "CA";
  if (US_STATE_AND_TERRITORY_CODES.has(state)) return "US";
  return "UNKNOWN";
}

export function marketLocationKey(country, state) {
  const normalizedState = cleanLocationValue(state).toUpperCase();
  if (!normalizedState) return "";
  const normalizedCountry = cleanLocationValue(country).toUpperCase() || "UNKNOWN";
  return `${normalizedCountry}|${normalizedState}`;
}

export function buildMarketLocationRow(warehouse, directoryStore = null) {
  const state = cleanLocationValue(directoryStore?.state || warehouse?.st || warehouse?.state).toUpperCase();
  const embeddedCountry = cleanLocationValue(warehouse?.country).toUpperCase();
  const country = cleanLocationValue(
    directoryStore?.country || embeddedCountry || inferredCountryFromState(state)
  ).toUpperCase();
  return {
    id:warehouse?.id || "",
    warehouse,
    directoryStore,
    country,
    state,
    city:cleanLocationValue(directoryStore?.city || warehouse?.city),
  };
}

export function marketStateOptions(rows = []) {
  const options = new Map();
  rows.forEach(row => {
    const country = cleanLocationValue(row?.country).toUpperCase();
    const state = cleanLocationValue(row?.state).toUpperCase();
    const key = marketLocationKey(country, state);
    if (key && !options.has(key)) options.set(key, { key, country, state });
  });
  return [...options.values()].sort((a, b) =>
    a.country.localeCompare(b.country) || a.state.localeCompare(b.state)
  );
}

export function filterMarketLocationRows(rows = [], stateKey = "", city = "") {
  const normalizedStateKey = cleanLocationValue(stateKey).toUpperCase();
  if (!normalizedStateKey) return rows;
  const normalizedCity = cleanLocationValue(city).toLocaleLowerCase();
  return rows.filter(row =>
    marketLocationKey(row?.country, row?.state) === normalizedStateKey &&
    (!normalizedCity || cleanLocationValue(row?.city).toLocaleLowerCase() === normalizedCity)
  );
}

export function searchMarketLocationRows(rows = [], query = "") {
  const normalizedQuery = cleanLocationValue(query).toLocaleLowerCase();
  if (!normalizedQuery) return rows;
  return rows.filter(row => cleanLocationValue(row?.warehouse?.name).toLocaleLowerCase().includes(normalizedQuery));
}

export function marketCityOptions(rows = [], stateKey = "") {
  if (!cleanLocationValue(stateKey)) return [];
  const cities = new Map();
  filterMarketLocationRows(rows, stateKey).forEach(row => {
    const city = cleanLocationValue(row?.city);
    if (city && !cities.has(city.toLocaleLowerCase())) cities.set(city.toLocaleLowerCase(), city);
  });
  return [...cities.values()].sort((a, b) => a.localeCompare(b));
}

export function preferredMarketWarehouseId(rows = [], currentId = "", externalId = "", fallbackId = "") {
  const ids = new Set(rows.map(row => row?.id).filter(Boolean));
  if (externalId && ids.has(externalId)) return externalId;
  if (currentId && ids.has(currentId)) return currentId;
  if (fallbackId && ids.has(fallbackId)) return fallbackId;
  return rows.find(row => row?.id)?.id || "";
}
