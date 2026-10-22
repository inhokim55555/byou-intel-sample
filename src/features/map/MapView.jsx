import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import _ from "lodash";
import { mapComparisonMarkers } from "../../lib/mapScope.js";
import { warehouseLocationLabel } from "../../lib/storeLookup.js";
import { useUiText, MAP_W, MAP_H, C, KpiCard, Panel, MONO, fmtCompactMoney, SANS } from "../../ui/dashboardShared.jsx";

export default function MapView({ ranked, selId, setSelId, minT, maxT, mapFeatures, d3Module = null, mapError = "", onRetryMap = () => {}, footnotes, sales, comparisonStats, selectedProductIds = [], selectedProducts = [], kpis = [] }) {
  const { lang, t, label:uiLabel } = useUiText();
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const dragMovedRef = useRef(false);
  const [mapZoom, setMapZoom] = useState({ k:1, x:0, y:0 });
  const [isDragging, setIsDragging] = useState(false);
  const [hoverId, setHoverId] = useState("");
  const geoProj = useMemo(() => d3Module ? d3Module.geoAlbersUsa().scale(900).translate([MAP_W/2, MAP_H/2]) : () => null, [d3Module]);
  const pathFn  = useMemo(() => d3Module ? d3Module.geoPath().projection(geoProj) : () => "", [d3Module, geoProj]);
  const sel = ranked.find(w => w.id === selId);
  const volumeStats = useMemo(() => {
    const volumes = _.sortBy(ranked.map(w => Number(w.total || 0)).filter(v => v > 0));
    const min = volumes.length ? volumes[0] : 0;
    const rawMax = volumes.length ? volumes[volumes.length - 1] : 1;
    const capIndex = volumes.length ? Math.min(volumes.length - 1, Math.floor((volumes.length - 1) * 0.95)) : 0;
    const cappedMax = volumes.length ? volumes[capIndex] : 1;
    return { min, max:Math.max(min + 1, cappedMax), rawMax };
  }, [ranked]);
  const markerRadius = useCallback((revenue, selected) => {
    if (selected) return 9;
    if (volumeStats.max === volumeStats.min) return Number(revenue || 0) > 0 ? 7 : 3.2;
    const cappedRevenue = Math.min(Number(revenue || 0), volumeStats.max);
    const t = Math.max(0, Math.min(1, (cappedRevenue - volumeStats.min) / (volumeStats.max - volumeStats.min || 1)));
    return 3.2 + Math.sqrt(t) * 7.2;
  }, [volumeStats]);
  const clampZoom = useCallback(z => {
    const k = Math.max(1, Math.min(16, z.k));
    if (k <= 1) return { k:1, x:0, y:0 };
    const minX = MAP_W - MAP_W * k, minY = MAP_H - MAP_H * k;
    return {
      k,
      x:Math.max(minX, Math.min(0, z.x)),
      y:Math.max(minY, Math.min(0, z.y)),
    };
  }, []);
  const zoomAt = useCallback((px, py, nextK) => {
    setMapZoom(z => {
      const k = Math.max(1, Math.min(16, nextK));
      const ratio = k / z.k;
      return clampZoom({ k, x:px - (px - z.x) * ratio, y:py - (py - z.y) * ratio });
    });
  }, [clampZoom]);
  const pointFromEvent = useCallback(e => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return [MAP_W/2, MAP_H/2];
    return [
      ((e.clientX - rect.left) / rect.width) * MAP_W,
      ((e.clientY - rect.top) / rect.height) * MAP_H,
    ];
  }, []);
  const handleMapMouseDown = useCallback(e => {
    if (e.button !== 0) return;
    if (mapZoom.k <= 1) return;
    e.preventDefault();
    const [x, y] = pointFromEvent(e);
    dragRef.current = { startX:x, startY:y, zoom:mapZoom };
    dragMovedRef.current = false;
    setIsDragging(true);
  }, [mapZoom, pointFromEvent]);
  const handleMapMouseMove = useCallback(e => {
    if (!dragRef.current) return;
    e.preventDefault();
    const [x, y] = pointFromEvent(e);
    const d = dragRef.current;
    const dx = x - d.startX, dy = y - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragMovedRef.current = true;
    setMapZoom(clampZoom({ ...d.zoom, x:d.zoom.x + dx, y:d.zoom.y + dy }));
  }, [clampZoom, pointFromEvent]);
  const stopMapDrag = useCallback(() => {
    dragRef.current = null;
    setIsDragging(false);
    setTimeout(() => { dragMovedRef.current = false; }, 0);
  }, []);
  const mapScale = mapZoom.k || 1;
  const explicitSelectedProducts = Array.isArray(selectedProducts) ? selectedProducts.filter(p => p?.pid || p?.product) : [];
  const explicitSelectedIds = Array.isArray(selectedProductIds) ? selectedProductIds.filter(Boolean) : [];
  const selectedProductCount = explicitSelectedIds.length || explicitSelectedProducts.length || comparisonStats?.selectedCount || 0;
  const isComparisonMode = selectedProductCount === 2;
  const comparisonProducts = useMemo(() => {
    const stats = new Map((comparisonStats?.productStats || []).map(p => [p.key || p.pid, p]));
    if (!explicitSelectedProducts.length) return comparisonStats?.productStats || [];
    return explicitSelectedProducts.map(p => {
      const stat = stats.get(p.key || p.pid) || {};
      return {
        ...stat,
        key:p.key || p.pid,
        pid:p.pid,
        product:p.product || stat.product || p.pid || "Product",
        col:p.col || stat.col || C.blue,
      };
    });
  }, [comparisonStats, explicitSelectedProducts]);
  const selectedProductByKey = useMemo(() => new Map(comparisonProducts.map(p => [p.key || p.pid, p])), [comparisonProducts]);
  const selectedColorSet = useMemo(() => new Set(comparisonProducts.map(p => p.col).filter(Boolean)), [comparisonProducts]);
  const selectedProduct = selectedProductCount === 1 ? comparisonProducts[0] : null;
  const legendProducts = selectedProductCount > 0 ? comparisonProducts.slice(0, Math.min(selectedProductCount, 4)) : [];
  const selectedMarkerColor = selectedProduct?.col || "";
  const selectedMarkerLabel = selectedProduct?.product || "";
  const mapColorLabel = selectedProduct
    ? (lang === "ko" ? `색상 = ${selectedProduct.product}` : `color = ${selectedProduct.product}`)
    : isComparisonMode
      ? (lang === "ko" ? "색상 = 선택한 캠페인" : "color = selected campaign")
      : selectedProductCount > 2
        ? (lang === "ko" ? "색상 = 선택 제품 중 매출 1위" : "color = top selected product")
        : (lang === "ko" ? "색상 = 매출 1위 제품" : "color = top product by revenue");
  const sizeSampleColor = selectedProduct?.col || C.blue;
  const hoverStore = hoverId ? ranked.find(w => w.id === hoverId) : null;
  const hoverPt = hoverStore ? geoProj([hoverStore.lng, hoverStore.lat]) : null;
  const markerColorForStore = useCallback(store => {
    if (!store) return C.blue;
    if (selectedProductCount === 1) return selectedProduct?.col || C.blue;
    if (selectedProductCount > 1) {
      const leader = selectedProductByKey.get(store.comparisonLeaderKey || store.comparisonLeaderPid);
      if (leader?.col) return leader.col;
      if (selectedColorSet.has(store.markerColor)) return store.markerColor;
      return comparisonProducts[0]?.col || C.blue;
    }
    return store.markerColor || C.blue;
  }, [selectedProductCount, selectedProduct, selectedProductByKey, selectedColorSet, comparisonProducts]);
  const productBreakdownForStore = useCallback(store => {
    const items = store?.compareBreakdown || store?.productBreakdown || [];
    if (!selectedProductCount) return items;
    return items
      .filter(p => selectedProductByKey.has(p.key || p.pid))
      .map(p => ({ ...p, col:selectedProductByKey.get(p.key || p.pid)?.col || p.col }));
  }, [selectedProductCount, selectedProductByKey]);
  const comparisonMarkersForStore = useCallback(store => (
    store?.comparisonMode ? mapComparisonMarkers(productBreakdownForStore(store)) : []
  ), [productBreakdownForStore]);
  const hoverStoreColor = markerColorForStore(hoverStore);
  const selectedStoreColor = markerColorForStore(sel);
  const selectedStoreBreakdown = productBreakdownForStore(sel);
  useEffect(() => {
    if (!svgRef.current || selectedProductCount !== 1 || !selectedMarkerColor) return;
    svgRef.current.querySelectorAll('[data-map-store-visible="true"]').forEach(node => {
      if (node.getAttribute("fill") !== "none") node.setAttribute("fill", selectedMarkerColor);
      if (node.getAttribute("stroke") && node.getAttribute("stroke") !== "none") node.setAttribute("stroke", selectedMarkerColor);
    });
  }, [selectedProductCount, selectedMarkerColor, ranked, mapZoom.k, mapZoom.x, mapZoom.y]);

  return (
    <>
      {kpis.length > 0 && (
        <div className="bi-kpi-grid" style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:10, marginBottom:14 }}>
          {kpis.map(k => <KpiCard key={k.label} label={k.label} value={k.val} sub={k.sub} color={k.c} exact={k.exact}/>)}
        </div>
      )}
      <Panel title="Costco Store Performance Map — United States">
        {comparisonStats?.selectedCount > 1 && (
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:8, marginBottom:12 }}>
            <div style={{ background:C.bg, border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 12px" }}>
              <div style={{ fontSize:10, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:1, marginBottom:5 }}>{lang === "ko" ? "일치 매장" : "Matched Stores"}</div>
              <div style={{ ...MONO, fontSize:17, fontWeight:500, color:C.green }}>{comparisonStats.sharedStores.toLocaleString()} / {comparisonStats.unionStores.toLocaleString()}</div>
              <div style={{ fontSize:10, color:C.muted, marginTop:3 }}>{lang === "ko" ? "직접 비교에 사용" : "Used for direct comparison"}</div>
            </div>
            {comparisonStats.productStats.map(p => (
              <div key={p.key || p.pid} style={{ background:C.bg, border:`1px solid ${p.col}33`, borderRadius:8, padding:"10px 12px", borderLeft:`3px solid ${p.col}` }}>
                <div style={{ fontSize:10, ...MONO, color:p.col, textTransform:"uppercase", letterSpacing:1, marginBottom:5, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{p.product}</div>
                <div style={{ ...MONO, fontSize:17, fontWeight:500, color:C.text }}>{p.stores.toLocaleString()} {uiLabel("Stores")}</div>
                <div style={{ fontSize:10, color:C.muted, marginTop:3 }}>{p.units.toLocaleString()} {t("common.units", "units")} / {fmtCompactMoney(p.rev)}</div>
              </div>
            ))}
          </div>
        )}
        <div style={{ background:"#05060B", borderRadius:8, overflow:"hidden", position:"relative" }}>
          <svg ref={svgRef} data-testid="costco-store-map" data-map-selected-count={selectedProductCount} data-map-selected-color={selectedMarkerColor || ""} viewBox={`0 0 ${MAP_W} ${MAP_H}`} onMouseDown={handleMapMouseDown} onMouseMove={handleMapMouseMove} onMouseUp={stopMapDrag} onMouseLeave={stopMapDrag} style={{ width:"100%", display:"block", cursor:isDragging?"grabbing":mapZoom.k>1?"grab":"default", userSelect:"none", touchAction:"pan-y" }}>
            <defs>
              <radialGradient id="mg" cx="30%" cy="65%" r="70%">
                <stop offset="0%" stopColor="#1A2540" stopOpacity="0.5"/>
                <stop offset="100%" stopColor="#05060B" stopOpacity="0"/>
              </radialGradient>
            </defs>
            {selectedProductCount === 1 && selectedMarkerColor && (
              <style>{`
                [data-testid="costco-store-map"][data-map-selected-count="1"] [data-map-store-visible="true"]:not([fill="none"]) { fill: ${selectedMarkerColor} !important; }
                [data-testid="costco-store-map"][data-map-selected-count="1"] [data-map-store-visible="true"][stroke]:not([stroke="none"]) { stroke: ${selectedMarkerColor} !important; }
              `}</style>
            )}
            <rect width={MAP_W} height={MAP_H} fill="url(#mg)"/>
            {mapFeatures.length > 0
              ? <g transform={`translate(${mapZoom.x} ${mapZoom.y}) scale(${mapZoom.k})`}>
                  {mapFeatures.map((f,i) => <path key={i} d={pathFn(f)||""} fill="#0C0F1A" stroke="#232845" strokeWidth={0.7 / mapScale}/>)}
                </g>
              : <text x={MAP_W/2} y={MAP_H/2} textAnchor="middle" fill={mapError ? C.red : C.muted} fontSize={11} fontFamily="'Helvetica Neue BYOU','Helvetica Neue',Helvetica,Arial,sans-serif">{mapError ? (lang === "ko" ? "미국 지도를 불러올 수 없습니다." : "US map could not be loaded.") : "Loading US map…"}</text>
            }
            {mapFeatures.length > 0 && (
              <g transform={`translate(${mapZoom.x} ${mapZoom.y}) scale(${mapZoom.k})`}>
                {ranked.map(w => {
                  const pt = geoProj([w.lng, w.lat]); if (!pt) return null;
                  const col = markerColorForStore(w);
                  const markerLabel = selectedMarkerLabel || w.markerLabel || "";
                  const isSel = selId===w.id;
                  const r = markerRadius(w.total, isSel);
                  const comparisonMarkers = comparisonMarkersForStore(w);
                  const markerItems = comparisonMarkers.length
                    ? comparisonMarkers
                    : [{ key:"aggregate", product:markerLabel, col, rev:w.total, offsetIndex:0 }];
                  return (
                    <g key={`wz-${w.id}`} role="button" tabIndex={0} aria-label={`${w.name} ${fmtCompactMoney(w.total)}`} onFocus={() => setHoverId(w.id)} onBlur={() => setHoverId("")} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelId(isSel?null:w.id); } }} onMouseEnter={() => setHoverId(w.id)} onMouseLeave={() => setHoverId("")} onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); if (dragMovedRef.current) return; setSelId(isSel?null:w.id); }} style={{ cursor:"pointer", outline:"none" }}>
                      <title>{`${w.name} - ${fmtCompactMoney(w.total)}${markerLabel ? ` - ${markerLabel}` : ""}`}</title>
                      <circle cx={pt[0]} cy={pt[1]} r={Math.max(16, r+9) / mapScale} fill="transparent" style={{ pointerEvents:"all" }}/>
                      {markerItems.map(marker => {
                        const markerCol = marker.col || col;
                        const markerR = markerRadius(marker.rev, isSel);
                        const markerX = pt[0] + Number(marker.offsetIndex || 0) * 18 / mapScale;
                        return (
                          <g key={`${w.id}-${marker.key || marker.product || "scope"}`} data-map-scope-marker="true" data-map-scope-key={marker.key || "aggregate"}>
                            <title>{`${w.name} - ${marker.product || markerLabel || "Store revenue"} - ${fmtCompactMoney(marker.rev)}`}</title>
                            {isSel && <circle data-map-store-visible="true" data-map-store-id={w.id} data-map-store-ring="selected-fill" cx={markerX} cy={pt[1]} r={13 / mapScale} fill={markerCol} opacity={0.13}/>}
                            <circle data-map-store-visible="true" data-map-store-id={w.id} data-map-store-ring="halo" cx={markerX} cy={pt[1]} r={(markerR+3) / mapScale} fill={markerCol} opacity={0.1}/>
                            <circle data-map-store-visible="true" data-map-store-id={w.id} data-map-store-ring="main" cx={markerX} cy={pt[1]} r={markerR / mapScale} fill={markerCol} opacity={isSel ? 0.95 : 0.8}/>
                            {isSel && <circle data-map-store-visible="true" data-map-store-id={w.id} data-map-store-ring="selected-stroke" cx={markerX} cy={pt[1]} r={(markerR+2) / mapScale} fill="none" stroke={markerCol} strokeWidth={1.5 / mapScale} opacity={0.5}/>}
                          </g>
                        );
                      })}
                    </g>
                  );
                })}
              </g>
            )}
          </svg>
          {hoverStore && hoverPt && (
            <div style={{ position:"absolute", left:`${Math.max(2, Math.min(82, ((hoverPt[0] * mapZoom.k + mapZoom.x) / MAP_W) * 100))}%`, top:`${Math.max(8, Math.min(94, ((hoverPt[1] * mapZoom.k + mapZoom.y) / MAP_H) * 100))}%`, pointerEvents:"none", transform:"translate(10px, -100%)", background:C.card, color:C.text, border:`1px solid ${C.border}`, borderRadius:8, boxShadow:"0 16px 38px rgba(0,0,0,0.28)", padding:"8px 10px", minWidth:170, maxWidth:240, zIndex:3 }}>
              <div style={{ fontSize:11, fontWeight:500, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{hoverStore.name}</div>
              {hoverStore.comparisonMode ? (
                <>
                  {comparisonMarkersForStore(hoverStore).map(marker => (
                    <div key={marker.key || marker.product} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, marginTop:5 }}>
                      <span style={{ display:"inline-flex", alignItems:"center", gap:5, minWidth:0, fontSize:10, color:marker.col }}>
                        <span style={{ width:7, height:7, borderRadius:"50%", background:marker.col, flex:"0 0 auto" }}/>
                        <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{marker.product}</span>
                      </span>
                      <span style={{ ...MONO, fontSize:10, color:C.text, flex:"0 0 auto" }}>{fmtCompactMoney(marker.rev)}</span>
                    </div>
                  ))}
                  <div style={{ ...MONO, fontSize:10, color:C.muted, marginTop:6, paddingTop:5, borderTop:`1px solid ${C.border}` }}>{lang === "ko" ? "합계" : "Combined"}: {fmtCompactMoney(hoverStore.total)}</div>
                </>
              ) : (
                <>
                  <div style={{ ...MONO, fontSize:12, color:hoverStoreColor, fontWeight:500, marginTop:4 }}>{fmtCompactMoney(hoverStore.total)}</div>
                  <div style={{ fontSize:10, color:C.muted, marginTop:3 }}>{selectedMarkerLabel || hoverStore.markerLabel || hoverStore.trend?.label || "Store revenue"}</div>
                </>
              )}
            </div>
          )}
          <div style={{ position:"absolute", top:10, right:12, display:"flex", alignItems:"center", gap:5, background:"rgba(5,6,11,0.72)", border:`1px solid ${C.border}`, borderRadius:7, padding:5, backdropFilter:"blur(6px)" }}>
            <button title="Zoom out" onClick={() => zoomAt(MAP_W/2, MAP_H/2, mapZoom.k * 0.65)} style={{ width:24, height:24, borderRadius:5, border:`1px solid ${C.border}`, background:C.bg, color:C.text, cursor:"pointer", fontSize:14, lineHeight:1 }}>-</button>
            <div style={{ minWidth:38, textAlign:"center", ...MONO, fontSize:10, color:C.muted }}>{mapZoom.k.toFixed(1)}x</div>
            <button title="Zoom in" onClick={() => zoomAt(MAP_W/2, MAP_H/2, mapZoom.k * 1.55)} style={{ width:24, height:24, borderRadius:5, border:`1px solid ${C.border}`, background:C.bg, color:C.text, cursor:"pointer", fontSize:14, lineHeight:1 }}>+</button>
            <button title="Reset zoom" onClick={() => setMapZoom({ k:1, x:0, y:0 })} style={{ height:24, borderRadius:5, border:`1px solid ${C.border}`, background:"transparent", color:C.muted, cursor:"pointer", fontSize:10, ...MONO }}>1x</button>
          </div>
          <div style={{ position:"absolute", bottom:10, right:12, display:"flex", alignItems:"center", gap:10, ...SANS, fontSize:10, color:C.muted, background:"rgba(5,6,11,0.62)", border:`1px solid ${C.border}`, borderRadius:7, padding:"7px 9px", backdropFilter:"blur(6px)" }}>
            <span>{lang === "ko" ? "원 크기 = 매출" : "Circle size = revenue"}</span>
            {[3,6,9].map(r => (
              <span key={r} style={{ width:r*2, height:r*2, borderRadius:"50%", background:sizeSampleColor, opacity:0.75, display:"inline-block" }}/>
            ))}
            {legendProducts.map(p => (
              <span key={p.key || p.pid} style={{ display:"inline-flex", alignItems:"center", gap:4 }}>
                <span style={{ width:8, height:8, borderRadius:"50%", background:p.col, display:"inline-block" }}/>
                <span>{p.product}</span>
              </span>
            ))}
            <span>{mapColorLabel}</span>
            {isComparisonMode && <span>{lang === "ko" ? "나란히 = 캠페인 비교" : "side-by-side = campaign comparison"}</span>}
          </div>
        </div>
        {mapError && <div role="alert" style={{ marginTop:10, padding:"10px 12px", display:"flex", justifyContent:"space-between", alignItems:"center", gap:12, border:`1px solid ${C.red}44`, borderRadius:7, background:C.redFade, color:C.red, fontSize:10 }}>
          <span>{lang === "ko" ? "미국 지도 파일을 불러오지 못했습니다." : "The US map file could not be loaded."}</span>
          <button type="button" onClick={onRetryMap} style={{ border:`1px solid ${C.red}66`, background:C.card, color:C.red, borderRadius:6, padding:"6px 10px", cursor:"pointer" }}>{lang === "ko" ? "다시 시도" : "Retry map"}</button>
        </div>}
        <div style={{ marginTop:12, padding:14, background:C.bg, borderRadius:8, border:`1px solid ${C.border}` }}>
          {sel ? (
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <div style={{ fontWeight:500, fontSize:15 }}>{sel.name}</div>
                <div style={{ fontSize:11, color:C.muted, marginTop:3 }}>{[warehouseLocationLabel(sel), `ID ${sel.id}`].filter(Boolean).join(" · ")}</div>
                <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>{(sel.units||0).toLocaleString()} {t("common.units", "units")} {lang === "ko" ? "판매됨" : "sold in range"}</div>
                {selectedStoreBreakdown.length > 0 && (
                  <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginTop:8, maxWidth:620 }}>
                    {selectedStoreBreakdown.slice(0,6).map(p => (
                      <span key={p.key || p.pid} style={{ display:"inline-flex", alignItems:"center", gap:5, padding:"3px 7px", borderRadius:999, border:`1px solid ${p.col}44`, background:p.missing ? C.card : `${p.col}12`, color:p.missing ? C.muted : p.col, fontSize:10 }}>
                        <span style={{ width:7, height:7, borderRadius:"50%", background:p.col }}/>
                        {p.product}: {p.missing ? (lang === "ko" ? "매출 없음" : "no sales") : `${p.units.toLocaleString()} ${t("common.units", "units")} / ${fmtCompactMoney(p.rev)}`}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ ...MONO, fontSize:24, fontWeight:500, color:selectedStoreColor }}>{fmtCompactMoney(sel.total)}</div>
                <div style={{ fontSize:11, color:selectedStoreColor || C.muted, marginTop:2 }}>{sel.comparisonMode ? `${sel.comparisonLeader} leads by ${fmtCompactMoney(Math.abs(sel.comparisonDelta || 0))}` : sel.trend?.label || "Trend unavailable"}</div>
              </div>
            </div>
          ) : (
            <div style={{ fontSize:11, color:C.muted, textAlign:"center", padding:"4px 0" }}>{lang === "ko" ? "점을 클릭하거나 사이드바에서 매장을 선택해 상세 정보를 확인하세요." : "Click a dot or select from the sidebar to inspect a store."}</div>
          )}
        </div>
      </Panel>
    </>
  );
}
