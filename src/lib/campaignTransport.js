export const CAMPAIGN_TRANSPORT_REPRESENTATION = "campaign-rows-v1";
export const CAMPAIGN_TRANSPORT_SCHEMA = "byou-intel-campaign-rows-v1";
const TABLES = ["sales", "prodSales", "comparison.sales", "comparison.prodSales"];
const invalid = () => new Error("Campaign transport is invalid. Please reload and retry.");
const scalar = value => value == null || ["string", "number", "boolean"].includes(typeof value);

function encodeRows(input) {
  if (!Array.isArray(input) || !input.length || input.length > 1000000) return null;
  const layouts = [], strings = [], rows = [];
  const layoutIds = new Map(), stringIds = new Map();
  for (const row of input) {
    if (!row || Array.isArray(row) || typeof row !== "object") return null;
    const entries = Object.entries(row).filter(([, value]) => value !== undefined);
    // Nested values remain on the ordinary JSON path, not a lossy conversion.
    if (entries.some(([, value]) => !scalar(value))) return null;
    const keys = entries.map(([key]) => key);
    if (keys.length > 128) return null;
    const layoutKey = JSON.stringify(keys);
    if (!layoutIds.has(layoutKey)) { layoutIds.set(layoutKey, layouts.length); layouts.push(keys); }
    if (layouts.length > 8192) return null;
    const values = entries.map(([, value]) => {
      if (typeof value !== "string") return value;
      if (!stringIds.has(value)) { stringIds.set(value, strings.length); strings.push(value); }
      return [stringIds.get(value)];
    });
    if (strings.length > 1000000) return null;
    rows.push([layoutIds.get(layoutKey), ...values]);
  }
  return { layouts, strings, rows };
}

// A lossless JSON transport only: no aggregation, rounding, row removal or metric
// changes. The decoded byte count charges the browser cache for expanded data.
export function encodeCampaignView(view) {
  if (view?.schema !== "byou-intel-view-v1" || view.view !== "campaign") return view;
  const dataset = { ...view, ...(view.comparison ? { comparison:{ ...view.comparison } } : {}) };
  const tables = {};
  for (const key of TABLES) {
    const [parent, child] = key.split(".");
    const owner = child ? dataset[parent] : dataset;
    const field = child || parent;
    const table = encodeRows(owner?.[field]);
    if (table) { tables[key] = table; delete owner[field]; }
  }
  if (!Object.keys(tables).length) return view;
  return {
    schema:CAMPAIGN_TRANSPORT_SCHEMA, representation:CAMPAIGN_TRANSPORT_REPRESENTATION,
    publishedAt:view.publishedAt, view:"campaign",
    expandedBytes:new TextEncoder().encode(JSON.stringify(view)).byteLength,
    dataset, tables,
  };
}

export function decodeCampaignView(payload) {
  if (payload?.schema !== CAMPAIGN_TRANSPORT_SCHEMA) return payload;
  const { dataset, tables, expandedBytes } = payload;
  if (payload.representation !== CAMPAIGN_TRANSPORT_REPRESENTATION
      || dataset?.schema !== "byou-intel-view-v1" || dataset.view !== "campaign"
      || dataset.publishedAt !== payload.publishedAt
      || !Number.isSafeInteger(expandedBytes) || expandedBytes < 0
      || !tables || Array.isArray(tables) || typeof tables !== "object") throw invalid();
  const view = { ...dataset, ...(dataset.comparison ? { comparison:{ ...dataset.comparison } } : {}) };
  for (const [key, table] of Object.entries(tables)) {
    if (!TABLES.includes(key) || !Array.isArray(table?.layouts) || !Array.isArray(table?.strings) || !Array.isArray(table?.rows)
        || table.layouts.length > 8192 || table.strings.length > 1000000 || table.rows.length > 1000000
        || table.strings.some(value => typeof value !== "string")
        || table.layouts.some(layout => !Array.isArray(layout) || layout.length > 128 || layout.some(field => typeof field !== "string") || new Set(layout).size !== layout.length)) throw invalid();
    const [parent, child] = key.split(".");
    const owner = child ? view[parent] : view;
    const field = child || parent;
    if (!owner || Array.isArray(owner) || typeof owner !== "object" || Object.hasOwn(owner, field)) throw invalid();
    owner[field] = table.rows.map(row => {
      if (!Array.isArray(row) || !Number.isInteger(row[0]) || row[0] < 0) throw invalid();
      const layout = table.layouts[row[0]];
      if (!layout || row.length !== layout.length + 1) throw invalid();
      return Object.fromEntries(layout.map((name, index) => {
        const value = row[index + 1];
        if (Array.isArray(value)) {
          if (value.length !== 1 || !Number.isInteger(value[0]) || value[0] < 0 || value[0] >= table.strings.length) throw invalid();
          return [name, table.strings[value[0]]];
        }
        if (!scalar(value) || typeof value === "string") throw invalid();
        return [name, value];
      }));
    });
  }
  return view;
}
