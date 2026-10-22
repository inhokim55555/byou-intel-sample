import {
  inventoryCampaignActiveAt,
  inventoryRowHasKnownBalance,
  matchingInventoryReviewDisposition,
} from "./dashboardScope.js";

export const MANUAL_INVENTORY_APPROVAL_DAYS = 14;

function text(value) {
  return String(value ?? "").trim();
}

function dateKey(value) {
  const date = text(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function integer(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : NaN;
}

function daysBetween(later, earlier) {
  const laterTime = Date.parse(`${dateKey(later)}T00:00:00Z`);
  const earlierTime = Date.parse(`${dateKey(earlier)}T00:00:00Z`);
  return Number.isFinite(laterTime) && Number.isFinite(earlierTime)
    ? Math.floor((laterTime - earlierTime) / 86_400_000)
    : NaN;
}

export function manualInventoryApprovalScopeKey(row = {}) {
  return ["physical_warehouse", row.pid, row.cid, row.wid]
    .map(value => text(value).toLowerCase())
    .join("|");
}

export function manualInventoryApprovalBusinessKey(row = {}) {
  return [manualInventoryApprovalScopeKey(row), dateKey(row.inventoryDate), integer(row.onHand)]
    .join("|");
}

export function exactLatestInventoryFactsMatchApproval(facts = [], scope = {}) {
  const relevant = (facts || []).filter(row => (
    text(row?.pid) === text(scope?.pid)
    && text(row?.cid) === text(scope?.cid)
    && text(row?.wid) === text(scope?.wid)
    && inventoryRowHasKnownBalance(row)
    && dateKey(row?.date)
  ));
  const latestDate = relevant.reduce((latest, row) => dateKey(row?.date) > latest ? dateKey(row?.date) : latest, "");
  const latestFacts = relevant.filter(row => dateKey(row?.date) === latestDate);
  return latestFacts.length > 0
    && latestDate === dateKey(scope?.inventoryDate)
    && latestFacts.every(row => Number(row?.inv) === Number(scope?.onHand));
}

export function upsertInventoryApproval(rows = [], approval = {}) {
  const key = manualInventoryApprovalBusinessKey(approval);
  if (!key || !approval?.issueId) return [...(rows || [])];
  return [
    ...(rows || []).filter(row => (
      row?.issueId !== approval.issueId
      && manualInventoryApprovalBusinessKey(row) !== key
    )),
    approval,
  ];
}

function metadataValue(map = {}, id = "") {
  if (map?.[id] && text(map[id]?.id) === text(id)) return map[id];
  return Object.values(map || {}).find(row => text(row?.id) === text(id)) || null;
}

export function inventoryApprovalCampaignCoversObservation(campaign = {}, product = {}, inventoryDate = "", grain = "physical_warehouse") {
  const hasExplicitHistoricalWindow = campaign?.active === false && dateKey(campaign?.start) && dateKey(campaign?.end);
  const campaignAtObservation = hasExplicitHistoricalWindow ? { ...campaign, active:true } : campaign;
  return inventoryCampaignActiveAt(campaignAtObservation, product, {
    asOfDate:dateKey(inventoryDate),
    grain,
  });
}

export function runtimeInventoryApprovalEligible(approval = {}, runtime = {}, today = "") {
  if (approval?.approved !== true || approval?.grain !== "physical_warehouse") return false;
  if (!approval?.pid || !approval?.cid || !approval?.wid || !dateKey(approval.inventoryDate)) return false;
  if (!Number.isFinite(Number(approval.onHand)) || Number(approval.onHand) < 0) return false;
  const evaluatedOn = dateKey(today);
  if (evaluatedOn && dateKey(approval.expiresOn) < evaluatedOn) return false;

  const product = metadataValue(runtime.productMeta, approval.pid);
  const campaign = metadataValue(runtime.campaignMeta, approval.cid);
  if (!product || !campaign || !inventoryApprovalCampaignCoversObservation(campaign, product, approval.inventoryDate)) return false;

  const disposition = matchingInventoryReviewDisposition(runtime.inventoryReviewDispositions || [], {
    grain:"physical_warehouse",
    pid:approval.pid,
    cid:approval.cid,
    wid:approval.wid,
    inventoryDate:approval.inventoryDate,
    onHand:approval.onHand,
  });
  return disposition?.decision !== "rejected";
}

export function mergeRuntimeInventoryApprovals(runtime = {}, overlay = [], today = "") {
  const merged = new Map();
  for (const approval of runtime.inventoryApprovals || []) {
    if (!approval?.issueId) continue;
    merged.set(manualInventoryApprovalBusinessKey(approval), approval);
  }
  for (const approval of overlay || []) {
    if (!runtimeInventoryApprovalEligible(approval, runtime, today)) continue;
    merged.set(manualInventoryApprovalBusinessKey(approval), approval);
  }
  return [...merged.values()].sort((left, right) => (
    text(left.pid).localeCompare(text(right.pid))
    || text(left.cid).localeCompare(text(right.cid))
    || text(left.wid).localeCompare(text(right.wid))
    || dateKey(left.inventoryDate).localeCompare(dateKey(right.inventoryDate))
  ));
}

export function normalizeManualInventoryApprovalRequest(body = {}, today = "") {
  const scope = body?.scope && typeof body.scope === "object" ? body.scope : {};
  const evidence = body?.evidence && typeof body.evidence === "object" ? body.evidence : {};
  const value = {
    idempotencyKey:text(body.idempotencyKey),
    sourcePublishedAt:text(body.sourcePublishedAt),
    confirmation:body.confirmation === true,
    approvalPassword:typeof body.approvalPassword === "string" ? body.approvalPassword : "",
    scope:{
      pid:text(scope.pid),
      cid:text(scope.cid),
      wid:text(scope.wid),
      inventoryDate:dateKey(scope.inventoryDate),
      onHand:integer(scope.onHand),
    },
    evidence:{
      receiptReference:text(evidence.receiptReference),
      receiptDate:dateKey(evidence.receiptDate),
      adjustmentReason:text(evidence.adjustmentReason),
      reviewer:text(evidence.reviewer),
    },
  };
  const errors = [];
  if (!/^[A-Za-z0-9._:-]{12,120}$/.test(value.idempotencyKey)) errors.push("A valid idempotency key is required.");
  if (!value.sourcePublishedAt || !Number.isFinite(Date.parse(value.sourcePublishedAt))) errors.push("The published dataset revision is missing.");
  if (!value.confirmation) errors.push("The exact on-hand confirmation is required.");
  if (!value.approvalPassword || value.approvalPassword.length > 256) errors.push("The approval password is required.");
  if (!value.scope.pid || !value.scope.cid || !value.scope.wid || !value.scope.inventoryDate) errors.push("The exact product, campaign, warehouse, and inventory date are required.");
  if (!Number.isInteger(value.scope.onHand) || value.scope.onHand < 2) errors.push("A positive current on-hand balance of at least 2 units is required.");
  if (!value.evidence.receiptReference || value.evidence.receiptReference.length > 200) errors.push("A receipt, transfer, or physical-count reference is required.");
  if (!value.evidence.receiptDate) errors.push("A receipt or physical-count date is required.");
  if (value.evidence.receiptDate && dateKey(today) && value.evidence.receiptDate > dateKey(today)) errors.push("The receipt or physical-count date cannot be in the future.");
  if (value.evidence.receiptDate && value.scope.inventoryDate && value.evidence.receiptDate < value.scope.inventoryDate) errors.push("The receipt or physical-count evidence must be dated on or after the source inventory fact.");
  if (value.evidence.receiptDate && dateKey(today) && daysBetween(today, value.evidence.receiptDate) > MANUAL_INVENTORY_APPROVAL_DAYS) errors.push("The receipt or physical-count evidence must be from the last 14 days.");
  if (!value.evidence.adjustmentReason || value.evidence.adjustmentReason.length > 1_000) errors.push("An adjustment reason is required.");
  if (value.evidence.reviewer.length < 2 || value.evidence.reviewer.length > 100) errors.push("A reviewer name is required.");
  return { ok:errors.length === 0, errors, value };
}

export function normalizeManualInventoryRevocationRequest(body = {}) {
  const scope = body?.scope && typeof body.scope === "object" ? body.scope : {};
  const value = {
    idempotencyKey:text(body.idempotencyKey),
    sourcePublishedAt:text(body.sourcePublishedAt),
    confirmation:body.confirmation === true,
    approvalPassword:typeof body.approvalPassword === "string" ? body.approvalPassword : "",
    reason:text(body.reason),
    reviewer:text(body.reviewer),
    scope:{
      pid:text(scope.pid),
      cid:text(scope.cid),
      wid:text(scope.wid),
      inventoryDate:dateKey(scope.inventoryDate),
      onHand:integer(scope.onHand),
    },
  };
  const errors = [];
  if (!/^[A-Za-z0-9._:-]{12,120}$/.test(value.idempotencyKey)) errors.push("A valid idempotency key is required.");
  if (!value.sourcePublishedAt || !Number.isFinite(Date.parse(value.sourcePublishedAt))) errors.push("The published dataset revision is missing.");
  if (!value.confirmation) errors.push("The removal confirmation is required.");
  if (!value.approvalPassword || value.approvalPassword.length > 256) errors.push("The approval password is required.");
  if (!value.scope.pid || !value.scope.cid || !value.scope.wid || !value.scope.inventoryDate) errors.push("The exact product, campaign, warehouse, and inventory date are required.");
  if (!Number.isInteger(value.scope.onHand) || value.scope.onHand < 1) errors.push("A positive current on-hand balance is required.");
  if (!value.reason || value.reason.length > 1_000) errors.push("A removal reason is required.");
  if (value.reviewer.length < 2 || value.reviewer.length > 100) errors.push("A reviewer name is required.");
  return { ok:errors.length === 0, errors, value };
}
