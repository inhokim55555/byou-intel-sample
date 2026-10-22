import React from "react";

// Shared presentation and product-display helpers; no imports from DashboardApp.
const PRODUCTS = [{"id":"DEMO001","name":"Lumen Grove Daily Cream","short":"Lumen Grove","col":"#E8A020","frac":0.4},{"id":"DEMO002","name":"Tidewell Scalp Wash","short":"Tidewell","col":"#F472B6","frac":0.35},{"id":"DEMO003","name":"Fieldnote Sun Veil","short":"Fieldnote","col":"#60A5FA","frac":0.25}];

function productDisplayName(value) {
  return String(value || "").replace(/\s*\(disc\.\)/ig, "").trim();
}

function normalizedProductKey(value) {
  return productDisplayName(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

const COMPANY_PRODUCT_ALIAS_TO_CANONICAL = new Map();

const COMPANY_PRODUCT_ALIAS_GROUPS = PRODUCTS.map(p=>({canonical:p.name,aliases:[p.id,p.short]}));

const COMPANY_PRODUCT_CANONICAL_TO_ALIASES = new Map();
COMPANY_PRODUCT_ALIAS_GROUPS.forEach(group => {
  const canonicalKey = normalizedProductKey(group.canonical);
  const aliases = [...new Set([group.canonical, ...(group.aliases || [])].map(normalizedProductKey).filter(Boolean))];
  if (canonicalKey) COMPANY_PRODUCT_CANONICAL_TO_ALIASES.set(canonicalKey, aliases);
  aliases.forEach(alias => COMPANY_PRODUCT_ALIAS_TO_CANONICAL.set(alias, group.canonical));
});

export { COMPANY_PRODUCT_CANONICAL_TO_ALIASES };

function canonicalCompanyProductLabel(value) {
  const key = normalizedProductKey(value);
  if (!key) return "";
  const exact = COMPANY_PRODUCT_ALIAS_TO_CANONICAL.get(key);
  if (exact) return exact;
  return "";
}

function productMetaNameKey(value) {
  const key = normalizedProductKey(value);
  return key ? `name:${key}` : "";
}

function productColorForValue(value) {
  const palette = ["#E8A020", "#F472B6", "#60A5FA", "#A78BFA", "#2DD4A0", "#F97316", "#22D3EE", "#FB7185", "#94A3B8", "#14B8A6", "#F59E0B", "#8B5CF6"];
  const key = normalizedProductKey(value);
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function parseISODate(date) {
  const [y, m, d] = String(date).split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

function productMetaForProduct(value, productMeta = {}) {
  if (!value) return {};
  const canonical = canonicalCompanyProductLabel(value);
  if (canonical && normalizedProductKey(canonical) !== normalizedProductKey(value)) {
    return productMetaForProduct(canonical, productMeta);
  }
  const direct = productMeta?.[value];
  if (direct) return direct;
  const base = PRODUCTS.find(p => p.id === value);
  const lookupKeys = [
    base?.id,
    productMetaNameKey(base?.short),
    productMetaNameKey(base?.name),
    productMetaNameKey(value),
  ].filter(Boolean);
  for (const key of lookupKeys) {
    if (productMeta?.[key]) return productMeta[key];
  }
  const rawKey = normalizedProductKey(value);
  if (!rawKey) return {};
  const fuzzy = Object.entries(productMeta || {}).filter(([key, meta]) => {
    const candidate = key.startsWith("name:") ? key.slice(5) : normalizedProductKey(meta?.short || meta?.name || "");
    return candidate && (candidate === rawKey || candidate.includes(rawKey) || rawKey.includes(candidate));
  });
  return fuzzy.length === 1 ? fuzzy[0][1] : {};
}

function productWithMeta(pid, productMeta = {}) {
  const base = PRODUCTS.find(p => p.id === pid);
  const meta = productMetaForProduct(pid, productMeta);
  if (base) return { ...base, ...meta, id:meta?.id || base.id, name:meta?.name || base.name, short:meta?.short || base.short };
  const label = productDisplayName(meta?.short || meta?.name || pid);
  return label ? {
    id:meta?.id || pid,
    name:productDisplayName(meta?.name || label),
    short:productDisplayName(meta?.short || meta?.name || label),
    col:meta?.col || productColorForValue(label),
    category:meta?.category || "",
    active:meta?.active !== false,
    totalWarehouses:meta?.totalWarehouses,
  } : null;
}

function productLabelForValue(pidOrName, productMeta = {}) {
  if (!pidOrName) return "All Products";
  const canonical = canonicalCompanyProductLabel(pidOrName);
  const value = canonical || pidOrName;
  const base = PRODUCTS.find(p => p.id === value);
  const meta = productMetaForProduct(value, productMeta);
  return productDisplayName(base?.short || meta?.short || meta?.name || value || "All Products");
}

const VIDEO_METRICS = [
  { key:"views",      label:"Views",        fmt: v => v>=1000000?`${(v/1e6).toFixed(1)}M`:v>=1000?`${(v/1000).toFixed(1)}K`:`${v}` },
  { key:"likes",      label:"Likes",        fmt: v => v>=1000?`${(v/1000).toFixed(1)}K`:`${v}` },
  { key:"comments",   label:"Comments",     fmt: v => `${v}` },
  { key:"saves",      label:"Saves",        fmt: v => v>=1000?`${(v/1000).toFixed(1)}K`:`${v}` },
  { key:"shares",     label:"Shares",       fmt: v => `${v}` },
  { key:"rate",       label:"Rate",         fmt: v => fmtCurrency(v) },
];

const CARD_METRICS = VIDEO_METRICS.filter(m => ["views","likes","rate"].includes(m.key));

const VIDEO_CHANGE_METRICS = VIDEO_METRICS.filter(m => ["views","likes","comments","saves","shares"].includes(m.key));

function fmtMetricDelta(metric, value) {
  const n = Math.round(Number(value || 0));
  const sign = n >= 0 ? "+" : "-";
  return `${sign}${metric.fmt(Math.abs(n))}`;
}

function videoDisplayName(video) {
  if (!video) return "Video";
  const parts = [video.creator, video.platform, video.type].filter(Boolean);
  return parts.length ? parts.join(" / ") : (video.url ? "Video link" : "Video");
}

function fmtCurrency(value) {
  const n = Number(value || 0);
  return n.toLocaleString("en-US", {
    style:"currency",
    currency:"USD",
    minimumFractionDigits:Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits:2,
  });
}

function fmtCompactMoney(value) {
  const n = Number(value || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const clean = (num, digits) => {
    const fixed = num.toFixed(digits);
    return fixed.replace(/\.0+$/,"").replace(/(\.\d*[1-9])0+$/,"$1");
  };
  if (abs >= 1000000000) return `${sign}$${clean(abs / 1000000000, 1)}B`;
  if (abs >= 1000000) return `${sign}$${clean(abs / 1000000, abs >= 10000000 ? 1 : 2)}M`;
  if (abs >= 1000) return `${sign}$${clean(abs / 1000, abs >= 100000 ? 0 : 1)}K`;
  return `${sign}$${Math.round(abs).toLocaleString()}`;
}

function metricGrowth(latest, previous, key, periodDays = 1) {
  if (key === "rate") return null;
  const currentValue = Number(latest?.[key] || 0);
  const previousValue = Number(previous?.[key] || 0);
  if (!latest?.date || !previous?.date || previousValue <= 0) return null;
  const days = Math.max(1, Math.round((parseISODate(latest.date) - parseISODate(previous.date)) / 864e5));
  return (Math.pow(currentValue / previousValue, periodDays / days) - 1) * 100;
}

function fmtGrowth(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/A";
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : 1;
  return `${value >= 0 ? "+" : "-"}${abs.toFixed(digits)}%`;
}

const MAP_W = 780, MAP_H = 460;

const C = {
  bg:"#F5F6F8", card:"#FFFFFF", border:"#D9DEE7",
  accent:"#111827", accentFade:"rgba(17,24,39,0.06)",
  warn:"#B7791F", warnFade:"rgba(183,121,31,0.1)",
  green:"#3F8E5F", red:"#C94747", blue:"#4F6F8F",
  text:"#111827", muted:"#697386", subtle:"#EEF0F3", hover:"#F1F3F5",
  nav:"#FFFFFF", navText:"#111827", sidebar:"#F8F9FB", line:"#E9EDF2",
  shadow:"0 1px 2px rgba(15, 23, 42, 0.05)",
};

const HELVETICA_NEUE_STACK = "'Helvetica Neue BYOU','Helvetica Neue',Helvetica,'Segoe UI',Arial,sans-serif";

const MONO = { fontFamily:HELVETICA_NEUE_STACK, fontVariantNumeric:"tabular-nums" };

const SANS = { fontFamily:HELVETICA_NEUE_STACK };

function rowCampaignId(row) {
  return String(row?.cid || row?.campaignId || row?.Campaign_ID || row?.["Campaign ID"] || "").trim();
}

function rowMatchesCampaignScope(row, campaignId = "") {
  return !campaignId || rowCampaignId(row) === campaignId;
}

function productValuesMatch(a = "", b = "", productMeta = {}) {
  if (!a || !b) return !b;
  if (a === b || normalizedProductKey(a) === normalizedProductKey(b)) return true;
  const labelA = productLabelForValue(a, productMeta);
  const labelB = productLabelForValue(b, productMeta);
  return !!labelA && !!labelB && normalizedProductKey(labelA) === normalizedProductKey(labelB);
}

const LanguageContext = React.createContext({
  lang:"en",
  setLang:() => {},
  t:(_key, fallback = "") => fallback,
  label:value => value,
});

function useUiText() {
  return React.useContext(LanguageContext);
}

function Panel({ title, children, style = {} }) {
  const { label } = useUiText();
  return (
    <div style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:6, padding:16, marginBottom:14, boxShadow:C.shadow, ...style }}>
      {title && <div style={{ fontSize:12, ...SANS, color:C.text, marginBottom:12, fontWeight:500 }}>{label(title)}</div>}
      {children}
    </div>
  );
}

function KpiCard({ label, value, sub, color = C.text, exact, panel = true, valueSize = 17, style = {} }) {
  const { label:uiLabel } = useUiText();
  return (
    <div title={exact || undefined} style={{ background:panel ? C.card : C.bg, border:`1px solid ${C.border}`, borderRadius:5, padding:"11px 12px", minWidth:0, ...style }}>
      <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>{uiLabel(label)}</div>
      <div style={{ ...MONO, fontSize:valueSize, fontWeight:500, color, marginBottom:sub ? 4 : 0, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{value}</div>
      {sub && <div style={{ fontSize:10, color:C.muted, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{sub}</div>}
    </div>
  );
}

function safeExternalHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const normalized = /^www\./i.test(raw) ? `https://${raw}` : raw;
    const parsed = new URL(normalized);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

export { useUiText, LanguageContext, VIDEO_METRICS, fmtCurrency, productValuesMatch, normalizedProductKey, productDisplayName, productLabelForValue, canonicalCompanyProductLabel, COMPANY_PRODUCT_ALIAS_TO_CANONICAL, PRODUCTS, productMetaForProduct, productMetaNameKey, rowMatchesCampaignScope, rowCampaignId, VIDEO_CHANGE_METRICS, productWithMeta, productColorForValue, C, metricGrowth, parseISODate, videoDisplayName, SANS, HELVETICA_NEUE_STACK, Panel, MONO, fmtMetricDelta, safeExternalHttpUrl, CARD_METRICS, fmtGrowth, MAP_W, MAP_H, KpiCard, fmtCompactMoney };
