function text(value) {
  return String(value ?? "").trim();
}

export function pnlImportBusinessKey(kind, row = {}) {
  if (kind === "forecast") return `${text(row.pid)}|${text(row.cid)}`;
  if (kind === "payments") return `${text(row.paymentId)}|${text(row.pid)}|${text(row.cid)}`;
  if (kind === "actuals") return text(row.externalId);
  return "";
}

function payloadRows(record) {
  const payload = typeof record?.normalized_payload === "string"
    ? JSON.parse(record.normalized_payload)
    : record?.normalized_payload;
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

export function selectEffectivePnlImports(records = []) {
  const ordered = [...records].sort((left, right) => (
    text(left.source_as_of).slice(0, 10).localeCompare(text(right.source_as_of).slice(0, 10))
    || text(left.imported_at).localeCompare(text(right.imported_at))
    || text(left.import_id).localeCompare(text(right.import_id))
  ));
  const selected = { forecast:new Map(), payments:new Map(), actuals:new Map() };
  const sources = {};
  for (const record of ordered) {
    const kind = text(record.source_kind);
    const target = selected[kind];
    if (!target) continue;
    const sourceAsOf = text(record.source_as_of).slice(0, 10);
    for (const row of payloadRows(record)) {
      const key = pnlImportBusinessKey(kind, row);
      if (!key) continue;
      const previous = target.get(key);
      const comparable = JSON.stringify(row);
      if (previous?.sourceAsOf === sourceAsOf && previous.comparable !== comparable) {
        throw Object.assign(new Error(`${kind} business key ${key} has conflicting imports for source-as-of ${sourceAsOf}.`), {
          statusCode:409,
          code:"PNL_SAME_AS_OF_CONFLICT",
        });
      }
      target.set(key, {
        row:{ ...row, sourceProvenance:{
          importId:text(record.import_id),
          sourceSha256:text(record.source_sha256),
          sourceAsOf,
          importedAt:record.imported_at,
        } },
        comparable,
        sourceAsOf,
      });
    }
    const previousSource = sources[kind];
    if (!previousSource || sourceAsOf > previousSource.asOf || (sourceAsOf === previousSource.asOf && text(record.imported_at) > text(previousSource.importedAt))) {
      sources[kind] = { asOf:sourceAsOf, importedAt:record.imported_at, sourceSha256:record.source_sha256, actorEmail:record.actor_email };
    }
  }
  return {
    forecasts:[...selected.forecast.values()].map(item => item.row),
    payments:[...selected.payments.values()].map(item => item.row),
    actuals:[...selected.actuals.values()].map(item => item.row),
    sources,
  };
}
