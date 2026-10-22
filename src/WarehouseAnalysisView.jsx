import React, { useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import WarehouseCompetitors from './WarehouseCompetitors.jsx';

import {
  C,
  INP,
  MONO,
  Panel,
  SELECT,
  StatusChip,
  productLabelForValue,
  productWithMeta,
  productValuesMatch,
  useUiText,
} from "./ByouIntel.jsx";
import { campaignChannelSupports } from "./lib/campaignChannel.js";
import { isNonStoreWarehouse } from "./lib/dashboardScope.js";
import { ANALYSIS_COMPACT_SCHEMA } from "./lib/analysisCompact.js";
import { fetchRuntimeView, runtimeRequestUrl } from "./lib/runtimeRequest.js";

const profileCache = new Map();
const PROFILE_CACHE_MAX = 24;

function number(value, digits = 1) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? "N/A"
    : Number(value).toLocaleString(undefined, { maximumFractionDigits:digits });
}

function money(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? "N/A"
    : Number(value).toLocaleString(undefined, { style:"currency", currency:"USD", maximumFractionDigits:0 });
}

function csvCell(value) {
  const string = String(value ?? "");
  const safe = /^\s*[=+\-@]/.test(string) ? `'${string}` : string;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function downloadCsv(filename, columns, rows) {
  const body = [columns.map(column => csvCell(column.label)).join(",")]
    .concat(rows.map(row => columns.map(column => csvCell(column.value(row))).join(",")))
    .join("\r\n");
  const blob = new Blob([`\uFEFF${body}`], { type:"text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function warehouseLabel(warehouse = {}) {
  const numberLabel = warehouse.warehouseNo ? `#${warehouse.warehouseNo}` : "";
  const location = [warehouse.city, warehouse.st].filter(Boolean).join(", ");
  return [numberLabel, warehouse.name, location].filter(Boolean).join(" · ");
}

function confidenceColor(value) {
  return value === "established" ? C.green : value === "limited-evidence" ? C.warn : C.muted;
}

function tierLabel(value, copy) {
  return {
    "top-10":copy("Top 10%", "상위 10%"),
    "top-25":copy("Top 25%", "상위 25%"),
    "middle-50":copy("Middle 50%", "중간 50%"),
    "bottom-25":copy("Bottom 25%", "하위 25%"),
    "bottom-10":copy("Bottom 10%", "하위 10%"),
    "insufficient-evidence":copy("Not scored", "점수 없음"),
  }[value] || value;
}

function confidenceLabel(value, copy) {
  return {
    established:copy("Established", "충분한 근거"),
    "limited-evidence":copy("Limited Evidence", "제한된 근거"),
    "insufficient-evidence":copy("Insufficient Evidence", "근거 부족"),
  }[value] || value;
}

function SummaryMetric({ label, value, sub, color = C.text }) {
  return (
    <div className="bi-warehouse-summary-metric" style={{ borderTop:`2px solid ${color}`, padding:"10px 11px", borderRadius:7, background:C.bg, minWidth:0 }}>
      <div style={{ ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:0.65, fontSize:8, marginBottom:6 }}>{label}</div>
      <div style={{ ...MONO, color, fontSize:18, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{value}</div>
      {sub && <div style={{ color:C.muted, fontSize:9, lineHeight:1.35, marginTop:4 }}>{sub}</div>}
    </div>
  );
}

function shortDate(value, includeYear = false) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return value || "";
  return includeYear ? `${match[2]}/${match[1].slice(2)}` : `${match[2]}/${match[3]}`;
}

function denseDailyRows(points = []) {
  if (!points.length) return [];
  const byDate = new Map(points.map(point => [point.date, point]));
  const start = Date.parse(`${points[0].date}T00:00:00Z`);
  const end = Date.parse(`${points.at(-1).date}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const rows = [];
  for (let time = start; time <= end; time += 86400000) {
    const date = new Date(time).toISOString().slice(0, 10);
    const point = byDate.get(date);
    rows.push({ date, netUnits:point ? point.netUnits : null, revenue:point ? point.revenue : null });
  }
  return rows;
}

function WarehouseTrendTooltip({ active, payload, label, copy }) {
  const row = payload?.[0]?.payload;
  if (!active || !row || row.netUnits === null) return null;
  return (
    <div className="bi-warehouse-trend-tooltip">
      <strong>{label}</strong>
      <span>{copy("Net units", "순 유닛")}: {number(row.netUnits, 0)}</span>
      <span>{copy("Revenue", "매출")}: {money(row.revenue)}</span>
    </div>
  );
}

function WarehouseProductTrend({ trends = [], productMeta = {}, copy }) {
  const [selectedPid, setSelectedPid] = useState(trends[0]?.pid || "");
  useEffect(() => {
    if (!trends.some(row => row.pid === selectedPid)) setSelectedPid(trends[0]?.pid || "");
  }, [trends, selectedPid]);
  const selected = trends.find(row => row.pid === selectedPid) || trends[0];
  const chartRows = useMemo(() => denseDailyRows(selected?.points || []), [selected]);
  if (!selected) {
    return <div className="bi-warehouse-empty">{copy("No product has verified current availability and enough sales evidence in this scope.", "이 범위에서 현재 판매 가능성과 충분한 판매 근거가 확인된 제품이 없습니다.")}</div>;
  }
  const color = productWithMeta(selected.pid, productMeta)?.col || C.accent;
  const spansYears = selected.points[0]?.date?.slice(0, 4) !== selected.points.at(-1)?.date?.slice(0, 4);
  const totalUnits = selected.points.reduce((sum, point) => sum + Number(point.netUnits || 0), 0);
  const latestPoint = selected.points.at(-1);
  const availabilityLabel = selected.availabilityState === "verified-inventory"
    ? copy("Positive inventory verified", "양수 재고 확인")
    : copy("Sales verified", "판매 확인");
  return (
    <div className="bi-warehouse-trend" data-warehouse-product-trend="true">
      <div className="bi-warehouse-trend-header">
        <label>
          <span>{copy("Product", "제품")}</span>
          <select value={selected.pid} onChange={event => setSelectedPid(event.target.value)} style={SELECT}>
            {trends.map(row => <option key={row.pid} value={row.pid}>{row.product}</option>)}
          </select>
        </label>
        <div className="bi-warehouse-trend-status"><span style={{ background:color }}/>{availabilityLabel} · {shortDate(selected.availableWeekEnd)}</div>
      </div>
      <div className="bi-warehouse-trend-stats">
        <span><strong>{number(totalUnits, 0)}</strong> {copy("net units", "순 유닛")}</span>
        <span><strong>{selected.observedDays}</strong> {copy("observed days", "관측 일수")}</span>
        <span><strong>{shortDate(latestPoint?.date)}</strong> {copy("latest observation", "최근 관측")}</span>
      </div>
      <div className="bi-warehouse-trend-chart" role="img" aria-label={copy(`Daily net unit sales for ${selected.product}. Missing dates are unknown, not zero.`, `${selected.product}의 일별 순 유닛 판매량입니다. 누락 날짜는 0이 아니라 알 수 없음입니다.`)}>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chartRows} margin={{ top:8, right:10, bottom:5, left:0 }}>
            <CartesianGrid stroke={C.border} strokeDasharray="2 5" vertical={false}/>
            <XAxis dataKey="date" tickFormatter={value => shortDate(value, spansYears)} tick={{ fontSize:9, fill:C.muted }} axisLine={false} tickLine={false} minTickGap={26}/>
            <YAxis tick={{ fontSize:9, fill:C.muted }} axisLine={false} tickLine={false} allowDecimals={false}/>
            <Tooltip content={<WarehouseTrendTooltip copy={copy}/>}/>
            <ReferenceLine y={0} stroke={C.muted} strokeWidth={1}/>
            <Bar dataKey="netUnits" fill={color} maxBarSize={16} radius={[2, 2, 0, 0]}/>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="bi-warehouse-trend-note">{copy("Daily net units are warehouse evidence, not official Costco totals. Gaps are unknown, and returns can make a day negative.", "일별 순 유닛은 웨어하우스 근거이며 공식 Costco 총계가 아닙니다. 공백은 알 수 없음이며 반품으로 일별 값이 음수가 될 수 있습니다.")}</p>
    </div>
  );
}

function WarehouseProfilePanel({ warehouseId, query, productKey, productMeta, onClose, onPublicationStale, returnFocusRef, copy }) {
  const [state, setState] = useState({ status:"loading", profile:null, error:"", stale:false });
  const [retry, setRetry] = useState(0);
  const closeRef = useRef(null);
  const layerRef = useRef(null);
  const dialogRef = useRef(null);
  const url = useMemo(() => warehouseId && query
    ? runtimeRequestUrl({ ...query, wid:warehouseId }, productKey)
    : "", [warehouseId, query, productKey]);

  useEffect(() => {
    if (!url || !warehouseId) return undefined;
    const cached = profileCache.get(url);
    if (cached) {
      setState({ status:"ready", profile:cached, error:"", stale:false });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status:"loading", profile:null, error:"", stale:false });
    fetchRuntimeView(url, { signal:controller.signal, expectedSchema:ANALYSIS_COMPACT_SCHEMA })
      .then(({ dataset }) => {
        if (dataset.section !== "warehouses" || dataset.result?.kind !== "warehouse-profile-v1") {
          throw new Error(copy("The warehouse profile response was not compatible.", "웨어하우스 프로필 응답이 호환되지 않습니다."));
        }
        if (query.publication && dataset.publishedAt !== query.publication) {
          throw Object.assign(new Error(copy("A newer publication is available. Refresh BYOU Intel.", "새 게시 버전이 있습니다. BYOU Intel을 새로고침하세요.")), { status:409 });
        }
        if (dataset.result.warehouse?.id !== warehouseId) {
          throw new Error(copy("The requested warehouse profile is unavailable in this scope.", "선택한 범위에서 웨어하우스 프로필을 사용할 수 없습니다."));
        }
        profileCache.set(url, dataset.result);
        while (profileCache.size > PROFILE_CACHE_MAX) profileCache.delete(profileCache.keys().next().value);
        setState({ status:"ready", profile:dataset.result, error:"", stale:false });
      })
      .catch(error => {
        if (error?.name === "AbortError") return;
        const stale = error?.status === 409;
        setState({
          status:"error",
          profile:null,
          stale,
          error:stale
            ? copy("The publication changed. Refresh BYOU Intel before retrying.", "게시 데이터가 변경되었습니다. 다시 시도하기 전에 BYOU Intel을 새로고침하세요.")
            : error?.message || copy("The warehouse profile could not be loaded.", "웨어하우스 프로필을 불러올 수 없습니다."),
        });
      });
    return () => controller.abort();
  }, [url, warehouseId, query, retry, copy]);

  useEffect(() => {
    const priorOverflow = document.body.style.overflow;
    const inerted = [];
    let branch = layerRef.current;
    while (branch?.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && !sibling.hasAttribute("inert")) {
          sibling.setAttribute("inert", "");
          inerted.push(sibling);
        }
      }
      branch = branch.parentElement;
    }
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = priorOverflow;
      inerted.forEach(element => element.removeAttribute("inert"));
      returnFocusRef?.current?.focus?.();
    };
  }, [onClose, returnFocusRef]);

  const profile = state.profile;
  const overall = profile?.overall;
  const campaignColumns = [
    { label:"Publication", value:() => query?.publication || "" },
    { label:"Scope Start", value:() => profile?.scope?.from || query?.from || "" },
    { label:"Scope End", value:() => profile?.scope?.to || query?.to || "" },
    { label:"Warehouse ID", value:() => profile?.warehouse?.id || warehouseId },
    { label:"Warehouse Number", value:() => profile?.warehouse?.warehouseNo || "" },
    { label:"Campaign ID", value:row => row.cid },
    { label:"Campaign", value:row => row.campaign },
    { label:"Product ID", value:row => row.pid },
    { label:"Product", value:row => row.product },
    { label:"Popularity Percentile", value:row => row.score ?? "" },
    { label:"Tier", value:row => row.tier },
    { label:"Net Units / Verified Week", value:row => row.velocity ?? "" },
    { label:"Verified Weeks", value:row => row.verifiedWeeks },
    { label:"Expected Weeks", value:row => row.expectedWeeks },
    { label:"Unknown Weeks", value:row => row.unknownWeeks },
    { label:"Sold-through Weeks Excluded", value:row => row.soldThroughWeeks },
    { label:"Net Units", value:row => row.netUnits },
    { label:"Revenue", value:row => row.revenue },
  ];
  const productColumns = [
    { label:"Publication", value:() => query?.publication || "" },
    { label:"Scope Start", value:() => profile?.scope?.from || query?.from || "" },
    { label:"Scope End", value:() => profile?.scope?.to || query?.to || "" },
    { label:"Warehouse ID", value:() => profile?.warehouse?.id || warehouseId },
    { label:"Warehouse Number", value:() => profile?.warehouse?.warehouseNo || "" },
    { label:"Product ID", value:row => row.pid },
    { label:"Product", value:row => row.product },
    { label:"Popularity Percentile", value:row => row.score ?? "" },
    { label:"Tier", value:row => row.tier },
    { label:"Confidence", value:row => row.confidence },
    { label:"Qualifying Campaigns", value:row => row.qualifyingCampaigns },
    { label:"Net Units / Verified Week", value:row => row.velocity ?? "" },
    { label:"Verified Weeks", value:row => row.verifiedWeeks },
    { label:"Coverage Percent", value:row => row.coveragePct },
    { label:"Net Units", value:row => row.netUnits },
    { label:"Revenue", value:row => row.revenue },
  ];

  return (
    <div ref={layerRef} className="bi-warehouse-profile-layer" data-warehouse-profile-state={state.status}>
      <button tabIndex={-1} className="bi-warehouse-profile-backdrop" aria-label={copy("Close warehouse profile", "웨어하우스 프로필 닫기")} onClick={onClose}/>
      <aside ref={dialogRef} className="bi-warehouse-profile" role="dialog" aria-modal="true" aria-labelledby="warehouse-profile-title" aria-busy={state.status === "loading"}>
        <div className="bi-warehouse-profile-header">
          <div style={{ minWidth:0 }}>
            <div style={{ ...MONO, fontSize:9, color:C.accent, textTransform:"uppercase", letterSpacing:0.8 }}>{copy("Warehouse Profile", "웨어하우스 프로필")}</div>
            <h2 id="warehouse-profile-title" style={{ margin:"5px 0 0", color:C.text, fontSize:18, lineHeight:1.25 }}>{profile?.warehouse ? warehouseLabel(profile.warehouse) : copy("Loading warehouse…", "웨어하우스 로딩 중…")}</h2>
          </div>
          <button ref={closeRef} onClick={onClose} aria-label={copy("Close", "닫기")} className="bi-warehouse-profile-close">×</button>
        </div>

        {state.status === "loading" && <div className="bi-warehouse-profile-state" role="status" aria-live="polite">{copy("Loading this warehouse's scoped profile…", "이 웨어하우스의 선택 범위 프로필을 불러오는 중…")}</div>}
        {state.status === "error" && (
          <div className="bi-warehouse-profile-state" role="alert">
            <div style={{ color:C.red, marginBottom:10 }}>{state.error}</div>
            <button onClick={() => {
              if (state.stale) {
                onClose();
                onPublicationStale?.();
                return;
              }
              profileCache.delete(url);
              setRetry(value => value + 1);
            }} className="bi-warehouse-action">{state.stale ? copy("Refresh Data", "데이터 새로고침") : copy("Retry", "다시 시도")}</button>
          </div>
        )}
        {state.status === "ready" && profile && (
          <div className="bi-warehouse-profile-body">
            <div className="sr-only" role="status" aria-live="polite">{copy("Warehouse profile loaded.", "웨어하우스 프로필을 불러왔습니다.")}</div>
            <div className="bi-warehouse-profile-metrics">
              <SummaryMetric label={copy("National Percentile", "전국 백분위")} value={overall?.score === null ? "N/A" : `${number(overall?.score)}%`} sub={overall?.nationalStanding?.rank ? `${copy("Rank", "순위")} ${overall.nationalStanding.rank} / ${overall.nationalStanding.total}` : copy("Not enough evidence", "근거 부족")} color={C.accent}/>
              <SummaryMetric label={copy("Regional Standing", "지역 순위")} value={overall?.regionalStanding?.rank ? `${overall.regionalStanding.rank} / ${overall.regionalStanding.total}` : "N/A"} sub={overall?.regionalStanding?.region || copy("Region unavailable", "지역 정보 없음")} color={C.blue}/>
              <SummaryMetric label={copy("Net Units / Verified Week", "검증 주당 순 유닛")} value={number(overall?.netUnitsPerVerifiedWeek)} sub={`${overall?.velocityVerifiedWeeks || 0} ${copy("contributing verified weeks", "계산에 포함된 검증 주")}`} color={C.green}/>
              <SummaryMetric label={copy("Raw Context", "원시 판매 컨텍스트")} value={number(overall?.rawNetUnits, 0)} sub={`${money(overall?.rawRevenue)} · ${copy("unadjusted rank", "미조정 순위")} ${overall?.rawRank || "N/A"}`} color={C.purple}/>
            </div>

            <div className="bi-warehouse-profile-actions">
              <button className="bi-warehouse-action" onClick={() => downloadCsv(`warehouse-${warehouseId}-campaign-history.csv`, campaignColumns, profile.campaignRows || [])}>{copy("Export Campaign History", "캠페인 이력 내보내기")}</button>
              <button className="bi-warehouse-action" onClick={() => downloadCsv(`warehouse-${warehouseId}-product-mix.csv`, productColumns, profile.productRows || [])}>{copy("Export Product Mix", "제품 구성 내보내기")}</button>
            </div>

            <section className="bi-warehouse-profile-section">
              <h3>{copy("Daily Product Sales", "제품별 일일 판매")}</h3>
              <WarehouseProductTrend trends={profile.dailyProductTrends || []} productMeta={productMeta} copy={copy}/>
            </section>

            <section className="bi-warehouse-profile-section">
              <h3>{copy("Product Mix", "제품 구성")}</h3>
              {!profile.productRows?.length ? <div className="bi-warehouse-empty">{copy("No product has enough evidence in this scope.", "이 범위에서 근거가 충분한 제품이 없습니다.")}</div> : (
                <div className="bi-warehouse-profile-table-wrap"><table className="bi-warehouse-profile-table">
                  <thead><tr><th>{copy("Product", "제품")}</th><th>{copy("Percentile", "백분위")}</th><th>{copy("Confidence", "근거 수준")}</th><th>{copy("Velocity", "속도")}</th><th>{copy("Net Units", "순 유닛")}</th></tr></thead>
                  <tbody>{profile.productRows.map(row => <tr key={row.pid}><td>{row.product}</td><td>{row.score === null ? "N/A" : `${number(row.score)}%`}</td><td>{confidenceLabel(row.confidence, copy)}</td><td>{number(row.velocity)}</td><td>{number(row.netUnits, 0)}</td></tr>)}</tbody>
                </table></div>
              )}
            </section>

            <section className="bi-warehouse-profile-section">
              <h3>{copy("Campaign History", "캠페인 이력")}</h3>
              {!profile.campaignRows?.length ? <div className="bi-warehouse-empty">{copy("No mapped physical-warehouse campaign evidence is available.", "매핑된 실제 웨어하우스 캠페인 근거가 없습니다.")}</div> : (
                <div className="bi-warehouse-profile-table-wrap"><table className="bi-warehouse-profile-table">
                  <thead><tr><th>{copy("Campaign", "캠페인")}</th><th>{copy("Percentile", "백분위")}</th><th>{copy("Verified Weeks", "검증 주")}</th><th>{copy("Velocity", "속도")}</th></tr></thead>
                  <tbody>{profile.campaignRows.map(row => <tr key={row.cid}><td><strong>{row.campaign}</strong><div>{row.product}</div></td><td>{row.score === null ? "N/A" : `${number(row.score)}%`}</td><td>{row.verifiedWeeks} / {row.expectedWeeks}</td><td>{number(row.velocity)}</td></tr>)}</tbody>
                </table></div>
              )}
            </section>

            <WarehouseCompetitors key={warehouseId} warehouseNo={String(profile.warehouse?.warehouseNo || '')} productKey={productKey} copy={copy}/>


          </div>
        )}
      </aside>
    </div>
  );
}

export default function WarehouseAnalysisView({
  model,
  analysisOptions = {},
  setAnalysisOptions = () => {},
  productOptions = [],
  campaignMeta = {},
  productMeta = {},
  whs = [],
  profileQuery = null,
  profileProductKey = "",
  onPublicationStale = () => {},
}) {
  const { lang } = useUiText();
  const copy = useMemo(() => (english, korean) => lang === "ko" ? korean : english, [lang]);
  const [search, setSearch] = useState("");
  const [selectedWarehouseId, setSelectedWarehouseId] = useState("");
  const [sort, setSort] = useState({ key:"rank", direction:"asc" });
  const profileTriggerRef = useRef(null);
  const rows = model?.kind === "warehouse-ranking-v1" ? model.rows || [] : [];
  const scope = model?.scope || {};
  const coverage = model?.coverage || {};
  const summary = model?.summary || {};
  const warehousePid = analysisOptions.warehousePid || "";
  const warehouseCid = analysisOptions.warehouseCid || "";

  const physicalCampaigns = useMemo(() => {
    const byId = new Map();
    for (const [key, value] of Object.entries(campaignMeta || {})) {
      const id = String(value?.id || key).trim();
      if (!id || byId.has(id) || !String(value?.channel || "").trim() || !campaignChannelSupports(value?.channel, "inline")) continue;
      byId.set(id, { ...value, id });
    }
    return [...byId.values()].sort((a, b) => String(b.start || "").localeCompare(String(a.start || "")) || String(a.short || a.name || a.id).localeCompare(String(b.short || b.name || b.id)));
  }, [campaignMeta]);
  const physicalProductOptions = useMemo(() => productOptions.filter(product => physicalCampaigns.some(campaign => productValuesMatch(campaign.pid, product.id, productMeta))), [productOptions, physicalCampaigns, productMeta]);
  const campaignOptions = useMemo(() => physicalCampaigns.filter(campaign => !warehousePid || productValuesMatch(campaign.pid, warehousePid, productMeta)), [physicalCampaigns, warehousePid, productMeta]);
  const retailWhs = useMemo(() => whs.filter(warehouse => !isNonStoreWarehouse(warehouse)), [whs]);
  const regionOptions = useMemo(() => [...new Set(retailWhs.map(warehouse => String(warehouse.region || "").trim()).filter(Boolean))].sort(), [retailWhs]);
  const stateOptions = useMemo(() => [...new Set(retailWhs.filter(warehouse => !analysisOptions.warehouseRegion || warehouse.region === analysisOptions.warehouseRegion).map(warehouse => String(warehouse.st || "").trim()).filter(Boolean))].sort(), [retailWhs, analysisOptions.warehouseRegion]);

  const update = values => setAnalysisOptions(previous => ({ ...previous, ...values }));
  const chooseProduct = pid => update({ warehousePid:pid, warehouseCid:"" });
  const chooseCampaign = cid => {
    const selected = physicalCampaigns.find(campaign => campaign.id === cid);
    update({ warehouseCid:cid, ...(selected ? { warehousePid:selected.pid } : {}) });
  };
  const chooseFrom = from => update({ warehouseFrom:from, ...(analysisOptions.warehouseTo && from > analysisOptions.warehouseTo ? { warehouseTo:from } : {}) });
  const chooseTo = to => update({ warehouseTo:to, ...(analysisOptions.warehouseFrom && to < analysisOptions.warehouseFrom ? { warehouseFrom:to } : {}) });
  const chooseRegion = region => update({ warehouseRegion:region, warehouseState:"" });
  const resetFilters = () => {
    setSearch("");
    update({ warehousePid:"", warehouseCid:"", warehouseFrom:"", warehouseTo:"", warehouseRegion:"", warehouseState:"" });
  };

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const visible = query ? rows.filter(row => warehouseLabel(row.warehouse).toLowerCase().includes(query)) : rows;
    const value = row => {
      if (sort.key === "warehouse") return warehouseLabel(row.warehouse).toLowerCase();
      if (sort.key === "tier") return ({ "insufficient-evidence":0, "bottom-10":1, "bottom-25":2, "middle-50":3, "top-25":4, "top-10":5 })[row.tier] ?? -1;
      if (sort.key === "confidence") return ({ "insufficient-evidence":0, "limited-evidence":1, established:2 })[row.confidence] ?? -1;
      if (sort.key === "strongestProduct") return row.strongestProduct?.product || "";
      return row[sort.key];
    };
    return visible.slice().sort((a, b) => {
      const left = value(a);
      const right = value(b);
      const emptyLeft = left === null || left === undefined || left === "";
      const emptyRight = right === null || right === undefined || right === "";
      if (emptyLeft !== emptyRight) return emptyLeft ? 1 : -1;
      const delta = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right), undefined, { numeric:true });
      return (sort.direction === "asc" ? delta : -delta) || warehouseLabel(a.warehouse).localeCompare(warehouseLabel(b.warehouse), undefined, { numeric:true });
    });
  }, [rows, search, sort]);

  const groupedRows = useMemo(() => {
    const groups = [
      ["established", filteredRows.filter(row => row.confidence === "established")],
      ["limited-evidence", filteredRows.filter(row => row.confidence === "limited-evidence")],
      ["insufficient-evidence", filteredRows.filter(row => row.confidence === "insufficient-evidence")],
    ];
    return sort.key === "confidence" && sort.direction === "asc" ? groups.reverse() : groups;
  }, [filteredRows, sort.key, sort.direction]);
  const displayedRows = useMemo(() => groupedRows.flatMap(([, group]) => group), [groupedRows]);

  const changeSort = key => setSort(previous => previous.key === key
    ? { key, direction:previous.direction === "asc" ? "desc" : "asc" }
    : { key, direction:["rank", "warehouse", "strongestProduct"].includes(key) ? "asc" : "desc" });
  const sortMark = key => sort.key === key ? (sort.direction === "asc" ? " ↑" : " ↓") : "";
  const leaderboardColumns = [
    { label:"Rank", value:row => row.rank ?? "" },
    { label:"Warehouse ID", value:row => row.warehouse?.id },
    { label:"Warehouse Number", value:row => row.warehouse?.warehouseNo },
    { label:"Warehouse", value:row => row.warehouse?.name },
    { label:"City", value:row => row.warehouse?.city },
    { label:"State", value:row => row.warehouse?.st },
    { label:"Region", value:row => row.warehouse?.region },
    { label:"Popularity Percentile", value:row => row.score ?? "" },
    { label:"Tier", value:row => row.tier },
    { label:"Net Units / Verified Week", value:row => row.netUnitsPerVerifiedWeek ?? "" },
    { label:"Qualifying Campaigns", value:row => row.qualifyingCampaigns },
    { label:"Confidence", value:row => row.confidence },
    { label:"Strongest Product", value:row => row.strongestProduct?.product || "" },
    { label:"Raw Net Units", value:row => row.rawNetUnits },
    { label:"Raw Revenue", value:row => row.rawRevenue },
    { label:"Unadjusted Rank", value:row => row.rawRank ?? "" },
    { label:"Verified Weeks", value:row => row.verifiedWeeks },
    { label:"Expected Weeks", value:row => row.expectedWeeks },
    { label:"Coverage Percent", value:row => row.coveragePct },
  ];

  if (!model || model.kind !== "warehouse-ranking-v1") {
    return <Panel title={copy("Warehouse Popularity", "웨어하우스 인기도")}><div className="bi-warehouse-empty">{copy("Warehouse analysis is not available for this scope.", "이 범위에서는 웨어하우스 분석을 사용할 수 없습니다.")}</div></Panel>;
  }

  return (
    <>
      <Panel title={copy("Warehouse Popularity", "웨어하우스 인기도")}>
        <div className="bi-warehouse-intro">
          <div>
            <strong>{copy("National comparison, evidence-aware.", "전국 비교, 근거 수준 반영.")}</strong>
            <div>{copy("Popularity compares net units per verified availability week. Geography narrows this list without changing national percentiles.", "인기도는 검증된 판매 가능 주당 순 유닛을 비교합니다. 지역 필터는 목록만 좁히며 전국 백분위는 변경하지 않습니다.")}</div>
          </div>
          <div className="bi-warehouse-profile-actions">
            <button className="bi-warehouse-action" onClick={resetFilters}>{copy("Reset Filters", "필터 초기화")}</button>
            <button className="bi-warehouse-action" onClick={() => downloadCsv("warehouse-popularity-leaderboard.csv", leaderboardColumns, displayedRows)}>{copy("Export Leaderboard", "리더보드 내보내기")}</button>
          </div>
        </div>

        <div className="bi-warehouse-filters" data-warehouse-filter-count="6">
          <label><span>{copy("Product", "제품")}</span><select value={warehousePid} onChange={event => chooseProduct(event.target.value)} style={SELECT}><option value="">{copy("All Products", "전체 제품")}</option>{physicalProductOptions.map(product => <option key={product.id} value={product.id}>{product.short}</option>)}</select></label>
          <label><span>{copy("Campaign", "캠페인")}</span><select value={warehouseCid} onChange={event => chooseCampaign(event.target.value)} style={SELECT}><option value="">{copy("All Campaigns", "전체 캠페인")}</option>{campaignOptions.map(campaign => <option key={campaign.id} value={campaign.id}>{[productLabelForValue(campaign.pid, productMeta), campaign.short || campaign.name, campaign.start].filter(Boolean).join(" / ")}</option>)}</select></label>
          <label><span>{copy("Start Date", "시작일")}</span><input type="date" value={analysisOptions.warehouseFrom || scope.from || ""} min={scope.availableFrom || undefined} max={analysisOptions.warehouseTo || scope.availableTo || undefined} onChange={event => chooseFrom(event.target.value)} style={INP}/></label>
          <label><span>{copy("End Date", "종료일")}</span><input type="date" value={analysisOptions.warehouseTo || scope.to || ""} min={analysisOptions.warehouseFrom || scope.availableFrom || undefined} max={scope.availableTo || undefined} onChange={event => chooseTo(event.target.value)} style={INP}/></label>
          <label><span>{copy("Region", "지역")}</span><select value={analysisOptions.warehouseRegion || ""} onChange={event => chooseRegion(event.target.value)} style={SELECT}><option value="">{copy("All Regions", "전체 지역")}</option>{regionOptions.map(region => <option key={region} value={region}>{region}</option>)}</select></label>
          <label><span>{copy("State", "주")}</span><select value={analysisOptions.warehouseState || ""} onChange={event => update({ warehouseState:event.target.value })} style={SELECT}><option value="">{copy("All States", "전체 주")}</option>{stateOptions.map(state => <option key={state} value={state}>{state}</option>)}</select></label>
          <label className="bi-warehouse-search"><span>{copy("Warehouse Search", "웨어하우스 검색")}</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder={copy("Number, name, city, or state", "번호, 이름, 도시 또는 주")} style={INP}/></label>
        </div>

        <div className="bi-warehouse-summary-strip">
          <SummaryMetric label={copy("Eligible Warehouses", "대상 웨어하우스")} value={summary.eligibleWarehouses || 0} sub={`${coverage.nationalRetailWarehouses || 0} ${copy("national retail identities", "전국 소매점 식별자")}`} color={C.blue}/>
          <SummaryMetric label={copy("Evidence Mix", "근거 구성")} value={`${summary.established || 0} / ${summary.limitedEvidence || 0}`} sub={copy("Established / Limited Evidence", "충분한 근거 / 제한된 근거")} color={C.green}/>
          <SummaryMetric label={copy("Highest Established", "근거 충분 그룹 최고") } value={summary.highest?.score === null || !summary.highest ? "N/A" : `${number(summary.highest.score)}%`} sub={summary.highest ? warehouseLabel(summary.highest.warehouse) : copy("No established result", "충분한 근거 결과 없음")} color={C.accent}/>
          <SummaryMetric label={copy("Lowest Established", "근거 충분 그룹 최저") } value={summary.lowest?.score === null || !summary.lowest ? "N/A" : `${number(summary.lowest.score)}%`} sub={summary.lowest ? warehouseLabel(summary.lowest.warehouse) : copy("No established result", "충분한 근거 결과 없음")} color={C.orange}/>
          <SummaryMetric label={copy("Verified-week Coverage", "검증 주 커버리지")} value={`${number(coverage.verifiedWeekPct)}%`} sub={`${number(coverage.verifiedWeeks, 0)} / ${number(coverage.expectedWeeks, 0)} ${copy("weeks", "주")}`} color={C.purple}/>
        </div>

        {!rows.length ? (
          <div className="bi-warehouse-empty" data-warehouse-empty-state="insufficient-evidence">
            <strong>{copy("No warehouse has evidence in this scope.", "이 범위에 웨어하우스 근거가 없습니다.")}</strong>
            <div>{copy("Try a broader date or product scope. Unresolved campaign mappings are excluded rather than guessed.", "기간 또는 제품 범위를 넓혀 보세요. 해결되지 않은 캠페인 매핑은 추정하지 않고 제외됩니다.")}</div>
          </div>
        ) : (
          <div className="bi-warehouse-table-wrap">
            <table className="bi-warehouse-table" data-warehouse-leaderboard>
              <thead><tr>
                {[
                  ["rank", copy("Rank", "순위")],
                  ["warehouse", copy("Warehouse", "웨어하우스")],
                  ["score", copy("Popularity", "인기도")],
                  ["tier", copy("Tier", "등급")],
                  ["netUnitsPerVerifiedWeek", copy("Net Units / Verified Week", "검증 주당 순 유닛")],
                  ["qualifyingCampaigns", copy("Campaigns", "캠페인")],
                  ["confidence", copy("Confidence", "근거 수준")],
                  ["strongestProduct", copy("Strongest Product", "강세 제품")],
                ].map(([key, label]) => <th key={key} scope="col" aria-sort={sort.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}><button onClick={() => changeSort(key)} aria-label={`${copy("Sort by", "정렬 기준")} ${label}`}>{label}{sortMark(key)}</button></th>)}
              </tr></thead>
              {groupedRows.map(([confidence, group]) => group.length ? (
                <tbody key={confidence} data-evidence-group={confidence}>
                  <tr className="bi-warehouse-group-row"><th scope="rowgroup" colSpan="8">{confidenceLabel(confidence, copy)} · {group.length}</th></tr>
                  {group.map(row => <tr key={row.warehouse.id} data-warehouse-id={row.warehouse.id}>
                    <td>{row.rank || "—"}</td>
                    <td><button className="bi-warehouse-row-button" onClick={event => { profileTriggerRef.current = event.currentTarget; setSelectedWarehouseId(row.warehouse.id); }}><strong>{row.warehouse.name}</strong><span>{[row.warehouse.warehouseNo ? `#${row.warehouse.warehouseNo}` : "", row.warehouse.city, row.warehouse.st, row.warehouse.region].filter(Boolean).join(" · ")}</span></button></td>
                    <td>{row.score === null ? "N/A" : <strong>{number(row.score)}%</strong>}</td>
                    <td>{tierLabel(row.tier, copy)}</td>
                    <td>{number(row.netUnitsPerVerifiedWeek)}</td>
                    <td>{row.qualifyingCampaigns}</td>
                    <td><StatusChip label={confidenceLabel(row.confidence, copy)} col={confidenceColor(row.confidence)}/></td>
                    <td>{row.strongestProduct?.product || "—"}</td>
                  </tr>)}
                </tbody>
              ) : null)}
            </table>
          </div>
        )}

        <div className="bi-warehouse-disclosure">
          {copy("This is an analytical popularity metric, not official Costco total sales and not an automatic Include/Exclude recommendation.", "이 지표는 분석용 인기도 지표이며 Costco 공식 총매출 또는 자동 포함/제외 추천이 아닙니다.")}
          {coverage.unresolvedCampaignRows > 0 && <> · {number(coverage.unresolvedCampaignRows, 0)} {copy("unresolved rows excluded", "미해결 행 제외")}</>}
          {coverage.unknownWeeks > 0 && <> · {number(coverage.unknownWeeks, 0)} {copy("unknown weeks lowered coverage", "미확인 주로 커버리지 감소")}</>}
        </div>
      </Panel>

      {selectedWarehouseId && <WarehouseProfilePanel warehouseId={selectedWarehouseId} query={profileQuery} productKey={profileProductKey} productMeta={productMeta} onClose={() => setSelectedWarehouseId("")} onPublicationStale={onPublicationStale} returnFocusRef={profileTriggerRef} copy={copy}/>}
    </>
  );
}

export const warehouseAnalysisViewInternals = Object.freeze({ csvCell, downloadCsv, warehouseLabel });
