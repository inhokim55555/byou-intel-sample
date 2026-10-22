import { useMemo, useEffect } from "react";
import _ from "lodash";
import { ResponsiveContainer, LineChart, CartesianGrid, XAxis, YAxis, Tooltip, Line } from "recharts";
import { useUiText, VIDEO_METRICS, productValuesMatch, rowMatchesCampaignScope, VIDEO_CHANGE_METRICS, productWithMeta, productDisplayName, C, metricGrowth, videoDisplayName, fmtCurrency, SANS, Panel, MONO, fmtMetricDelta, safeExternalHttpUrl, CARD_METRICS, fmtGrowth } from "../../ui/dashboardShared.jsx";

export default function VideosView({ videos, videoMetrics, selPid, selPlatform, selType, dateRange, selVid, setSelVid, selMetric, setSelMetric, productMeta = {}, campaignId = "" }) {
  const { lang, t } = useUiText();
  const metricDef = VIDEO_METRICS.find(m => m.key === selMetric) || VIDEO_METRICS[0];

  const metricsInRange = useMemo(() =>
    videoMetrics.filter(m => (!dateRange?.start || m.date >= dateRange.start) && (!dateRange?.end || m.date <= dateRange.end))
  , [videoMetrics, dateRange]);

  const vidIdsInRange = useMemo(() => new Set(metricsInRange.map(m => m.vid)), [metricsInRange]);

  const firstSnapshotByVid = useMemo(() => {
    const map = new Map();
    videoMetrics.forEach(m => {
      if (!m.vid || !m.date) return;
      const prev = map.get(m.vid);
      if (!prev || m.date < prev.date) map.set(m.vid, m);
    });
    return map;
  }, [videoMetrics]);

  // Filter videos by product + type + platform
  const filteredVideos = useMemo(() =>
    videos.filter(v => (!selPid || productValuesMatch(v.pid, selPid, productMeta)) && rowMatchesCampaignScope(v, campaignId) && (!selType || v.type === selType) && (!selPlatform || v.platform === selPlatform) && vidIdsInRange.has(v.id))
  , [videos, selPid, campaignId, selType, selPlatform, vidIdsInRange, productMeta]);

  useEffect(() => {
    if (selVid && !filteredVideos.some(v => v.id === selVid)) setSelVid(null);
  }, [selVid, filteredVideos, setSelVid]);

  // All snapshot dates in chronological order
  const snapDates = useMemo(() =>
    [...new Set(metricsInRange.map(m => m.date))].sort()
  , [metricsInRange]);

  const chartSelVid = filteredVideos.some(v => v.id === selVid) ? selVid : null;

  // Line chart data
  const chartData = useMemo(() => {
    if (chartSelVid) {
      // Single video trend over time
      const vMetrics = metricsInRange.filter(m => m.vid === chartSelVid);
      return snapDates
        .map(date => ({ date:date.slice(5), value:vMetrics.find(m => m.date===date)?.[selMetric] ?? null }))
        .filter(d => d.value !== null);
    }
    // Aggregate across all filtered videos
    const vidIds = new Set(filteredVideos.map(v => v.id));
    return snapDates.map(date => {
      const snaps = metricsInRange.filter(m => vidIds.has(m.vid) && m.date === date);
      if (!snaps.length) return null;
      const value = _.sumBy(snaps, selMetric);
      return { date:date.slice(5), value };
    }).filter(Boolean);
  }, [metricsInRange, chartSelVid, selMetric, filteredVideos, snapDates]);

  const changeSummary = useMemo(() => {
    const ids = new Set(chartSelVid ? [chartSelVid] : filteredVideos.map(v => v.id));
    const range = Object.fromEntries(VIDEO_CHANGE_METRICS.map(m => [m.key, 0]));
    const latest = Object.fromEntries(VIDEO_CHANGE_METRICS.map(m => [m.key, 0]));
    let firstDate = "";
    let lastDate = "";
    let latestDate = "";
    let previousDate = "";
    let rangeVideos = 0;
    let latestVideos = 0;
    const scopedInRange = metricsInRange.filter(m => ids.has(m.vid) && m.date);
    const scopedAll = videoMetrics.filter(m => ids.has(m.vid) && m.date);
    latestDate = _.max(scopedInRange.map(m => m.date)) || "";
    previousDate = latestDate ? (_.max(scopedAll.map(m => m.date).filter(date => date < latestDate)) || "") : "";
    Object.values(_.groupBy(scopedInRange, "vid")).forEach(groupRows => {
      const sorted = _.sortBy(groupRows, "date");
      if (!sorted.length) return;
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      firstDate = !firstDate || first.date < firstDate ? first.date : firstDate;
      lastDate = !lastDate || last.date > lastDate ? last.date : lastDate;
      if (sorted.length > 1) rangeVideos++;
      VIDEO_CHANGE_METRICS.forEach(metric => {
        range[metric.key] += Number(last[metric.key] || 0) - Number(first[metric.key] || 0);
      });
    });
    if (latestDate && previousDate) {
      const byVidDate = new Map(scopedAll.map(m => [`${m.vid}|${m.date}`, m]));
      ids.forEach(id => {
        const current = byVidDate.get(`${id}|${latestDate}`);
        const previous = byVidDate.get(`${id}|${previousDate}`);
        if (!current || !previous) return;
        latestVideos++;
        VIDEO_CHANGE_METRICS.forEach(metric => {
          latest[metric.key] += Number(current[metric.key] || 0) - Number(previous[metric.key] || 0);
        });
      });
    }
    const rangeWindow = firstDate && lastDate
      ? firstDate === lastDate ? firstDate : `${firstDate.slice(5)} to ${lastDate.slice(5)}`
      : "No snapshots";
    const latestWindow = latestDate && previousDate
      ? `${previousDate.slice(5)} to ${latestDate.slice(5)}`
      : latestDate ? `Needs prior snapshot before ${latestDate.slice(5)}` : "No snapshots";
    return {
      rangeWindow,
      latestWindow,
      rangeVideos,
      latestVideos,
      rows:VIDEO_CHANGE_METRICS.map(metric => ({
        ...metric,
        rangeDelta:range[metric.key],
        latestDelta:latest[metric.key],
      })),
    };
  }, [metricsInRange, videoMetrics, filteredVideos, chartSelVid]);

  const brandUploadRows = useMemo(() => {
    const rows = videos
      .filter(v => (!selPid || productValuesMatch(v.pid, selPid, productMeta)) && rowMatchesCampaignScope(v, campaignId) && (!selType || v.type === selType) && (!selPlatform || v.platform === selPlatform))
      .map(v => ({ ...v, uploadDate:v.postedDate || firstSnapshotByVid.get(v.id)?.date || "", prod:productWithMeta(v.pid, productMeta) }))
      .filter(v => v.uploadDate && (!dateRange?.start || v.uploadDate >= dateRange.start) && (!dateRange?.end || v.uploadDate <= dateRange.end));
    return _.orderBy(Object.values(_.groupBy(rows, v => v.pid || "unassigned")).map(groupRows => {
      const first = groupRows[0] || {};
      const prod = first.prod;
      const firstUpload = _.minBy(groupRows, "uploadDate")?.uploadDate || "";
      const lastUpload = _.maxBy(groupRows, "uploadDate")?.uploadDate || "";
      return {
        key:first.pid || "unassigned",
        product:productDisplayName(prod?.short || first.pid || "Unassigned"),
        col:prod?.col || C.blue,
        count:groupRows.length,
        paid:groupRows.filter(v => v.type === "Paid").length,
        seeding:groupRows.filter(v => v.type === "Seeding").length,
        platforms:[...new Set(groupRows.map(v => v.platform).filter(Boolean))].join(" / ") || "All platforms",
        window:firstUpload && lastUpload ? (firstUpload === lastUpload ? firstUpload.slice(5) : `${firstUpload.slice(5)} to ${lastUpload.slice(5)}`) : "",
      };
    }), ["count", "product"], ["desc", "asc"]);
  }, [videos, firstSnapshotByVid, selPid, campaignId, selType, selPlatform, dateRange, productMeta]);

  // Latest snapshot per video for the cards
  const videoCards = useMemo(() => {
    return filteredVideos.map(v => {
      const snaps = metricsInRange.filter(m => m.vid === v.id).sort((a,b) => b.date.localeCompare(a.date));
      const latest = snaps[0] || { views:0, likes:0, comments:0, saves:0, shares:0, rate:v.rate || 0 };
      const prev   = snaps[1] || null;
      const pctChg = prev && prev[selMetric] > 0
        ? (((latest[selMetric] - prev[selMetric]) / prev[selMetric]) * 100).toFixed(1)
        : null;
      return { ...v, ...latest, pctChg, dailyGrowth:metricGrowth(latest, prev, selMetric, 1), sevenDayGrowth:metricGrowth(latest, prev, selMetric, 7) };
    });
  }, [filteredVideos, metricsInRange, selMetric]);

  // Sort cards by selected metric descending
  const sortedCards = useMemo(() =>
    [...videoCards].sort((a,b) => (b[selMetric]||0) - (a[selMetric]||0))
  , [videoCards, selMetric]);

  const selVideo   = filteredVideos.find(v => v.id === chartSelVid);
  const selProd    = productWithMeta(selVideo?.pid, productMeta);
  const lineColor  = selProd?.col || C.accent;
  const filterActive = selPid || campaignId || selPlatform || selType;
  const selectedVideoName = chartSelVid ? videoDisplayName(selVideo) : "";
  const rangeLabel = dateRange?.start && dateRange?.end ? `${dateRange.start.slice(5)} to ${dateRange.end.slice(5)}` : "All dates";
  const maxBrandUploads = Math.max(1, ...brandUploadRows.map(r => r.count));

  const yFormatter = v => {
    if (selMetric === "rate") return fmtCurrency(v);
    return v >= 1000000 ? `${(v/1e6).toFixed(1)}M` : v >= 1000 ? `${(v/1000).toFixed(0)}K` : `${v}`;
  };

  return (
    <>
      {chartSelVid && (
        <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:10 }}>
          <button onClick={() => setSelVid(null)} style={{ padding:"6px 14px", borderRadius:20, border:`1px solid ${C.border}`, background:"transparent", color:C.muted, cursor:"pointer", fontSize:11, ...SANS }}>
            × {lang === "ko" ? "선택 해제" : "Clear selection"}
          </button>
        </div>
      )}

      {/* Line chart */}
      <Panel title={`${metricDef.label} Over Time - ${chartSelVid ? selectedVideoName : `${filteredVideos.length} videos${filterActive?" (filtered)":""}`} / ${rangeLabel}`}>
        {chartData.length > 1 ? (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData} margin={{ top:5, right:8, bottom:5, left:0 }}>
              <CartesianGrid stroke={C.border} strokeDasharray="2 5" vertical={false}/>
              <XAxis dataKey="date" tick={{ fontSize:10, fill:C.muted, fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif" }} axisLine={false} tickLine={false}/>
              <YAxis tick={{ fontSize:10, fill:C.muted, fontFamily:"'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif" }} axisLine={false} tickLine={false} tickFormatter={yFormatter}/>
              <Tooltip
                contentStyle={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:8, fontSize:11, ...SANS }}
                formatter={v => [metricDef.fmt(v), metricDef.label]}
                labelStyle={{ color:C.muted }}
              />
              <Line type="monotone" dataKey="value" stroke={lineColor} strokeWidth={2.5}
                dot={{ r:4, fill:lineColor, strokeWidth:0 }}
                activeDot={{ r:5, fill:lineColor, strokeWidth:0 }}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : chartData.length === 1 ? (
          <div style={{ textAlign:"center", padding:"34px 0", color:C.muted, fontSize:11, background:C.bg, border:`1px solid ${C.border}`, borderRadius:8 }}>
            Only one snapshot matches this filter, so there is not enough history to draw a trend.
            <div style={{ ...MONO, color:lineColor, fontSize:18, fontWeight:500, marginTop:8 }}>{metricDef.fmt(chartData[0].value)}</div>
          </div>
        ) : (
          <div style={{ textAlign:"center", padding:"30px 0", color:C.muted, fontSize:11 }}>
            {lang === "ko" ? "이 조합에 대한 데이터가 없습니다. 추이를 보려면 스냅샷 날짜가 포함된 영상 CSV를 업로드하세요." : "No data for this combination. Upload a video CSV with snapshot dates to see trends."}
          </div>
        )}
        <div style={{ marginTop:8, fontSize:10, color:C.muted, ...SANS }}>
          Click a video below to view its individual trend. Click again to deselect.
        </div>
      </Panel>

      <div className="bi-two-col" style={{ display:"grid", gridTemplateColumns:"minmax(0,1.15fr) minmax(280px,0.85fr)", gap:14, marginBottom:14 }}>
        <Panel title="Metric Change" style={{ marginBottom:0 }}>
          {changeSummary.rangeVideos === 0 && changeSummary.latestVideos === 0 ? (
            <div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:16, color:C.muted, fontSize:11, lineHeight:1.6 }}>
              No prior snapshot is available for this filter, so metric change cannot be calculated yet.
            </div>
          ) : <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(112px,1fr))", gap:8 }}>
            {changeSummary.rows.map(metric => {
              const rangeColor = metric.rangeDelta >= 0 ? C.green : C.red;
              const latestColor = metric.latestDelta >= 0 ? C.green : C.red;
              return (
                <div key={metric.key} style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 11px", minWidth:0 }}>
                  <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>{metric.label}</div>
                  <div style={{ ...MONO, fontSize:17, fontWeight:500, color:rangeColor, marginBottom:4, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                    {fmtMetricDelta(metric, metric.rangeDelta)}
                  </div>
                  <div style={{ fontSize:10, color:C.muted, marginBottom:8 }}>Range change</div>
                  <div style={{ display:"flex", justifyContent:"space-between", gap:8, fontSize:10, ...MONO }}>
                    <span style={{ color:C.muted }}>Latest</span>
                    <span style={{ color:latestColor, fontWeight:500 }}>{fmtMetricDelta(metric, metric.latestDelta)}</span>
                  </div>
                </div>
              );
            })}
          </div>}
        </Panel>

        <Panel title="Videos Uploaded by Brand" style={{ marginBottom:0 }}>
          {brandUploadRows.length ? (
            <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
              {brandUploadRows.map(row => (
                <div key={row.key} style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 11px", borderLeft:`4px solid ${row.col}` }}>
                  <div style={{ display:"flex", justifyContent:"space-between", gap:10, alignItems:"baseline", marginBottom:6 }}>
                    <div style={{ fontSize:12, color:C.text, fontWeight:500, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{row.product}</div>
                    <div style={{ ...MONO, fontSize:14, color:row.col, fontWeight:500, flexShrink:0 }}>{row.count}</div>
                  </div>
                  <div style={{ height:5, background:C.card, borderRadius:4, overflow:"hidden", marginBottom:7 }}>
                    <div style={{ height:"100%", width:`${Math.max(5, (row.count / maxBrandUploads) * 100)}%`, background:row.col }}/>
                  </div>
                  <div style={{ display:"flex", justifyContent:"space-between", gap:8, color:C.muted, fontSize:10, lineHeight:1.4 }}>
                    <span>{row.paid} paid / {row.seeding} seeding</span>
                    <span style={{ textAlign:"right" }}>{row.window}</span>
                  </div>
                  <div style={{ color:C.muted, fontSize:10, marginTop:3, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{row.platforms}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:16, color:C.muted, fontSize:11, lineHeight:1.6 }}>
              No uploaded videos match this date range and filter combination.
            </div>
          )}
        </Panel>
      </div>

      {/* Video cards */}
      <Panel title={`Videos - sorted by ${metricDef.label} (${sortedCards.length}) / ${rangeLabel}`}>
        {sortedCards.length === 0 ? (
          <div style={{ textAlign:"center", padding:"24px 0", color:C.muted, fontSize:11 }}>
            No videos match the current filters.
            <div style={{ marginTop:8 }}>{lang === "ko" ? "데이터 소스에서 영상 CSV를 업로드하세요." : "Upload a video CSV from Data Sources."}</div>
          </div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {sortedCards.map((v, rank) => {
              const prod    = productWithMeta(v.pid, productMeta);
              const isSel   = selVid === v.id;
              const metVal  = v[selMetric] || 0;
              return (
                <div key={v.id} role="button" tabIndex={0} onClick={() => setSelVid(isSel ? null : v.id)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setSelVid(isSel ? null : v.id);}}} style={{
                  background:isSel?C.hover:C.bg, borderRadius:8, padding:"12px 14px",
                  cursor:"pointer", transition:"all 0.1s",
                  border:`1px solid ${isSel?prod?.col||C.accent:C.border}`,
                  borderLeft:`3px solid ${prod?.col||C.accent}`,
                }}>
                  <div className="bi-video-row" style={{ display:"flex", alignItems:"flex-start", gap:12 }}>

                    {/* Rank + platform */}
                    <div style={{ flexShrink:0, textAlign:"center", width:36 }}>
                      <div style={{ ...MONO, fontSize:16, fontWeight:500, color:rank===0?C.green:rank===1?C.blue:rank===2?C.accent:C.muted }}>{rank+1}</div>
                      <div style={{ fontSize:10, ...MONO, color:C.muted, marginTop:2 }}>{v.platform==="TikTok"?"TT":v.platform==="Instagram"?"IG":v.platform==="YouTube"?"YT":v.platform==="Facebook"?"FB":"-"}</div>
                    </div>

                    {/* Creator + metadata */}
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4, flexWrap:"wrap" }}>
                        {prod && <span style={{ fontSize:10, ...MONO, color:prod.col, background:`${prod.col}1A`, padding:"2px 6px", borderRadius:4 }}>{prod.short}</span>}
                        {v.type && <span style={{ fontSize:10, ...MONO, color:v.type==="Paid"?C.accent:C.blue, background:v.type==="Paid"?C.accentFade:"rgba(106,171,247,0.1)", padding:"2px 6px", borderRadius:4 }}>{v.type}</span>}
                        <span style={{ fontSize:10, ...MONO, color:C.muted }}>{v.platform}</span>
                      </div>
                      <div style={{ fontWeight:500, fontSize:13, color:isSel?C.accent:C.text, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", marginBottom:3 }}>
                        {v.creator || "Unknown creator"}
                      </div>
                      <div style={{ fontSize:11, color:C.muted }}>
                        {[v.platform, prod?.short, v.type].filter(Boolean).join(" / ")}
                        {safeExternalHttpUrl(v.url) && (
                          <> · <a href={safeExternalHttpUrl(v.url)} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{ color:C.blue, textDecoration:"none" }}>Open ↗</a></>
                        )}
                      </div>
                    </div>

                    {/* Key metrics */}
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:6, flexShrink:0 }}>
                      {CARD_METRICS.map(m => (
                        <div key={m.key} style={{ background:C.card, borderRadius:6, padding:"5px 10px", textAlign:"center", border:`1px solid ${selMetric===m.key?C.accent+"44":C.border}` }}>
                          <div style={{ ...MONO, fontSize:12, fontWeight:500, color:selMetric===m.key?C.accent:C.text }}>
                            {m.fmt(v[m.key]||0)}
                          </div>
                          <div style={{ fontSize:9, ...MONO, color:C.muted, marginTop:2 }}>{m.label}</div>
                        </div>
                      ))}
                    </div>

                    {/* Selected metric growth */}
                    <div style={{ background:C.card, borderRadius:8, padding:"7px 12px", flexShrink:0, minWidth:126, border:`1px solid ${C.accent}44` }}>
                      <div style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", gap:8, marginBottom:6 }}>
                        <div style={{ fontSize:10, ...MONO, color:C.muted }}>{metricDef.label}</div>
                        <div style={{ ...MONO, fontSize:13, fontWeight:500, color:C.accent }}>{metricDef.fmt(metVal)}</div>
                      </div>
                      {[
                        ["Daily", v.dailyGrowth],
                        ["7D", v.sevenDayGrowth],
                      ].map(([label, value]) => {
                        const isMissing = value === null || value === undefined || !Number.isFinite(value);
                        const isPositive = !isMissing && value >= 0;
                        const color = isMissing ? C.subtle : isPositive ? C.green : C.red;
                        return (
                          <div key={label} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, fontSize:10, ...MONO, marginTop:3 }}>
                            <span style={{ color:C.muted }}>{label}</span>
                            <span style={{ color, fontWeight:500 }}>{fmtGrowth(value)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </>
  );
}
