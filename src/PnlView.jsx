import React, { useCallback, useEffect, useMemo, useState } from "react";
import writeExcelFile from "write-excel-file/browser";
import { pnlBearerHeaders, pnlSupabaseConfigured, pnlSupabaseSession, pnlSupabaseSignIn, pnlSupabaseSignOut, onPnlAuthStateChange } from "./lib/supabaseClient.js";
import { actualRowsFromSheets, forecastRowsFromSheets, paymentRowsFromSheets, pnlImportEnvelope, sha256File } from "./lib/pnlWorkbook.js";
import { notifySessionExpired } from "./lib/runtimeRequest.js";

const C = {
  bg:"#F5F6F8", card:"#FFFFFF", text:"#111827", muted:"#697386", border:"#D9DEE7",
  accent:"#111827", accentFade:"rgba(17,24,39,0.06)", blue:"#4F6F8F", green:"#3F8E5F",
  red:"#C94747", amber:"#B7791F", subtle:"#EEF0F3", hover:"#F1F3F5", line:"#E9EDF2",
  shadow:"0 1px 2px rgba(15, 23, 42, 0.05)",
};
const HELVETICA_NEUE_STACK = "'Helvetica Neue BYOU','Helvetica Neue',Helvetica,'Segoe UI',Arial,sans-serif";
const SANS = { fontFamily:HELVETICA_NEUE_STACK };
const MONO = { fontFamily:HELVETICA_NEUE_STACK, fontVariantNumeric:"tabular-nums" };
const inputStyle = { width:"100%", boxSizing:"border-box", border:`1px solid ${C.border}`, borderRadius:5, background:C.card, padding:"7px 8px", color:C.text, fontSize:11, fontWeight:400, outline:"none", ...SANS };
const buttonStyle = { border:`1px solid ${C.border}`, borderRadius:5, background:C.card, color:C.text, padding:"6px 10px", fontSize:11, fontWeight:500, cursor:"pointer", ...SANS };
const today = () => new Date().toISOString().slice(0, 10);
const money = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? new Intl.NumberFormat("en-US", { style:"currency", currency:"USD", maximumFractionDigits:0 }).format(Number(value)) : "—";
const percent = value => value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
const statusMeta = {
  profitable:{ icon:"✓", en:"Profitable", ko:"수익 실현", color:C.green, bg:"rgba(63,142,95,0.08)" },
  on_track:{ icon:"↗", en:"On Track", ko:"정상 진행", color:C.blue, bg:"rgba(79,111,143,0.08)" },
  forecast_loss:{ icon:"!", en:"Forecast Loss", ko:"예상 손실", color:C.red, bg:"rgba(201,71,71,0.08)" },
  unknown:{ icon:"?", en:"Unknown", ko:"확인 불가", color:C.amber, bg:"rgba(183,121,31,0.08)" },
};
const copy = {
  eyebrow:["Campaign finance", "캠페인 재무"],
  title:["Campaign P&L", "캠페인 손익"], subtitle:["Confirmed contribution, full-campaign forecast, and the evidence behind each status.", "확정 기여이익, 캠페인 전체 예측, 상태 판단 근거를 한곳에서 확인합니다."],
  actual:["Confirmed contribution", "확정 기여이익"], forecast:["Forecast contribution", "예상 기여이익"], actualMargin:["Current margin", "현재 마진"], forecastMargin:["Forecast margin", "예상 마진"],
  paidMarketing:["Paid marketing", "지급 마케팅"], unpaid:["Unpaid commitments", "미지급 약정"], unreimbursed:["Unreimbursed", "미수 지원금"],
  campaign:["Campaign", "캠페인"], product:["Product", "제품"], through:["Data through", "데이터 기준일"], status:["Status", "상태"], marketing:["Marketing", "마케팅"],
  missing:["Missing information", "누락 정보"], bridge:["Contribution bridge", "기여이익 브리지"], lineItems:["Financial line items", "재무 항목"], reconciliation:["Marketing reconciliation", "마케팅 조정"], freshness:["Source freshness", "소스 최신성"],
  admin:["Financial data administration", "재무 데이터 관리"], import:["Workbook import", "워크북 가져오기"], override:["Forecast override", "예측값 수정"], audit:["Audit history", "감사 기록"],
};
const tr = (key, lang) => copy[key]?.[lang === "ko" ? 1 : 0] || key;

function Card({ label, value, sub, color = C.text }) {
  return <div className="pnl-kpi-card" style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:5, padding:"11px 12px", minWidth:0, boxShadow:C.shadow }}>
    <div style={{ fontSize:10, color:C.muted, textTransform:"uppercase", letterSpacing:.8, fontWeight:500, ...MONO }}>{label}</div>
    <div style={{ fontSize:17, fontWeight:500, color, marginTop:5, ...MONO }}>{value}</div>
    {sub && <div style={{ fontSize:10, color:C.muted, marginTop:3, ...SANS }}>{sub}</div>}
  </div>;
}

function Badge({ status, lang }) {
  const meta = statusMeta[status] || statusMeta.unknown;
  const label = lang === "ko" ? meta.ko : meta.en;
  return <span aria-label={label} style={{ display:"inline-flex", alignItems:"center", gap:5, padding:"3px 7px", border:`1px solid ${meta.color}44`, borderRadius:5, color:meta.color, background:meta.bg, fontSize:10, fontWeight:500, whiteSpace:"nowrap", ...MONO }}><span aria-hidden="true">{meta.icon}</span>{label}</span>;
}

function Section({ title, action, children }) {
  return <section className="pnl-section" style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:6, padding:16, boxShadow:C.shadow }}>
    <div className="pnl-section-heading" style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:12, marginBottom:12 }}><h3 style={{ margin:0, color:C.text, fontSize:12, fontWeight:500, ...SANS }}>{title}</h3>{action}</div>
    {children}
  </section>;
}

function readPnlWorkbook(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./workers/readPnlWorkbook.worker.js", import.meta.url), { type:"module" });
    const finish = (callback, value) => { worker.terminate(); callback(value); };
    worker.onmessage = event => event.data?.ok ? finish(resolve, event.data.sheets) : finish(reject, new Error(event.data?.error || "Could not read workbook."));
    worker.onerror = event => finish(reject, new Error(event.message || "Workbook reader failed."));
    worker.postMessage({ file });
  });
}

async function apiRequest(path, options = {}) {
  const auth = await pnlBearerHeaders();
  const response = await fetch(path, { credentials:"same-origin", cache:"no-store", ...options, headers:{ ...(options.body ? { "Content-Type":"application/json" } : {}), ...auth, ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (notifySessionExpired(response)) throw Object.assign(new Error("Your login session expired. Sign in again to continue."), { payload, status:response.status });
  if (!response.ok) throw Object.assign(new Error(payload.error || `Request failed (${response.status}).`), { payload, status:response.status });
  return payload;
}

function normalizedProducts(options = []) {
  return [...new Map(options.filter(row => row?.id).map(row => [row.id, row])).values()].sort((a, b) => String(a.short || a.name || a.id).localeCompare(String(b.short || b.name || b.id)));
}

function normalizedCampaigns(options = []) {
  return [...new Map(options.filter(row => row?.id).map(row => [row.id, row])).values()].sort((a, b) => String(a.short || a.name || a.id).localeCompare(String(b.short || b.name || b.id)));
}

function ImportAdmin({ lang, products, campaigns, onCommitted }) {
  const [kind, setKind] = useState("forecast");
  const [sourceAsOf, setSourceAsOf] = useState(today());
  const [fileState, setFileState] = useState(null);
  const [rows, setRows] = useState([]);
  const [receipt, setReceipt] = useState(null);
  const [confirmedPayload, setConfirmedPayload] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const campaignChoices = pid => campaigns.filter(campaign => !pid || campaign.pid === pid);
  const updateRow = (index, patch) => { setRows(previous => previous.map((row, i) => i === index ? { ...row, ...patch } : row)); setConfirmedPayload(null); };
  const includeRows = rows.filter(row => row.included !== false);

  const chooseFile = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true); setError(""); setReceipt(null); setConfirmedPayload(null);
    try {
      if (!/\.xlsx$/i.test(file.name) || file.size > 40 * 1024 * 1024) throw new Error("Use an .xlsx workbook no larger than 40 MB.");
      const sourceSha256 = await sha256File(file);
      const sheets = await readPnlWorkbook(file);
      const parsed = kind === "forecast" ? forecastRowsFromSheets(sheets) : kind === "payments" ? await paymentRowsFromSheets(sheets, sourceSha256) : actualRowsFromSheets(sheets);
      setRows(parsed.rows.map(row => ({ ...row, included:true })));
      setFileState({ name:file.name, sourceSha256, exclusions:parsed.exclusions, warnings:parsed.warnings });
    } catch (problem) { setError(problem.message); setRows([]); setFileState(null); }
    finally { setBusy(false); event.target.value = ""; }
  };

  const envelope = () => pnlImportEnvelope(kind, fileState.sourceSha256, sourceAsOf, includeRows);
  const preview = async () => {
    setBusy(true); setError("");
    try {
      const payload = envelope();
      const result = await apiRequest("/api/pnl/imports?dryRun=true", { method:"POST", body:JSON.stringify(payload) });
      setReceipt(result); setConfirmedPayload(JSON.stringify({ ...result.normalized, previewReceipt:result.previewReceipt }));
    } catch (problem) { setReceipt(problem.payload || null); setConfirmedPayload(null); setError(problem.message); }
    finally { setBusy(false); }
  };
  const commit = async () => {
    if (!confirmedPayload) return;
    setBusy(true); setError("");
    try { await apiRequest("/api/pnl/imports?dryRun=false", { method:"POST", body:confirmedPayload }); setReceipt(null); setRows([]); setFileState(null); setConfirmedPayload(null); await onCommitted(); }
    catch (problem) { setError(problem.message); }
    finally { setBusy(false); }
  };
  const split = index => {
    setRows(previous => {
      const row = previous[index];
      const next = previous.map((item, i) => i === index ? { ...item, allocationPct:50 } : item);
      next.splice(index + 1, 0, { ...row, allocationPct:50, cid:"" });
      return next;
    });
    setConfirmedPayload(null);
  };

  return <Section title={tr("import", lang)} action={<button style={buttonStyle} onClick={async () => {
    const headers = ["External ID","Transaction Date","Product ID","Campaign ID","Channel","Line Type","Amount in USD","Optional Units","Source Reference","Coverage-Through Date"];
    const example = ["FIN-2026-0001","2026-08-28","P009","campaign-id","Inline","confirmed_revenue",0,0,"ERP batch/reference","2026-08-28"];
    const readme = [["Rule","Detail"],["Currency","USD only. Do not convert KRW without a dated exchange-rate source."],["External ID","Required and stable. Duplicate conflicting IDs are rejected."],["Line Type","confirmed_revenue, cogs, import_cost, costco_allowance, promotion, markdown, endcap, packaging, returns, other_campaign_expense"],["Coverage","Every row requires a coverage-through date."]];
    await writeExcelFile([{ sheet:"Finance_Actuals", data:[headers, example], stickyRowsCount:1 }, { sheet:"README", data:readme, stickyRowsCount:1 }]).toFile("BYOU_PnL_Finance_Actuals_Template.xlsx");
  }}>{lang === "ko" ? "실적 템플릿" : "Actuals template"}</button>}>
    <div className="pnl-import-controls" style={{ display:"grid", gridTemplateColumns:"150px 170px minmax(220px,1fr)", gap:8 }}>
      <select value={kind} onChange={event => { setKind(event.target.value); setRows([]); setFileState(null); setReceipt(null); setConfirmedPayload(null); }} style={inputStyle}><option value="forecast">Campaign forecast</option><option value="payments">Creator payments</option><option value="actuals">Finance actuals</option></select>
      <input type="date" value={sourceAsOf} onChange={event => { setSourceAsOf(event.target.value); setConfirmedPayload(null); }} style={inputStyle}/>
      <input type="file" accept=".xlsx" onChange={chooseFile} style={inputStyle}/>
    </div>
    {busy && <div role="status" style={{ marginTop:10, fontSize:11, color:C.blue }}>Processing…</div>}
    {error && <div role="alert" style={{ marginTop:10, color:C.red, fontSize:11 }}>{error}</div>}
    {fileState && <div style={{ marginTop:10, padding:10, background:C.bg, borderRadius:5, color:C.muted, fontSize:10, lineHeight:1.6 }}>{fileState.name} · {rows.length.toLocaleString()} normalized rows · SHA-256 {fileState.sourceSha256.slice(0, 12)}…<br/>{[...fileState.warnings, ...fileState.exclusions].slice(0, 12).map((item, i) => <div key={i}>• {item}</div>)}</div>}
    {!!rows.length && <div style={{ overflowX:"auto", marginTop:12, maxHeight:420, overflowY:"auto", border:`1px solid ${C.border}`, borderRadius:5 }}>
      <table style={{ width:"100%", borderCollapse:"collapse", minWidth:kind === "payments" ? 1050 : 850, fontSize:10, ...SANS }}><thead style={{ position:"sticky", top:0, background:C.subtle, zIndex:1 }}><tr>{["Use","Source","Product mapping","Campaign mapping", kind === "payments" ? "Allocation / payment" : "Amount", kind === "payments" ? "Paid / reimbursement" : "Coverage"].map(label => <th key={label} style={{ padding:8, textAlign:"left", color:C.muted }}>{label}</th>)}</tr></thead><tbody>
        {rows.map((row, index) => <tr key={`${row.paymentId || row.externalId || row.sourceSheet}-${index}`} style={{ borderTop:`1px solid ${C.border}`, opacity:row.included === false ? .45 : 1 }}>
          <td style={{ padding:7 }}><input type="checkbox" checked={row.included !== false} onChange={event => updateRow(index, { included:event.target.checked })}/></td>
          <td style={{ padding:7, maxWidth:190 }}><div>{row.sourceSheet || row.externalId}</div><div style={{ color:C.muted }}>{row.sourceProduct || row.productName || row.lineType}</div></td>
          <td style={{ padding:7 }}><select value={row.pid || ""} onChange={event => updateRow(index, { pid:event.target.value, cid:"" })} style={inputStyle}><option value="">Select explicitly…</option>{products.map(product => <option key={product.id} value={product.id}>{product.short || product.name || product.id}</option>)}</select></td>
          <td style={{ padding:7 }}><select value={row.cid || ""} onChange={event => updateRow(index, { cid:event.target.value })} style={inputStyle}><option value="">Select explicitly…</option>{campaignChoices(row.pid).map(campaign => <option key={campaign.id} value={campaign.id}>{campaign.short || campaign.name || campaign.id}</option>)}</select></td>
          <td style={{ padding:7 }}>{kind === "payments" ? <div style={{ display:"grid", gridTemplateColumns:"70px 1fr", gap:5 }}><input type="number" min="0.001" max="100" step="0.001" value={row.allocationPct} onChange={event => updateRow(index, { allocationPct:event.target.value })} style={inputStyle}/><span>{money(row.grossFee)}</span>{rows.filter(item => item.paymentId === row.paymentId).length === 1 && <button onClick={() => split(index)} style={{ ...buttonStyle, gridColumn:"1 / -1", padding:4 }}>Split shared payment</button>}</div> : <div>{money(row.forecastRevenue ?? row.amount)}</div>}</td>
          <td style={{ padding:7 }}>{kind === "payments" ? <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:5 }}><span>{row.paid ? "Paid" : "Committed"}</span><input type="date" value={row.paidDate || ""} disabled={!row.paid} onChange={event => updateRow(index, { paidDate:event.target.value })} style={inputStyle}/><input type="number" min="0" placeholder="Expected reimb." value={row.expectedReimbursement} onChange={event => updateRow(index, { expectedReimbursement:event.target.value })} style={inputStyle}/><input type="number" min="0" placeholder="Received reimb." value={row.reimbursementReceived} onChange={event => updateRow(index, { reimbursementReceived:event.target.value })} style={inputStyle}/><input type="date" value={row.reimbursementDate || ""} onChange={event => updateRow(index, { reimbursementDate:event.target.value })} style={{ ...inputStyle, gridColumn:"1 / -1" }}/></div> : <span>{row.coverageThrough || "—"}</span>}</td>
        </tr>)}
      </tbody></table>
    </div>}
    {!!rows.length && <div style={{ display:"flex", justifyContent:"flex-end", gap:8, marginTop:12 }}><button disabled={busy || !includeRows.length} onClick={preview} style={buttonStyle}>{lang === "ko" ? "검증 미리보기" : "Validate preview"}</button><button disabled={!confirmedPayload || busy} onClick={commit} style={{ ...buttonStyle, background:confirmedPayload ? C.green : C.subtle, color:confirmedPayload ? "white" : C.muted }}>{lang === "ko" ? "가져오기 확정" : "Confirm import"}</button></div>}
    {receipt && <div style={{ marginTop:10, color:receipt.valid ? C.green : C.red, fontSize:11 }}>{receipt.valid ? `${receipt.summary?.rowCount || 0} rows validated. Confirm to append this exact normalized payload.` : (receipt.errors || []).join(" · ")}{(receipt.warnings || []).map((warning, i) => <div key={i} style={{ color:C.amber }}>• {warning}</div>)}</div>}
  </Section>;
}

function OverrideAdmin({ lang, selected, audit = [], onCommitted }) {
  const [field, setField] = useState("forecastRevenue");
  const [value, setValue] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(today());
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const submit = async () => {
    try {
      await apiRequest("/api/pnl/overrides", { method:"POST", body:JSON.stringify({ action:"set", eventId:crypto.randomUUID(), pid:selected.pid, cid:selected.cid, field, value, effectiveDate, reason }) });
      setValue(""); setReason(""); setMessage("Recorded."); await onCommitted();
    } catch (error) { setMessage(error.message); }
  };
  const reverse = async event => {
    const reasonText = window.prompt(lang === "ko" ? "취소 사유를 입력하세요." : "Enter the reversal reason.");
    if (!reasonText) return;
    try { await apiRequest("/api/pnl/overrides", { method:"POST", body:JSON.stringify({ action:"reverse", eventId:crypto.randomUUID(), targetEventId:event.eventId, reason:reasonText }) }); await onCommitted(); }
    catch (error) { setMessage(error.message); }
  };
  return <div className="pnl-admin-grid" style={{ display:"grid", gridTemplateColumns:"minmax(0,1fr) minmax(0,1fr)", gap:12 }}>
    <Section title={tr("override", lang)}>{selected ? <><div style={{ fontSize:11, color:C.muted, marginBottom:8 }}>{selected.productName || selected.pid} · {selected.campaignName || selected.cid}</div><div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:7 }}><select value={field} onChange={event => setField(event.target.value)} style={inputStyle}><option value="forecastRevenue">Forecast revenue</option><option value="forecastCogs">Forecast COGS</option><option value="forecastOtherExpenses">Forecast expenses</option><option value="plannedMarketing">Planned marketing</option></select><input type="number" min="0" value={value} placeholder="USD amount" onChange={event => setValue(event.target.value)} style={inputStyle}/><input type="date" value={effectiveDate} onChange={event => setEffectiveDate(event.target.value)} style={inputStyle}/><input value={reason} placeholder="Reason required" onChange={event => setReason(event.target.value)} style={inputStyle}/></div><button disabled={value === "" || reason.trim().length < 3} onClick={submit} style={{ ...buttonStyle, marginTop:8 }}>Append override</button>{message && <span style={{ marginLeft:8, fontSize:10, color:C.muted }}>{message}</span>}</> : <div style={{ color:C.muted, fontSize:11 }}>Select a campaign above.</div>}</Section>
    <Section title={tr("audit", lang)}><div style={{ maxHeight:220, overflowY:"auto" }}>{audit.length ? audit.map(event => <div key={event.eventId} style={{ padding:"7px 0", borderBottom:`1px solid ${C.border}`, fontSize:10, color:C.muted }}>{event.type === "import" ? <><div><b style={{ color:C.text }}>import</b> {event.sourceKind} · {event.rowCount} rows</div><div>{event.sourceAsOf} · superseded {event.supersededCount} · {event.sourceSha256?.slice(0, 10)}…</div></> : <div><b style={{ color:C.text }}>{event.action}</b> {event.pid} / {event.cid} {event.field} {event.value === null ? "" : money(event.value)}</div>}<div>{event.actorEmail} · {String(event.createdAt || "").slice(0, 19)}</div>{event.action === "set" && <button onClick={() => reverse(event)} style={{ ...buttonStyle, padding:"3px 6px", marginTop:4 }}>Reverse</button>}</div>) : <div style={{ color:C.muted, fontSize:11 }}>No import or override events.</div>}</div></Section>
  </div>;
}

export default function PnlView({ lang = "en", productOptions = [], campaignOptions = [] }) {
  const products = useMemo(() => normalizedProducts(productOptions), [productOptions]);
  const campaignsMeta = useMemo(() => normalizedCampaigns(campaignOptions), [campaignOptions]);
  const [asOf, setAsOf] = useState(today());
  const [view, setView] = useState(null);
  const [selectedKey, setSelectedKey] = useState("");
  const [sort, setSort] = useState({ key:"status", dir:"asc" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [auth, setAuth] = useState({ email:"", password:"", session:null, message:"" });
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { const payload = await apiRequest(`/api/pnl/view?asOf=${encodeURIComponent(asOf)}`); setView(payload); setSelectedKey(previous => previous || (payload.campaigns?.[0] ? `${payload.campaigns[0].pid}|${payload.campaigns[0].cid}` : "")); }
    catch (problem) { setError(problem.message); }
    finally { setLoading(false); }
  }, [asOf]);
  useEffect(() => { void pnlSupabaseSession().then(session => setAuth(previous => ({ ...previous, session }))).finally(load); return onPnlAuthStateChange(session => { setAuth(previous => ({ ...previous, session })); void load(); }); }, [load]);
  const selected = view?.campaigns?.find(row => `${row.pid}|${row.cid}` === selectedKey) || view?.campaigns?.[0] || null;
  const sorted = useMemo(() => [...(view?.campaigns || [])].sort((a, b) => {
    const statusOrder = { forecast_loss:0, unknown:1, on_track:2, profitable:3 };
    const value = row => sort.key === "campaign" ? `${row.productName}|${row.campaignName}|${row.cid}` : sort.key === "actual" ? row.actual.contribution : sort.key === "forecast" ? row.forecast.contribution : sort.key === "through" ? row.actual.coverageThrough || "" : sort.key === "margin" ? row.actual.margin ?? -Infinity : sort.key === "marketing" ? row.actual.paidMarketing : statusOrder[row.status];
    const left = value(a), right = value(b); const compared = typeof left === "string" ? left.localeCompare(right) : left - right; return sort.dir === "asc" ? compared : -compared;
  }), [view, sort]);
  const changeSort = key => setSort(previous => ({ key, dir:previous.key === key && previous.dir === "asc" ? "desc" : "asc" }));
  const p = view?.portfolio || {};
  const signIn = async event => { event.preventDefault(); try { const session = await pnlSupabaseSignIn(auth.email, auth.password); setAuth(previous => ({ ...previous, password:"", session, message:"Signed in." })); await load(); } catch (problem) { setAuth(previous => ({ ...previous, message:problem.message })); } };
  const signOut = async () => { await pnlSupabaseSignOut(); setAuth(previous => ({ ...previous, session:null, message:"" })); await load(); };
  const dbConfigured = view?.sources?.database?.configured !== false;

  return <div className="pnl-root" style={{ display:"flex", flexDirection:"column", gap:14, ...SANS }}>
    <header className="pnl-header">
      <div>
        <div className="pnl-eyebrow">{tr("eyebrow", lang)}</div>
        <h1>{tr("title", lang)}</h1>
        <p>{tr("subtitle", lang)}</p>
      </div>
      <label className="pnl-as-of"><span>{lang === "ko" ? "기준일" : "AS OF"}</span><input type="date" value={asOf} onChange={event => setAsOf(event.target.value)} onBlur={load} style={{ ...inputStyle, width:150 }}/></label>
    </header>
    {loading && <div role="status" style={{ color:C.blue, fontSize:11 }}>{lang === "ko" ? "손익을 불러오는 중…" : "Loading P&L…"}</div>}
    {error && <div role="alert" className="pnl-notice pnl-notice-error">{error}</div>}
    {!dbConfigured && <div role="status" className="pnl-notice pnl-notice-warning">{lang === "ko" ? "손익 데이터베이스가 아직 설정되지 않았습니다." : (view?.sources?.database?.message || "P&L storage is not configured. Add the dedicated Supabase database connection before importing financial records.")}</div>}
    <div className="pnl-kpi-grid"><Card label={tr("actual", lang)} value={p.actualCampaignCount ? money(p.actualContribution) : "—"} sub={`${p.actualCampaignCount || 0}/${p.campaignCount || 0} ${lang === "ko" ? "실적 완료" : "actual-complete"}`} color={C.green}/><Card label={tr("forecast", lang)} value={p.forecastCampaignCount ? money(p.forecastContribution) : "—"} sub={`${p.forecastCampaignCount || 0}/${p.campaignCount || 0} ${lang === "ko" ? "예측 완료" : "forecast-complete"}`} color={C.blue}/><Card label={tr("actualMargin", lang)} value={percent(p.actualMargin)}/><Card label={tr("forecastMargin", lang)} value={percent(p.forecastMargin)}/><Card label={tr("paidMarketing", lang)} value={money(p.paidMarketing)}/><Card label={tr("unpaid", lang)} value={money(p.unpaidCommitments)} color={C.amber}/><Card label={tr("unreimbursed", lang)} value={money(p.unreimbursed)} color={C.red}/></div>
    <div className="pnl-status-strip"><span className="pnl-status-label">{lang === "ko" ? "포트폴리오 상태" : "PORTFOLIO STATUS"}</span>{Object.keys(statusMeta).map(status => <span key={status} className="pnl-status-count"><Badge status={status} lang={lang}/><b>{p.statusCounts?.[status] || 0}</b></span>)}</div>
    <Section title={lang === "ko" ? "캠페인 포트폴리오" : "Campaign portfolio"}>
      <div className="pnl-table-wrap">
        <table className="pnl-table">
          <thead><tr>{[["campaign",tr("campaign",lang)],["status",tr("status",lang)],["through",tr("through",lang)],["actual",tr("actual",lang)],["forecast",tr("forecast",lang)],["margin",tr("actualMargin",lang)],["marketing",tr("marketing",lang)]].map(([key,label]) => <th key={key} aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}><button type="button" onClick={() => changeSort(key)}>{label}<span aria-hidden="true">{sort.key === key ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}</span></button></th>)}</tr></thead>
          <tbody>{sorted.map(row => {
            const isSelected = Boolean(selected && row.pid === selected.pid && row.cid === selected.cid);
            const selectRow = () => setSelectedKey(`${row.pid}|${row.cid}`);
            return <tr key={`${row.pid}|${row.cid}`} className={isSelected ? "pnl-selected-row" : ""} aria-selected={isSelected} tabIndex={0} onClick={selectRow} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectRow(); } }}>
              <td><b>{row.productName || products.find(product => product.id === row.pid)?.short || row.pid}</b><div className="pnl-secondary-text">{row.campaignName || campaignsMeta.find(campaign => campaign.id === row.cid)?.short || row.cid} · {row.channel}</div></td>
              <td><Badge status={row.status} lang={lang}/></td>
              <td>{row.actual.coverageThrough || "—"}</td>
              <td style={MONO}>{row.actualComplete ? money(row.actual.contribution) : "—"}</td>
              <td style={MONO}>{row.forecastComplete ? money(row.forecast.contribution) : "—"}</td>
              <td>{row.actualComplete ? percent(row.actual.margin) : "—"}</td>
              <td>{money(row.actual.paidMarketing)} / {money(row.forecast.marketing)}</td>
            </tr>;
          })}</tbody>
        </table>
        {!sorted.length && !loading && <div className="pnl-empty-state">{lang === "ko" ? "아직 가져온 캠페인 손익 데이터가 없습니다." : "No normalized campaigns have been imported yet."}</div>}
      </div>
    </Section>
    {selected && <div className="pnl-detail-grid" style={{ display:"grid", gridTemplateColumns:"minmax(0,1.25fr) minmax(280px,.75fr)", gap:12 }}><div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <Section title={`${selected.productName || selected.pid} · ${selected.campaignName || selected.cid}`} action={<Badge status={selected.status} lang={lang}/>}><div className="pnl-bridge-grid" style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}><div><b style={{ fontSize:10, color:C.muted }}>{tr("actual",lang)}</b>{[["Revenue",selected.missing.includes("Confirmed Costco revenue") ? null : selected.actual.revenue,C.green],["Reimbursements",selected.actual.reimbursement,C.blue],["Expenses",selected.missing.includes("Confirmed COGS") ? null : -selected.actual.expenses,C.red],["Paid creators",-selected.actual.paidMarketing,C.red],["Contribution",selected.actualComplete ? selected.actual.contribution : null,C.text]].map(([label,value,color]) => <div key={label} style={{ display:"flex", justifyContent:"space-between", padding:"6px 0", borderBottom:`1px solid ${C.border}`, color, fontSize:11 }}><span>{label}</span><b>{money(value)}</b></div>)}</div><div><b style={{ fontSize:10, color:C.muted }}>{tr("forecast",lang)}</b>{[["Revenue",selected.forecastComplete ? selected.forecast.revenue : null,C.green],["Expected reimbursement",selected.forecast.reimbursement,C.blue],["COGS",selected.forecastComplete ? -selected.forecast.cogs : null,C.red],["Campaign expenses",selected.forecastComplete ? -selected.forecast.otherExpenses : null,C.red],["Reconciled marketing",selected.forecastComplete ? -selected.forecast.marketing : null,C.red],["Contribution",selected.forecastComplete ? selected.forecast.contribution : null,C.text]].map(([label,value,color]) => <div key={label} style={{ display:"flex", justifyContent:"space-between", padding:"6px 0", borderBottom:`1px solid ${C.border}`, color, fontSize:11 }}><span>{label}</span><b>{money(value)}</b></div>)}</div></div></Section>
      <Section title={tr("lineItems",lang)}><div className="pnl-lines-grid" style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}><div><b style={{ fontSize:10, color:C.muted }}>FORECAST BASELINE</b>{(selected.lineItems?.forecast || []).map((row,i) => <div key={`${row.sourceCell}-${i}`} style={{ display:"flex", justifyContent:"space-between", gap:8, padding:"5px 0", borderBottom:`1px solid ${C.border}`, fontSize:10 }}><span>{row.label || row.lineType}<small style={{ color:C.muted }}> {row.sourceCell}</small></span><b>{money(row.amount)}</b></div>)}</div><div><b style={{ fontSize:10, color:C.muted }}>CONFIRMED ACTUALS</b>{(selected.lineItems?.actual || []).map(row => <div key={row.externalId} style={{ padding:"5px 0", borderBottom:`1px solid ${C.border}`, fontSize:10 }}><div style={{ display:"flex", justifyContent:"space-between", gap:8 }}><span>{row.lineType}</span><b>{money(row.amount)}</b></div><div style={{ color:C.muted }}>{row.transactionDate} · {row.externalId}</div></div>)}</div></div></Section>
    </div><div style={{ display:"flex", flexDirection:"column", gap:12 }}><Section title={tr("missing",lang)}>{selected.missing.length ? selected.missing.map(item => <div key={item} style={{ padding:"6px 0", color:C.amber, fontSize:11 }}>? {item}</div>) : <div style={{ color:C.green, fontSize:11 }}>✓ Required inputs complete through {selected.actual.coverageThrough}.</div>}</Section><Section title={tr("reconciliation",lang)}>{[["Planned budget",selected.reconciliation.plannedMarketing],["Creator commitments",selected.reconciliation.committedMarketing],["Forecast cost counted once",selected.reconciliation.forecastMarketing],["Unpaid commitments",selected.reconciliation.unpaidCommitments],["Unreimbursed",selected.reconciliation.unreimbursed]].map(([label,value]) => <div key={label} style={{ display:"flex", justifyContent:"space-between", padding:"6px 0", borderBottom:`1px solid ${C.border}`, fontSize:10 }}><span>{label}</span><b>{money(value)}</b></div>)}</Section><Section title={tr("freshness",lang)}>{Object.entries(view.sources || {}).map(([kind, source]) => <div key={kind} style={{ padding:"6px 0", borderBottom:`1px solid ${C.border}`, fontSize:10 }}><b>{kind}</b><div style={{ color:C.muted }}>{source.asOf || (source.configured ? "Configured" : "Not configured")} {source.importedAt ? `· ${String(source.importedAt).slice(0,10)}` : ""}</div></div>)}</Section></div></div>}
      <Section title={tr("admin",lang)} action={auth.session ? <button style={buttonStyle} onClick={signOut}>{auth.session.user?.email} · {lang === "ko" ? "로그아웃" : "Sign out"}</button> : null}>{view?.permissions?.canEdit ? <div style={{ display:"flex", flexDirection:"column", gap:12 }}><ImportAdmin lang={lang} products={products} campaigns={campaignsMeta} onCommitted={load}/><OverrideAdmin lang={lang} selected={selected} audit={view.audit || []} onCommitted={load}/></div> : <div><p style={{ margin:"0 0 10px", color:C.muted, fontSize:11 }}>{lang === "ko" ? "모든 로그인 사용자는 손익을 볼 수 있습니다. 재무 가져오기와 수정은 승인된 Supabase 계정만 가능합니다." : "All signed-in dashboard viewers may read P&L. Imports and overrides require an approved Supabase account."}</p>{pnlSupabaseConfigured() ? <form className="pnl-auth-grid" onSubmit={signIn} style={{ display:"grid", gridTemplateColumns:"minmax(180px,1fr) minmax(160px,1fr) auto", gap:7 }}><input type="email" required placeholder="alex.rivera@example.invalid" value={auth.email} onChange={event => setAuth(previous => ({ ...previous, email:event.target.value }))} style={inputStyle}/><input type="password" required placeholder={lang === "ko" ? "Supabase 비밀번호" : "Supabase password"} value={auth.password} onChange={event => setAuth(previous => ({ ...previous, password:event.target.value }))} style={inputStyle}/><button style={{ ...buttonStyle, background:C.accent, borderColor:C.accent, color:"white" }}>{lang === "ko" ? "재무 계정 로그인" : "Finance sign in"}</button></form> : <div style={{ color:C.amber, fontSize:11 }}>{lang === "ko" ? "이 배포에는 Supabase 로그인이 아직 설정되지 않았습니다." : "Supabase sign-in is not configured in this deployment."}</div>}{auth.message && <div style={{ color:C.muted, fontSize:10, marginTop:6 }}>{auth.message}</div>}</div>}</Section>
  </div>;
}

