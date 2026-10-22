import { campaignChannelSupports } from "./campaignChannel.js";

const productLabelKey = value => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");

// Keep server-side warm keys and browser request keys identical regardless of
// the host's configured locale. The raw-text tie-breaker also makes case-only
// differences deterministic.
export function compareProductFilterText(left, right) {
  const leftKey = productLabelKey(left);
  const rightKey = productLabelKey(right);
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  const leftText = String(left || "").trim();
  const rightText = String(right || "").trim();
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

// These are selector groups only. Never rewrite source product or campaign IDs.
export function groupProductFilterOptions(products = []) {
  const groups = new Map();
  for (const product of products) {
    const label = String(product.short || product.name || product.id || "").trim();
    const key = productLabelKey(label);
    if (!key || !product.id) continue;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...product, short:label, productIds:[product.id] });
      continue;
    }
    if (!existing.productIds.includes(product.id)) existing.productIds.push(product.id);
    // Prefer the ID that already equals the displayed name, independent of order.
    if (productLabelKey(product.id) === key) existing.id = product.id;
    existing.active = existing.active !== false || product.active !== false;
  }
  return [...groups.values()].sort((a, b) => compareProductFilterText(a.short, b.short));
}

export function expandProductFilterIds(ids = [], options = []) {
  return [...new Set(ids.flatMap(id => {
    const option = options.find(product => product.id === id || product.productIds?.includes(id));
    return option?.productIds || [id];
  }).filter(Boolean))];
}

export function campaignContextMatchesChannel(row, channel, campaignMeta = {}) {
  if (!channel) return true;
  const cid = row?.cid || row?.campaignId || "";
  const campaign = campaignMeta[cid] || Object.values(campaignMeta).find(item => item?.id === cid);
  // Unassigned annotations are shared context, not invented channel sales.
  return !campaign?.channel || campaignChannelSupports(campaign.channel, channel);
}

export function channelViewDataset(dataset = {}, channel = "inline", campaignMeta = {}) {
  const inline = channel === "inline";
  const context = rows => (rows || []).filter(row => campaignContextMatchesChannel(row, channel, campaignMeta));
  return {
    ...dataset,
    sales:inline ? dataset.sales || [] : [],
    prodSales:inline ? dataset.prodSales || [] : [],
    inlineTotalSales:inline ? dataset.inlineTotalSales || [] : [],
    warehouseDailySales:inline ? dataset.warehouseDailySales || [] : [],
    onlineSales:inline ? [] : dataset.onlineSales || [],
    ppcRows:context(dataset.ppcRows),
    footnotes:context(dataset.footnotes),
    videos:context(dataset.videos),
  };
}
