import { PNL_ACTUAL_LINE_TYPES, PNL_IMPORT_SCHEMA } from "./pnl.js";

const text = value => String(value ?? "").trim();
const money = value => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.abs(value);
  const cleaned = text(value).replace(/[$,()]/g, "").trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.abs(parsed) : null;
};
const bool = value => value === true || /^(true|yes|y|paid|1)$/i.test(text(value));

export function pnlDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) {
    const [month, day, year] = raw.split("/").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(date.valueOf()) || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ? "" : date.toISOString().slice(0, 10);
  }
  return "";
}

export async function sha256File(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function forecastRowsFromSheets(sheets = []) {
  const rows = [];
  const exclusions = [];
  for (const sheet of sheets) {
    if (/template|instruction|사용법/i.test(sheet.sheet)) {
      exclusions.push(`${sheet.sheet}: template/instructions`);
      continue;
    }
    const data = sheet.data || [];
    const forecastRevenue = money(data[12]?.[20]);
    const forecastCogs = money(data[15]?.[20]);
    if (forecastRevenue === null || forecastCogs === null) {
      exclusions.push(`${sheet.sheet}: no reconciled P&L block`);
      continue;
    }
    const expenseRows = data.slice(19, 26);
    const forecastOtherExpenses = expenseRows.reduce((sum, row) => sum + (money(row?.[20]) || 0), 0);
    const marketingRows = data.map((row, index) => ({ row, index })).filter(({ row }) => /mkt|marketing|influencer|instagram|facebook|tiktok/i.test(text(row?.[2])) && money(row?.[7]) !== null);
    const plannedMarketing = marketingRows.reduce((sum, entry) => {
      const row = entry.row;
      const label = text(row?.[2]);
      return /mkt|marketing|influencer|instagram|facebook|tiktok/i.test(label) ? sum + (money(row?.[7]) || 0) : sum;
    }, 0);
    const expenseType = label => /tpd|promo/i.test(label) ? "promotion" : /markdown/i.test(label) ? "markdown" : /endcap/i.test(label) ? "endcap" : /allowance|freight|spoils/i.test(label) ? "costco_allowance" : /packag/i.test(label) ? "packaging" : /return|e-blast/i.test(label) ? "returns" : /mkt|marketing/i.test(label) ? "costco_marketing" : "other_campaign_expense";
    const forecastLines = [
      { lineType:"forecast_revenue", label:"Forecast sell-in revenue", amount:forecastRevenue, sourceCell:"U13" },
      { lineType:"forecast_cogs", label:"Forecast COGS", amount:forecastCogs, sourceCell:"U16" },
      ...expenseRows.map((row, index) => ({ lineType:expenseType(`${text(row?.[18])} ${text(row?.[19])}`), label:text(row?.[18]) || `Campaign expense ${index + 1}`, amount:money(row?.[20]) || 0, sourceCell:`U${index + 20}` })),
      ...marketingRows.map(({ row, index }) => ({ lineType:"planned_marketing", label:text(row?.[2]), amount:money(row?.[7]) || 0, sourceCell:`H${index + 1}` })),
    ];
    const dates = data.flatMap(row => [pnlDate(row?.[2]), pnlDate(row?.[3])]).filter(Boolean).sort();
    rows.push({
      sourceSheet:sheet.sheet,
      sourceItem:text(data[1]?.[2]),
      productName:text(data[2]?.[2]) || sheet.sheet,
      campaignName:text(data[1]?.[18]).replace(/\s*[—-]\s*P&L.*$/i, "") || sheet.sheet,
      channel:/online/i.test(text(data[1]?.[18])) ? "Online" : "Inline",
      pid:"",
      cid:"",
      forecastRevenue,
      forecastCogs,
      forecastOtherExpenses,
      plannedMarketing,
      forecastUnits:money(data[5]?.[20]) || 0,
      coverageThrough:dates.at(-1) || "",
      forecastLines,
    });
  }
  return { rows, exclusions, warnings:[] };
}

function headerMap(header = []) {
  return new Map(header.map((value, index) => [text(value).toLowerCase().replace(/\s+/g, " "), index]).filter(([key]) => key));
}

function column(headers, ...names) {
  for (const name of names) if (headers.has(name)) return headers.get(name);
  return -1;
}

async function stablePaymentId(profile, sourceProduct, sourceSheet, occurrence) {
  if (!text(profile)) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${text(sourceSheet).toLowerCase()}|${text(profile).toLowerCase()}|${text(sourceProduct).toLowerCase()}|${occurrence}`));
  return `pay-${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 32)}`;
}

export async function paymentRowsFromSheets(sheets = [], _sourceSha256 = "") {
  const rows = [];
  const exclusions = [];
  const warnings = [];
  for (const sheet of sheets) {
    const data = sheet.data || [];
    const headerIndex = data.findIndex(row => row.some(value => /^(profile|f)$/i.test(text(value))) && row.some(value => /^rate$/i.test(text(value))));
    if (headerIndex < 0) {
      exclusions.push(`${sheet.sheet}: payment columns not found`);
      continue;
    }
    const headers = headerMap(data[headerIndex]);
    const profileCol = column(headers, "profile", "f");
    const rateCol = column(headers, "rate");
    const productCol = column(headers, "product");
    const paidCol = column(headers, "paid");
    const paidDateCol = column(headers, "paid date");
    const dueDateCol = column(headers, "due date", "due date (est.)", "date");
    const supportCol = column(headers, "brand 50% 지원");
    const expectedCol = column(headers, "expected reimbursement");
    const receivedCol = column(headers, "received reimbursement");
    const reimbursementDateCol = column(headers, "reimbursement date");
    const occurrenceByIdentity = new Map();
    const sourceRows = data.slice(headerIndex + 1);
    for (let offset = 0; offset < sourceRows.length; offset += 1) {
      const row = sourceRows[offset];
      const grossFee = money(row?.[rateCol]);
      const sourceProduct = text(row?.[productCol]);
      if (!sourceProduct || grossFee === null || grossFee === 0) continue;
      if (typeof row?.[rateCol] === "string" && /\b(?:cad|krw|eur|gbp)\b/i.test(row[rateCol])) {
        exclusions.push(`${sheet.sheet} row ${headerIndex + offset + 2}: non-USD rate`);
        continue;
      }
      const profile = text(row?.[profileCol]);
      const identityKey = `${profile.toLowerCase()}|${sourceProduct.toLowerCase()}`;
      const occurrence = (occurrenceByIdentity.get(identityKey) || 0) + 1;
      occurrenceByIdentity.set(identityKey, occurrence);
      const paymentId = await stablePaymentId(profile, sourceProduct, sheet.sheet, occurrence);
      const paid = bool(row?.[paidCol]);
      const paidDate = paidDateCol >= 0 ? pnlDate(row?.[paidDateCol]) : "";
      const brandSupportMarked = supportCol >= 0 && bool(row?.[supportCol]);
      if (paid && !paidDate) warnings.push(`${sheet.sheet} row ${headerIndex + offset + 2}: Paid Date required`);
      if (brandSupportMarked && expectedCol < 0) warnings.push(`${sheet.sheet} row ${headerIndex + offset + 2}: brand support marked; exact reimbursement required`);
      if (!paymentId) warnings.push(`${sheet.sheet} row ${headerIndex + offset + 2}: a stable payment fingerprint cannot be created without the source profile identifier`);
      rows.push({
        paymentId,
        sourceSheet:sheet.sheet,
        sourceRow:headerIndex + offset + 2,
        sourceProduct,
        profileFingerprint:text(row?.[profileCol]) ? "present" : "missing",
        brandSupportMarked,
        pid:"",
        cid:"",
        allocationPct:100,
        grossFee,
        paid,
        paidDate,
        committedDate:pnlDate(row?.[dueDateCol]),
        expectedReimbursement:expectedCol >= 0 ? money(row?.[expectedCol]) || 0 : 0,
        reimbursementReceived:receivedCol >= 0 ? money(row?.[receivedCol]) || 0 : 0,
        reimbursementDate:reimbursementDateCol >= 0 ? pnlDate(row?.[reimbursementDateCol]) : "",
      });
    }
  }
  return { rows, exclusions, warnings };
}

const ACTUAL_HEADERS = Object.freeze({
  externalId:["external id"], transactionDate:["transaction date"], pid:["product id", "pid"], cid:["campaign id", "cid"],
  channel:["channel"], lineType:["line type"], amount:["amount in usd", "amount"], units:["optional units", "units"],
  sourceReference:["source reference"], coverageThrough:["coverage-through date", "coverage through date"],
});

export function actualRowsFromSheets(sheets = []) {
  const rows = [];
  const exclusions = [];
  const warnings = [];
  for (const sheet of sheets) {
    const data = sheet.data || [];
    const headerIndex = data.findIndex(row => row.some(value => /^external id$/i.test(text(value))));
    if (headerIndex < 0) {
      exclusions.push(`${sheet.sheet}: finance template headers not found`);
      continue;
    }
    const headers = headerMap(data[headerIndex]);
    const positions = Object.fromEntries(Object.entries(ACTUAL_HEADERS).map(([key, aliases]) => [key, column(headers, ...aliases)]));
    const missingHeaders = Object.entries(positions).filter(([key, index]) => index < 0 && !["units", "sourceReference"].includes(key)).map(([key]) => key);
    if (missingHeaders.length) {
      exclusions.push(`${sheet.sheet}: missing ${missingHeaders.join(", ")}`);
      continue;
    }
    data.slice(headerIndex + 1).forEach(row => {
      if (!text(row?.[positions.externalId])) return;
      const lineType = text(row?.[positions.lineType]).toLowerCase().replace(/[ /-]+/g, "_");
      if (!PNL_ACTUAL_LINE_TYPES.includes(lineType)) warnings.push(`${text(row?.[positions.externalId])}: unsupported line type ${lineType}`);
      rows.push({
        externalId:text(row?.[positions.externalId]), transactionDate:pnlDate(row?.[positions.transactionDate]),
        pid:text(row?.[positions.pid]), cid:text(row?.[positions.cid]), channel:text(row?.[positions.channel]) || "Inline",
        lineType, amount:money(row?.[positions.amount]), units:positions.units >= 0 ? money(row?.[positions.units]) || 0 : 0,
        sourceReference:positions.sourceReference >= 0 ? text(row?.[positions.sourceReference]) : "",
        coverageThrough:pnlDate(row?.[positions.coverageThrough]),
      });
    });
  }
  return { rows, exclusions, warnings };
}

export function pnlImportEnvelope(kind, sourceSha256, sourceAsOf, rows) {
  const keep = kind === "payments"
    ? ["paymentId", "pid", "cid", "allocationPct", "grossFee", "paid", "paidDate", "expectedReimbursement", "reimbursementReceived", "reimbursementDate", "committedDate"]
    : kind === "forecast"
      ? ["pid", "cid", "channel", "productName", "campaignName", "forecastRevenue", "forecastCogs", "forecastOtherExpenses", "plannedMarketing", "forecastUnits", "coverageThrough", "forecastLines"]
      : ["externalId", "transactionDate", "coverageThrough", "pid", "cid", "channel", "lineType", "amount", "units", "sourceReference"];
  return {
    schema:PNL_IMPORT_SCHEMA, kind, sourceSha256, sourceAsOf,
    rows:rows.map(row => Object.fromEntries(keep.map(key => [key, row[key] ?? ""]))),
  };
}
