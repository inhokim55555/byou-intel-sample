export const PNL_IMPORT_SCHEMA = "byou-pnl-import-v1";
export const PNL_IMPORT_KINDS = Object.freeze(["forecast", "payments", "actuals"]);
export const PNL_ACTUAL_LINE_TYPES = Object.freeze([
  "confirmed_revenue",
  "cogs",
  "import_cost",
  "costco_allowance",
  "promotion",
  "markdown",
  "endcap",
  "packaging",
  "returns",
  "other_campaign_expense",
]);
export const PNL_OVERRIDE_FIELDS = Object.freeze([
  "forecastRevenue",
  "forecastCogs",
  "forecastOtherExpenses",
  "plannedMarketing",
]);
export const PNL_FORECAST_LINE_TYPES = Object.freeze([
  "forecast_revenue", "forecast_cogs", "import_cost", "promotion", "markdown", "endcap", "costco_allowance",
  "packaging", "returns", "costco_marketing", "planned_marketing", "other_campaign_expense",
]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA_PATTERN = /^[a-f0-9]{64}$/i;
const CHANNELS = new Set(["Inline", "Online"]);

const cleanText = value => String(value ?? "").trim();
const cleanDate = value => {
  const text = cleanText(value).slice(0, 10);
  if (!DATE_PATTERN.test(text)) return "";
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === text ? text : "";
};
const cleanAmount = value => {
  if (value === null || value === undefined || cleanText(value) === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};
const scopeKey = row => `${cleanText(row.pid)}|${cleanText(row.cid)}`;

function requireText(value, label, errors, rowNumber) {
  const text = cleanText(value);
  if (!text) errors.push(`Row ${rowNumber}: ${label} is required.`);
  return text;
}

function requireDate(value, label, errors, rowNumber, { optional = false } = {}) {
  const date = cleanDate(value);
  if (!date && (!optional || cleanText(value))) errors.push(`Row ${rowNumber}: ${label} must use YYYY-MM-DD.`);
  return date;
}

function requireAmount(value, label, errors, rowNumber, { optional = false } = {}) {
  if (optional && (value === "" || value === null || value === undefined)) return 0;
  const amount = cleanAmount(value);
  if (amount === null) errors.push(`Row ${rowNumber}: ${label} must be a nonnegative number.`);
  return amount ?? 0;
}

function normalizeForecastRow(row, index, errors) {
  const rowNumber = index + 1;
  const channel = cleanText(row.channel || "Inline");
  if (!CHANNELS.has(channel)) errors.push(`Row ${rowNumber}: channel must be Inline or Online.`);
  const forecastLines = Array.isArray(row.forecastLines) ? row.forecastLines.map((line, lineIndex) => {
    const lineType = cleanText(line?.lineType).toLowerCase();
    if (!PNL_FORECAST_LINE_TYPES.includes(lineType)) errors.push(`Row ${rowNumber}, forecast line ${lineIndex + 1}: unsupported line type.`);
    return { lineType, label:cleanText(line?.label).slice(0, 120), amount:requireAmount(line?.amount, `forecast line ${lineIndex + 1} amount`, errors, rowNumber), sourceCell:cleanText(line?.sourceCell).slice(0, 20) };
  }) : [];
  return {
    pid:requireText(row.pid, "product mapping", errors, rowNumber),
    cid:requireText(row.cid, "campaign mapping", errors, rowNumber),
    channel,
    productName:cleanText(row.productName),
    campaignName:cleanText(row.campaignName),
    forecastRevenue:requireAmount(row.forecastRevenue, "forecast revenue", errors, rowNumber),
    forecastCogs:requireAmount(row.forecastCogs, "forecast COGS", errors, rowNumber),
    forecastOtherExpenses:requireAmount(row.forecastOtherExpenses, "forecast campaign expenses", errors, rowNumber),
    plannedMarketing:requireAmount(row.plannedMarketing, "planned marketing", errors, rowNumber, { optional:true }),
    forecastUnits:requireAmount(row.forecastUnits, "forecast units", errors, rowNumber, { optional:true }),
    coverageThrough:requireDate(row.coverageThrough, "coverage-through date", errors, rowNumber, { optional:true }),
    forecastLines,
    currency:"USD",
  };
}

function normalizePaymentRow(row, index, errors) {
  const rowNumber = index + 1;
  const paid = row.paid === true;
  const paidDate = cleanDate(row.paidDate);
  if (cleanText(row.paidDate) && !paidDate) errors.push(`Row ${rowNumber}: Paid Date must use YYYY-MM-DD.`);
  const reimbursementReceived = requireAmount(row.reimbursementReceived, "received reimbursement", errors, rowNumber, { optional:true });
  const reimbursementDate = requireDate(row.reimbursementDate, "reimbursement date", errors, rowNumber, { optional:reimbursementReceived === 0 });
  const allocationPct = Number(row.allocationPct);
  if (!Number.isFinite(allocationPct) || allocationPct <= 0 || allocationPct > 100) {
    errors.push(`Row ${rowNumber}: allocation must be greater than 0% and no more than 100%.`);
  }
  return {
    paymentId:requireText(row.paymentId, "payment ID", errors, rowNumber),
    pid:requireText(row.pid, "product mapping", errors, rowNumber),
    cid:requireText(row.cid, "campaign mapping", errors, rowNumber),
    allocationPct:Number.isFinite(allocationPct) ? allocationPct : 0,
    grossFee:requireAmount(row.grossFee, "gross creator fee", errors, rowNumber),
    paid,
    paidDate,
    expectedReimbursement:requireAmount(row.expectedReimbursement, "expected reimbursement", errors, rowNumber, { optional:true }),
    reimbursementReceived,
    reimbursementDate,
    committedDate:requireDate(row.committedDate, "commitment date", errors, rowNumber, { optional:true }),
    currency:"USD",
  };
}

function normalizeActualRow(row, index, errors) {
  const rowNumber = index + 1;
  const lineType = cleanText(row.lineType).toLowerCase();
  if (!PNL_ACTUAL_LINE_TYPES.includes(lineType)) errors.push(`Row ${rowNumber}: unsupported finance line type.`);
  return {
    externalId:requireText(row.externalId, "external ID", errors, rowNumber),
    transactionDate:requireDate(row.transactionDate, "transaction date", errors, rowNumber),
    coverageThrough:requireDate(row.coverageThrough, "coverage-through date", errors, rowNumber),
    pid:requireText(row.pid, "product mapping", errors, rowNumber),
    cid:requireText(row.cid, "campaign mapping", errors, rowNumber),
    channel:CHANNELS.has(cleanText(row.channel)) ? cleanText(row.channel) : "Inline",
    lineType,
    amount:requireAmount(row.amount, "amount", errors, rowNumber),
    units:requireAmount(row.units, "units", errors, rowNumber, { optional:true }),
    sourceReference:cleanText(row.sourceReference).slice(0, 200),
    currency:"USD",
  };
}

export function validatePnlImportEnvelope(input = {}) {
  const errors = [];
  const warnings = [];
  const schema = cleanText(input.schema);
  const kind = cleanText(input.kind).toLowerCase();
  const sourceSha256 = cleanText(input.sourceSha256).toLowerCase();
  const sourceAsOf = cleanDate(input.sourceAsOf);
  if (schema !== PNL_IMPORT_SCHEMA) errors.push(`schema must be ${PNL_IMPORT_SCHEMA}.`);
  if (!PNL_IMPORT_KINDS.includes(kind)) errors.push("kind must be forecast, payments, or actuals.");
  if (!SHA_PATTERN.test(sourceSha256)) errors.push("sourceSha256 must be a 64-character SHA-256 digest.");
  if (!sourceAsOf) errors.push("sourceAsOf must use YYYY-MM-DD.");
  if (!Array.isArray(input.rows) || !input.rows.length) errors.push("At least one normalized row is required.");
  if (Array.isArray(input.rows) && input.rows.length > 5000) errors.push("One import cannot exceed 5,000 rows.");

  const normalizer = kind === "forecast" ? normalizeForecastRow : kind === "payments" ? normalizePaymentRow : normalizeActualRow;
  const rows = Array.isArray(input.rows) && normalizer
    ? input.rows.map((row, index) => normalizer(row || {}, index, errors))
    : [];

  if (kind === "forecast") {
    const duplicates = new Set();
    for (const row of rows) {
      const key = scopeKey(row);
      if (duplicates.has(key)) errors.push(`Forecast contains more than one row for ${key}.`);
      duplicates.add(key);
    }
  }
  if (kind === "payments") {
    const allocationByPayment = new Map();
    for (const row of rows) {
      allocationByPayment.set(row.paymentId, (allocationByPayment.get(row.paymentId) || 0) + row.allocationPct);
      if (row.paid && !row.paidDate) warnings.push(`Payment ${row.paymentId} is marked Paid but has no Paid Date; it remains incomplete and is excluded from dated contribution.`);
    }
    for (const [paymentId, total] of allocationByPayment) {
      if (Math.abs(total - 100) > 0.001) errors.push(`Payment ${paymentId} allocations must total exactly 100%; received ${total}%.`);
    }
  }
  if (kind === "actuals") {
    const fingerprints = new Map();
    for (const row of rows) {
      const prior = fingerprints.get(row.externalId);
      const value = JSON.stringify(row);
      if (prior && prior !== value) errors.push(`External ID ${row.externalId} has conflicting rows.`);
      else if (prior) warnings.push(`External ID ${row.externalId} is duplicated identically and will be counted once.`);
      fingerprints.set(row.externalId, value);
    }
  }

  return {
    valid:errors.length === 0,
    errors,
    warnings,
    normalized:{ schema:PNL_IMPORT_SCHEMA, kind, sourceSha256, sourceAsOf, rows },
    summary:{ rowCount:rows.length, campaignCount:new Set(rows.map(scopeKey).filter(key => !key.startsWith("|"))).size },
  };
}

export function validatePnlOverride(input = {}) {
  const errors = [];
  const action = cleanText(input.action || "set").toLowerCase();
  if (!['set', 'reverse'].includes(action)) errors.push("Override action must be set or reverse.");
  const normalized = {
    action,
    eventId:cleanText(input.eventId),
    targetEventId:cleanText(input.targetEventId),
    pid:cleanText(input.pid),
    cid:cleanText(input.cid),
    field:cleanText(input.field),
    value:cleanAmount(input.value),
    effectiveDate:cleanDate(input.effectiveDate),
    reason:cleanText(input.reason).slice(0, 500),
  };
  if (action === "set") {
    if (!normalized.eventId || !normalized.pid || !normalized.cid) errors.push("A new override requires event, product, and campaign IDs.");
    if (!PNL_OVERRIDE_FIELDS.includes(normalized.field)) errors.push("This forecast field cannot be overridden.");
    if (normalized.value === null) errors.push("Override value must be a nonnegative number.");
    if (!normalized.effectiveDate) errors.push("Override effective date is required.");
    if (normalized.reason.length < 3) errors.push("Override reason must be at least three characters.");
  } else if (!normalized.eventId || !normalized.targetEventId || normalized.reason.length < 3) {
    errors.push("A reversal requires event ID, target event ID, and reason.");
  }
  return { valid:errors.length === 0, errors, normalized };
}

function latestRowsByKey(rows, keyFn) {
  const byKey = new Map();
  for (const row of rows || []) byKey.set(keyFn(row), row);
  return [...byKey.values()];
}

function activeOverrideMap(overrides = [], asOf = "9999-12-31") {
  const reversed = new Set(overrides.filter(row => row.action === "reverse" && (!cleanDate(row.effectiveDate) || cleanDate(row.effectiveDate) <= asOf)).map(row => row.targetEventId));
  const map = new Map();
  for (const row of overrides) {
    if (row.action !== "set" || reversed.has(row.eventId) || cleanDate(row.effectiveDate) > asOf) continue;
    map.set(`${row.pid}|${row.cid}|${row.field}`, row.value);
  }
  return map;
}

const sum = values => values.reduce((total, value) => total + (Number(value) || 0), 0);
const margin = (contribution, revenue) => revenue > 0 ? contribution / revenue : null;

export function buildPnlView({ forecasts = [], payments = [], actuals = [], overrides = [], asOf = "", permissions = {}, sources = {} } = {}) {
  const resolvedAsOf = cleanDate(asOf) || new Date().toISOString().slice(0, 10);
  const forecastRows = latestRowsByKey(forecasts, scopeKey);
  const actualRows = latestRowsByKey(actuals, row => row.externalId);
  const paymentRows = latestRowsByKey(payments, row => `${row.paymentId}|${scopeKey(row)}`);
  const overrideMap = activeOverrideMap(overrides, resolvedAsOf);
  const scopes = new Map();
  const touch = row => {
    const key = scopeKey(row);
    if (key !== "|") scopes.set(key, { pid:row.pid, cid:row.cid, productName:row.productName || scopes.get(key)?.productName || "", campaignName:row.campaignName || scopes.get(key)?.campaignName || "", channel:row.channel || "Inline" });
  };
  [...forecastRows, ...actualRows, ...paymentRows].forEach(touch);

  const campaigns = [...scopes.values()].map(scope => {
    const key = scopeKey(scope);
    const forecast = forecastRows.find(row => scopeKey(row) === key);
    const scopedPayments = paymentRows.filter(row => scopeKey(row) === key);
    const scopedActuals = actualRows.filter(row => scopeKey(row) === key && row.transactionDate <= resolvedAsOf);
    const value = field => overrideMap.has(`${key}|${field}`) ? Number(overrideMap.get(`${key}|${field}`)) : Number(forecast?.[field] || 0);

    const actualRevenue = sum(scopedActuals.filter(row => row.lineType === "confirmed_revenue").map(row => row.amount));
    const actualExpenses = sum(scopedActuals.filter(row => row.lineType !== "confirmed_revenue").map(row => row.amount));
    const actualPaidMarketing = sum(scopedPayments.filter(row => row.paid && row.paidDate && row.paidDate <= resolvedAsOf).map(row => row.grossFee * row.allocationPct / 100));
    const receivedReimbursement = sum(scopedPayments.filter(row => row.reimbursementDate && row.reimbursementDate <= resolvedAsOf).map(row => row.reimbursementReceived * row.allocationPct / 100));
    const committedMarketing = sum(scopedPayments.map(row => row.grossFee * row.allocationPct / 100));
    const expectedReimbursement = sum(scopedPayments.map(row => row.expectedReimbursement * row.allocationPct / 100));
    const forecastRevenue = value("forecastRevenue");
    const forecastCogs = value("forecastCogs");
    const forecastOtherExpenses = value("forecastOtherExpenses");
    const plannedMarketing = value("plannedMarketing");
    const forecastMarketing = Math.max(plannedMarketing, committedMarketing);
    const actualContribution = actualRevenue + receivedReimbursement - actualExpenses - actualPaidMarketing;
    const forecastContribution = forecastRevenue - forecastCogs - forecastOtherExpenses - forecastMarketing + expectedReimbursement;
    const hasRevenue = scopedActuals.some(row => row.lineType === "confirmed_revenue");
    const hasCogs = scopedActuals.some(row => row.lineType === "cogs");
    const invalidPayments = scopedPayments.some(row => row.paid && !row.paidDate);
    const revenueCoverageThrough = scopedActuals.filter(row => row.lineType === "confirmed_revenue").map(row => row.coverageThrough).filter(Boolean).sort().at(-1) || "";
    const cogsCoverageThrough = scopedActuals.filter(row => row.lineType === "cogs").map(row => row.coverageThrough).filter(Boolean).sort().at(-1) || "";
    const actualCoverageThrough = [revenueCoverageThrough, cogsCoverageThrough].filter(Boolean).sort().at(0) || "";
    const actualCoverageComplete = !!actualCoverageThrough && actualCoverageThrough >= resolvedAsOf;
    const forecastComplete = !!forecast && forecastRevenue > 0 && !!forecast.coverageThrough;
    const actualComplete = hasRevenue && hasCogs && !invalidPayments && actualCoverageComplete;
    const missing = [];
    if (!forecast || forecastRevenue <= 0) missing.push("Complete campaign forecast");
    else if (!forecast.coverageThrough) missing.push("Forecast coverage-through date");
    if (!hasRevenue) missing.push("Confirmed Costco revenue");
    if (!hasCogs) missing.push("Confirmed COGS");
    if (invalidPayments) missing.push("Paid Date for creator payment");
    if (hasRevenue && hasCogs && !actualCoverageComplete) missing.push("Finance actuals coverage through selected date");
    const complete = forecastComplete && actualComplete;
    const status = !complete ? "unknown" : forecastContribution <= 0 ? "forecast_loss" : actualContribution > 0 ? "profitable" : "on_track";
    return {
      ...scope,
      asOf:resolvedAsOf,
      status,
      complete,
      forecastComplete,
      actualComplete,
      missing,
      actual:{ revenue:actualRevenue, expenses:actualExpenses, paidMarketing:actualPaidMarketing, reimbursement:receivedReimbursement, contribution:actualContribution, margin:margin(actualContribution, actualRevenue), coverageThrough:actualCoverageThrough },
      forecast:{ revenue:forecastRevenue, cogs:forecastCogs, otherExpenses:forecastOtherExpenses, plannedMarketing, committedMarketing, marketing:forecastMarketing, reimbursement:expectedReimbursement, contribution:forecastContribution, margin:margin(forecastContribution, forecastRevenue), coverageThrough:forecast?.coverageThrough || "" },
      reconciliation:{
        plannedMarketing,
        committedMarketing,
        forecastMarketing,
        uncommittedBudget:Math.max(0, plannedMarketing - committedMarketing),
        overBudgetCommitment:Math.max(0, committedMarketing - plannedMarketing),
        unpaidCommitments:Math.max(0, committedMarketing - actualPaidMarketing),
        unreimbursed:Math.max(0, expectedReimbursement - receivedReimbursement),
      },
      lineItems:{
        forecast:(forecast?.forecastLines || []).map(row => ({ lineType:row.lineType, label:row.label, amount:row.amount, sourceCell:row.sourceCell })),
        actual:scopedActuals.map(row => ({ externalId:row.externalId, transactionDate:row.transactionDate, coverageThrough:row.coverageThrough, lineType:row.lineType, amount:row.amount, units:row.units || 0, sourceReference:row.sourceReference || "" })),
        marketing:scopedPayments.map(row => ({ paymentId:row.paymentId, allocationPct:row.allocationPct, grossFee:row.grossFee, paid:row.paid, paidDate:row.paidDate || "", committedDate:row.committedDate || "", expectedReimbursement:row.expectedReimbursement, reimbursementReceived:row.reimbursementReceived, reimbursementDate:row.reimbursementDate || "" })),
      },
      freshness:{ actual:actualCoverageThrough, forecast:forecast?.coverageThrough || "" },
    };
  }).sort((a, b) => `${a.productName}|${a.campaignName}|${a.cid}`.localeCompare(`${b.productName}|${b.campaignName}|${b.cid}`));

  const completeCampaigns = campaigns.filter(row => row.complete);
  const actualCompleteCampaigns = campaigns.filter(row => row.actualComplete);
  const forecastCompleteCampaigns = campaigns.filter(row => row.forecastComplete);
  const statusCounts = Object.fromEntries(["profitable", "on_track", "forecast_loss", "unknown"].map(status => [status, campaigns.filter(row => row.status === status).length]));
  return {
    schema:"byou-pnl-view-v1",
    asOf:resolvedAsOf,
    permissions:{ canView:permissions.canView !== false, canEdit:!!permissions.canEdit, email:cleanText(permissions.email) },
    portfolio:{
      campaignCount:campaigns.length,
      completeCampaignCount:completeCampaigns.length,
      actualCampaignCount:actualCompleteCampaigns.length,
      forecastCampaignCount:forecastCompleteCampaigns.length,
      statusCounts,
      actualRevenue:sum(actualCompleteCampaigns.map(row => row.actual.revenue)),
      actualContribution:sum(actualCompleteCampaigns.map(row => row.actual.contribution)),
      forecastRevenue:sum(forecastCompleteCampaigns.map(row => row.forecast.revenue)),
      forecastContribution:sum(forecastCompleteCampaigns.map(row => row.forecast.contribution)),
      actualMargin:margin(sum(actualCompleteCampaigns.map(row => row.actual.contribution)), sum(actualCompleteCampaigns.map(row => row.actual.revenue))),
      forecastMargin:margin(sum(forecastCompleteCampaigns.map(row => row.forecast.contribution)), sum(forecastCompleteCampaigns.map(row => row.forecast.revenue))),
      paidMarketing:sum(campaigns.map(row => row.actual.paidMarketing)),
      committedMarketing:sum(campaigns.map(row => row.forecast.committedMarketing)),
      unpaidCommitments:sum(campaigns.map(row => row.reconciliation.unpaidCommitments)),
      unreimbursed:sum(campaigns.map(row => Math.max(0, row.forecast.reimbursement - row.actual.reimbursement))),
    },
    campaigns,
    sources,
  };
}
