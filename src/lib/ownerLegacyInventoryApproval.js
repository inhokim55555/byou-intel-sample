import crypto from "node:crypto";
import { canonicalWarehouseIsUnique } from "./canonicalWarehouseApproval.js";
import {
  inventoryCoverageEvidence,
  inventoryRowHasKnownBalance,
  inventoryValidationEvidence,
  matchingInventoryApproval,
  matchingInventoryReviewDisposition,
} from "./dashboardScope.js";
import {
  exactLatestInventoryFactsMatchApproval,
  inventoryApprovalCampaignCoversObservation,
} from "./manualInventoryApproval.js";

function text(value) {
  return String(value ?? "").trim();
}

function dateKey(value) {
  const valueText = text(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(valueText) ? valueText : "";
}

function inclusiveDateSpan(start, end) {
  const startTime = Date.parse(`${dateKey(start)}T00:00:00Z`);
  const endTime = Date.parse(`${dateKey(end)}T00:00:00Z`);
  return Number.isFinite(startTime) && Number.isFinite(endTime) && endTime >= startTime
    ? Math.floor((endTime - startTime) / 86_400_000) + 1
    : 1;
}

function scopeKey(row = {}) {
  return [row.pid, row.cid, row.wid].map(value => text(value).toLowerCase()).join("|");
}

function metadataValue(map = {}, id = "") {
  if (map?.[id] && text(map[id]?.id) === text(id)) return map[id];
  return Object.values(map || {}).find(row => text(row?.id) === text(id)) || null;
}

function dispositionFactExists(facts = [], disposition = {}) {
  return (facts || []).some(row => (
    text(row?.pid) === text(disposition.pid)
    && text(row?.cid) === text(disposition.cid)
    && text(row?.wid) === text(disposition.wid)
    && dateKey(row?.date) === dateKey(disposition.inventoryDate)
    && inventoryRowHasKnownBalance(row)
    && Number(row?.inv) === Number(disposition.onHand)
  ));
}

function summarize(rows = [], key = "pid") {
  return Object.fromEntries([...rows.reduce((counts, row) => {
    const value = text(row?.[key]) || "Unknown";
    counts.set(value, (counts.get(value) || 0) + 1);
    return counts;
  }, new Map())].sort(([left], [right]) => left.localeCompare(right)));
}

export function ownerLegacyApprovalManifestPayload({
  sourceVersion = "",
  sourcePublishedAt = "",
  authorizationReference = "",
  evaluationDate = "",
  candidates = [],
} = {}) {
  return {
    schema:"byou-owner-legacy-inventory-approval-v1",
    sourceVersion:text(sourceVersion),
    sourcePublishedAt:text(sourcePublishedAt),
    authorizationReference:text(authorizationReference),
    evaluationDate:dateKey(evaluationDate),
    rows:[...(candidates || [])].map(row => ({
      issueId:text(row.issueId),
      pid:text(row.pid),
      cid:text(row.cid),
      wid:text(row.wid),
      inventoryDate:dateKey(row.inventoryDate),
      onHand:Number(row.onHand),
      sourceDispositionIssueId:text(row.sourceDispositionIssueId),
      sourceDispositionDate:dateKey(row.sourceDispositionDate),
      sourceDispositionOnHand:Number(row.sourceDispositionOnHand),
      factSha256:text(row.factSha256),
    })).sort((left, right) => (
      left.pid.localeCompare(right.pid)
      || left.cid.localeCompare(right.cid)
      || left.wid.localeCompare(right.wid)
      || left.inventoryDate.localeCompare(right.inventoryDate)
      || left.issueId.localeCompare(right.issueId)
    )),
  };
}

export function ownerLegacyApprovalManifestHash(options = {}) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(ownerLegacyApprovalManifestPayload(options)))
    .digest("hex");
}

export function buildOwnerLegacyInventoryApprovalPreflight({
  runtime = {},
  facts = [],
  activeApprovals = [],
  revokedScopeKeys = new Set(),
  canonicalWarehouseDirectory = null,
  sourceVersion = "",
  sourcePublishedAt = "",
  authorizationReference = "",
  evaluationDate = "",
  fingerprint = () => "",
} = {}) {
  const warehouseRows = Array.isArray(runtime.whs) ? runtime.whs : [];
  const warehouseById = new Map(warehouseRows.map(row => [text(row?.id), row]));
  const factsByScope = new Map();
  for (const row of facts || []) {
    const key = scopeKey(row);
    const rows = factsByScope.get(key) || [];
    rows.push(row);
    factsByScope.set(key, rows);
  }

  const reviewed = (runtime.inventoryReviewDispositions || []).filter(row => (
    row?.decision === "reviewed_quarantined"
    && row?.grain === "physical_warehouse"
  ));
  const candidates = [];
  const excluded = [];
  const alreadyApproved = [];

  const exclude = (disposition, reason, scope = {}) => excluded.push({
    reason,
    issueId:text(disposition?.issueId),
    pid:text(disposition?.pid),
    cid:text(disposition?.cid),
    wid:text(disposition?.wid),
    inventoryDate:dateKey(scope.inventoryDate || disposition?.inventoryDate),
    onHand:Number(scope.onHand ?? disposition?.onHand ?? 0),
  });

  for (const disposition of reviewed) {
    const key = scopeKey(disposition);
    const history = [...(factsByScope.get(key) || [])]
      .sort((left, right) => dateKey(left?.date).localeCompare(dateKey(right?.date)));
    if (!dispositionFactExists(history, disposition)) {
      exclude(disposition, "source-disposition-fact-missing");
      continue;
    }
    const evidence = inventoryCoverageEvidence(history);
    const scope = {
      grain:"physical_warehouse",
      pid:text(disposition.pid),
      cid:text(disposition.cid),
      wid:text(disposition.wid),
      inventoryDate:dateKey(evidence.latestInventoryDate),
      onHand:Number(evidence.onHand),
    };
    const matchingDisposition = matchingInventoryReviewDisposition(runtime.inventoryReviewDispositions || [], scope);
    if (matchingDisposition?.decision !== "reviewed_quarantined" || matchingDisposition?.issueId !== disposition?.issueId) {
      exclude(disposition, "accepted-review-no-longer-matches-current-fact", scope);
      continue;
    }
    const postDispositionHistory = history.filter(row => dateKey(row?.date) >= dateKey(disposition.inventoryDate));
    const postDispositionValidation = inventoryValidationEvidence(postDispositionHistory, {
      asOfDate:scope.inventoryDate,
      evaluationDate,
      lookbackDays:inclusiveDateSpan(disposition.inventoryDate, scope.inventoryDate),
    });
    if ((postDispositionValidation.reasonCodes || []).some(reason => (
      reason === "recent-large-inventory-addition"
      || reason === "recent-large-inventory-removal"
    ))) {
      exclude(disposition, "material-inventory-change-after-accepted-review", scope);
      continue;
    }
    if (!Number.isInteger(scope.onHand) || scope.onHand < 1) {
      exclude(disposition, "current-on-hand-below-one", scope);
      continue;
    }
    if (scope.onHand === 1 && Number(evidence.peakOnHand || 0) < 2) {
      exclude(disposition, "one-unit-fact-has-no-meaningful-prior-allocation", scope);
      continue;
    }
    if (!exactLatestInventoryFactsMatchApproval(history, scope)) {
      exclude(disposition, "latest-fact-conflict", scope);
      continue;
    }
    if (revokedScopeKeys instanceof Set && revokedScopeKeys.has(key)) {
      exclude(disposition, "newer-manual-revocation", scope);
      continue;
    }
    const existing = matchingInventoryApproval(activeApprovals, scope, evaluationDate);
    if (existing) {
      alreadyApproved.push({ ...scope, issueId:text(existing.issueId), pid:scope.pid });
      continue;
    }

    const warehouse = warehouseById.get(scope.wid);
    if (!warehouse || !canonicalWarehouseIsUnique(warehouse, warehouseRows, canonicalWarehouseDirectory)) {
      exclude(disposition, "warehouse-not-canonical-and-unique", scope);
      continue;
    }
    const product = metadataValue(runtime.productMeta, scope.pid);
    const campaign = metadataValue(runtime.campaignMeta, scope.cid);
    if (!product || !campaign || !inventoryApprovalCampaignCoversObservation(campaign, product, scope.inventoryDate)) {
      exclude(disposition, "campaign-does-not-cover-current-fact", scope);
      continue;
    }

    const factSha256 = text(fingerprint(scope, history, warehouse));
    if (!/^[0-9a-f]{64}$/.test(factSha256)) {
      exclude(disposition, "history-fingerprint-unavailable", scope);
      continue;
    }
    candidates.push({
      issueId:text(disposition.issueId),
      issueCode:text(disposition.issueCode) || "physical_inventory_review",
      pid:scope.pid,
      cid:scope.cid,
      wid:scope.wid,
      location:text(warehouse.name || warehouse.id),
      inventoryDate:scope.inventoryDate,
      onHand:scope.onHand,
      factSha256,
      sourceDispositionIssueId:text(disposition.issueId),
      sourceDispositionDate:dateKey(disposition.inventoryDate),
      sourceDispositionOnHand:Number(disposition.onHand),
    });
  }

  const manifestHash = ownerLegacyApprovalManifestHash({
    sourceVersion,
    sourcePublishedAt,
    authorizationReference,
    evaluationDate,
    candidates,
  });
  return {
    reviewedCount:reviewed.length,
    candidateCount:candidates.length,
    alreadyApprovedCount:alreadyApproved.length,
    excludedCount:excluded.length,
    candidates,
    alreadyApproved,
    excluded,
    manifestHash,
    candidateByProduct:summarize(candidates),
    excludedByReason:summarize(excluded, "reason"),
  };
}
