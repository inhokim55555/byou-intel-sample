import { createHash, randomUUID } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { SALES_UNUSED_WAREHOUSE_FIELDS, salesWarehouseReadScope } from './salesCompact.js';

const compress = promisify(gzip);
const expand = promisify(gunzip);
const SCHEMA = 'byou-sales-read-blocks-v1';
export const SALES_READ_INDEX = 'sales-read-index-v1';
const GRAINS = ['campaign-daily-inline', 'campaign-daily-online', 'campaign-warehouse-daily', 'warehouse-portfolio-daily'];
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 1000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const warehouseGrain = grain => grain === 'campaign-warehouse-daily' || grain === 'warehouse-portfolio-daily';

function validManifest(manifest, versionId) {
  if (!object(manifest) || manifest.schema !== SCHEMA || manifest.versionId !== versionId
      || JSON.stringify(manifest.projection) !== JSON.stringify(SALES_UNUSED_WAREHOUSE_FIELDS)
      || !Array.isArray(manifest.blocks) || manifest.blocks.length > 50000 || !object(manifest.counts)
      || manifest.sha256 !== hash(JSON.stringify(manifest.blocks))) return false;
  const seen = new Set(), counts = Object.fromEntries(GRAINS.map(grain => [grain, 0]));
  for (const block of manifest.blocks) {
    if (!Array.isArray(block) || block.length !== 9) return false;
    const [key, grain, pid, from, to, hasNull, count, checksum, bytes] = block;
    if (typeof key !== 'string' || !/^sales-read-v1:[a-zA-Z0-9-]+:\d+$/.test(key) || seen.has(key)
        || !GRAINS.includes(grain) || typeof pid !== 'string' || typeof hasNull !== 'boolean'
        || !(from === null && to === null && hasNull || isoDate(from) && isoDate(to) && from <= to)
        || !Number.isInteger(count) || count < 1 || count > MAX_ROWS
        || typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum)
        || !Number.isInteger(bytes) || bytes < 2 || bytes > MAX_BYTES) return false;
    seen.add(key); counts[grain] += count;
  }
  return GRAINS.every(grain => counts[grain] === (manifest.counts[grain] ?? 0));
}

async function unpack(block, descriptor) {
  if (!object(block) || block.schema !== SCHEMA || typeof block.data !== 'string'
      || block.data.length > MAX_BYTES * 2) throw new Error('Invalid Sales read block.');
  // Fewer async output-buffer callbacks for existing large blocks. The 2 MiB
  // expansion cap and all subsequent integrity/shape checks still apply.
  const bytes = await expand(Buffer.from(block.data, 'base64'), { maxOutputLength:MAX_BYTES, chunkSize:64 * 1024 });
  if (bytes.length !== descriptor[8] || hash(bytes) !== descriptor[7]) throw new Error('Sales read block integrity mismatch.');
  const rows = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(rows) || rows.length !== descriptor[6]) throw new Error('Sales read block count mismatch.');
  // A block repeats the same few dates across many warehouses. Validate each
  // distinct date once instead of allocating Date objects for every row.
  const dates = new Set();
  for (const row of rows) {
    const date = row?.[1];
    if (date !== null && !dates.has(date)) {
      if (!isoDate(date) || date < descriptor[3] || date > descriptor[4]) throw new Error('Invalid Sales read block date.');
      dates.add(date);
    }
    if (!Array.isArray(row) || row.length !== 8 || !Number.isInteger(row[0]) || row[0] < 0
        || date === null && !descriptor[5]
        || row[2] !== descriptor[2] || typeof row[3] !== 'string' || typeof row[4] !== 'string'
        || typeof row[5] !== 'string' || typeof row[6] !== 'string'
        || !object(row[7])) throw new Error('Invalid Sales read block row.');
  }
  return rows;
}

// No data/model cache: each call checks the exact immutable version and decodes
// fresh objects. Missing or invalid derived blocks use the authoritative SELECT.
export async function readSalesReadBlocks(client, versionId, categories, options, bootstrap) {
  // Product/month blocks would overfetch for a single store or other narrow
  // scope. Keep those indexed SELECTs until a measured block layout suits them.
  if (options.cid || options.cids?.length || options.wid || options.wids?.length
      || options.region || options.state || String(options.storeSearch ?? '').trim()) return null;
  if (!categories.every(grain => GRAINS.includes(grain))
      || new Set(categories).size !== categories.length
      || ['pids', 'cids', 'wids'].some(key => options[key] !== undefined && (!Array.isArray(options[key]) || options[key].some(value => typeof value !== 'string')))
      || ['cid', 'wid', 'region', 'state'].some(key => options[key] !== undefined && typeof options[key] !== 'string')
      || options.from && !isoDate(options.from) || options.to && !isoDate(options.to)) return null;
  const result = await client.query('SELECT payload FROM byou_dataset_blobs WHERE version_id=$1 AND kind=$2', [versionId, SALES_READ_INDEX]);
  const manifest = result.rows[0]?.payload;
  if (!validManifest(manifest, versionId)) return null;
  const selected = manifest.blocks.filter(([, grain, pid, from, to, hasNull]) => categories.includes(grain)
    && (!options.pids?.length || options.pids.includes(pid))
    && (hasNull || (!options.from || to >= options.from) && (!options.to || from <= options.to)));
  const grouped = Object.fromEntries(categories.map(grain => [grain, []]));
  const ordinals = new Map(categories.map(grain => [grain, new Set()]));
  const cids = options.cids?.length ? options.cids : options.cid ? [options.cid] : [];
  const scope = salesWarehouseReadScope(bootstrap, options);
  const warehouseIds = scope.warehouseIds === null ? null : new Set(scope.warehouseIds);
  const hidden = new Set(scope.hiddenScopes);
  for (let offset = 0; offset < selected.length; offset += 32) {
    const descriptors = selected.slice(offset, offset + 32);
    // Query errors propagate; only invalid derived content falls back. A SQL
    // error may abort the caller's transaction and cannot safely be swallowed.
    const blocks = await client.query('SELECT kind,payload FROM byou_dataset_blobs WHERE version_id=$1 AND kind=ANY($2::text[])', [versionId, descriptors.map(block => block[0])]);
    const byKey = new Map(blocks.rows.map(block => [block.kind, block.payload]));
    for (const descriptor of descriptors) {
      let rows;
      try { rows = await unpack(byKey.get(descriptor[0]), descriptor); } catch { return null; }
      const grain = descriptor[1];
      for (const [ordinal, date, pid, cid, wid, region, state, original] of rows) {
        if (ordinals.get(grain).has(ordinal)) return null;
        ordinals.get(grain).add(ordinal);
        // Match addScope's SQL column semantics, not inferred payload identity.
        if (date !== null && (options.from && date < options.from || options.to && date > options.to)
            || cids.length && cid !== '' && !cids.includes(cid)
            || (options.wids?.length ? !options.wids.includes(wid) : options.wid && wid !== options.wid)
            || options.region && region !== options.region || options.state && state !== options.state) continue;
        if (warehouseGrain(grain) && (warehouseIds !== null && !warehouseIds.has(wid) && !warehouseIds.has(wid.trim())
            || hidden.has(`${pid}|${cid}|${wid}`))) continue;
        grouped[grain].push({ ordinal, date, payload:original });
      }
    }
  }
  for (const grain of categories) grouped[grain] = grouped[grain]
    .sort((a, b) => a.date === b.date ? a.ordinal - b.ordinal : a.date === null ? -1 : b.date === null ? 1 : a.date < b.date ? -1 : 1)
    .map(row => row.payload);
  return grouped;
}

// Caller owns a transaction. Read source rows in bounded batches and publish
// the manifest last; a failure rolls back all derived blobs, never source rows.
export async function buildSalesReadBlocks(client, versionId) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`sales-read:${versionId}`]);
  const version = await client.query('SELECT id FROM byou_dataset_versions WHERE id=$1 FOR SHARE', [versionId]);
  if (!version.rows.length) throw new Error('Sales read version is unavailable.');
  const existing = await client.query('SELECT payload FROM byou_dataset_blobs WHERE version_id=$1 AND kind=$2', [versionId, SALES_READ_INDEX]);
  if (existing.rows.length) {
    if (!validManifest(existing.rows[0].payload, versionId)) throw new Error('Existing Sales read index is invalid; explicit repair is required.');
    return { alreadyBuilt:true, blocks:existing.rows[0].payload.blocks.length };
  }
  const generation = randomUUID(), blocks = [], counts = Object.fromEntries(GRAINS.map(grain => [grain, 0]));
  let pending = [], pendingKey = '', pendingGrain = '', pendingPid = '';
  async function flush() {
    if (!pending.length) return;
    const bytes = Buffer.from(JSON.stringify(pending));
    if (bytes.length > MAX_BYTES) {
      if (pending.length === 1) throw new Error('Sales read row exceeds the block budget.');
      const rest = pending.splice(Math.ceil(pending.length / 2));
      await flush(); pending = rest; await flush(); return;
    }
    const dates = pending.map(row => row[1]).filter(date => date !== null).sort();
    const key = `sales-read-v1:${generation}:${blocks.length}`;
    const descriptor = [key, pendingGrain, pendingPid, dates[0] ?? null, dates.at(-1) ?? null, pending.some(row => row[1] === null), pending.length, hash(bytes), bytes.length];
    const payload = { schema:SCHEMA, data:(await compress(bytes)).toString('base64') };
    await client.query('INSERT INTO byou_dataset_blobs(version_id,kind,payload) VALUES ($1,$2,$3::jsonb)', [versionId, key, JSON.stringify(payload)]);
    const readback = await client.query('SELECT payload FROM byou_dataset_blobs WHERE version_id=$1 AND kind=$2', [versionId, key]);
    await unpack(readback.rows[0]?.payload, descriptor);
    blocks.push(descriptor); counts[pendingGrain] += pending.length; pending = [];
  }
  await client.query(`DECLARE byou_sales_read_source NO SCROLL CURSOR FOR
    SELECT grain,ordinal,to_char(date_key,'YYYY-MM-DD') AS date_key,pid,cid,wid,region,state,payload
    FROM byou_summary_rows WHERE version_id=$1 AND grain=ANY($2::text[])
    ORDER BY grain,pid,date_key NULLS FIRST,ordinal`, [versionId, GRAINS]);
  try {
    while (true) {
      const batch = await client.query(`FETCH FORWARD ${MAX_ROWS} FROM byou_sales_read_source`);
      if (!batch.rows.length) break;
      for (const row of batch.rows) {
        const key = JSON.stringify([row.grain, row.pid, row.date_key?.slice(0, 7) ?? null]);
        if (pending.length && (pendingKey !== key || pending.length >= MAX_ROWS)) await flush();
        pendingKey = key; pendingGrain = row.grain; pendingPid = row.pid;
        const payload = { ...row.payload };
        if (warehouseGrain(row.grain)) for (const key of SALES_UNUSED_WAREHOUSE_FIELDS) delete payload[key];
        pending.push([row.ordinal, row.date_key, row.pid, row.cid, row.wid, row.region, row.state, payload]);
      }
    }
    await flush();
  } finally { await client.query('CLOSE byou_sales_read_source'); }
  const actual = await client.query('SELECT grain,count(*)::int AS count FROM byou_summary_rows WHERE version_id=$1 AND grain=ANY($2::text[]) GROUP BY grain', [versionId, GRAINS]);
  const actualCounts = Object.fromEntries(actual.rows.map(row => [row.grain, row.count]));
  if (!GRAINS.every(grain => counts[grain] === (actualCounts[grain] ?? 0))) throw new Error('Sales read source counts changed.');
  const manifest = { schema:SCHEMA, versionId, blocks, counts, projection:SALES_UNUSED_WAREHOUSE_FIELDS, sha256:hash(JSON.stringify(blocks)) };
  if (!validManifest(manifest, versionId)) throw new Error('Sales read index failed validation.');
  await client.query('INSERT INTO byou_dataset_blobs(version_id,kind,payload) VALUES ($1,$2,$3::jsonb)', [versionId, SALES_READ_INDEX, JSON.stringify(manifest)]);
  return { alreadyBuilt:false, blocks:blocks.length, rows:Object.values(counts).reduce((sum, count) => sum + count, 0) };
}
