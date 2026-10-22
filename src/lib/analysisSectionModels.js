import { averageWeeklyRevenueDoorStats, isNonStoreWarehouse, verifiedSellingWarehouseStats } from "./dashboardScope.js";
import { meaningfulSalesStart } from "./reportingEvidence.js";
import { buildSalesAffinityModel, summarizeSalesAffinityReading } from "./salesAffinity.js";
import { marketWarehouseSalesContext } from "./marketDemographicSales.js";
import { normalizeStoreText, warehouseLocationLabel, warehouseNumberFromText } from "./storeLookup.js";
import { buildWarehouseAnalysisModel } from "./warehouseAnalysis.js";

const IMPACT_EVENT_TYPES = new Set(["tpd", "markdown", "promo", "demo", "seasonal", "meta"]);
const EVENT_TYPE_LABELS = Object.freeze({
  tpd:"TPD", markdown:"Markdown", promo:"Promo", demo:"Demo", seasonal:"Seasonal", meta:"Meta Ad", other:"Other",
});

function text(value) {
  return String(value ?? "").trim();
}

function finite(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedKey(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isoDate(value) {
  const match = text(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const parsed = new Date(`${match[0]}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== match[0] ? "" : match[0];
}

function offsetDate(value, days) {
  const date = isoDate(value);
  if (!date) return "";
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Number(days || 0));
  return parsed.toISOString().slice(0, 10);
}

function inclusiveDays(start, end) {
  const from = isoDate(start);
  const to = isoDate(end);
  if (!from || !to || to < from) return 0;
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
}

function pctChange(current, previous) {
  return previous > 0 ? ((current - previous) / previous) * 100 : null;
}

function average(values = []) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : 0;
}

const productIdentityIndexes = new WeakMap();

function productIdentityIndex(productMeta = {}) {
  if (productMeta && typeof productMeta === "object" && productIdentityIndexes.has(productMeta)) {
    return productIdentityIndexes.get(productMeta);
  }
  const entries = Object.entries(productMeta || {}).map(([key, value]) => ({ id:text(value?.id || key), ...value }));
  const aliasToId = new Map();
  const byId = new Map();
  const metadataByAlias = new Map();
  for (const product of entries) {
    if (!byId.has(product.id)) byId.set(product.id, product);
    for (const candidate of [product.id, product.short, product.name, product.product].flatMap(value => Array.isArray(value) ? value : [value])) {
      const key = normalizedKey(candidate);
      if (key && !aliasToId.has(key)) aliasToId.set(key, product.id);
    }
  }
  for (const [key, product] of Object.entries(productMeta || {})) {
    for (const candidate of [key.replace(/^name:/, ""), product?.id, product?.short, product?.name]) {
      const alias = normalizedKey(candidate);
      if (!alias) continue;
      if (!metadataByAlias.has(alias)) metadataByAlias.set(alias, []);
      const matches = metadataByAlias.get(alias);
      if (!matches.includes(product)) matches.push(product);
    }
  }
  const index = { aliasToId, byId, metadataByAlias };
  if (productMeta && typeof productMeta === "object") productIdentityIndexes.set(productMeta, index);
  return index;
}

function canonicalProductId(value, productMeta = {}) {
  const raw = text(value);
  if (!raw) return "";
  const key = normalizedKey(raw);
  return productIdentityIndex(productMeta).aliasToId.get(key) || raw;
}

function productLabel(value, productMeta = {}) {
  const id = canonicalProductId(value, productMeta);
  const product = productIdentityIndex(productMeta).byId.get(id);
  return text(product?.short || product?.name || value || id);
}

function totalWarehousesForProductIds(values = [], productMeta = {}) {
  const seen = new Set();
  return values.reduce((sum, value) => {
    const raw = text(value);
    if (!raw) return sum;
    const direct = productMeta?.[raw];
    const rawKey = normalizedKey(raw);
    const matches = direct ? [direct] : productIdentityIndex(productMeta).metadataByAlias.get(rawKey) || [];
    const identity = normalizedKey(matches[0]?.id || matches[0]?.short || matches[0]?.name || canonicalProductId(raw, productMeta));
    if (seen.has(identity || rawKey)) return sum;
    seen.add(identity || rawKey);
    return sum + Math.max(0, ...matches.map(product => Math.round(finite(product?.totalWarehouses))));
  }, 0);
}

function rowProductId(row, productMeta = {}) {
  return canonicalProductId(row?.pid || row?.product || row?.name, productMeta);
}

function campaignEntries(campaignMeta = {}, productMeta = {}) {
  const byId = new Map();
  Object.entries(campaignMeta || {}).forEach(([key, value]) => {
    const campaign = { id:text(value?.id || key), ...value };
    if (campaign.id && campaign.pid) byId.set(campaign.id, { ...campaign, pid:text(campaign.pid) });
  });
  return [...byId.values()]
    .sort((a, b) => productLabel(a.pid, productMeta).localeCompare(productLabel(b.pid, productMeta)) || text(a.start).localeCompare(text(b.start)) || a.id.localeCompare(b.id));
}

function campaignMatchesDate(campaign, date) {
  const key = isoDate(date);
  if (!campaign || !key) return false;
  return (!campaign.start || key >= campaign.start) && (!campaign.end || key <= campaign.end);
}

function campaignForRow(row, campaigns = [], productMeta = {}) {
  const explicit = text(row?.cid || row?.campaignId || row?.Campaign_ID || row?.["Campaign ID"]);
  if (explicit) {
    const direct = campaigns.find(campaign => campaign.id === explicit || normalizedKey(campaign.short) === normalizedKey(explicit) || normalizedKey(campaign.name) === normalizedKey(explicit));
    if (direct) return direct;
  }
  const pid = rowProductId(row, productMeta);
  const matches = campaigns.filter(campaign => canonicalProductId(campaign.pid, productMeta) === pid && campaignMatchesDate(campaign, row?.date));
  return matches.length === 1 ? matches[0] : null;
}

function compileCampaignResolver(campaigns = [], productMeta = {}) {
  const byId = new Map();
  const firstExactIndex = new Map();
  const firstAliasIndex = new Map();
  const byProduct = new Map();
  campaigns.forEach((campaign, index) => {
    if (!byId.has(campaign.id)) byId.set(campaign.id, campaign);
    if (!firstExactIndex.has(campaign.id)) firstExactIndex.set(campaign.id, index);
    for (const value of [campaign.short, campaign.name]) {
      const key = normalizedKey(value);
      if (key && !firstAliasIndex.has(key)) firstAliasIndex.set(key, index);
    }
    const pid = canonicalProductId(campaign.pid, productMeta);
    if (!byProduct.has(pid)) byProduct.set(pid, []);
    byProduct.get(pid).push(campaign);
  });

  const explicitCampaign = explicit => {
    const value = text(explicit);
    if (!value) return null;
    const exactIndex = firstExactIndex.get(value);
    const aliasIndex = firstAliasIndex.get(normalizedKey(value));
    const index = exactIndex == null
      ? aliasIndex
      : aliasIndex == null ? exactIndex : Math.min(exactIndex, aliasIndex);
    return index == null ? null : campaigns[index];
  };
  const resolve = row => {
    const explicit = text(row?.cid || row?.campaignId || row?.Campaign_ID || row?.["Campaign ID"]);
    const direct = explicitCampaign(explicit);
    if (direct) return direct;
    const pid = rowProductId(row, productMeta);
    const matches = (byProduct.get(pid) || []).filter(campaign => campaignMatchesDate(campaign, row?.date));
    return matches.length === 1 ? matches[0] : null;
  };
  const matches = (row, cid, fallbackPid = "") => {
    if (!cid) return true;
    const campaign = byId.get(cid);
    const inferred = resolve(row);
    if (inferred) return inferred.id === cid;
    const explicit = text(row?.cid || row?.campaignId);
    if (explicit) return explicit === cid;
    const pid = rowProductId(row, productMeta) || fallbackPid;
    return !!campaign && canonicalProductId(campaign.pid, productMeta) === canonicalProductId(pid, productMeta) && campaignMatchesDate(campaign, row?.date);
  };
  return { byId, resolve, matches };
}

function rowMatchesCampaign(row, cid, campaigns, productMeta, fallbackPid = "") {
  if (!cid) return true;
  const campaign = campaigns.find(candidate => candidate.id === cid);
  const inferred = campaignForRow(row, campaigns, productMeta);
  if (inferred) return inferred.id === cid;
  const explicit = text(row?.cid || row?.campaignId);
  if (explicit) return explicit === cid;
  const pid = rowProductId(row, productMeta) || fallbackPid;
  return !!campaign && canonicalProductId(campaign.pid, productMeta) === canonicalProductId(pid, productMeta) && campaignMatchesDate(campaign, row?.date);
}

function inRange(row, start, end) {
  const date = isoDate(row?.date);
  return !!date && (!start || date >= start) && (!end || date <= end);
}

function groupBy(values, keyFor) {
  const groups = new Map();
  for (const value of values || []) {
    const key = keyFor(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function aggregateDaily(rows = []) {
  return [...groupBy((rows || []).filter(row => isoDate(row?.date)), row => isoDate(row.date)).entries()]
    .map(([date, dateRows]) => ({
      date,
      rev:dateRows.reduce((sum, row) => sum + finite(row?.rev), 0),
      units:dateRows.reduce((sum, row) => sum + finite(row?.units), 0),
      inv:dateRows.reduce((sum, row) => sum + finite(row?.inv), 0),
      invKnown:dateRows.some(row => row?.invKnown === true || row?.inv !== "" && row?.inv != null && Number.isFinite(Number(row.inv))),
      promo:dateRows.reduce((sum, row) => sum + finite(row?.promo), 0),
      refund:dateRows.reduce((sum, row) => sum + finite(row?.refund), 0),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function analysisWarehouseStats(rows = [], warehouse, options = {}) {
  const minUnits = Math.max(0, finite(options.minUnits ?? 100));
  const minInventory = Math.max(0, finite(options.minInventory ?? minUnits));
  const minRevenue = Math.max(0, finite(options.minRevenue ?? 1000));
  const sorted = [...(rows || [])].filter(Boolean).sort((a, b) => text(a.date).localeCompare(text(b.date)));
  const positiveRev = sorted.reduce((sum, row) => sum + Math.max(0, finite(row.rev)), 0);
  const positiveUnits = sorted.reduce((sum, row) => sum + Math.max(0, finite(row.units)), 0);
  const netRev = sorted.reduce((sum, row) => sum + finite(row.rev), 0);
  const netUnits = sorted.reduce((sum, row) => sum + finite(row.units), 0);
  const inventoryValues = sorted.map(row => Number(row?.inv)).filter(Number.isFinite);
  const maxInventory = inventoryValues.length ? Math.max(...inventoryValues) : 0;
  const initialInventory = finite(sorted.find(row => finite(row.inv) > 0)?.inv);
  let reason = "";
  if (!warehouse || isNonStoreWarehouse(warehouse)) reason = "non-store";
  else if ((positiveRev <= 0 && positiveUnits <= 0) || (netRev <= 0 && netUnits <= 0)) reason = "returns-only";
  else if (options.requireMeaningfulVolume !== false && positiveRev < minRevenue && positiveUnits < minUnits && maxInventory < minInventory) reason = "low-volume";
  return { eligible:!reason, reason, positiveRev, positiveUnits, netRev, netUnits, maxInventory, initialInventory };
}

function compactWarehouse(warehouse = {}) {
  return {
    id:text(warehouse.id),
    name:text(warehouse.name),
    warehouseNo:text(warehouse.warehouseNo),
    city:text(warehouse.city),
    st:text(warehouse.st || warehouse.state),
    region:text(warehouse.region),
  };
}

function selectCampaign(campaigns, options, productMeta = {}) {
  return campaigns.find(campaign => options.primaryCid && campaign.id === options.primaryCid)
    || campaigns.find(campaign => options.primaryPid && canonicalProductId(campaign.pid, productMeta) === canonicalProductId(options.primaryPid, productMeta) && (!campaign.start || campaign.start <= options.to) && (!campaign.end || campaign.end >= options.from))
    || campaigns.find(campaign => options.primaryPid && canonicalProductId(campaign.pid, productMeta) === canonicalProductId(options.primaryPid, productMeta))
    || campaigns[0]
    || null;
}

// Pacing uses warehouse detail only for its primary product. Resolve identifiers
// from the actual immutable database directory, not a guessed list of aliases.
// Blank identifiers stay eligible for the existing product/name fallback. Keep
// campaign/date/geography filters and all official peer evidence unchanged.
export function pacingWarehouseSourcePids(dataset = {}, options = {}, availablePids = []) {
  const productMeta = dataset.productMeta || {};
  const selected = selectCampaign(campaignEntries(dataset.campaignMeta, productMeta), options, productMeta);
  const pid = selected?.pid || options.primaryPid;
  const canonical = canonicalProductId(pid, productMeta);
  return availablePids.filter(value => (!options.pids?.length || options.pids.includes(value))
    && (!canonical || !text(value) || canonicalProductId(rowProductId({pid:value}, productMeta), productMeta) === canonical));
}

function selectComparisonCampaign(campaigns, selected, options, productMeta = {}) {
  return campaigns.find(campaign => options.comparisonCid && campaign.id === options.comparisonCid)
    || campaigns.find(campaign => options.comparisonPid && campaign.id !== selected?.id && canonicalProductId(campaign.pid, productMeta) === canonicalProductId(options.comparisonPid, productMeta))
    || null;
}

function videoActivityDate(video = {}) {
  return isoDate(video.postedDate);
}

function pacingOfficialCoverage(campaign, options, officialRows = [], warehouseRows = []) {
  const expectedStarts = [isoDate(options.from), isoDate(campaign?.start)].filter(Boolean);
  const expectedEnds = [isoDate(options.to), isoDate(campaign?.end)].filter(Boolean);
  const expectedStart = expectedStarts.sort().at(-1) || "";
  const expectedEnd = expectedEnds.sort()[0] || "";
  const dateSpan = rows => {
    let start = "";
    let end = "";
    for (const row of rows) {
      const date = isoDate(row?.date);
      if (!date) continue;
      if (!start || date < start) start = date;
      if (!end || date > end) end = date;
    }
    return { start, end };
  };
  const officialSpan = dateSpan(officialRows);
  const warehouseSpan = dateSpan(warehouseRows);
  const officialStart = officialSpan.start;
  const officialEnd = officialSpan.end;
  const warehouseStart = warehouseSpan.start;
  const warehouseEnd = warehouseSpan.end;
  const status = !officialStart
    ? "unavailable"
    : (expectedStart && officialStart > expectedStart) || (expectedEnd && officialEnd < expectedEnd)
      ? "partial"
      : "complete";
  return {
    status,
    expectedStart,
    expectedEnd,
    officialStart,
    officialEnd,
    officialRowCount:officialRows.length,
    warehouseStart,
    warehouseEnd,
    warehouseRowCount:warehouseRows.length,
  };
}

function buildPacingModel(dataset, options) {
  const productMeta = dataset.productMeta || {};
  const campaignMeta = dataset.campaignMeta || {};
  const campaigns = campaignEntries(campaignMeta, productMeta);
  const officialRows = dataset.analysisOfficialRows || dataset.inlineTotalSales || [];
  const warehouseRows = dataset.prodSales || [];
  const whs = dataset.whs || [];
  const videos = dataset.videos || [];
  const footnotes = dataset.footnotes || [];
  const campaignResolver = compileCampaignResolver(campaigns, productMeta);
  const officialRowsByCampaign = groupBy(officialRows, row => campaignResolver.resolve(row)?.id || "");
  const summaries = campaigns.map(campaign => {
    const rows = officialRowsByCampaign.get(campaign.id) || [];
    const daily = aggregateDaily(rows);
    const firstDate = daily[0]?.date || campaign.start || "";
    const lastDate = daily.at(-1)?.date || campaign.end || firstDate;
    const firstSalesDate = daily.find(row => row.rev > 0 || row.units > 0)?.date || "";
    const analysisStart = meaningfulSalesStart(daily) || firstSalesDate || firstDate;
    let cumulativeRev = 0;
    let cumulativeUnits = 0;
    const pacingRows = daily.filter(row => !analysisStart || row.date >= analysisStart).map((row, index) => {
      cumulativeRev += row.rev;
      cumulativeUnits += row.units;
      return {
        date:row.date,
        day:analysisStart ? inclusiveDays(analysisStart, row.date) : index + 1,
        rev:row.rev,
        units:row.units,
        cumulativeRev,
        cumulativeUnits,
      };
    });
    const sellingRows = pacingRows.filter(row => row.rev > 0 || row.units > 0);
    const sumThrough = day => pacingRows.filter(row => row.day <= day).reduce((sum, row) => sum + row.rev, 0);
    const campaignVideos = videos.filter(video => {
      const date = videoActivityDate(video);
      if (!date || !campaignMatchesDate(campaign, date)) return false;
      if (text(video.cid) === campaign.id) return true;
      return canonicalProductId(video.pid, productMeta) === canonicalProductId(campaign.pid, productMeta);
    });
    const events = footnotes.filter(note => campaignMatchesDate(campaign, note.date) && (text(note.cid) === campaign.id || canonicalProductId(note.pid, productMeta) === canonicalProductId(campaign.pid, productMeta)));
    return {
      id:campaign.id,
      pid:campaign.pid,
      short:text(campaign.short || campaign.name || campaign.id),
      name:text(campaign.name || campaign.short || campaign.id),
      col:text(campaign.col),
      start:text(campaign.start),
      end:text(campaign.end),
      officialAvailable:daily.length > 0,
      firstDate,
      firstSalesDate,
      analysisStart,
      lastDate,
      elapsedDays:analysisStart && lastDate ? inclusiveDays(analysisStart, lastDate) : 0,
      rev:daily.reduce((sum, row) => sum + row.rev, 0),
      units:daily.reduce((sum, row) => sum + row.units, 0),
      avgDailyRev:sellingRows.length ? sellingRows.reduce((sum, row) => sum + row.rev, 0) / sellingRows.length : 0,
      avgDailyUnits:sellingRows.length ? sellingRows.reduce((sum, row) => sum + row.units, 0) / sellingRows.length : 0,
      first7Rev:sumThrough(7),
      first14Rev:sumThrough(14),
      first30Rev:sumThrough(30),
      paidVideos:campaignVideos.filter(video => text(video.type).toLowerCase() === "paid").length,
      seedingVideos:campaignVideos.filter(video => text(video.type).toLowerCase() === "seeding").length,
      videos:campaignVideos.length,
      events:events.length,
      pacingRows,
    };
  });
  const selected = selectCampaign(summaries, options, productMeta);
  const comparison = selectComparisonCampaign(summaries, selected, options, productMeta);
  const pacingCampaigns = [selected, comparison].filter(Boolean);
  const maxDay = Math.min(120, Math.max(0, ...pacingCampaigns.flatMap(campaign => campaign.pacingRows.map(row => row.day))));
  const positions = new Map();
  const latestValues = new Map();
  const chartData = Array.from({ length:maxDay }, (_, index) => {
    const day = index + 1;
    const row = { day, label:`D${day}` };
    pacingCampaigns.forEach(campaign => {
      let position = positions.get(campaign.id) || 0;
      while (position < campaign.pacingRows.length && campaign.pacingRows[position].day <= day) {
        latestValues.set(campaign.id, campaign.pacingRows[position].cumulativeRev);
        position += 1;
      }
      positions.set(campaign.id, position);
      row[campaign.id] = latestValues.has(campaign.id) ? latestValues.get(campaign.id) : null;
    });
    return row;
  });
  const peers = summaries.filter(campaign => campaign.id !== selected?.id && campaign.officialAvailable);
  const benchmark = {
    count:peers.length,
    avgFirst7:average(peers.map(row => row.first7Rev)),
    avgFirst14:average(peers.map(row => row.first14Rev)),
    avgFirst30:average(peers.map(row => row.first30Rev)),
    avgDailyRev:average(peers.map(row => row.avgDailyRev)),
    avgPaidVideos:average(peers.map(row => row.paidVideos)),
    avgSeedingVideos:average(peers.map(row => row.seedingVideos)),
  };
  const selectedPid = selected?.pid || options.primaryPid;
  const selectedCid = selected?.id || options.primaryCid;
  const selectedVideos = videos.filter(video => {
    const date = videoActivityDate(video);
    return !!date && (!selected || campaignMatchesDate(selected, date)) && (!options.from || date >= options.from) && (!options.to || date <= options.to)
      && campaignResolver.matches({ ...video, date }, selectedCid, selectedPid);
  });
  const selectedOfficialRows = officialRows.filter(row => inRange(row, options.from, options.to)
    && (!selectedPid || canonicalProductId(rowProductId(row, productMeta), productMeta) === canonicalProductId(selectedPid, productMeta))
    && campaignResolver.matches(row, selectedCid, selectedPid));
  const selectedWarehouseRows = warehouseRows.filter(row => inRange(row, options.from, options.to)
    && (!selectedPid || canonicalProductId(rowProductId(row, productMeta), productMeta) === canonicalProductId(selectedPid, productMeta))
    && campaignResolver.matches(row, selectedCid, selectedPid));
  const officialCoverage = pacingOfficialCoverage(selected, options, selectedOfficialRows, selectedWarehouseRows);
  const warehouseById = new Map(whs.map(warehouse => [text(warehouse.id), warehouse]));
  const verified = verifiedSellingWarehouseStats(selectedWarehouseRows, whs);
  const door = averageWeeklyRevenueDoorStats(selectedOfficialRows, selectedWarehouseRows, whs, { start:options.from, end:options.to });
  const inlineRev = selectedOfficialRows.reduce((sum, row) => sum + finite(row.rev), 0);
  const inlineUnits = selectedOfficialRows.reduce((sum, row) => sum + finite(row.units), 0);
  const storeRows = [...groupBy(selectedWarehouseRows, row => text(row.wid)).entries()].map(([wid, rows]) => {
    const warehouse = warehouseById.get(wid);
    const stats = analysisWarehouseStats(rows, warehouse, { requireMeaningfulVolume:true });
    if (!stats.eligible) return null;
    const movement = rows.filter(row => finite(row.rev) > 0 || finite(row.units) > 0);
    const revenuePerDoor = averageWeeklyRevenueDoorStats(movement, movement, [warehouse], { start:options.from, end:options.to }).revenuePerDoor;
    return {
      ...compactWarehouse(warehouse),
      wid,
      location:warehouseLocationLabel(warehouse),
      rev:movement.reduce((sum, row) => sum + finite(row.rev), 0),
      units:movement.reduce((sum, row) => sum + finite(row.units), 0),
      revenuePerDoor,
      share:inlineRev > 0 ? movement.reduce((sum, row) => sum + finite(row.rev), 0) / inlineRev * 100 : 0,
      maxInventory:stats.maxInventory,
      initialInventory:stats.initialInventory,
    };
  }).filter(Boolean).sort((a, b) => b.rev - a.rev || a.name.localeCompare(b.name));
  const dailySelected = aggregateDaily(selectedOfficialRows);
  const observedDays = dailySelected.filter(row => row.rev > 0 || row.units > 0).length;
  const recentRows = dailySelected.slice(-14);
  const recentDailyUnits = recentRows.length ? recentRows.reduce((sum, row) => sum + row.units, 0) / recentRows.length : 0;
  const fallbackDailyUnits = observedDays ? dailySelected.reduce((sum, row) => sum + row.units, 0) / observedDays : 0;
  const velocityUnits = recentDailyUnits > 0 ? recentDailyUnits : fallbackDailyUnits;
  const inventoryBySeries = new Map();
  for (const row of selectedWarehouseRows) {
    if (!(row?.invKnown === true || row?.inv !== "" && row?.inv != null && Number.isFinite(Number(row.inv)))) continue;
    const key = `${text(row.wid)}\u001f${rowProductId(row, productMeta)}\u001f${text(row.cid)}`;
    const current = inventoryBySeries.get(key);
    if (!current || text(row.date) >= current.date) inventoryBySeries.set(key, { date:text(row.date), inv:Math.max(0, finite(row.inv)) });
  }
  const latestInventoryKnown = inventoryBySeries.size > 0;
  const latestInventory = [...inventoryBySeries.values()].reduce((sum, row) => sum + row.inv, 0);
  const fullPriceRows = selectedOfficialRows.filter(row => finite(row.rev) > 0 && finite(row.units) > 0 && finite(row.promo) <= 0 && finite(row.refund) >= 0);
  const priceRows = fullPriceRows.length ? fullPriceRows : selectedOfficialRows.filter(row => finite(row.rev) > 0 && finite(row.units) > 0);
  const priceUnits = priceRows.reduce((sum, row) => sum + Math.max(0, finite(row.units)), 0);
  const fullPriceUnitPrice = priceUnits ? priceRows.reduce((sum, row) => sum + Math.max(0, finite(row.rev)), 0) / priceUnits : 0;
  const daysToSellout = latestInventoryKnown ? latestInventory <= 0 ? 0 : velocityUnits > 0 ? latestInventory / velocityUnits : null : null;
  const avgDailyRevenue = observedDays ? inlineRev / observedDays : selected?.avgDailyRev || 0;
  const projected30 = avgDailyRevenue * 30;
  const eventDayByDate = new Map((selected?.pacingRows || []).map(row => [row.date, row.day]));
  const eventLines = footnotes.filter(note => inRange(note, options.from, options.to) && eventDayByDate.has(note.date)
    && campaignResolver.matches(note, selectedCid, selectedPid))
    .map(note => ({ label:`D${eventDayByDate.get(note.date)}`, type:text(note.type), title:text(note.title), date:text(note.date) }));
  const stripPacing = campaign => campaign ? Object.fromEntries(Object.entries(campaign).filter(([key]) => key !== "pacingRows")) : null;
  return {
    kind:"pacing-v2",
    officialAvailable:officialCoverage.status !== "unavailable",
    officialCoverage,
    selected:stripPacing(selected),
    pacingCampaigns:pacingCampaigns.map(stripPacing),
    campaignSnapshotRows:summaries.slice(0, 6).map(stripPacing),
    chartData,
    eventLines,
    benchmark,
    selectedRange:{
      inlineRev,
      inlineUnits,
      verifiedDoors:door.weekly.length ? verified.count : 0,
      totalWarehouses:totalWarehousesForProductIds([selectedPid], productMeta),
      revenuePerDoor:door.revenuePerDoor,
      weeklyPeriodCount:door.weekly.length,
    },
    planning:{
      observedDays,
      avgDailyRevenue,
      recentDailyUnits,
      velocityUnits,
      latestInventory,
      latestInventoryKnown,
      fullPriceUnitPrice,
      daysToSellout,
      projected30,
      projectedVsBenchmark:benchmark.avgFirst30 ? pctChange(projected30, benchmark.avgFirst30) : null,
      sellThroughReviewDate:daysToSellout === null ? "" : daysToSellout <= 45 ? options.to : offsetDate(options.to, Math.max(0, Math.round(daysToSellout - 45))),
      strongDoors:storeRows.filter(row => row.revenuePerDoor >= 1000).length,
      weakDoors:storeRows.filter(row => row.revenuePerDoor <= 500).length,
      paidVideos:selectedVideos.filter(video => text(video.type).toLowerCase() === "paid").length,
      seedingVideos:selectedVideos.filter(video => text(video.type).toLowerCase() === "seeding").length,
    },
  };
}

function warehouseDirectoryNumber(warehouse) {
  const explicit = text(warehouse?.warehouseNo);
  const parsed = explicit || warehouseNumberFromText(warehouse?.name);
  const digits = text(parsed).match(/\d+/)?.[0] || "";
  return digits ? String(Number(digits)) : "";
}

function matchWarehouseDirectoryStore(warehouse, stores = []) {
  if (!warehouse) return null;
  const warehouseNo = warehouseDirectoryNumber(warehouse);
  if (warehouseNo) {
    const numberMatch = stores.find(store => text(store.warehouseNo) === warehouseNo);
    if (numberMatch) return numberMatch;
  }
  const name = normalizeStoreText(warehouse.name);
  const state = text(warehouse.st).toUpperCase();
  return stores.find(store => normalizeStoreText(store.name) === name && (!state || text(store.state).toUpperCase() === state)) || null;
}

function buildAffinityModel(dataset, options, referenceData) {
  const productMeta = dataset.productMeta || {};
  const campaigns = campaignEntries(dataset.campaignMeta || {}, productMeta);
  const stores = referenceData.marketStores || [];
  const warehouses = (dataset.whs || []).filter(warehouse => !isNonStoreWarehouse(warehouse)
    && (!options.affinityRegion || text(warehouse.region) === options.affinityRegion)
    && (!options.affinityState || text(warehouse.st) === options.affinityState));
  const warehouseIds = new Set(warehouses.map(warehouse => text(warehouse.id)));
  const rows = (dataset.prodSales || []).filter(row => warehouseIds.has(text(row.wid)) && inRange(row, options.from, options.to));
  const selectedPid = options.primaryPid || campaigns.find(campaign => campaign.id === options.primaryCid)?.pid || "";
  const selectedProductKey = normalizedKey(productLabel(selectedPid, productMeta) || selectedPid);
  const campaignResolver = compileCampaignResolver(campaigns, productMeta);
  const selectedCanonicalPid = canonicalProductId(selectedPid, productMeta);
  const scopeRows = [];
  const baselineRows = [];
  for (const row of rows) {
    const rawPid = row?.pid;
    const canonicalPid = canonicalProductId(rawPid || row?.product || row?.name, productMeta);
    const normalized = {};
    for (const key of Object.keys(row || {})) {
      if (key !== "pid") normalized[key] = row[key];
    }
    normalized.pid = normalizedKey(productLabel(canonicalPid, productMeta));
    baselineRows.push(normalized);
    if ((!selectedPid || canonicalPid === selectedCanonicalPid) && campaignResolver.matches(row, options.primaryCid, selectedPid)) {
      scopeRows.push(normalized);
    }
  }
  const demographicsByWarehouseId = {};
  warehouses.forEach(warehouse => {
    const store = matchWarehouseDirectoryStore(warehouse, stores);
    if (store?.country === "US" && store.demographics) demographicsByWarehouseId[warehouse.id] = store.demographics;
  });
  const model = buildSalesAffinityModel({
    scopeRows,
    baselineRows,
    warehouses,
    demographicsByWarehouseId,
    selectedProductKey,
    minimumPeriods:options.affinityMinimumPeriods,
    minimumUnits:options.affinityMinimumUnits,
  });
  const compactRows = model.rows.map(row => ({
    warehouseId:row.warehouseId,
    warehouse:compactWarehouse(row.warehouse),
    units:row.units,
    revenue:row.revenue,
    observedPeriods:row.observedPeriods,
    availablePeriods:row.availablePeriods,
    velocity:row.velocity,
    expectedVelocity:row.expectedVelocity,
    affinityIndex:row.affinityIndex,
    affinityPercentile:row.affinityPercentile,
    inventoryObserved:row.inventoryObserved,
    promoShare:row.promoShare,
    portfolioFactor:row.portfolioFactor,
    portfolioQualified:row.portfolioQualified,
  }));
  const compactModel = { ...model, rows:compactRows };
  const allStoreWarehouses = (dataset.whs || []).filter(warehouse => !isNonStoreWarehouse(warehouse));
  const regions = [...new Set(allStoreWarehouses.map(warehouse => text(warehouse.region)).filter(Boolean))].sort();
  const states = [...new Set(allStoreWarehouses.filter(warehouse => !options.affinityRegion || text(warehouse.region) === options.affinityRegion).map(warehouse => text(warehouse.st)).filter(Boolean))].sort();
  return {
    kind:"sales-affinity-v1",
    scope:{
      selectedPid,
      selectedCid:options.primaryCid,
      selectedProductKey,
      from:options.from,
      to:options.to,
      region:options.affinityRegion,
      state:options.affinityState,
      minimumPeriods:options.affinityMinimumPeriods,
      minimumUnits:options.affinityMinimumUnits,
    },
    regions,
    states,
    model:compactModel,
    reading:summarizeSalesAffinityReading(compactModel),
  };
}

function buildDemographicsModel(dataset, options) {
  const productMeta = dataset.productMeta || {};
  const campaigns = campaignEntries(dataset.campaignMeta || {}, productMeta);
  const selectedPid = options.primaryPid || campaigns.find(campaign => campaign.id === options.primaryCid)?.pid || "";
  const rows = selectedPid || options.primaryCid ? dataset.prodSales || [] : dataset.sales || dataset.prodSales || [];
  const scopedRows = rows.filter(row => (!selectedPid || canonicalProductId(rowProductId(row, productMeta), productMeta) === canonicalProductId(selectedPid, productMeta))
    && rowMatchesCampaign(row, options.primaryCid, campaigns, productMeta, selectedPid));
  return {
    kind:"market-demographics-v1",
    selectedWarehouseId:options.wid,
    salesScope:{ selectedPid, selectedCid:options.primaryCid, from:options.from, to:options.to },
    salesContext:marketWarehouseSalesContext(scopedRows, { warehouseId:options.wid, start:options.from, end:options.to }),
  };
}

function buildComparisonModel(dataset, options) {
  const productMeta = dataset.productMeta || {};
  const campaigns = campaignEntries(dataset.campaignMeta || {}, productMeta);
  const whs = dataset.whs || [];
  const warehouseById = new Map(whs.map(warehouse => [text(warehouse.id), warehouse]));
  const pidA = options.compareA || options.primaryPid;
  const pidB = options.compareB || options.comparisonPid;
  const cidA = options.compareCampaignA || options.primaryCid;
  const cidB = options.compareCampaignB || options.comparisonCid;
  const matchesSide = (row, pid, cid) => canonicalProductId(rowProductId(row, productMeta), productMeta) === canonicalProductId(pid, productMeta)
    && rowMatchesCampaign(row, cid, campaigns, productMeta, pid);
  const rowSides = new Map();
  const rowSide = row => {
    if (rowSides.has(row)) return rowSides.get(row);
    const side = matchesSide(row, pidA, cidA) ? "a" : matchesSide(row, pidB, cidB) ? "b" : "";
    rowSides.set(row, side);
    return side;
  };
  const eligibleRows = (dataset.prodSales || []).filter(row => rowSide(row) && (finite(row.rev) > 0 || finite(row.units) > 0));
  const geoRows = eligibleRows.filter(row => {
    const warehouse = warehouseById.get(text(row.wid));
    return warehouse && !isNonStoreWarehouse(warehouse)
      && (!options.compareRegion || text(warehouse.region) === options.compareRegion)
      && (!options.compareState || text(warehouse.st) === options.compareState);
  });
  const windowDays = Math.max(1, inclusiveDays(options.compareFrom, options.compareTo));
  const productWindow = (pid, cid) => {
    if (options.compareNormMode !== "sellingAge") return { start:options.compareFrom, end:options.compareTo };
    const start = meaningfulSalesStart(geoRows.filter(row => matchesSide(row, pid, cid))) || "";
    return start ? { start, end:offsetDate(start, windowDays - 1) } : { start:"", end:"" };
  };
  const windowA = productWindow(pidA, cidA);
  const windowB = productWindow(pidB, cidB);
  const scoped = geoRows.filter(row => {
    const side = rowSide(row);
    const window = side === "a" ? windowA : windowB;
    return window.start && window.end && row.date >= window.start && row.date <= window.end;
  });
  const rowsBySideWarehouse = groupBy(scoped, row => `${rowSide(row)}\u001f${text(row.wid)}`);
  const qualifiedSideWarehouses = new Set();
  for (const [key, sideRows] of rowsBySideWarehouse) {
    const [side, wid] = key.split("\u001f");
    const stats = analysisWarehouseStats(sideRows, warehouseById.get(wid), { minUnits:options.compareMinUnits, minInventory:0 });
    if (stats.eligible && (options.compareMinUnits <= 0 || stats.positiveUnits >= options.compareMinUnits)) qualifiedSideWarehouses.add(`${side}\u001f${wid}`);
  }
  const qualifies = (side, wid) => qualifiedSideWarehouses.has(`${side}\u001f${wid}`);
  const rawA = new Set(scoped.filter(row => rowSide(row) === "a").map(row => text(row.wid)).filter(Boolean));
  const rawB = new Set(scoped.filter(row => rowSide(row) === "b").map(row => text(row.wid)).filter(Boolean));
  const storesA = new Set([...rawA].filter(wid => qualifies("a", wid)));
  const storesB = new Set([...rawB].filter(wid => qualifies("b", wid)));
  const common = new Set([...storesA].filter(wid => storesB.has(wid)));
  const matchedRows = scoped.map(row => ({ ...row, compareSide:rowSide(row) })).filter(row => common.has(text(row.wid)) && qualifies(row.compareSide, text(row.wid)));
  const bucketFor = row => {
    const warehouse = warehouseById.get(text(row.wid));
    if (options.compareBucket === "region") return { key:text(warehouse?.region || "Unassigned"), label:text(warehouse?.region || "Unassigned"), sub:"Region" };
    if (options.compareBucket === "state") return { key:text(warehouse?.st || "Unassigned"), label:text(warehouse?.st || "Unassigned"), sub:text(warehouse?.region || "State") };
    return { key:text(row.wid), label:text(warehouse?.name || row.wid), sub:warehouseLocationLabel(warehouse) || "Warehouse" };
  };
  const buckets = new Map();
  for (const row of matchedRows) {
    const bucket = bucketFor(row);
    if (!buckets.has(bucket.key)) buckets.set(bucket.key, { ...bucket, aRev:0, bRev:0, aUnits:0, bUnits:0, aStoreIds:new Set(), bStoreIds:new Set(), storeIds:new Set() });
    const value = buckets.get(bucket.key);
    value.storeIds.add(text(row.wid));
    if (row.compareSide === "a") {
      value.aRev += finite(row.rev); value.aUnits += finite(row.units); value.aStoreIds.add(text(row.wid));
    } else {
      value.bRev += finite(row.rev); value.bUnits += finite(row.units); value.bStoreIds.add(text(row.wid));
    }
  }
  const metricValue = (row, side) => {
    const rev = side === "a" ? row.aRev : row.bRev;
    const units = side === "a" ? row.aUnits : row.bUnits;
    const doors = Math.max(1, (side === "a" ? row.aStoreIds : row.bStoreIds).size || row.storeIds.size);
    const storeDays = Math.max(1, row.storeIds.size * windowDays);
    return options.compareMetric === "units" ? units
      : options.compareMetric === "revDoor" ? rev / doors
        : options.compareMetric === "unitsDoorDay" ? units / storeDays
          : rev;
  };
  const rows = [...buckets.values()].map(bucket => {
    const a = metricValue(bucket, "a");
    const b = metricValue(bucket, "b");
    return {
      key:bucket.key, label:bucket.label, sub:bucket.sub,
      aRev:bucket.aRev, bRev:bucket.bRev, aUnits:bucket.aUnits, bUnits:bucket.bUnits,
      a, b, delta:b - a, absDelta:Math.abs(b - a),
      winner:b > a ? "comparison" : a > b ? "baseline" : "tie",
      stores:bucket.storeIds.size,
    };
  }).filter(row => row.a || row.b).sort((a, b) => b.absDelta - a.absDelta || Math.max(b.a, b.b) - Math.max(a.a, a.b));
  const totalStoreDays = Math.max(1, rows.reduce((sum, row) => sum + row.stores, 0) * windowDays);
  const aRev = rows.reduce((sum, row) => sum + row.aRev, 0);
  const bRev = rows.reduce((sum, row) => sum + row.bRev, 0);
  const aUnits = rows.reduce((sum, row) => sum + row.aUnits, 0);
  const bUnits = rows.reduce((sum, row) => sum + row.bUnits, 0);
  const matchedDoors = Math.max(1, common.size);
  const totalMetric = (rev, units) => options.compareMetric === "units" ? units
    : options.compareMetric === "revDoor" ? rev / matchedDoors
      : options.compareMetric === "unitsDoorDay" ? units / totalStoreDays
        : rev;
  const totalA = totalMetric(aRev, aUnits);
  const totalB = totalMetric(bRev, bUnits);
  const storeWarehouses = whs.filter(warehouse => !isNonStoreWarehouse(warehouse));
  return {
    kind:"comparison-v1",
    scope:{ pidA, pidB, cidA, cidB, bucket:options.compareBucket, metric:options.compareMetric, normMode:options.compareNormMode, minUnits:options.compareMinUnits, region:options.compareRegion, state:options.compareState, from:options.compareFrom, to:options.compareTo, windowDays, windowA, windowB },
    regions:[...new Set(storeWarehouses.map(warehouse => text(warehouse.region)).filter(Boolean))].sort(),
    states:[...new Set(storeWarehouses.filter(warehouse => !options.compareRegion || text(warehouse.region) === options.compareRegion).map(warehouse => text(warehouse.st)).filter(Boolean))].sort(),
    dateBounds:{
      start:[...eligibleRows].map(row => text(row.date)).filter(Boolean).sort()[0] || options.compareFrom,
      end:[...eligibleRows].map(row => text(row.date)).filter(Boolean).sort().at(-1) || options.compareTo,
    },
    labels:{ a:productLabel(pidA, productMeta) || "Baseline", b:productLabel(pidB, productMeta) || "Comparison" },
    rows,
    totals:{
      a:totalA, b:totalB, delta:totalB - totalA,
      ahead:rows.filter(row => row.winner === "comparison").length,
      behind:rows.filter(row => row.winner === "baseline").length,
      tied:rows.filter(row => row.winner === "tie").length,
      matched:common.size,
      baselineOnly:[...storesA].filter(wid => !storesB.has(wid)).length,
      comparisonOnly:[...storesB].filter(wid => !storesA.has(wid)).length,
      lowVolume:[...rawA].filter(wid => !storesA.has(wid)).length + [...rawB].filter(wid => !storesB.has(wid)).length,
      baselineStores:storesA.size,
      comparisonStores:storesB.size,
    },
  };
}

export function eventUsesOnlineSales(note = {}) {
  const channelText = [note.channel, note.title].filter(Boolean).join(" ").toLowerCase();
  return /\bonline\b|e[-_\s]*commerce|dtc|shopify|amazon/.test(channelText);
}

export function selectAnalysisEventNotes(dataset = {}, options = {}) {
  const productMeta = dataset.productMeta || {};
  const campaigns = campaignEntries(dataset.campaignMeta || {}, productMeta);
  const campaignResolver = compileCampaignResolver(campaigns, productMeta);
  const requestedPids = new Set([...(options.pids || []), options.primaryPid].filter(Boolean).map(value => canonicalProductId(value, productMeta)));
  const requestedCids = new Set([...(options.cids || []), options.primaryCid].filter(Boolean).map(text));
  return (dataset.footnotes || []).filter(note => {
    if (!IMPACT_EVENT_TYPES.has(text(note.type)) || !inRange(note, options.from, options.to)) return false;
    const notePid = canonicalProductId(note.pid || note.product, productMeta);
    if (requestedPids.size && (!notePid || !requestedPids.has(notePid))) return false;
    if (requestedCids.size && ![...requestedCids].some(cid => campaignResolver.matches(note, cid, notePid))) return false;
    return true;
  });
}

function buildEventNeeds(notes = [], productMeta = {}, online = false) {
  const byDate = new Map();
  for (const note of notes) {
    if (eventUsesOnlineSales(note) !== online) continue;
    const eventProduct = note.pid || note.product || "";
    const productKey = eventProduct ? normalizedKey(productLabel(eventProduct, productMeta)) : "__all__";
    const wid = online ? "__all__" : text(note.wid) || "__all__";
    for (let date = offsetDate(note.date, -7); date && date <= offsetDate(note.date, 6); date = offsetDate(date, 1)) {
      if (!byDate.has(date)) byDate.set(date, new Map());
      byDate.get(date).set(`${productKey}\u001f${wid}`, { productKey, wid });
    }
  }
  return byDate;
}

export function filterAnalysisEventEvidence(rows = [], notes = [], productMeta = {}, online = false) {
  const needs = buildEventNeeds(notes, productMeta, online);
  if (!needs.size) return [];
  return (rows || []).filter(row => {
    const dateNeeds = needs.get(isoDate(row?.date));
    if (!dateNeeds) return false;
    let product = null;
    const wid = text(row?.wid) || "__all__";
    for (const need of dateNeeds.values()) {
      if (need.wid !== "__all__" && need.wid !== wid) continue;
      if (need.productKey === "__all__") return true;
      if (product == null) product = normalizedKey(productLabel(rowProductId(row, productMeta), productMeta));
      if (need.productKey === product) return true;
    }
    return false;
  });
}

function buildEventIndex(rows = [], productMeta = {}, needs = new Map()) {
  const index = new Map();
  const add = (productKey, wid, date, rev, units) => {
    const key = `${productKey}\u001f${wid}\u001f${date}`;
    const current = index.get(key) || { rev:0, units:0 };
    current.rev += rev; current.units += units; index.set(key, current);
  };
  for (const row of rows || []) {
    const date = isoDate(row?.date);
    const dateNeeds = needs.get(date);
    if (!dateNeeds) continue;
    let product = null;
    const wid = text(row.wid) || "__all__";
    const rev = finite(row.rev);
    const units = finite(row.units);
    for (const need of dateNeeds.values()) {
      if (need.wid !== "__all__" && need.wid !== wid) continue;
      if (need.productKey !== "__all__") {
        if (product == null) product = normalizedKey(productLabel(rowProductId(row, productMeta), productMeta));
        if (need.productKey !== product) continue;
      }
      add(need.productKey, need.wid, date, rev, units);
    }
  }
  return index;
}

function sumEventWindow(index, product, wid, start, end) {
  const productKey = product ? normalizedKey(product) : "__all__";
  const location = wid || "__all__";
  let rev = 0; let units = 0;
  for (let date = start; date && date <= end; date = offsetDate(date, 1)) {
    const row = index.get(`${productKey}\u001f${location}\u001f${date}`);
    rev += finite(row?.rev); units += finite(row?.units);
  }
  return { rev, units };
}

function buildEventsModel(dataset, options) {
  const productMeta = dataset.productMeta || {};
  const warehouseById = new Map((dataset.whs || []).map(warehouse => [text(warehouse.id), warehouse]));
  const notes = dataset.analysisEventNotes || selectAnalysisEventNotes(dataset, options);
  const inlineNeeds = buildEventNeeds(notes, productMeta, false);
  const onlineNeeds = buildEventNeeds(notes, productMeta, true);
  const inlineIndex = buildEventIndex(dataset.prodSales || [], productMeta, inlineNeeds);
  const onlineIndex = buildEventIndex(dataset.onlineSales || [], productMeta, onlineNeeds);
  const rows = notes.map(note => {
    const eventProduct = note.pid || note.product || "";
    const eventProductKey = productLabel(eventProduct, productMeta) || eventProduct;
    const online = eventUsesOnlineSales(note);
    const pre = sumEventWindow(online ? onlineIndex : inlineIndex, eventProductKey, online ? "" : text(note.wid), offsetDate(note.date, -7), offsetDate(note.date, -1));
    const post = sumEventWindow(online ? onlineIndex : inlineIndex, eventProductKey, online ? "" : text(note.wid), note.date, offsetDate(note.date, 6));
    const lift = pctChange(post.rev, pre.rev);
    const unitLift = pctChange(post.units, pre.units);
    return {
      id:text(note.id), date:text(note.date), type:text(note.type), typeLabel:EVENT_TYPE_LABELS[note.type] || EVENT_TYPE_LABELS.other,
      title:text(note.title), product:eventProduct ? eventProductKey : "All Products",
      wid:online ? "" : text(note.wid),
      storeName:online ? "Online" : note.wid ? text(warehouseById.get(text(note.wid))?.name || note.wid) : "All stores",
      channel:online ? "Online" : "Inline",
      preRev:pre.rev, postRev:post.rev, delta:post.rev - pre.rev, lift,
      preUnits:pre.units, postUnits:post.units, unitLift,
      status:lift === null ? post.rev > 0 ? "No baseline" : "Pending / no sales" : lift >= 15 ? "Positive lift" : lift <= -15 ? "Sales drag" : "Flat",
    };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.typeLabel.localeCompare(b.typeLabel) || a.title.localeCompare(b.title));
  const typeRows = [...groupBy(rows, row => row.type).entries()].map(([type, typeEvents]) => {
    const preRev = typeEvents.reduce((sum, row) => sum + row.preRev, 0);
    const postRev = typeEvents.reduce((sum, row) => sum + row.postRev, 0);
    return {
      type, label:EVENT_TYPE_LABELS[type] || EVENT_TYPE_LABELS.other, count:typeEvents.length,
      preRev, postRev, delta:postRev - preRev, lift:pctChange(postRev, preRev),
      positive:typeEvents.filter(row => Number(row.lift || 0) > 0).length,
      negative:typeEvents.filter(row => row.lift !== null && row.lift < 0).length,
    };
  }).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const comparable = rows.filter(row => row.lift !== null);
  const sortedByDelta = [...comparable].sort((a, b) => a.delta - b.delta);
  return {
    kind:"event-impact-v1",
    rows,
    typeRows,
    summary:{
      tracked:rows.length,
      comparable:comparable.length,
      positive:comparable.filter(row => row.lift > 0).length,
      negative:comparable.filter(row => row.lift < 0).length,
      top:sortedByDelta.at(-1) || null,
      bottom:sortedByDelta[0] || null,
    },
  };
}

export function buildAnalysisSectionModel(dataset = {}, options = {}, referenceData = {}) {
  if (options.section === "pacing") return buildPacingModel(dataset, options);
  if (options.section === "affinity") return buildAffinityModel(dataset, options, referenceData);
  if (options.section === "demographics") return buildDemographicsModel(dataset, options);
  if (options.section === "comparison") return buildComparisonModel(dataset, options);
  if (options.section === "events") return buildEventsModel(dataset, options);
  if (options.section === "warehouses") return buildWarehouseAnalysisModel(dataset, options);
  throw new Error("The requested Analysis section is not supported.");
}

export const analysisSectionModelInternals = Object.freeze({
  canonicalProductId,
  campaignForRow,
  matchWarehouseDirectoryStore,
});
