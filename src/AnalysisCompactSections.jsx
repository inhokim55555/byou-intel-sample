import React, { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  ANALYSIS_MIN_SELLING_UNITS,
  ANALYSIS_MIN_SELLING_UNIT_OPTIONS,
  C,
  FN_TYPES,
  INP,
  MONO,
  Panel,
  SELECT,
  SmBtn,
  StatusChip,
  campaignHealth,
  campaignWithMeta,
  downloadRowsCsv,
  fmtCompactMoney,
  fmtGrowth,
  pctChange,
  productLabelForValue,
  productWithMeta,
  useUiText,
} from "./ByouIntel.jsx";
import { warehouseLocationLabel } from "./lib/storeLookup.js";

function CompactMetric({ label, value, sub = "", color = C.text }) {
  return (
    <div style={{ minWidth:0, background:C.card, border:`1px solid ${C.border}`, borderTop:`3px solid ${color}`, borderRadius:8, padding:"12px 13px" }}>
      <div style={{ ...MONO, color:C.muted, fontSize:9, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>{label}</div>
      <div style={{ ...MONO, color, fontSize:20, fontWeight:500, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{value}</div>
      <div style={{ color:C.muted, fontSize:9, minHeight:13, marginTop:4, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{sub}</div>
    </div>
  );
}

function compactDateSpan(start, end) {
  if (start && end) return start === end ? start : `${start} to ${end}`;
  return start || end || "";
}

function OfficialCoverageNotice({ coverage = {}, lang = "en" }) {
  if (!coverage?.status) return null;
  const status = coverage.status || "unavailable";
  const label = lang === "ko"
    ? status === "complete" ? "공식 합계 기간 완전" : status === "partial" ? "공식 합계 일부만 있음" : "공식 합계 없음"
    : status === "complete" ? "Official totals complete" : status === "partial" ? "Partial official totals" : "Official totals unavailable";
  const color = status === "complete" ? C.green : status === "partial" ? C.warn : C.red;
  const expectedSpan = compactDateSpan(coverage.expectedStart, coverage.expectedEnd);
  const officialSpan = compactDateSpan(coverage.officialStart, coverage.officialEnd);
  const warehouseSpan = compactDateSpan(coverage.warehouseStart, coverage.warehouseEnd);
  const warehouseContext = coverage.warehouseRowCount
    ? lang === "ko"
      ? `창고 이력은 ${warehouseSpan || "선택 기간"}에 존재하지만 보조 맥락일 뿐이며 공식 합계에 더하거나 대체하지 않습니다.`
      : `Warehouse history is supporting context only (${warehouseSpan || "selected window"}) and does not replace or add to official totals.`
    : lang === "ko"
      ? "선택 기간에 사용할 수 있는 창고 이력도 없습니다."
      : "No warehouse history is available for the selected window either.";
  const explanation = lang === "ko"
    ? status === "complete"
      ? `Costco_Daily_Totals가 요청한 캠페인 기간 ${expectedSpan || officialSpan}의 양 끝을 포함합니다. ${warehouseContext}`
      : status === "partial"
        ? `Costco_Daily_Totals는 요청 기간 ${expectedSpan} 중 ${officialSpan}만 포함합니다. 아래 지표는 확인된 공식 합계만 사용하므로 불완전합니다. ${warehouseContext}`
        : `요청 기간 ${expectedSpan || "선택 기간"}에 Costco_Daily_Totals 행이 없습니다. 공식 매출과 페이싱은 사용할 수 없습니다. ${warehouseContext}`
    : status === "complete"
      ? `Costco_Daily_Totals spans the requested campaign window, ${expectedSpan || officialSpan}. ${warehouseContext}`
      : status === "partial"
        ? `Costco_Daily_Totals covers ${officialSpan} of the requested ${expectedSpan} window. Metrics below use only available official totals and are incomplete. ${warehouseContext}`
        : `No Costco_Daily_Totals rows are available for the requested ${expectedSpan || "selected"} window. Official sales and pacing remain unavailable. ${warehouseContext}`;
  return (
    <div style={{ display:"flex", alignItems:"flex-start", gap:9, border:`1px solid ${color}38`, background:`${color}0D`, borderRadius:7, padding:"9px 10px", marginBottom:12 }}>
      <StatusChip label={label} col={color}/>
      <div style={{ color:C.muted, fontSize:10, lineHeight:1.55 }}>{explanation}</div>
    </div>
  );
}

function formatAffinitySignalValue(signal, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "N/A";
  if (signal?.format === "currency") return fmtCompactMoney(number);
  if (signal?.format === "percent") return `${number.toFixed(1)}%`;
  return signal?.format === "count" ? Math.round(number).toLocaleString() : number.toFixed(1);
}

export function CompactPacingAnalysisView({ model }) {
  const { lang, t, label:uiLabel } = useUiText();
  const selected = model?.selected || null;
  const selectedRange = model?.selectedRange || {};
  const planning = model?.planning || {};
  const benchmark = model?.benchmark || {};
  const pacingCampaigns = Array.isArray(model?.pacingCampaigns) ? model.pacingCampaigns : [];
  const chartData = Array.isArray(model?.chartData) ? model.chartData : [];
  const campaignRows = Array.isArray(model?.campaignSnapshotRows) ? model.campaignSnapshotRows : [];
  const eventLines = (Array.isArray(model?.eventLines) ? model.eventLines : []).map(event => ({ ...event, col:FN_TYPES[event.type]?.col || selected?.col || C.accent }));
  const selectedHealth = campaignHealth(Number(selectedRange.revenuePerDoor || 0), Number(selectedRange.verifiedDoors || 0));
  const first14Delta = benchmark.avgFirst14 ? pctChange(Number(selected?.first14Rev || 0), Number(benchmark.avgFirst14)) : null;
  const actions = useMemo(() => {
    const days = Number.isFinite(Number(planning.daysToSellout)) ? Number(planning.daysToSellout) : null;
    const inventoryAvailable = planning.latestInventoryKnown && Number(planning.velocityUnits || 0) > 0 && days !== null;
    const projectedDelta = Number.isFinite(Number(planning.projectedVsBenchmark)) ? Number(planning.projectedVsBenchmark) : null;
    const contentBehind = Number(planning.paidVideos || 0) < Number(benchmark.avgPaidVideos || 0) || Number(planning.seedingVideos || 0) < Number(benchmark.avgSeedingVideos || 0);
    const strongDoors = Number(planning.strongDoors || 0);
    const weakDoors = Number(planning.weakDoors || 0);
    return [
      inventoryAvailable ? {
        title:lang === "ko" ? (days <= 45 ? "Sell-through 성공" : "Sell-through 주의") : (days <= 45 ? "Sell-through success" : "Sell-through watch"),
        metric:`${days.toFixed(0)} ${lang === "ko" ? "일 예상" : "estimated days"}`,
        action:lang === "ko" ? `현재 판매 속도와 최근 확인 재고를 기준으로 ${planning.sellThroughReviewDate || "다음 보고일"}에 다시 확인하세요.` : `Recheck on ${planning.sellThroughReviewDate || "the next reporting date"} using the latest verified inventory and unit velocity.`,
        col:days <= 45 ? C.green : C.warn,
      } : {
        title:lang === "ko" ? "재고 판독 불가" : "Inventory read unavailable",
        metric:lang === "ko" ? "사용 가능한 재고 또는 최근 유닛 속도 없음" : "No usable inventory or recent unit velocity",
        action:lang === "ko" ? "일별 합계와 재고 스냅샷을 채워야 sell-through를 정확히 읽을 수 있습니다." : "A verified inventory snapshot and recent unit velocity are required for a sell-through estimate.",
        col:C.muted,
      },
      {
        title:lang === "ko" ? "30일 매출 예상" : "30-day sales projection",
        metric:`${fmtCompactMoney(Number(planning.projected30 || 0))}${benchmark.avgFirst30 ? ` / ${fmtGrowth(projectedDelta)} ${lang === "ko" ? "vs 피어 30일 평균" : "vs peer 30-day avg"}` : ""}`,
        action:projectedDelta !== null && projectedDelta < -15 ? (lang === "ko" ? "다음 매출 판독에서 상승이 확인될 때까지 목표보다 뒤처진 것으로 관리하세요." : "Treat this as behind pace until the next sales read shows lift.") : (lang === "ko" ? "다음 Costco 판독의 현재 계획 목표로 사용하세요." : "Use this as the current planning target for the next Costco readout."),
        col:projectedDelta !== null && projectedDelta < -15 ? C.red : projectedDelta !== null && projectedDelta > 15 ? C.green : C.warn,
      },
      {
        title:lang === "ko" ? "콘텐츠 지원" : "Content support",
        metric:`Paid ${Number(planning.paidVideos || 0).toLocaleString()} / ${Number(benchmark.avgPaidVideos || 0).toFixed(1)} avg; Seeding ${Number(planning.seedingVideos || 0).toLocaleString()} / ${Number(benchmark.avgSeedingVideos || 0).toFixed(1)} avg`,
        action:contentBehind ? (lang === "ko" ? "피어 벤치마크보다 낮은 Paid 또는 Seeding 지원을 필요한 구간에 보강하세요." : "Paid or seeding coverage is below the peer benchmark; add support where the campaign needs it.") : (lang === "ko" ? "각 Paid 또는 Seeding 콘텐츠 묶음 이후의 매출 움직임을 계속 측정하세요." : "Keep measuring sales movement after each paid or seeding content cluster."),
        col:contentBehind ? C.warn : C.green,
      },
      {
        title:lang === "ko" ? "매장 실행" : "Door execution",
        metric:lang === "ko" ? `강한 매장 ${strongDoors} / 약한 매장 ${weakDoors}` : `${strongDoors} strong / ${weakDoors} weak doors`,
        action:weakDoors > strongDoors ? (lang === "ko" ? "Revenue / Door가 낮은 매장을 우선 점검하세요." : "Prioritize field follow-up for weak Revenue / Door locations.") : (lang === "ko" ? "강한 매장 실행을 유지하고 약한 매장을 선택적으로 점검하세요." : "Maintain strong-door execution and follow up selectively on weak locations."),
        col:weakDoors > strongDoors ? C.warn : strongDoors ? C.green : C.muted,
      },
    ];
  }, [planning, benchmark, lang]);

  return (
    <>
      <Panel title={lang === "ko" ? "캠페인 분석 및 계획" : "Campaign Analysis & Planning"}>
        <div style={{ color:C.muted, fontSize:10, marginBottom:12 }}>{selected?.short || selected?.name || t("filter.allProducts", "All Products")} · complete history remains server-side; this view contains only the selected section result.</div>
        <OfficialCoverageNotice coverage={model?.officialCoverage} lang={lang}/>
        <div className="bi-kpi-grid" style={{ display:"grid", gridTemplateColumns:"repeat(4,minmax(150px,1fr))", gap:9, marginBottom:14 }}>
          <CompactMetric label={uiLabel("Inline Sales")} value={model?.officialAvailable ? fmtCompactMoney(Number(selectedRange.inlineRev || 0)) : t("common.missing", "Missing")} color={selected?.col || C.green}/>
          <CompactMetric label={uiLabel("Inline Units")} value={model?.officialAvailable ? Number(selectedRange.inlineUnits || 0).toLocaleString() : t("common.missing", "Missing")} color={C.blue}/>
          <CompactMetric label={uiLabel("Total Warehouses")} value={Number(selectedRange.totalWarehouses || 0) ? Number(selectedRange.totalWarehouses).toLocaleString() : t("common.notAvailable", "N/A")}/>
          <CompactMetric label={uiLabel("Revenue / Door")} value={model?.officialAvailable && Number(selectedRange.verifiedDoors || 0) ? fmtCompactMoney(Number(selectedRange.revenuePerDoor || 0)) : t("common.notAvailable", "N/A")} sub={Number(selectedRange.weeklyPeriodCount || 0) ? `Average of ${Number(selectedRange.weeklyPeriodCount).toLocaleString()} weekly periods` : ""} color={Number(selectedRange.verifiedDoors || 0) ? selectedHealth.col : C.muted}/>
        </div>
      </Panel>
      <Panel title="Campaign Pacing Comparison">
        {chartData.length ? <><div style={{ display:"flex", gap:14, flexWrap:"wrap", marginBottom:8 }}>{pacingCampaigns.map(campaign => <div key={campaign.id} style={{ display:"flex", alignItems:"center", gap:6, fontSize:10, color:C.muted }}><span style={{ width:18, height:3, borderRadius:3, background:campaign.col || C.accent }}/><span style={{ color:C.text, fontWeight:500 }}>{campaign.short || campaign.name}{campaign.id === selected?.id ? " (baseline)" : ""}</span></div>)}</div><ResponsiveContainer width="100%" height={340}><LineChart data={chartData} margin={{ top:8, right:12, bottom:6, left:4 }}><CartesianGrid stroke={C.border} strokeDasharray="2 5" vertical={false}/><XAxis dataKey="label" tick={{fontSize:10,fill:C.muted}} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:C.muted}} axisLine={false} tickLine={false} tickFormatter={fmtCompactMoney}/><Tooltip formatter={(value, name) => [fmtCompactMoney(value), pacingCampaigns.find(campaign => campaign.id === name)?.short || name]}/>{eventLines.map((event, index) => <ReferenceLine key={`${event.date}-${event.type}-${index}`} x={event.label} stroke={event.col} strokeDasharray="3 4"/>)}{pacingCampaigns.map(campaign => <Line key={campaign.id} type="monotone" dataKey={campaign.id} name={campaign.id} stroke={campaign.col || C.accent} strokeWidth={campaign.id === selected?.id ? 3 : 2} dot={false}/>)}</LineChart></ResponsiveContainer></> : <div style={{ padding:"22px", textAlign:"center", color:C.muted }}>{lang === "ko" ? "페이싱을 비교하려면 매출 기록이 있는 캠페인을 선택하세요." : "Select a campaign with sales history to compare pacing."}</div>}
      </Panel>
      <Panel title={uiLabel("Pace Snapshot")}>
        <div className="bi-kpi-grid" style={{ display:"grid", gridTemplateColumns:"repeat(4,minmax(145px,1fr))", gap:8, marginBottom:14 }}><CompactMetric label="Observed Days" value={Number(selected?.elapsedDays || 0) ? Number(selected.elapsedDays).toLocaleString() : "N/A"}/><CompactMetric label="Avg Daily Sales" value={fmtCompactMoney(Number(selected?.avgDailyRev || 0))} color={selected?.col || C.green}/><CompactMetric label="First 14 Days" value={fmtCompactMoney(Number(selected?.first14Rev || 0))} sub={benchmark.avgFirst14 ? `${fmtGrowth(first14Delta)} vs peer avg` : "first 14 active-sales days"} color={first14Delta !== null && first14Delta < 0 ? C.red : C.green}/><CompactMetric label="Revenue / Door" value={Number(selectedRange.verifiedDoors || 0) ? fmtCompactMoney(Number(selectedRange.revenuePerDoor || 0)) : "N/A"} sub={Number(selectedRange.weeklyPeriodCount || 0) ? `Average of ${Number(selectedRange.weeklyPeriodCount)} weekly periods` : ""} color={Number(selectedRange.verifiedDoors || 0) ? selectedHealth.col : C.muted}/></div>
        <div style={{ display:"grid", gap:7 }}>{campaignRows.map(row => <div key={row.id} style={{ display:"grid", gridTemplateColumns:"minmax(0,1fr) 92px 92px", gap:8, alignItems:"center", background:C.bg, border:`1px solid ${C.border}`, borderLeft:`3px solid ${row.col || C.accent}`, borderRadius:7, padding:"8px 9px" }}><div style={{ minWidth:0 }}><div style={{ color:C.text, fontWeight:500, fontSize:11 }}>{row.short || row.name}</div><div style={{ color:C.muted, fontSize:10 }}>{row.firstDate || "No date"} to {row.lastDate || "No date"}</div></div><div style={{ ...MONO, color:row.col || C.accent, textAlign:"right" }}>{fmtCompactMoney(Number(row.rev || 0))}</div><div style={{ ...MONO, color:C.text, textAlign:"right" }}>{fmtCompactMoney(Number(row.avgDailyRev || 0))}/day</div></div>)}</div>
      </Panel>
      <Panel title="Planning Actions"><div style={{ display:"grid", gap:9 }}>{actions.map(action => <div key={action.title} className="bi-planning-action" style={{ border:`1px solid ${C.border}`, borderLeft:`4px solid ${action.col}`, background:C.bg, borderRadius:8, padding:"12px 13px" }}><div><div style={{ color:C.text, fontWeight:500, fontSize:13, marginBottom:5 }}>{action.title}</div><div style={{ color:C.muted, fontSize:11, lineHeight:1.55 }}>{action.action}</div></div><div className="bi-planning-outcome" style={{ border:`1px solid ${action.col}38`, background:`${action.col}0D` }}><div style={{ ...MONO, color:C.muted, fontSize:9, textTransform:"uppercase" }}>{lang === "ko" ? "결과" : "Outcome"}</div><div style={{ ...MONO, color:action.col, fontSize:14, fontWeight:600 }}>{action.metric}</div></div></div>)}</div></Panel>
    </>
  );
}

export function CompactSalesAffinityView({ result, selId, analysisOptions = {}, setAnalysisOptions = () => {}, campaignPid = "", campaignCid = "", productMeta = {}, campaignMeta = {}, dateRange }) {
  const { t } = useUiText();
  const model = result?.model || { rows:[], summary:{} };
  const summary = model.summary || {};
  const reading = result?.reading || { available:false };
  const exclusions = model.exclusions || {};
  const signals = Array.isArray(model.signals) ? model.signals : [];
  const modelControls = Array.isArray(summary.modelControls) ? summary.modelControls : [];
  const [showLimit, setShowLimit] = useState(30);
  const update = (key, value, extra = {}) => { setShowLimit(30); setAnalysisOptions(previous => ({ ...previous, [key]:value, ...extra })); };
  const selectedRow = model.rows.find(row => row.warehouseId === selId) || (!selId ? model.rows[0] : null);
  const selectedCampaign = campaignWithMeta(campaignCid, campaignMeta, productMeta);
  const selectedProduct = result?.scope?.selectedPid ? productWithMeta(result.scope.selectedPid, productMeta) : null;
  const scopeLabel = [selectedProduct?.short || (campaignPid ? productLabelForValue(campaignPid, productMeta) : t("filter.allProducts", "All Products")), selectedCampaign?.short].filter(Boolean).join(" / ");
  const confidenceColor = summary.cohortConfidence === "high" ? C.green : summary.cohortConfidence === "medium" ? C.blue : summary.cohortConfidence === "low" ? C.warn : C.red;
  return (
    <Panel title={t("analysis.affinityTitle", "Campaign Sales Affinity")}>
      <div style={{ padding:"10px 12px", borderRadius:7, background:C.accentFade, border:`1px solid ${C.accent}22`, marginBottom:14, color:C.text, fontSize:10, lineHeight:1.55 }}><strong>What this measures:</strong> which warehouse markets sell the selected product or campaign faster than expected. An affinity index of 100 is expected; 120 means roughly 20% above expected after the available controls. This is a market association model, not a customer identity model.</div>
      <div className="bi-affinity-controls" style={{ display:"grid", gridTemplateColumns:"repeat(4,minmax(135px,1fr))", gap:10, marginBottom:14 }}>
        <label><div style={{ ...MONO, fontSize:9, color:C.muted }}>Region</div><select value={analysisOptions.affinityRegion || ""} onChange={event => update("affinityRegion", event.target.value, { affinityState:"" })} style={{ ...SELECT, width:"100%" }}><option value="">All regions</option>{(result?.regions || []).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><div style={{ ...MONO, fontSize:9, color:C.muted }}>State</div><select value={analysisOptions.affinityState || ""} onChange={event => update("affinityState", event.target.value)} style={{ ...SELECT, width:"100%" }}><option value="">All states</option>{(result?.states || []).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><div style={{ ...MONO, fontSize:9, color:C.muted }}>Minimum reporting periods</div><select value={Number(analysisOptions.affinityMinimumPeriods || 3)} onChange={event => update("affinityMinimumPeriods", Number(event.target.value))} style={{ ...SELECT, width:"100%" }}>{[1,2,3,4,6].map(value => <option key={value} value={value}>{value} period{value === 1 ? "" : "s"}</option>)}</select></label>
        <label><div style={{ ...MONO, fontSize:9, color:C.muted }}>Minimum units</div><select value={Number(analysisOptions.affinityMinimumUnits || 0)} onChange={event => update("affinityMinimumUnits", Number(event.target.value))} style={{ ...SELECT, width:"100%" }}>{[0,5,10,25,50,100].map(value => <option key={value} value={value}>{value.toLocaleString()} units</option>)}</select></label>
      </div>
      <div style={{ fontSize:10, color:C.muted, marginBottom:12 }}>{scopeLabel} · {dateRange?.start} to {dateRange?.end}</div>
      <div style={{ fontSize:10, color:C.muted, marginBottom:12 }}><strong style={{ color:C.text }}>Model controls:</strong> {modelControls.length ? modelControls.join(", ") : "none available for this cohort"}</div>
      <div className="bi-kpi-grid" style={{ display:"grid", gridTemplateColumns:"repeat(4,minmax(145px,1fr))", gap:8, marginBottom:14 }}><CompactMetric label="Qualified warehouses" value={Number(summary.eligibleWarehouses || 0).toLocaleString()} sub={`${Number(summary.candidateWarehouses || 0).toLocaleString()} with scoped reporting rows`} color={C.accent}/><CompactMetric label="Median velocity" value={Number(summary.medianVelocity || 0).toFixed(1)} sub={`units / available period · mean ${Number(summary.meanVelocity || 0).toFixed(1)}`} color={C.blue}/><CompactMetric label="Demographic coverage" value={`${(Number(summary.demographicCoverage || 0) * 100).toFixed(0)}%`} sub="of sales-qualified warehouses" color={C.purple}/><CompactMetric label="Cohort confidence" value={String(summary.cohortConfidence || "insufficient").toUpperCase()} sub={`${Number(summary.medianPeriods || 0).toFixed(0)} median reporting periods`} color={confidenceColor}/></div>
      {model.status !== "ready" ? <div style={{ padding:14, border:`1px solid ${C.warn}44`, background:C.warnFade, borderRadius:8, color:C.text }}><strong style={{ color:C.warn }}>Not enough qualified warehouses for a dependable affinity read.</strong><div>{model.reason}</div></div> : <><div style={{ display:"grid", gridTemplateColumns:"repeat(4,minmax(130px,1fr))", gap:8, marginBottom:14 }}>{selectedRow && <><CompactMetric label="Selected warehouse" value={selectedRow.warehouse?.name || selectedRow.warehouseId} sub={warehouseLocationLabel(selectedRow.warehouse)}/><CompactMetric label="Affinity index" value={Number(selectedRow.affinityIndex || 0).toFixed(0)} sub={`${Number(selectedRow.affinityPercentile || 0).toFixed(0)}th percentile`} color={selectedRow.affinityIndex >= 110 ? C.green : selectedRow.affinityIndex <= 90 ? C.red : C.blue}/><CompactMetric label="Actual velocity" value={Number(selectedRow.velocity || 0).toFixed(1)} sub="units / available period" color={C.accent}/><CompactMetric label="Expected velocity" value={Number(selectedRow.expectedVelocity || 0).toFixed(1)} sub="after available controls" color={C.purple}/></>}</div>{reading.available && <div style={{ padding:"10px 12px", background:C.bg, border:`1px solid ${C.border}`, borderRadius:7, marginBottom:14 }}>{reading.aboveExpected} of {reading.qualifiedWarehouses} qualified warehouses are at least 10% above expected; {reading.belowExpected} are at least 10% below expected.</div>}<div style={{ display:"flex", justifyContent:"flex-end", marginBottom:10 }}><SmBtn onClick={() => downloadRowsCsv("campaign-sales-affinity.csv", [{ label:"Warehouse", value:row => row.warehouse?.name || row.warehouseId }, { label:"Affinity Index", value:row => row.affinityIndex }, { label:"Velocity", value:row => row.velocity }, { label:"Expected Velocity", value:row => row.expectedVelocity }, { label:"Revenue", value:row => row.revenue }, { label:"Units", value:row => row.units }], model.rows)}>{t("common.exportCsv", "Export CSV")}</SmBtn></div><div style={{ overflowX:"auto" }}><table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}><thead><tr>{["Warehouse","Affinity","Velocity","Expected","Revenue","Units"].map((heading, index) => <th key={heading} style={{ textAlign:index ? "right" : "left", padding:"0 8px 8px", borderBottom:`1px solid ${C.border}`, color:C.muted }}>{heading}</th>)}</tr></thead><tbody>{model.rows.slice(0, showLimit).map(row => <tr key={row.warehouseId}><td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}` }}><div>{row.warehouse?.name || row.warehouseId}</div><div style={{ color:C.muted }}>{warehouseLocationLabel(row.warehouse)}</div></td><td style={{ textAlign:"right" }}>{Number(row.affinityIndex || 0).toFixed(0)}</td><td style={{ textAlign:"right" }}>{Number(row.velocity || 0).toFixed(1)}</td><td style={{ textAlign:"right" }}>{Number(row.expectedVelocity || 0).toFixed(1)}</td><td style={{ textAlign:"right" }}>{fmtCompactMoney(Number(row.revenue || 0))}</td><td style={{ textAlign:"right" }}>{Number(row.units || 0).toLocaleString()}</td></tr>)}</tbody></table></div>{model.rows.length > showLimit && <button onClick={() => setShowLimit(value => Math.min(value + 50, model.rows.length))}>Show 50 more warehouses ({(model.rows.length - showLimit).toLocaleString()} hidden)</button>}</>}
      {model.status !== "ready" && <div style={{ marginTop:12, display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(135px,1fr))", gap:7 }}>{[
        ["No scoped rows", exclusions.noRows], ["Too few periods", exclusions.lowPeriods], ["No availability", exclusions.noAvailability], ["Below minimum units", exclusions.lowUnits], ["No demographics", exclusions.noDemographics],
      ].map(([label, value]) => <div key={label} style={{ padding:"8px 10px", background:C.bg, border:`1px solid ${C.border}`, borderRadius:6 }}><div style={{ ...MONO, color:C.muted, fontSize:9 }}>{label}</div><div style={{ ...MONO, color:C.text, marginTop:3 }}>{Number(value || 0).toLocaleString()}</div></div>)}</div>}
      {model.status === "ready" && <>
        {selId && !selectedRow && <div style={{ padding:"9px 11px", marginBottom:12, background:C.warnFade, border:`1px solid ${C.warn}44`, borderRadius:7, color:C.text }}>The selected warehouse is outside the current affinity thresholds.</div>}
        {selectedRow && <div className="bi-kpi-grid" style={{ display:"grid", gridTemplateColumns:"repeat(4,minmax(145px,1fr))", gap:8, margin:"14px 0" }}><CompactMetric label="Availability" value={`${Number(selectedRow.availablePeriods || 0)} / ${Number(selectedRow.observedPeriods || 0)} periods`} sub={selectedRow.inventoryObserved ? "available / observed · inventory observed" : "available / observed reporting periods"} color={C.blue}/><CompactMetric label="Inventory evidence" value={selectedRow.inventoryObserved ? "Observed" : "Unavailable"} color={selectedRow.inventoryObserved ? C.green : C.warn}/><CompactMetric label="Percentile" value={`${Number(selectedRow.affinityPercentile || 0).toFixed(0)}th`} sub="within qualified cohort" color={C.accent}/><CompactMetric label="Portfolio" value={selectedRow.portfolioQualified ? `${Number(selectedRow.portfolioFactor || 0).toFixed(2)}×` : "Not qualified"} sub="portfolio strength factor" color={selectedRow.portfolioQualified ? C.purple : C.muted}/></div>}
        {reading.available && <div style={{ padding:"10px 12px", background:C.bg, border:`1px solid ${C.border}`, borderRadius:7, marginBottom:14, lineHeight:1.6 }}><strong>Leader:</strong> {reading.leader?.name || "N/A"} ({Number(reading.leader?.affinityIndex || 0).toFixed(0)}) · <strong>Watch:</strong> {reading.watch?.name || "N/A"} ({Number(reading.watch?.affinityIndex || 0).toFixed(0)}) · <strong>Repeatable signals:</strong> {Number(reading.repeatableSignals || 0)} of {Number(reading.testedCharacteristics || 0)} tested characteristics.</div>}
        {signals.length > 0 && <div style={{ overflowX:"auto", marginTop:14 }}><div style={{ ...MONO, color:C.muted, fontSize:9, marginBottom:8 }}>Market characteristic signals</div><table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}><thead><tr>{["Characteristic","Direction","Rho","Top quartile","Cohort","Confidence"].map((heading, index) => <th key={heading} style={{ textAlign:index < 2 ? "left" : "right", padding:"0 8px 8px", borderBottom:`1px solid ${C.border}`, color:C.muted }}>{heading}</th>)}</tr></thead><tbody>{signals.map(signal => <tr key={signal.key || signal.label}><td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}` }}>{signal.label}</td><td>{signal.direction}</td><td style={{ textAlign:"right" }}>{Number(signal.rho || 0).toFixed(2)}</td><td style={{ textAlign:"right" }}>{formatAffinitySignalValue(signal, signal.highAffinityMedian)}</td><td style={{ textAlign:"right" }}>{formatAffinitySignalValue(signal, signal.cohortMedian)}</td><td style={{ textAlign:"right" }}><StatusChip label={signal.confidence} col={signal.confidence === "high" ? C.green : signal.confidence === "medium" ? C.blue : C.muted}/></td></tr>)}</tbody></table></div>}
      </>}
    </Panel>
  );
}

export function CompactComparisonView({ model, analysisOptions = {}, setAnalysisOptions = () => {}, compareA = "", compareB = "", productMeta = {} }) {
  const { lang, t, label:uiLabel } = useUiText();
  const [limit, setLimit] = useState(24);
  const update = (key, value, extra = {}) => { setLimit(24); setAnalysisOptions(previous => ({ ...previous, [key]:value, ...extra })); };
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  const totals = model?.totals || {};
  const scope = model?.scope || {};
  const metric = scope.metric || analysisOptions.compareMetric || "rev";
  const formatter = value => metric === "units" ? Math.round(Number(value || 0)).toLocaleString() : metric === "unitsDoorDay" ? Number(value || 0).toFixed(2) : fmtCompactMoney(Number(value || 0));
  const metricLabel = metric === "units" ? "Units" : metric === "revDoor" ? "Revenue / Door" : metric === "unitsDoorDay" ? "Units / Door / Day" : "Revenue";
  const labelA = model?.labels?.a || productLabelForValue(compareA, productMeta) || "Baseline";
  const labelB = model?.labels?.b || productLabelForValue(compareB, productMeta) || "Comparison";
  const visibleRows = rows.slice(0, limit);
  return (
    <Panel title="Campaign Comparison Histogram">
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))", gap:8, marginBottom:14 }}>
        <label><div style={{ ...MONO, fontSize:9, color:C.muted }}>{uiLabel("Breakdown")}</div><select value={scope.bucket || analysisOptions.compareBucket || "warehouse"} onChange={event => update("compareBucket", event.target.value)} style={SELECT}><option value="warehouse">Warehouse</option><option value="state">State</option><option value="region">Region</option></select></label>
        <label><div style={{ ...MONO, fontSize:9, color:C.muted }}>{uiLabel("Metric")}</div><select value={metric} onChange={event => update("compareMetric", event.target.value)} style={SELECT}><option value="rev">Revenue</option><option value="revDoor">Revenue / Door</option><option value="units">Units</option><option value="unitsDoorDay">Units / Door / Day</option></select></label>
        <label><div style={{ ...MONO, fontSize:9, color:C.muted }}>{uiLabel("Normalize")}</div><select value={scope.normMode || analysisOptions.compareNormMode || "sellingAge"} onChange={event => update("compareNormMode", event.target.value)} style={SELECT}><option value="sellingAge">{lang === "ko" ? "같은 활성 판매 기간" : "Same active-sales window"}</option><option value="calendar">{lang === "ko" ? "같은 달력 날짜" : "Same calendar dates"}</option></select></label>
        <label><div style={{ ...MONO, fontSize:9, color:C.muted }}>{uiLabel("Min Units")}</div><select value={Number(scope.minUnits ?? analysisOptions.compareMinUnits ?? ANALYSIS_MIN_SELLING_UNITS)} onChange={event => update("compareMinUnits", Number(event.target.value))} style={SELECT}>{ANALYSIS_MIN_SELLING_UNIT_OPTIONS.map(value => <option key={value} value={value}>{value ? `${value.toLocaleString()}+ ${t("common.units", "units")}` : t("common.noMinimum", "No minimum")}</option>)}</select></label>
        <label><div style={{ ...MONO, fontSize:9, color:C.muted }}>{uiLabel("Region")}</div><select value={scope.region || ""} onChange={event => update("compareRegion", event.target.value, { compareState:"" })} style={SELECT}><option value="">{uiLabel("All Regions")}</option>{(model?.regions || []).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><div style={{ ...MONO, fontSize:9, color:C.muted }}>{uiLabel("State")}</div><select value={scope.state || ""} onChange={event => update("compareState", event.target.value)} style={SELECT}><option value="">{uiLabel("All States")}</option>{(model?.states || []).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><div style={{ ...MONO, fontSize:9, color:C.muted }}>{uiLabel("Start")}</div><input type="date" value={scope.from || ""} min={model?.dateBounds?.start || ""} max={scope.to || model?.dateBounds?.end || ""} onChange={event => update("compareFrom", event.target.value)} style={INP}/></label>
        <label><div style={{ ...MONO, fontSize:9, color:C.muted }}>{uiLabel("End")}</div><input type="date" value={scope.to || ""} min={scope.from || model?.dateBounds?.start || ""} max={model?.dateBounds?.end || ""} onChange={event => update("compareTo", event.target.value)} style={INP}/></label>
      </div>
      <div style={{ padding:"10px 12px", background:C.bg, border:`1px solid ${C.border}`, borderRadius:7, marginBottom:14, fontSize:10, color:C.muted, lineHeight:1.6 }}>
        <div><strong style={{ color:C.text }}>Baseline window:</strong> {scope.windowA?.start || "N/A"} to {scope.windowA?.end || "N/A"} · <strong style={{ color:C.text }}>Comparison window:</strong> {scope.windowB?.start || "N/A"} to {scope.windowB?.end || "N/A"}</div>
        <div><strong style={{ color:C.text }}>Coverage:</strong> {labelA} {Number(totals.baselineStores || 0)} stores · {labelB} {Number(totals.comparisonStores || 0)} stores · Matched {Number(totals.matched || 0)} · Baseline only {Number(totals.baselineOnly || 0)} · Comparison only {Number(totals.comparisonOnly || 0)} · Below minimum units {Number(totals.lowVolume || 0)}</div>
        <div>Matched warehouses clear the {Number(scope.minUnits || 0).toLocaleString()}-unit minimum for both campaigns before the selected metric is compared.</div>
      </div>
      <div className="bi-kpi-grid" style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:10, marginBottom:14 }}>
        <CompactMetric label={labelA} value={formatter(totals.a)} sub={metricLabel} color={C.blue}/><CompactMetric label={labelB} value={formatter(totals.b)} sub={metricLabel} color={C.accent}/><CompactMetric label="Delta" value={`${Number(totals.delta || 0) >= 0 ? "+" : "-"}${formatter(Math.abs(Number(totals.delta || 0)))}`} sub={metricLabel} color={Number(totals.delta || 0) >= 0 ? C.green : C.red}/><CompactMetric label="Matched Warehouses" value={Number(totals.matched || 0).toLocaleString()} color={C.text}/><CompactMetric label="Buckets Ahead" value={Number(totals.ahead || 0).toLocaleString()} sub={`${Number(totals.behind || 0)} behind / ${Number(totals.tied || 0)} tied`} color={C.green}/>
      </div>
      {visibleRows.length ? <><ResponsiveContainer width="100%" height={360}><BarChart data={visibleRows} margin={{ top:8, right:10, bottom:80, left:0 }}><CartesianGrid stroke={C.border} strokeDasharray="2 5" vertical={false}/><XAxis dataKey="label" tick={{fontSize:10,fill:C.muted}} angle={-35} textAnchor="end" interval={0} axisLine={false} tickLine={false}/><YAxis tick={{fontSize:10,fill:C.muted}} axisLine={false} tickLine={false} tickFormatter={formatter}/><Tooltip formatter={(value, name) => [formatter(value), name === "a" ? labelA : labelB]}/><Bar dataKey="a" name={labelA} fill={C.blue} radius={[3,3,0,0]} opacity={0.78}/><Bar dataKey="b" name={labelB} fill={C.accent} radius={[3,3,0,0]} opacity={0.86}/></BarChart></ResponsiveContainer><div style={{ display:"flex", justifyContent:"flex-end", margin:"10px 0" }}><SmBtn onClick={() => downloadRowsCsv("product-comparison.csv", [{ label:"Bucket", value:row => row.label }, { label:labelA, value:row => row.a }, { label:labelB, value:row => row.b }, { label:"Delta", value:row => row.delta }, { label:"Winner", value:row => row.winner }], rows)}>{t("common.exportCsv", "Export CSV")}</SmBtn></div><div style={{ overflowX:"auto" }}><table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}><thead><tr>{["Bucket",labelA,labelB,"Delta","Winner"].map((heading, index) => <th key={heading} style={{ textAlign:index ? "right" : "left", padding:"0 8px 8px", borderBottom:`1px solid ${C.border}`, color:C.muted }}>{heading}</th>)}</tr></thead><tbody>{visibleRows.map(row => <tr key={row.key}><td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}` }}><div>{row.label}</div><div style={{ color:C.muted }}>{row.sub}</div></td><td style={{ textAlign:"right" }}>{formatter(row.a)}</td><td style={{ textAlign:"right" }}>{formatter(row.b)}</td><td style={{ textAlign:"right", color:row.delta >= 0 ? C.green : C.red }}>{row.delta >= 0 ? "+" : "-"}{formatter(Math.abs(row.delta))}</td><td style={{ textAlign:"right" }}>{row.winner === "comparison" ? labelB : row.winner === "baseline" ? labelA : "Tie"}</td></tr>)}</tbody></table></div>{rows.length > limit && <button onClick={() => setLimit(value => Math.min(value + 50, rows.length))}>Show 50 more buckets ({(rows.length - limit).toLocaleString()} hidden)</button>}</> : <div style={{ padding:16, color:C.muted, background:C.bg, border:`1px solid ${C.border}`, borderRadius:8 }}>No matched warehouses have data for both selected products in this geography and date range.</div>}
    </Panel>
  );
}

export function CompactEventsView({ model }) {
  const { t, label:uiLabel } = useUiText();
  const [limit, setLimit] = useState(18);
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  const typeRows = Array.isArray(model?.typeRows) ? model.typeRows : [];
  const summary = model?.summary || {};
  const visibleRows = rows.slice(0, limit);
  const eventColor = row => row.lift === null ? C.muted : row.lift >= 15 ? C.green : row.lift <= -15 ? C.red : C.blue;
  const maxTypeDelta = Math.max(1, ...typeRows.map(row => Math.abs(Number(row.delta || 0))));
  return (
    <Panel title="Event Impact Report">
      <div className="bi-kpi-grid" style={{ display:"grid", gridTemplateColumns:"repeat(4,minmax(145px,1fr))", gap:8, marginBottom:14 }}><CompactMetric label={uiLabel("Tracked Events")} value={Number(summary.tracked || 0).toLocaleString()} sub="TPD, Markdown, Promo, Demo, Seasonal, Meta" color={C.accent}/><CompactMetric label={uiLabel("Comparable")} value={Number(summary.comparable || 0).toLocaleString()} sub="Has pre/post sales windows" color={C.blue}/><CompactMetric label={uiLabel("Positive Lift")} value={Number(summary.positive || 0).toLocaleString()} sub="Post 7D > prior 7D" color={C.green}/><CompactMetric label={uiLabel("Sales Drag")} value={Number(summary.negative || 0).toLocaleString()} sub="Post 7D < prior 7D" color={C.red}/></div>
      {rows.length ? <><div className="bi-two-col" style={{ display:"grid", gridTemplateColumns:"minmax(0,0.9fr) minmax(0,1.1fr)", gap:14, marginBottom:14 }}><div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:13 }}><div style={{ ...MONO, fontSize:9, color:C.muted, marginBottom:10 }}>IMPACT BY TYPE</div>{typeRows.map(row => <div key={row.type} style={{ display:"grid", gridTemplateColumns:"92px minmax(0,1fr) 84px", gap:10, alignItems:"center", marginBottom:8 }}><div style={{ color:FN_TYPES[row.type]?.col || C.accent, ...MONO, fontSize:10 }}>{uiLabel(row.label)}</div><div style={{ height:5, background:C.card, borderRadius:4 }}><div style={{ height:"100%", width:`${Math.min(100, Math.max(4, Math.abs(Number(row.delta || 0)) / maxTypeDelta * 100))}%`, background:Number(row.delta || 0) >= 0 ? C.green : C.red }}/></div><div style={{ textAlign:"right", ...MONO, fontSize:10, color:Number(row.delta || 0) >= 0 ? C.green : C.red }}>{fmtGrowth(row.lift)}</div></div>)}</div><div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:13 }}><div style={{ ...MONO, fontSize:9, color:C.muted, marginBottom:10 }}>GENERATED READ</div><div style={{ fontSize:12, color:C.text, lineHeight:1.65 }}>{summary.top ? <>Strongest lift: <span style={{ color:C.green, fontWeight:500 }}>{summary.top.title}</span> drove {fmtCompactMoney(Number(summary.top.delta || 0))} more revenue in the 7-day post window.</> : "Impact report needs at least one event with a pre/post sales baseline."}</div><div style={{ marginTop:10, fontSize:11, color:C.muted }}>Window logic: compares 7 days before the event against event day plus the next 6 days. Store and product scope are respected when the calendar note includes them.</div></div></div><div style={{ display:"flex", justifyContent:"flex-end", marginBottom:10 }}><SmBtn onClick={() => downloadRowsCsv("event-impact-report.csv", [{ label:"Date", value:row => row.date }, { label:"Type", value:row => row.typeLabel }, { label:"Event", value:row => row.title }, { label:"Product", value:row => row.product }, { label:"Warehouse ID", value:row => row.wid }, { label:"Store", value:row => row.storeName }, { label:"Prior 7D Revenue", value:row => row.preRev }, { label:"Post 7D Revenue", value:row => row.postRev }, { label:"Revenue Lift", value:row => row.lift }, { label:"Status", value:row => row.status }], rows)}>{t("common.exportCsv", "Export CSV")}</SmBtn></div><div style={{ overflowX:"auto" }}><table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}><thead><tr>{["Event","Scope","Prior 7D","Post 7D","Lift","Units Lift","Status"].map((heading, index) => <th key={heading} style={{ textAlign:index < 2 ? "left" : "right", padding:"0 8px 8px", borderBottom:`1px solid ${C.border}`, color:C.muted }}>{heading}</th>)}</tr></thead><tbody>{visibleRows.map(row => <tr key={row.id || `${row.date}-${row.title}`}><td style={{ padding:"9px 8px", borderBottom:`1px solid ${C.border}` }}><div style={{ color:FN_TYPES[row.type]?.col || C.accent }}>{row.typeLabel} · {row.date}</div><div>{row.title}</div></td><td><div>{row.product}</div><div style={{ color:C.muted }}>{row.storeName}</div></td><td style={{ textAlign:"right" }}>{fmtCompactMoney(row.preRev)}</td><td style={{ textAlign:"right" }}>{fmtCompactMoney(row.postRev)}</td><td style={{ textAlign:"right", color:eventColor(row) }}>{fmtGrowth(row.lift)}</td><td style={{ textAlign:"right", color:eventColor({ lift:row.unitLift }) }}>{fmtGrowth(row.unitLift)}</td><td style={{ textAlign:"right" }}><StatusChip label={row.status} col={eventColor(row)}/></td></tr>)}</tbody></table></div>{rows.length > limit && <button onClick={() => setLimit(value => Math.min(value + 50, rows.length))}>Show 50 more events ({(rows.length - limit).toLocaleString()} hidden)</button>}</> : <div style={{ padding:16, color:C.muted, background:C.bg, border:`1px solid ${C.border}`, borderRadius:8 }}>Add calendar notes with Type set to TPD, Markdown, Promo, Demo, Seasonal, or Meta to generate event impact tracking here.</div>}
    </Panel>
  );
}
