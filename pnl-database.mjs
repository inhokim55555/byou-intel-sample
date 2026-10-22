import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildPnlView, validatePnlImportEnvelope, validatePnlOverride } from "./src/lib/pnl.js";
import { pnlImportBusinessKey, selectEffectivePnlImports } from "./src/lib/pnlImportSelection.js";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const connectionString = "postgresql://postgres:postgres@127.0.0.1:16531/postgres";
const configured = !!connectionString;
const useSsl = /^(require|verify-ca|verify-full)$/i.test(String(process.env.BYOU_PNL_PGSSLMODE || process.env.PGSSLMODE || ""));
const pool = configured ? new Pool({
  connectionString,
  max:Number(process.env.BYOU_PNL_DB_POOL_SIZE || 4),
  idleTimeoutMillis:30_000,
  connectionTimeoutMillis:8_000,
  ssl:useSsl ? { rejectUnauthorized:true } : undefined,
}) : null;
let migrationPromise = null;

pool?.on("error", error => console.error("[BYOU Intel] P&L database pool error:", error.message));

export function pnlDatabaseConfigured() {
  return configured;
}

export async function initializePnlDatabase() {
  if (!configured) return false;
  if (!migrationPromise) {
    migrationPromise = readFile(path.join(__dirname, "migrations", "004_pnl.sql"), "utf8")
      .then(sql => pool.query(sql))
      .then(() => true)
      .catch(error => {
        migrationPromise = null;
        throw error;
      });
  }
  return migrationPromise;
}

function importId(kind, sourceSha256) {
  return `pnl-${crypto.createHash("sha256").update(`${kind}|${sourceSha256}`).digest("hex")}`;
}

async function importedRows(client) {
  const result = await client.query(`
    SELECT import_id, source_kind, source_sha256, source_as_of, normalized_payload, superseded_payload, actor_email, imported_at
    FROM byou_pnl_imports
    ORDER BY source_as_of, imported_at, import_id
  `);
  const imports = [];
  for (const record of result.rows) {
    const payload = typeof record.normalized_payload === "string" ? JSON.parse(record.normalized_payload) : record.normalized_payload;
    const superseded = typeof record.superseded_payload === "string" ? JSON.parse(record.superseded_payload) : record.superseded_payload;
    imports.push({
      type:"import",
      action:"import",
      eventId:record.import_id,
      sourceKind:record.source_kind,
      sourceSha256:record.source_sha256,
      sourceAsOf:String(record.source_as_of || "").slice(0, 10),
      rowCount:(payload?.rows || []).length,
      supersededCount:Array.isArray(superseded) ? superseded.length : 0,
      actorEmail:record.actor_email,
      createdAt:record.imported_at,
    });
  }
  return { ...selectEffectivePnlImports(result.rows), imports };
}

async function overrideRows(client) {
  const result = await client.query(`
    SELECT event_id, action, target_event_id, pid, cid, field_key, numeric_value, superseded_value, effective_date, reason, actor_email, created_at
    FROM byou_pnl_override_events
    ORDER BY created_at, event_id
  `);
  return result.rows.map(row => ({
    eventId:row.event_id,
    action:row.action,
    targetEventId:row.target_event_id || "",
    pid:row.pid,
    cid:row.cid,
    field:row.field_key,
    value:row.numeric_value === null ? null : Number(row.numeric_value),
    supersededValue:row.superseded_value === null ? null : Number(row.superseded_value),
    effectiveDate:String(row.effective_date || "").slice(0, 10),
    reason:row.reason,
    actorEmail:row.actor_email,
    createdAt:row.created_at,
  }));
}

export async function getPnlView({ asOf = "", pid = "", cid = "", permissions = {} } = {}) {
  if (!configured) return buildPnlView({
    asOf,
    permissions,
    sources:{ database:{ configured:false, message:"P&L database is not configured." } },
  });
  await initializePnlDatabase();
  const client = await pool.connect();
  try {
    const imported = await importedRows(client);
    const overrides = await overrideRows(client);
    const scoped = {
      forecasts:imported.forecasts.filter(row => (!pid || row.pid === pid) && (!cid || row.cid === cid)),
      payments:imported.payments.filter(row => (!pid || row.pid === pid) && (!cid || row.cid === cid)),
      actuals:imported.actuals.filter(row => (!pid || row.pid === pid) && (!cid || row.cid === cid)),
    };
    const view = buildPnlView({ ...scoped, overrides, asOf, permissions, sources:{ ...imported.sources, database:{ configured:true } } });
    view.audit = permissions.canEdit
      ? [...imported.imports, ...overrides.map(row => ({ ...row, type:"override" }))].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).slice(0, 100)
      : [];
    return view;
  } finally {
    client.release();
  }
}

export async function savePnlImport(input, actorEmail) {
  if (!configured) throw Object.assign(new Error("P&L database is not configured."), { statusCode:503, code:"PNL_DATABASE_REQUIRED" });
  const validation = validatePnlImportEnvelope(input);
  if (!validation.valid) throw Object.assign(new Error("P&L import validation failed."), { statusCode:422, code:"PNL_IMPORT_INVALID", details:validation });
  await initializePnlDatabase();
  const normalized = validation.normalized;
  const id = importId(normalized.kind, normalized.sourceSha256);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('byou_pnl_imports'))");
    const existingImport = await client.query(`
      SELECT import_id, normalized_payload = $3::jsonb AS identical, imported_at
      FROM byou_pnl_imports
      WHERE source_kind = $1 AND source_sha256 = $2
      FOR SHARE
    `, [normalized.kind, normalized.sourceSha256, JSON.stringify(normalized)]);
    if (existingImport.rowCount) {
      if (!existingImport.rows[0].identical) {
        throw Object.assign(new Error("This source hash was already imported with different normalized financial data."), { statusCode:409, code:"PNL_IMPORT_HASH_CONFLICT" });
      }
      await client.query("COMMIT");
      return { ok:true, importId:existingImport.rows[0].import_id, alreadyImported:true, importedAt:existingImport.rows[0].imported_at, validation };
    }
    const existing = await importedRows(client);
    if (normalized.kind === "actuals") {
      const existingById = new Map(existing.actuals.map(row => {
        const { sourceProvenance:_, ...businessRow } = row;
        return [row.externalId, JSON.stringify(businessRow)];
      }));
      for (const row of normalized.rows) {
        const prior = existingById.get(row.externalId);
        if (prior && prior !== JSON.stringify(row)) {
          throw Object.assign(new Error(`Finance external ID ${row.externalId} conflicts with an earlier import.`), { statusCode:409, code:"PNL_ACTUAL_ID_CONFLICT" });
        }
      }
    }
    const sameDateImports = await client.query(`
      SELECT import_id, source_kind, source_sha256, source_as_of, normalized_payload, actor_email, imported_at
      FROM byou_pnl_imports
      WHERE source_kind=$1 AND source_as_of=$2
    `, [normalized.kind, normalized.sourceAsOf]);
    const incomingByKey = new Map(normalized.rows.map(row => [pnlImportBusinessKey(normalized.kind, row), JSON.stringify(row)]));
    for (const record of sameDateImports.rows) {
      const payload = typeof record.normalized_payload === "string" ? JSON.parse(record.normalized_payload) : record.normalized_payload;
      for (const row of payload?.rows || []) {
        const key = pnlImportBusinessKey(normalized.kind, row);
        if (incomingByKey.has(key) && incomingByKey.get(key) !== JSON.stringify(row)) {
          throw Object.assign(new Error(`${normalized.kind} business key ${key} already has different data for source-as-of ${normalized.sourceAsOf}.`), { statusCode:409, code:"PNL_SAME_AS_OF_CONFLICT" });
        }
      }
    }
    const keyFor = normalized.kind === "forecast"
      ? row => `${row.pid}|${row.cid}`
      : normalized.kind === "payments"
        ? row => `${row.paymentId}|${row.pid}|${row.cid}`
        : row => row.externalId;
    const priorRows = normalized.kind === "forecast" ? existing.forecasts : normalized.kind === "payments" ? existing.payments : existing.actuals;
    const priorByKey = new Map(priorRows.map(row => [keyFor(row), row]));
    const supersededPayload = normalized.rows.map(row => priorByKey.get(keyFor(row))).filter(Boolean).map(row => {
      const { sourceProvenance:_, ...businessRow } = row;
      return businessRow;
    });
    const result = await client.query(`
      INSERT INTO byou_pnl_imports (
        import_id, source_kind, source_sha256, source_as_of, schema_name,
        normalized_payload, superseded_payload, normalized_row_count, actor_email
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)
      ON CONFLICT (source_kind, source_sha256) DO NOTHING
      RETURNING import_id, imported_at
    `, [id, normalized.kind, normalized.sourceSha256, normalized.sourceAsOf, normalized.schema, JSON.stringify(normalized), JSON.stringify(supersededPayload), normalized.rows.length, actorEmail]);
    if (result.rowCount === 0) {
      const raced = await client.query(`
        SELECT import_id, normalized_payload = $3::jsonb AS identical, imported_at
        FROM byou_pnl_imports
        WHERE source_kind = $1 AND source_sha256 = $2
      `, [normalized.kind, normalized.sourceSha256, JSON.stringify(normalized)]);
      if (!raced.rows[0]?.identical) {
        throw Object.assign(new Error("This source hash was concurrently imported with different normalized financial data."), { statusCode:409, code:"PNL_IMPORT_HASH_CONFLICT" });
      }
      await client.query("COMMIT");
      return { ok:true, importId:raced.rows[0].import_id, alreadyImported:true, importedAt:raced.rows[0].imported_at, validation };
    }
    await client.query("COMMIT");
    return { ok:true, importId:id, alreadyImported:false, importedAt:result.rows[0]?.imported_at || null, validation };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function savePnlOverride(input, actorEmail) {
  if (!configured) throw Object.assign(new Error("P&L database is not configured."), { statusCode:503, code:"PNL_DATABASE_REQUIRED" });
  const validation = validatePnlOverride(input);
  if (!validation.valid) throw Object.assign(new Error("P&L override validation failed."), { statusCode:422, code:"PNL_OVERRIDE_INVALID", details:validation });
  await initializePnlDatabase();
  const row = validation.normalized;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('byou_pnl_overrides'))");
    const existingEvent = await client.query(`
      SELECT event_id, action, target_event_id, pid, cid, field_key, numeric_value, effective_date, reason, actor_email, created_at
      FROM byou_pnl_override_events
      WHERE event_id = $1
      FOR SHARE
    `, [row.eventId]);
    if (existingEvent.rowCount) {
      const existing = existingEvent.rows[0];
      const identical = existing.action === row.action
        && String(existing.target_event_id || "") === row.targetEventId
        && (row.action === "reverse" || (existing.pid === row.pid && existing.cid === row.cid && existing.field_key === row.field && Number(existing.numeric_value) === row.value && String(existing.effective_date).slice(0, 10) === row.effectiveDate))
        && existing.reason === row.reason
        && existing.actor_email === actorEmail;
      if (!identical) throw Object.assign(new Error("This override event ID already exists with different content."), { statusCode:409, code:"PNL_OVERRIDE_ID_CONFLICT" });
      await client.query("COMMIT");
      return { ok:true, eventId:row.eventId, alreadyApplied:true, createdAt:existing.created_at, validation };
    }

    let scope = { pid:row.pid, cid:row.cid, field:row.field, effectiveDate:row.effectiveDate };
    if (row.action === "reverse") {
      const target = await client.query(`
        SELECT event_id, pid, cid, field_key, numeric_value
        FROM byou_pnl_override_events
        WHERE event_id = $1 AND action = 'set'
        FOR SHARE
      `, [row.targetEventId]);
      if (!target.rowCount) throw Object.assign(new Error("The override being reversed does not exist."), { statusCode:404, code:"PNL_OVERRIDE_TARGET_REQUIRED" });
      const priorReversal = await client.query("SELECT event_id FROM byou_pnl_override_events WHERE action = 'reverse' AND target_event_id = $1", [row.targetEventId]);
      if (priorReversal.rowCount) throw Object.assign(new Error("This override has already been reversed."), { statusCode:409, code:"PNL_OVERRIDE_ALREADY_REVERSED" });
      scope = { pid:target.rows[0].pid, cid:target.rows[0].cid, field:target.rows[0].field_key, effectiveDate:new Date().toISOString().slice(0, 10) };
    }

    const imported = await importedRows(client);
    const overrides = await overrideRows(client);
    const currentView = buildPnlView({ forecasts:imported.forecasts, overrides, asOf:scope.effectiveDate });
    const campaign = currentView.campaigns.find(item => item.pid === scope.pid && item.cid === scope.cid);
    if (!campaign) throw Object.assign(new Error("The exact campaign forecast must exist before an override can be recorded."), { statusCode:409, code:"PNL_OVERRIDE_CAMPAIGN_REQUIRED" });
    const fieldValue = {
      forecastRevenue:campaign.forecast.revenue,
      forecastCogs:campaign.forecast.cogs,
      forecastOtherExpenses:campaign.forecast.otherExpenses,
      plannedMarketing:campaign.forecast.plannedMarketing,
    }[scope.field];
    if (!Number.isFinite(Number(fieldValue))) throw Object.assign(new Error("The superseded forecast value could not be determined."), { statusCode:409, code:"PNL_OVERRIDE_BASE_REQUIRED" });

    const result = await client.query(`
      INSERT INTO byou_pnl_override_events (
        event_id, action, target_event_id, pid, cid, field_key, numeric_value,
        superseded_value, effective_date, reason, actor_email
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING event_id, created_at
    `, [row.eventId, row.action, row.targetEventId || null, scope.pid, scope.cid, scope.field, row.action === "set" ? row.value : null, Number(fieldValue), scope.effectiveDate, row.reason, actorEmail]);
    await client.query("COMMIT");
    return { ok:true, eventId:row.eventId, alreadyApplied:false, createdAt:result.rows[0]?.created_at || null, supersededValue:Number(fieldValue), validation };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function pnlDatabaseHealth() {
  if (!configured) return { configured:false, ready:false };
  try {
    await initializePnlDatabase();
    const result = await pool.query("SELECT COUNT(*)::integer AS imports FROM byou_pnl_imports");
    return { configured:true, ready:true, imports:result.rows[0]?.imports || 0 };
  } catch (error) {
    return { configured:true, ready:false, error:error.message };
  }
}
