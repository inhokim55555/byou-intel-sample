import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NON_STORE_WAREHOUSE_PATTERN } from './warehouseIdentity.js';

export const COMPETITOR_SCHEMA = 'byou-competitor-snapshot-v1';
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const pacificDate = value => new Intl.DateTimeFormat('en-CA', { timeZone:'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(value));
const dateValid = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const instantValid = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const normalize = value => String(value || '').toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
const freshnessWindowDays = cutoff => {
  const day = new Date(`${cutoff}T12:00:00Z`).getUTCDay();
  return day === 0 ? 2 : day === 1 ? 3 : 1;
};
export function addressKey(row) {
  return [normalize(row.street || row.address), normalize(row.city), normalize(row.state), String(row.zip || '').slice(0, 5)].join('|');
}
export function warehouseCrosswalk(stores) {
  const map = new Map();
  for (const store of stores) {
    if (store.country !== 'US' || NON_STORE_WAREHOUSE_PATTERN.test(store.name || '') || !store.street || !store.city || !store.state || !/^\d{5}/.test(store.zip || '')) continue;
    const key = addressKey(store);
    map.set(key, map.has(key) ? null : String(store.warehouseNo));
  }
  return map;
}
export function validateSnapshot(data, stores, now = Date.now()) {
  const fail = message => { throw Object.assign(new Error(message), { status:400 }); };
  if (data?.schema !== COMPETITOR_SCHEMA || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.id || '')) fail('Invalid competitor snapshot identity.');
  if (!instantValid(data.completedAt) || Date.parse(data.completedAt) > now + 60000 || !Array.isArray(data.items) || !data.items.length || data.items.length > 100 || !Array.isArray(data.observations) || data.observations.length > 100000) fail('Invalid competitor snapshot bounds.');
  const items = new Map();
  if (data.coverage?.completeItems !== data.items.length || data.coverage?.expectedItems !== data.items.length || data.coverage?.matchedRows !== data.observations.length || !Number.isInteger(data.coverage?.totalRows) || data.coverage.totalRows !== data.observations.length + data.coverage.unresolvedRows + data.coverage.ambiguousRows) fail('Incomplete competitor coverage declaration.');
  for (const item of data.items) {
    if (!/^\d{1,12}$/.test(item.id || '') || items.has(item.id) || typeof item.title !== 'string' || !item.title || item.title.length > 500 || !Array.isArray(item.productIds) || item.productIds.some(p => typeof p !== 'string' || p.length > 150) || !/^[a-f0-9]{64}$/.test(item.identityKey || '') || !/^https:\/\/app\.warehouserunner\.com\/costco\//.test(item.url || '')) fail('Invalid competitor item.');
    items.set(item.id, item);
  }
  const seen = new Set();
  const map = warehouseCrosswalk(stores);
  for (const row of data.observations) {
    const key = `${row.itemId}|${row.warehouseNo}`;
    if (!items.has(row.itemId) || seen.has(key) || !row.warehouseNo || map.get(addressKey(row)) !== row.warehouseNo || NON_STORE_WAREHOUSE_PATTERN.test(row.name || '')) fail('Ambiguous or invalid competitor warehouse identity.');
    seen.add(key);
    if (!['in_stock','low_stock','out_of_stock','unknown'].includes(row.status) || typeof row.statusRaw !== 'string' || row.statusRaw.length > 100 || (row.status === 'in_stock' && normalize(row.statusRaw) !== 'in stock')) fail('Invalid competitor stock label.');
    if (!instantValid(row.observedAt) || Date.parse(row.observedAt) > Date.parse(data.completedAt) || (row.sourceDate !== null && !dateValid(row.sourceDate)) || (row.price !== null && (!Number.isFinite(row.price) || row.price < 0)) || !/^[a-f0-9]{64}$/.test(row.evidenceHash || '')) fail('Invalid competitor observation.');
  }
  return data;
}

export function competitorView(snapshots, { warehouseNo, pids = [], asOf = '', itemId = '', days = 90, now = Date.now() }) {
  if (asOf && (!dateValid(asOf) || asOf > pacificDate(now))) throw Object.assign(new Error('Invalid observation cutoff.'), { status:400 });
  const cutoff = asOf || pacificDate(now);
  const releases = snapshots.filter(s => pacificDate(s.completedAt) <= cutoff).sort((a,b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
  const latest = releases[0];
  const base = { schema:'byou-warehouse-competitors-v1', warehouseNo, releaseId:latest?.id || null, completedAt:latest?.completedAt || null, cutoff, coverage:latest?.coverage || null, rows:[] };
  if (!latest) return base;
  const age = date => dateValid(date) ? (Date.parse(cutoff) - Date.parse(date)) / 86400000 : Infinity;
  const freshnessDays = freshnessWindowDays(cutoff);
  const candidates = latest.observations.filter(r => r.warehouseNo === warehouseNo);
  base.observedItems = candidates.length;
  base.rows = candidates.filter(r => r.status === 'in_stock' && age(r.sourceDate) >= 0 && age(r.sourceDate) <= freshnessDays + 1 && age(pacificDate(r.observedAt)) <= freshnessDays).flatMap(row => {
    const item = latest.items.find(i => i.id === row.itemId);
    if (pids.length && !item.productIds.some(p => pids.includes(p))) return [];
    if (itemId && item.id !== itemId) return [];
    const history = releases.flatMap(s => {
      const version = s.items.find(i => i.id === item.id);
      if (version?.identityKey !== item.identityKey) return [];
      return s.observations.filter(r => r.itemId === item.id && r.warehouseNo === warehouseNo && (!days || age(pacificDate(r.observedAt)) <= days)).map(r => ({ ...r, releaseId:s.id }));
    }).sort((a,b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    const previous = history.filter(r => Date.parse(r.observedAt) < Date.parse(row.observedAt) && r.sourceDate && row.sourceDate && r.sourceDate < row.sourceDate && r.price !== null).at(-1);
    return [{ ...row, title:item.title, url:item.url, productIds:item.productIds, warnings:item.warnings || [], matchStatus:'provisional', priceChange:previous && row.price !== null ? Math.round((row.price - previous.price) * 100) / 100 : null, previousDate:previous?.sourceDate || null, ...(itemId ? { history } : {}) }];
  }).sort((a,b) => a.title.localeCompare(b.title));
  return base;
}

export function createCompetitorStore(directory) {
  let queue = Promise.resolve();
  let cachedIndex = '';
  let cachedSnapshots = null;
  const root = path.join(directory, 'competitor-research');
  async function snapshots() {
    let indexText;
    try { indexText = await readFile(path.join(root, 'index.json'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (indexText === cachedIndex && cachedSnapshots) return cachedSnapshots;
    const pointer = JSON.parse(indexText);
    const result = await Promise.all(pointer.files.map(async file => {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) throw new Error('Invalid competitor archive reference.');
      const bytes = await readFile(path.join(root, file));
      if (`${hash(bytes)}.json` !== file) throw new Error('Competitor archive integrity check failed.');
      return JSON.parse(bytes);
    }));
    cachedIndex = indexText;
    cachedSnapshots = result;
    return result;
  }
  function publish(data, stores) {
    const task = queue.then(async () => {
      validateSnapshot(data, stores);
      const prior = await snapshots();
      const bytes = JSON.stringify(data);
      const digest = hash(bytes);
      const existing = prior.find(s => s.id === data.id);
      if (existing && hash(JSON.stringify(existing)) !== digest) throw Object.assign(new Error('Competitor run identity already exists with different content.'), { status:409 });
      if (existing) return { id:data.id, sha256:digest, duplicate:true };
      if (prior.some(s => Date.parse(s.completedAt) >= Date.parse(data.completedAt))) throw Object.assign(new Error('An equal or newer competitor run is already published.'), { status:409 });
      await mkdir(root, { recursive:true });
      await writeFile(path.join(root, `${digest}.json`), bytes, { flag:'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      if (hash(await readFile(path.join(root, `${digest}.json`))) !== digest) throw new Error('Competitor snapshot readback failed.');
      const files = prior.map(s => `${hash(JSON.stringify(s))}.json`).concat(`${digest}.json`);
      const temp = path.join(root, `index-${crypto.randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify({ files }));
      await rename(temp, path.join(root, 'index.json'));
      return { id:data.id, sha256:digest, duplicate:false };
    });
    queue = task.catch(() => {});
    return task;
  }
  return { publish, snapshots };
}
