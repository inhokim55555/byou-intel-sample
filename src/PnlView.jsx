import React, { useCallback, useEffect, useMemo, useState } from "react";
import { pnlBearerHeaders } from "./lib/supabaseClient.js";
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
const SAMPLE_AS_OF = "2026-10-20";
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

async function apiRequest(path, options = {}) {
  const auth = await pnlBearerHeaders();
  const response = await fetch(path, { credentials:"same-origin", cache:"no-store", ...options, headers:{ ...(options.body ? { "Content-Type":"application/json" } : {}), ...auth, ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (notifySessionExpired(response)) throw Object.assign(new Error("Your login session expired. Sign in again to continue."), { payload, status:response.status });
  if (!response.ok) throw Object.assign(new Error(payload.error || `Request failed (${response.status}).`), { payload, status:response.status });
  return payload;
}


function pnlRows(c) {
  const actual = type => (c.lineItems.actual || []).filter(r => r.lineType === type).reduce((n,r) => n+r.amount,0);
  const forecast = type => (c.lineItems.forecast || []).filter(r => r.lineType === type).reduce((n,r) => n+r.amount,0);
  return [
    ["Revenue",c.actual.revenue,c.forecast.revenue],
    ["Cost of goods",-actual("cogs"),-c.forecast.cogs],
    ["Gross profit",c.actual.revenue-actual("cogs"),c.forecast.revenue-c.forecast.cogs],
    ...[["import_cost","Freight & import"],["costco_allowance","Retail allowances"],["promotion","Promotions"],["markdown","Markdowns"],["endcap","Retail placement"],["packaging","Packaging"],["returns","Returns"],["other_campaign_expense","Other expenses"]].map(([type,label])=>[label,-actual(type),-forecast(type)]),
    ["Marketing",-c.actual.paidMarketing,-c.forecast.marketing],
    ["Reimbursements",c.actual.reimbursement,c.forecast.reimbursement],
    ["Contribution profit",c.actual.contribution,c.forecast.contribution],
  ];
}
export default function PnlView({ lang = "en", productOptions = [], campaignOptions = [] }) {
  const products = useMemo(() => productOptions, [productOptions]);
  const campaignsMeta = useMemo(() => campaignOptions, [campaignOptions]);
  const [asOf, setAsOf] = useState(SAMPLE_AS_OF);
  const [view, setView] = useState(null);
  const [selectedKey, setSelectedKey] = useState("");
  const [sort, setSort] = useState({ key:"status", dir:"asc" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { const payload = await apiRequest(`/api/pnl/view?asOf=${encodeURIComponent(asOf)}`); setView(payload); setSelectedKey(previous => previous || (payload.campaigns?.[0] ? `${payload.campaigns[0].pid}|${payload.campaigns[0].cid}` : "")); }
    catch (problem) { setError(problem.message); }
    finally { setLoading(false); }
  }, [asOf]);
  useEffect(() => { void load(); }, [load]);
  const selected = view?.campaigns?.find(row => `${row.pid}|${row.cid}` === selectedKey) || view?.campaigns?.[0] || null;
  const sorted = useMemo(() => [...(view?.campaigns || [])].sort((a, b) => {
    const statusOrder = { forecast_loss:0, unknown:1, on_track:2, profitable:3 };
    const value = row => sort.key === "campaign" ? `${row.productName}|${row.campaignName}|${row.cid}` : sort.key === "actual" ? row.actual.contribution : sort.key === "forecast" ? row.forecast.contribution : sort.key === "through" ? row.actual.coverageThrough || "" : sort.key === "margin" ? row.actual.margin ?? -Infinity : sort.key === "marketing" ? row.actual.paidMarketing : statusOrder[row.status];
    const left = value(a), right = value(b); const compared = typeof left === "string" ? left.localeCompare(right) : left - right; return sort.dir === "asc" ? compared : -compared;
  }), [view, sort]);
  const changeSort = key => setSort(previous => ({ key, dir:previous.key === key && previous.dir === "asc" ? "desc" : "asc" }));
  const p = view?.portfolio || {};
  const dbConfigured = view?.sources?.database?.configured !== false;

  return <div className="pnl-root" style={{ display:"flex", flexDirection:"column", gap:14, ...SANS }}>
    <header className="pnl-header">
      <div>

        <h1>{tr("title", lang)}</h1>

      </div>
      <div className="pnl-as-of">As of <time dateTime={SAMPLE_AS_OF}>Oct 20, 2026</time></div>
    </header>
    {loading && <div role="status" style={{ color:C.blue, fontSize:11 }}>{lang === "ko" ? "손익을 불러오는 중…" : "Loading P&L…"}</div>}
    {error && <div role="alert" className="pnl-notice pnl-notice-error">{error}</div>}
    {!dbConfigured && <div role="status" className="pnl-notice pnl-notice-warning">{lang === "ko" ? "손익 데이터베이스가 아직 설정되지 않았습니다." : (view?.sources?.database?.message || "P&L storage is not configured. Add the dedicated Supabase database connection before importing financial records.")}</div>}
    <div className="pnl-kpi-grid"><Card label={tr("actual", lang)} value={p.actualCampaignCount ? money(p.actualContribution) : "—"} color={C.green}/><Card label={tr("forecast", lang)} value={p.forecastCampaignCount ? money(p.forecastContribution) : "—"} color={C.blue}/><Card label={tr("actualMargin", lang)} value={percent(p.actualMargin)}/><Card label={tr("forecastMargin", lang)} value={percent(p.forecastMargin)}/><Card label={tr("paidMarketing", lang)} value={money(p.paidMarketing)}/><Card label={tr("unpaid", lang)} value={money(p.unpaidCommitments)} color={C.amber}/><Card label={tr("unreimbursed", lang)} value={money(p.unreimbursed)} color={C.red}/></div>
    <div className="pnl-status-strip">{Object.keys(statusMeta).map(status => <span key={status} className="pnl-status-count"><Badge status={status} lang={lang}/><b>{p.statusCounts?.[status] || 0}</b></span>)}</div>
    <Section title={lang === "ko" ? "캠페인 포트폴리오" : "Campaign portfolio"}>
      <div className="pnl-table-wrap">
        <table className="pnl-table">
          <thead><tr>{[["campaign",tr("campaign",lang)],["status",tr("status",lang)],["through",tr("through",lang)],["actual",tr("actual",lang)],["forecast",tr("forecast",lang)],["margin",tr("actualMargin",lang)],["marketing",(lang === "ko" ? "지급 / 예산" : "Paid / forecast")]].map(([key,label]) => <th key={key} aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}><button type="button" onClick={() => changeSort(key)}>{label}<span aria-hidden="true">{sort.key === key ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}</span></button></th>)}</tr></thead>
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
      <Section title={`${selected.productName} · ${selected.campaignName}`} action={<Badge status={selected.status} lang={lang}/>}>
        <table className="pnl-table" style={{minWidth:0,width:"100%",tableLayout:"fixed"}}><thead><tr><th style={{width:"44%"}}>USD</th><th>Actual · Oct 20</th><th>Forecast · Nov 19</th></tr></thead><tbody>
        {pnlRows(selected).map(([label,actual,forecast]) => <tr key={label} style={label.includes("profit") ? {fontWeight:700,background:C.subtle} : undefined}><td>{label}</td><td style={MONO}>{money(actual)}</td><td style={MONO}>{money(forecast)}</td></tr>)}
        </tbody></table>
      </Section>
    </div><div style={{ display:"flex", flexDirection:"column", gap:12 }}><Section title={lang === "ko" ? "마케팅 예산" : "Marketing budget"}>{[["Budget",selected.reconciliation.plannedMarketing],["Committed",selected.reconciliation.committedMarketing],["Paid",selected.actual.paidMarketing],["Unpaid",selected.reconciliation.unpaidCommitments],["Reimbursement due",selected.reconciliation.unreimbursed]].map(([label,value]) => <div key={label} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:`1px solid ${C.border}`, fontSize:11 }}><span>{label}</span><b>{money(value)}</b></div>)}</Section></div></div>}

  </div>;
}
