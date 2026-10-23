import React, { useCallback, useEffect, useMemo, useState } from "react";
import { asianDatasetMatchesCityReference, asianDatasetMatchesMarketDirectory, demographicNumber, rankedAsianGroupRows } from "./lib/demographicDisplay.js";
import { marketDemographicSourceRows, marketWarehouseSalesContext } from "./lib/marketDemographicSales.js";
import { createMarketDirectoryIndex, matchWarehouseDirectoryStore } from "./lib/marketDirectoryIndex.js";
import {
  buildMarketLocationRow,
  filterMarketLocationRows,
  marketCityOptions,
  marketLocationKey,
  marketStateOptions,
  preferredMarketWarehouseId,
  searchMarketLocationRows,
} from "./lib/marketDemographicFilters.js";
import { warehouseLocationLabel } from "./lib/storeLookup.js";
import {
  C,
  DATA_END,
  DATA_START,
  INP,
  MONO,
  Panel,
  SELECT,
  StatusChip,
  campaignWithMeta,
  fmtCompactMoney,
  fmtCurrency,
  isNonStoreInventoryLocation,
  productIdForMetricRow,
  productLabelForValue,
  productValuesMatch,
  productWithMeta,
  rowMatchesCampaignScopeWithInference,
  useUiText,
  warehouseNumberFromText,
} from "./ByouIntel.jsx";
import { CompactComparisonView, CompactEventsView, CompactPacingAnalysisView, CompactSalesAffinityView } from "./AnalysisCompactSections.jsx";
import WarehouseAnalysisView from "./WarehouseAnalysisView.jsx";
const COSTCO_MARKET_DIRECTORY_URL = "/data/costco-market-demographics.json";
const COSTCO_CITY_REFERENCE_URL = "/data/costco-city-demographics-2024-acs5.json";
const COSTCO_CITY_ASIAN_DEMOGRAPHICS_URL = "/data/costco-city-asian-demographics-2024-acs5.json";
const COSTCO_FIVE_MILE_ASIAN_DEMOGRAPHICS_URL = "/data/costco-five-mile-asian-demographics-2024-acs5.json";
let marketDirectoryPromise = null;
let cityReferencePromise = null;
let cityAsianReferencePromise = null;
let fiveMileAsianReferencePromise = null;

const ASIAN_GROUP_LABELS_KO = Object.freeze({
  chineseExceptTaiwanese:"중국계 (대만계 제외)",
  hmong:"몽족",
  japanese:"일본계",
  korean:"한국계",
  mongolian:"몽골계",
  okinawan:"오키나와계",
  taiwanese:"대만계",
  otherEastAsian:"기타 동아시아계",
  burmese:"버마계",
  cambodian:"캄보디아계",
  filipino:"필리핀계",
  indonesian:"인도네시아계",
  laotian:"라오스계",
  malaysian:"말레이시아계",
  mien:"미엔족",
  singaporean:"싱가포르계",
  thai:"태국계",
  vietnamese:"베트남계",
  otherSoutheastAsian:"기타 동남아시아계",
  asianIndian:"인도계 아시아인",
  bangladeshi:"방글라데시계",
  bhutanese:"부탄계",
  nepalese:"네팔계",
  pakistani:"파키스탄계",
  sikh:"시크계",
  sriLankan:"스리랑카계",
  otherSouthAsian:"기타 남아시아계",
  afghan:"아프가니스탄계",
  kazakh:"카자흐계",
  uzbek:"우즈베크계",
  otherCentralAsian:"기타 중앙아시아계",
  otherAsianSpecified:"기타 아시아계 (상세 응답)",
  otherAsianNotSpecified:"기타 아시아계 (상세 미응답)",
});

function loadStaticAnalysisJson(url, schema, currentPromise, setPromise, unavailableMessage) {
  if (currentPromise) return currentPromise;
  const request = fetch(url, { cache:"no-cache" })
    .then(async response => {
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.schema !== schema) throw new Error(unavailableMessage);
      return payload;
    })
    .catch(error => {
      setPromise(null);
      throw error;
    });
  setPromise(request);
  return request;
}

function loadMarketDirectory() {
  return loadStaticAnalysisJson(
    COSTCO_MARKET_DIRECTORY_URL,
    "byou-costco-market-demographics-v1",
    marketDirectoryPromise,
    value => { marketDirectoryPromise = value; },
    "The Costco market demographic directory is unavailable.",
  );
}

function loadCityReference() {
  return loadStaticAnalysisJson(
    COSTCO_CITY_REFERENCE_URL,
    "byou-costco-city-demographics-v1",
    cityReferencePromise,
    value => { cityReferencePromise = value; },
    "The bundled Census City Reference is unavailable.",
  );
}

function loadCityAsianReference() {
  return loadStaticAnalysisJson(
    COSTCO_CITY_ASIAN_DEMOGRAPHICS_URL,
    "byou-costco-city-asian-demographics-v1",
    cityAsianReferencePromise,
    value => { cityAsianReferencePromise = value; },
    "The bundled detailed Asian Census reference is unavailable.",
  );
}

function loadFiveMileAsianReference() {
  return loadStaticAnalysisJson(
    COSTCO_FIVE_MILE_ASIAN_DEMOGRAPHICS_URL,
    "byou-costco-five-mile-asian-demographics-v1",
    fiveMileAsianReferencePromise,
    value => { fiveMileAsianReferencePromise = value; },
    "The bundled five-mile detailed Asian Census reference is unavailable.",
  );
}

function warehouseDirectoryNumber(warehouse) {
  const explicit = String(warehouse?.warehouseNo || "").trim();
  const parsed = explicit || warehouseNumberFromText(warehouse?.name);
  const digits = String(parsed || "").match(/\d+/)?.[0] || "";
  return digits ? String(Number(digits)) : "";
}

function cachedMarketProfile(store) {
  const cached = store?.demographics;
  if (!cached) return null;
  return {
    source:"Fictional demonstration data",
    vintage:"Synthetic sample",
    radiusMiles:Number(cached.radiusMiles || 5),
    tractCount:Number(cached.tractCount || 0),
    method:cached.scope || "5-mile Census tract radius",
    caveat:"Fictional aggregate profiles.",
    cached:true,
    metrics:{
      population:cached.population,
      incomeIndicator:cached.householdIncome,
      averageHouseholdIncome:cached.householdIncome,
      medianAgeIndicator:cached.averageAge,
      asianPct:cached.asianPct,
      whitePct:cached.whitePct,
      blackPct:cached.blackPct,
      hispanicPct:cached.hispanicPct,
      malePct:cached.malePct,
      femalePct:cached.femalePct,
    },
  };
}

function MarketMetric({ label, value, sub, color = C.text }) {
  return (
    <div style={{ minWidth:0, borderTop:`2px solid ${color}`, padding:"10px 10px 8px", background:C.bg, borderRadius:6 }}>
      <div style={{ fontSize:9, ...MONO, color:C.muted, textTransform:"uppercase", letterSpacing:0.8, marginBottom:6 }}>{label}</div>
      <div style={{ fontSize:18, ...MONO, color, fontWeight:500, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{value}</div>
      {sub && <div style={{ fontSize:9, color:C.muted, marginTop:4, lineHeight:1.35 }}>{sub}</div>}
    </div>
  );
}

function DemographicShareRow({ rowKey, label, value, moe, color = C.blue }) {
  const numericValue = demographicNumber(value);
  const hasValue = numericValue !== null;
  const pctValue = hasValue ? Math.max(0, numericValue) : 0;
  const hasMoe = moe !== null && moe !== undefined && Number.isFinite(Number(moe));
  return (
    <div className="bi-demographic-share-row" data-demographic-row={rowKey} style={{ display:"grid", gridTemplateColumns:"minmax(118px,1fr) minmax(100px,2fr) minmax(48px,auto)", alignItems:"center", gap:10, padding:"7px 0", borderBottom:`1px solid ${C.border}` }}>
      <div style={{ fontSize:11, color:C.text, minWidth:0 }}>{label}</div>
      <div style={{ height:7, borderRadius:999, background:C.border, overflow:"hidden" }}>
        <div style={{ width:hasValue ? `${Math.min(100, pctValue)}%` : "0%", height:"100%", background:color, borderRadius:999 }}/>
      </div>
      <div style={{ ...MONO, fontSize:11, color:C.text, textAlign:"right", minHeight:25 }}>
        {hasValue ? `${pctValue.toFixed(1)}%` : "N/A"}
        <div aria-hidden={!hasMoe} style={{ color:C.muted, fontSize:8, marginTop:2, minHeight:10, visibility:hasMoe ? "visible" : "hidden" }}>
          {hasMoe ? `±${Number(moe).toFixed(1)} pp` : "±0.0 pp"}
        </div>
      </div>
    </div>
  );
}

function MarketDemographicsView({ ranked = [], whs = [], selId, setSelId = () => {}, portfolioSales = [], prodSales = [], salesContextOverride = null, dateRange = { start:DATA_START, end:DATA_END }, campaignPid = "", campaignCid = "", productMeta = {}, campaignMeta = {}, onReady = () => {} }) {
  const warehouseOptions = whs.length ? whs : ranked;
  const storeWarehouseOptions = useMemo(() => warehouseOptions.filter(warehouse => !isNonStoreInventoryLocation(warehouse)), [warehouseOptions]);
  const { lang } = useUiText();
  const copy = (english, korean) => lang === "ko" ? korean : english;
  const [directory, setDirectory] = useState({ state:"loading", data:null, stores:[], error:"" });
  const [cityReference, setCityReference] = useState({ state:"loading", data:null, error:"" });
  const [localAsianReference, setLocalAsianReference] = useState({ state:"idle", data:null, error:"" });
  const [localAsianDetailsOpen, setLocalAsianDetailsOpen] = useState(false);
  const [localAsianDetailsShowAll, setLocalAsianDetailsShowAll] = useState(false);
  const [asianReference, setAsianReference] = useState({ state:"idle", data:null, error:"" });
  const [asianDetailsOpen, setAsianDetailsOpen] = useState(false);
  const [asianDetailsShowAll, setAsianDetailsShowAll] = useState(false);
  const [warehouseId, setWarehouseId] = useState(selId || ranked[0]?.id || storeWarehouseOptions[0]?.id || "");
  const [locationState, setLocationState] = useState("");
  const [mailingCity, setMailingCity] = useState("");
  const [warehouseSearch, setWarehouseSearch] = useState("");
  const [warehouseSearchOpen, setWarehouseSearchOpen] = useState(false);
  const [activeWarehouseResult, setActiveWarehouseResult] = useState(0);
  const directoryIndex = useMemo(() => createMarketDirectoryIndex(directory.stores), [directory.stores]);

  useEffect(() => {
    let active = true;
    loadMarketDirectory()
      .then(payload => {
        if (active) setDirectory({ state:"ready", data:payload, stores:Array.isArray(payload.stores) ? payload.stores : [], error:"" });
      })
      .catch(error => active && setDirectory({ state:"error", data:null, stores:[], error:error.message || "The Costco warehouse directory could not be loaded." }));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    loadCityReference()
      .then(payload => {
        if (active) setCityReference({ state:"ready", data:payload, error:"" });
      })
      .catch(error => active && setCityReference({ state:"error", data:null, error:error.message || "The bundled Census City Reference could not be loaded." }));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const validIds = new Set(storeWarehouseOptions.map(warehouse => warehouse.id));
    const rows = [...validIds].map(id => ({ id }));
    const rankedStore = ranked.find(warehouse => validIds.has(warehouse.id));
    const next = preferredMarketWarehouseId(rows, warehouseId, selId || "", rankedStore?.id || "");
    if (next !== warehouseId) setWarehouseId(next);
    if (next && next !== selId) setSelId(next);
  }, [selId, ranked, storeWarehouseOptions, warehouseId, setSelId]);

  useEffect(() => {
    if (directory.state !== "ready" || cityReference.state !== "ready" || !warehouseId || (selId && warehouseId !== selId) || typeof requestAnimationFrame !== "function") return undefined;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => onReady());
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [directory.state, cityReference.state, warehouseId, onReady]);

  const marketLocationRows = useMemo(() => {
    const rows = storeWarehouseOptions.map(option => {
      const directoryStore = matchWarehouseDirectoryStore(option, directoryIndex);
      return buildMarketLocationRow(option, directoryStore);
    });
    return rows.sort((a, b) =>
      a.country.localeCompare(b.country) ||
      a.state.localeCompare(b.state) ||
      a.city.localeCompare(b.city) ||
      String(a.warehouse?.name || "").localeCompare(String(b.warehouse?.name || ""), undefined, { numeric:true })
    );
  }, [storeWarehouseOptions, directoryIndex]);
  const locationStateOptions = useMemo(() => marketStateOptions(marketLocationRows), [marketLocationRows]);
  const locationCityOptions = useMemo(() => marketCityOptions(marketLocationRows, locationState), [marketLocationRows, locationState]);
  const filteredLocationRows = useMemo(
    () => filterMarketLocationRows(marketLocationRows, locationState, mailingCity),
    [marketLocationRows, locationState, mailingCity]
  );
  const searchedLocationRows = useMemo(
    () => searchMarketLocationRows(filteredLocationRows, warehouseSearch),
    [filteredLocationRows, warehouseSearch]
  );
  const visibleWarehouseResults = searchedLocationRows.slice(0, 20);
  const locationCountries = useMemo(() => [...new Set(locationStateOptions.map(option => option.country))].sort((a, b) => {
    const order = value => value === "US" ? 0 : value === "CA" ? 1 : 2;
    return order(a) - order(b) || a.localeCompare(b);
  }), [locationStateOptions]);

  useEffect(() => {
    const selectedRow = marketLocationRows.find(row => row.id === warehouseId);
    if (!selectedRow) return;
    if (locationState && marketLocationKey(selectedRow.country, selectedRow.state) !== locationState) {
      setLocationState("");
      setMailingCity("");
      return;
    }
    if (mailingCity && selectedRow.city !== mailingCity) setMailingCity("");
  }, [warehouseId, marketLocationRows, locationState, mailingCity]);

  const warehouse = storeWarehouseOptions.find(item => item.id === warehouseId) || null;
  const selectedLocationRow = useMemo(() => marketLocationRows.find(row => row.id === warehouseId) || null, [marketLocationRows, warehouseId]);
  const directoryStore = useMemo(() => matchWarehouseDirectoryStore(warehouse, directoryIndex), [warehouse, directoryIndex]);
  const selectedCountry = String(directoryStore?.country || selectedLocationRow?.country || "").trim().toUpperCase();
  const localProfile = useMemo(() => cachedMarketProfile(directoryStore), [directoryStore]);
  const warehouseNo = warehouseDirectoryNumber(warehouse);
  const cityMapping = warehouseNo ? cityReference.data?.warehouseMappings?.[warehouseNo] || null : null;
  const cityProfile = cityMapping?.status === "resolved" ? cityReference.data?.placesByGeoid?.[cityMapping.geoid] || null : null;
  const cityProfileGeoid = cityProfile?.geoid || "";
  const outsideCensusPlace = cityMapping?.status === "outside_place";
  const censusCityUnavailable = Boolean(selectedCountry && selectedCountry !== "US" && selectedCountry !== "UNKNOWN");
  const selectedCampaign = useMemo(() => campaignWithMeta(campaignCid, campaignMeta, productMeta), [campaignCid, campaignMeta, productMeta]);
  const selectedProduct = selectedCampaign?.pid || campaignPid || "";

  useEffect(() => {
    setLocalAsianDetailsShowAll(false);
  }, [warehouseNo]);

  useEffect(() => {
    if (!localAsianDetailsOpen || !warehouseNo || selectedCountry !== "US" || localAsianReference.state !== "idle") return undefined;
    setLocalAsianReference({ state:"loading", data:null, error:"" });
    loadFiveMileAsianReference()
      .then(payload => {
        setLocalAsianReference({ state:"ready", data:payload, error:"" });
      })
      .catch(error => {
        setLocalAsianReference({ state:"error", data:null, error:error.message || "The five-mile detailed Asian Census reference could not be loaded." });
      });
    return undefined;
  }, [localAsianDetailsOpen, warehouseNo, selectedCountry, localAsianReference.state]);

  useEffect(() => {
    setAsianDetailsShowAll(false);
  }, [cityProfileGeoid]);

  useEffect(() => {
    if (!asianDetailsOpen || !cityProfileGeoid || asianReference.state !== "idle") return undefined;
    setAsianReference({ state:"loading", data:null, error:"" });
    loadCityAsianReference()
      .then(payload => {
        setAsianReference({ state:"ready", data:payload, error:"" });
      })
      .catch(error => {
        setAsianReference({ state:"error", data:null, error:error.message || "The detailed Asian Census reference could not be loaded." });
      });
    return undefined;
  }, [asianDetailsOpen, cityProfileGeoid, asianReference.state]);

  const salesContext = useMemo(() => {
    if (!warehouse) return { hasRows:false, revenue:0, units:0, revenuePeriod:0, unitsPeriod:0, inventory:null, reportingPeriods:0 };
    if (salesContextOverride) return salesContextOverride;
    const scopedSourceRows = marketDemographicSourceRows({
      portfolioSales,
      productSales:prodSales,
      selectedProduct,
      selectedCampaign:campaignCid,
    });
    const rows = scopedSourceRows.filter(row =>
      (!selectedProduct || productValuesMatch(productIdForMetricRow(row), selectedProduct, productMeta)) &&
      rowMatchesCampaignScopeWithInference(row, campaignCid, campaignMeta, productMeta, selectedProduct)
    );
    return marketWarehouseSalesContext(rows, {
      warehouseId:warehouse.id,
      start:dateRange.start,
      end:dateRange.end,
    });
  }, [warehouse, portfolioSales, prodSales, salesContextOverride, dateRange.start, dateRange.end, selectedProduct, campaignCid, productMeta, campaignMeta]);

  const product = productWithMeta(selectedProduct, productMeta);
  const campaign = selectedCampaign;
  const salesScopeLabel = [product?.short || (selectedProduct ? productLabelForValue(selectedProduct, productMeta) : copy("All products", "전체 제품")), campaign?.short].filter(Boolean).join(" / ");
  const localMetrics = localProfile?.metrics || {};
  const cityMetrics = cityProfile?.metrics || {};
  const localComposition = [
    [copy("Asian", "아시아계"), localMetrics.asianPct, null, C.accent],
    [copy("White", "백인"), localMetrics.whitePct, null, C.blue],
    [copy("Black / African American", "흑인 / 아프리카계 미국인"), localMetrics.blackPct, null, C.purple],
    [copy("Hispanic / Latino", "히스패닉 / 라틴계"), localMetrics.hispanicPct, null, C.orange],
  ];
  const cityComposition = [
    [copy("Asian, non-Hispanic", "아시아계, 비히스패닉"), cityMetrics.asianNonHispanicPct?.estimate, cityMetrics.asianNonHispanicPct?.moe, C.accent],
    [copy("White, non-Hispanic", "백인, 비히스패닉"), cityMetrics.whiteNonHispanicPct?.estimate, cityMetrics.whiteNonHispanicPct?.moe, C.blue],
    [copy("Black, non-Hispanic", "흑인, 비히스패닉"), cityMetrics.blackNonHispanicPct?.estimate, cityMetrics.blackNonHispanicPct?.moe, C.purple],
    [copy("Hispanic / Latino", "히스패닉 / 라틴계"), cityMetrics.hispanicPct?.estimate, cityMetrics.hispanicPct?.moe, C.orange],
  ];
  const localGenderRows = [
    [copy("Male", "남성"), localMetrics.malePct, null, C.blue],
    [copy("Female", "여성"), localMetrics.femalePct, null, C.purple],
  ];
  const cityGenderRows = [
    [copy("Male", "남성"), cityMetrics.malePct?.estimate, cityMetrics.malePct?.moe, C.blue],
    [copy("Female", "여성"), cityMetrics.femalePct?.estimate, cityMetrics.femalePct?.moe, C.purple],
  ];
  const localAsianDatasetCompatible = localAsianReference.state === "ready" && asianDatasetMatchesMarketDirectory(localAsianReference.data, directory.data);
  const localAsianProfile = localAsianDatasetCompatible ? localAsianReference.data?.storesByWarehouseNo?.[warehouseNo] || null : null;
  const localAsianGroupRows = localAsianProfile?.status === "complete" ? rankedAsianGroupRows(localAsianProfile, localAsianReference.data?.groupDefinitions) : [];
  const visibleLocalAsianGroupRows = localAsianDetailsShowAll ? localAsianGroupRows : localAsianGroupRows.slice(0, 6);
  const asianDatasetCompatible = asianReference.state === "ready" && asianDatasetMatchesCityReference(asianReference.data, cityReference.data);
  const asianCityProfile = asianDatasetCompatible ? asianReference.data?.placesByGeoid?.[cityProfileGeoid] || null : null;
  const asianGroupRows = asianCityProfile ? rankedAsianGroupRows(asianCityProfile, asianReference.data?.groupDefinitions) : [];
  const visibleAsianGroupRows = asianDetailsShowAll ? asianGroupRows : asianGroupRows.slice(0, 6);
  const formatNumber = value => {
    const numeric = demographicNumber(value);
    return numeric === null ? "N/A" : Math.round(numeric).toLocaleString();
  };
  const formatMoney = value => {
    const numeric = demographicNumber(value);
    return numeric === null ? "N/A" : fmtCurrency(numeric);
  };
  const formatDecimal = value => {
    const numeric = demographicNumber(value);
    return numeric === null ? "N/A" : numeric.toFixed(1);
  };
  const formatMedianIncome = metric => {
    const numeric = demographicNumber(metric?.estimate);
    if (numeric === null) return "N/A";
    if ((metric?.estimateAnnotation === "upper_interval" || metric?.moeAnnotation === "open_interval") && numeric >= 250001) return "$250,000+";
    return fmtCurrency(numeric);
  };
  const metricMoe = (metric, formatter = formatNumber) => {
    if (cityReference.data?.synthetic) return "";
    if (metric?.moeAnnotation === "controlled") return copy("Controlled Census estimate; sampling MOE treated as 0", "Census 통제 추정치; 표본 오차범위는 0으로 처리");
    if (metric?.moeAnnotation === "open_interval") return copy("Open-ended Census interval; conventional MOE unavailable", "Census 개방형 구간; 일반 오차범위 없음");
    if (metric?.moeAnnotation === "insufficient_sample") return copy("Census MOE unavailable because the sample is insufficient", "표본 부족으로 Census 오차범위 없음");
    return metric?.moe !== null && metric?.moe !== undefined && Number.isFinite(Number(metric.moe))
      ? `90% MOE ±${formatter(metric.moe)}`
      : copy("90% MOE unavailable", "90% 오차범위 없음");
  };
  const selectWarehouse = id => {
    setWarehouseId(id);
    setSelId(id || null);
  };
  const selectWarehouseResult = row => {
    selectWarehouse(row.id);
    setWarehouseSearch(String(row.warehouse?.name || ""));
    setWarehouseSearchOpen(false);
    setActiveWarehouseResult(0);
  };
  const handleWarehouseSearchKeyDown = event => {
    if (event.key === "Escape") {
      setWarehouseSearchOpen(false);
      return;
    }
    if (!visibleWarehouseResults.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setWarehouseSearchOpen(true);
      setActiveWarehouseResult(index => Math.min(index + 1, visibleWarehouseResults.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setWarehouseSearchOpen(true);
      setActiveWarehouseResult(index => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && warehouseSearchOpen) {
      event.preventDefault();
      selectWarehouseResult(visibleWarehouseResults[activeWarehouseResult] || visibleWarehouseResults[0]);
    }
  };
  const selectFirstLocationMatch = rows => {
    const next = preferredMarketWarehouseId(rows, warehouseId);
    if (next && next !== warehouseId) selectWarehouse(next);
  };
  const selectLocationState = nextState => {
    setLocationState(nextState);
    setMailingCity("");
    setWarehouseSearch("");
    setWarehouseSearchOpen(false);
    selectFirstLocationMatch(filterMarketLocationRows(marketLocationRows, nextState));
  };
  const selectMailingCity = nextCity => {
    setMailingCity(nextCity);
    setWarehouseSearch("");
    setWarehouseSearchOpen(false);
    selectFirstLocationMatch(filterMarketLocationRows(marketLocationRows, locationState, nextCity));
  };
  const locationCountryLabel = country => country === "US"
    ? copy("United States", "미국")
    : country === "CA"
      ? copy("Canada", "캐나다")
      : copy("Other / Unverified", "기타 / 미확인");
  const cityReferenceTitle = outsideCensusPlace
    ? copy("5-mi data only - Outside Census place", "5마일 데이터만 제공 - Census 지역 경계 밖")
    : censusCityUnavailable
      ? copy("5-mi data only - U.S. Census unavailable", "5마일 데이터만 제공 - 미국 Census 사용 불가")
      : copy("City Reference", "도시 기준");
  const cityReferenceSubtitle = outsideCensusPlace
    ? copy("Use the Local Market Profile at left; no official citywide Census profile", "왼쪽의 지역 시장 프로필을 사용하세요. 공식 도시 전체 Census 프로필은 없습니다.")
    : censusCityUnavailable
      ? copy("Use the Local Market Profile at left; City Reference is available only for U.S. warehouses", "왼쪽의 지역 시장 프로필을 사용하세요. 도시 기준은 미국 웨어하우스에만 제공됩니다.")
      : cityProfile?.name || copy("Census city", "웨어하우스가 위치한 공식 Census 지역");

  return (
    <div data-demographics-content-ready={directory.state === "ready" && cityReference.state === "ready" && !!warehouseId ? "true" : "false"}>
      <Panel title={copy("Warehouse Market Demographics", "웨어하우스 시장 인구통계")}>
        <div style={{ display:"grid", gridTemplateColumns:"minmax(140px,0.7fr) minmax(180px,1fr) minmax(280px,1.6fr)", gap:10, alignItems:"end", marginBottom:14 }} className="bi-demographic-controls">
          <label style={{ minWidth:0 }}>
            <div style={{ ...MONO, fontSize:9, color:C.muted, textTransform:"uppercase", letterSpacing:0.8, marginBottom:5 }}>{copy("State / Province", "주 / 도")}</div>
            <select value={locationState} onChange={event => selectLocationState(event.target.value)} disabled={directory.state === "loading" || !locationStateOptions.length} style={{ ...SELECT, width:"100%" }}>
              <option value="">{copy("All states / provinces", "전체 주 / 도")}</option>
              {locationCountries.map(country => (
                <optgroup key={country} label={locationCountryLabel(country)}>
                  {locationStateOptions.filter(option => option.country === country).map(option => <option key={option.key} value={option.key}>{option.state}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <label style={{ minWidth:0 }}>
            <div style={{ ...MONO, fontSize:9, color:C.muted, textTransform:"uppercase", letterSpacing:0.8, marginBottom:5 }}>{copy("Mailing City", "우편 주소 도시")}</div>
            <select value={mailingCity} onChange={event => selectMailingCity(event.target.value)} disabled={!locationState || directory.state === "loading"} style={{ ...SELECT, width:"100%" }}>
              <option value="">{copy("All mailing cities", "전체 우편 주소 도시")}</option>
              {locationCityOptions.map(city => <option key={city} value={city}>{city}</option>)}
            </select>
          </label>
          <div style={{ minWidth:0 }}>
            <label htmlFor="market-demographic-warehouse-search" style={{ ...MONO, display:"block", fontSize:9, color:C.muted, textTransform:"uppercase", letterSpacing:0.8, marginBottom:5 }}>{copy("Warehouse", "웨어하우스")}</label>
            <div style={{ position:"relative" }}>
              <input
                id="market-demographic-warehouse-search"
                type="search"
                role="combobox"
                value={warehouseSearch}
                onFocus={() => warehouseSearch.trim() && setWarehouseSearchOpen(true)}
                onChange={event => { setWarehouseSearch(event.target.value); setWarehouseSearchOpen(true); setActiveWarehouseResult(0); }}
                onKeyDown={handleWarehouseSearchKeyDown}
                placeholder={copy("Type a warehouse name", "웨어하우스 이름 입력")}
                aria-label={copy("Search by warehouse name", "웨어하우스 이름 검색")}
                aria-expanded={warehouseSearchOpen && !!warehouseSearch.trim()}
                aria-controls="market-demographic-warehouse-results"
                aria-autocomplete="list"
                style={{ ...INP, width:"100%" }}
              />
              {warehouseSearchOpen && warehouseSearch.trim() && (
                <div id="market-demographic-warehouse-results" role="listbox" style={{ position:"absolute", zIndex:20, top:"calc(100% + 4px)", left:0, right:0, maxHeight:260, overflowY:"auto", padding:4, background:C.card, border:`1px solid ${C.border}`, borderRadius:7, boxShadow:"0 10px 28px rgba(0,0,0,0.18)" }}>
                  {!visibleWarehouseResults.length && <div style={{ padding:"10px 9px", color:C.muted, fontSize:10 }}>{copy("No warehouse names match", "일치하는 웨어하우스 이름이 없습니다")}</div>}
                  {visibleWarehouseResults.map((row, index) => {
                    const option = row.warehouse;
                    const location = [row.city, row.state].filter(Boolean).join(", ") || warehouseLocationLabel(option);
                    return <button key={option.id} type="button" role="option" aria-selected={index === activeWarehouseResult} onMouseDown={event => event.preventDefault()} onClick={() => selectWarehouseResult(row)} style={{ width:"100%", display:"block", padding:"9px 10px", border:0, borderRadius:5, background:index === activeWarehouseResult ? C.accentFade : "transparent", color:C.text, textAlign:"left", cursor:"pointer" }}><strong>{option.name}</strong>{location && <span style={{ display:"block", marginTop:2, color:C.muted, fontSize:9 }}>{location}{warehouseDirectoryNumber(option) ? ` · #${warehouseDirectoryNumber(option)}` : ""}</span>}</button>;
                  })}
                  {searchedLocationRows.length > visibleWarehouseResults.length && <div style={{ padding:"7px 9px", color:C.muted, fontSize:9 }}>{copy(`Showing the first ${visibleWarehouseResults.length} matches. Type more letters to narrow the list.`, `처음 ${visibleWarehouseResults.length}개 결과를 표시합니다. 더 많은 글자를 입력해 범위를 좁히세요.`)}</div>}
                </div>
              )}
            </div>
          </div>
          <div style={{ gridColumn:"1 / -1", color:C.muted, fontSize:9, lineHeight:1.45 }}>
          </div>
        </div>

        {warehouse && (
          <div style={{ display:"flex", justifyContent:"space-between", gap:12, alignItems:"flex-start", padding:"10px 12px", background:C.bg, border:`1px solid ${C.border}`, borderRadius:7, marginBottom:14, flexWrap:"wrap" }}>
            <div>
              <div style={{ fontSize:13, fontWeight:600, color:C.text }}>{warehouse.name}{warehouseDirectoryNumber(warehouse) ? ` #${warehouseDirectoryNumber(warehouse)}` : ""}</div>
              <div style={{ fontSize:10, color:C.muted, marginTop:3 }}>
                {warehouseLocationLabel({ ...warehouse, city:directoryStore?.city || warehouse.city, st:directoryStore?.state || warehouse.st }) || "Verified location unavailable"}
                {directoryStore?.street ? ` - ${directoryStore.street}` : ""}
              </div>
            </div>
            <div style={{ fontSize:10, color:C.muted, textAlign:"right" }}>{copy("Fictional market profiles", "가상 시장 프로필")}<br/>{directoryStore ? `${directoryStore.lat.toFixed(4)}, ${directoryStore.lng.toFixed(4)}` : copy("Directory coordinates unavailable", "디렉터리 좌표 없음")}</div>
          </div>
        )}

        <div style={{ ...MONO, fontSize:9, color:C.muted, textTransform:"uppercase", letterSpacing:0.8, marginBottom:7 }}>{copy("Current BYOU sales context", "현재 BYOU 판매 컨텍스트")} - {salesScopeLabel}</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(145px,1fr))", gap:8, marginBottom:16 }}>
          <MarketMetric label={copy("Warehouse Revenue", "웨어하우스 매출")} value={salesContext.hasRows ? fmtCompactMoney(salesContext.revenue) : "N/A"} sub={`${dateRange.start} to ${dateRange.end}`} color={C.green}/>
          <MarketMetric label={copy("Units Sold", "판매 유닛")} value={salesContext.hasRows ? Math.round(salesContext.units).toLocaleString() : "N/A"} sub={salesContext.hasRows ? `${salesContext.reportingPeriods} ${copy("reporting periods", "보고 기간")}` : copy("Warehouse sales rows unavailable", "웨어하우스 판매 행을 사용할 수 없음")} color={C.blue}/>
          <MarketMetric label={copy("Revenue / Reporting Period", "보고 기간당 매출")} value={salesContext.hasRows ? fmtCompactMoney(salesContext.revenuePeriod) : "N/A"} sub={salesContext.hasRows ? copy("", "현재 BYOU 행에서 계산") : copy("Warehouse sales rows unavailable", "웨어하우스 판매 행을 사용할 수 없음")} color={C.accent}/>
          <MarketMetric
            label={copy("Units / Reporting Period", "보고 기간당 유닛")}
            value={salesContext.hasRows ? salesContext.unitsPeriod.toFixed(1) : "N/A"}
            sub={salesContext.inventory === null
              ? copy("Latest units on hand unavailable", "최신 보유 유닛 확인 불가")
              : `${salesContext.inventory.toLocaleString()} ${copy("latest known units on hand", "최근 확인된 보유 유닛")}`}
            color={C.purple}
          />
        </div>

        {directory.state === "error" && <div style={{ padding:"11px 12px", borderRadius:7, background:C.redFade, color:C.red, fontSize:11, marginBottom:12 }}>{directory.error}</div>}
        <div className={`bi-demographic-comparison${localProfile && cityProfile ? " bi-demographic-comparison-aligned" : ""}`} style={{ marginBottom:14 }}>
          <section className="bi-demographic-profile" data-demographic-profile="local" style={{ border:`1px solid ${C.border}`, borderRadius:8, padding:"13px", background:C.card }}>
            <div data-demographic-slot="header" style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10, marginBottom:11 }}>
              <div>
                <div style={{ fontSize:13, fontWeight:600, color:C.text }}>{copy("5-mi Local Market Profile", "5마일 지역 시장 프로필")}</div>
                <div style={{ color:C.muted, fontSize:9, marginTop:3 }}>{copy("Estimated 5-mile area", "대략적인 5마일 트랙 기반 상권으로, 도시 경계를 넘을 수 있으며 도시 기준의 하위 범위가 아닙니다.")}</div>
              </div>
              <StatusChip label="5 mi" col={C.accent}/>
            </div>
            {!localProfile && <div style={{ padding:"12px", borderRadius:7, background:C.warnFade, color:C.warn, fontSize:10, lineHeight:1.5 }}>{copy("No local profile available.", "이 웨어하우스의 번들 5마일 프로필이 없습니다.")}</div>}
            {localProfile && (
              <>
                <div data-demographic-slot="summary" style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(125px,1fr))", gap:8, marginBottom:13, alignContent:"start", alignItems:"start" }}>
                  <MarketMetric label={copy("Estimated Population", "추정 인구")} value={formatNumber(localMetrics.population)} sub={`${localProfile.tractCount || 0} ${copy("tracts", "트랙")}`} color={C.accent}/>
                  <MarketMetric label={copy("Avg Household Income", "평균 가구소득")} value={formatMoney(localMetrics.averageHouseholdIncome ?? localMetrics.incomeIndicator)}  color={C.green}/>
                  <MarketMetric label={copy("Average Age", "평균 연령")} value={formatDecimal(localMetrics.medianAgeIndicator)}  color={C.purple}/>
                </div>
                <div data-demographic-slot="race-heading" style={{ ...MONO, fontSize:9, color:C.muted, textTransform:"uppercase", letterSpacing:0.8, marginBottom:3 }}>{copy("Race and ethnicity", "인종 및 민족")}</div>
                {localComposition.map(([label, value, moe, color], index) => <DemographicShareRow key={label} rowKey={["asian", "white", "black", "hispanic"][index]} label={label} value={value} moe={moe} color={color}/>)}
                {localGenderRows.map(([label, value, moe, color], index) => <DemographicShareRow key={label} rowKey={["male", "female"][index]} label={label} value={value} moe={moe} color={color}/>)}
              </>
            )}
            {selectedCountry === "US" && warehouseNo && (
              <div data-demographic-slot="footer" style={{ marginTop:10, paddingTop:10, borderTop:`1px solid ${C.border}`, color:C.muted, fontSize:9, lineHeight:1.5 }}>
                <button
                  type="button"
                  data-local-asian-details-toggle
                  aria-expanded={localAsianDetailsOpen}
                  onClick={() => setLocalAsianDetailsOpen(open => !open)}
                  style={{ border:`1px solid ${C.accent}55`, borderRadius:6, padding:"6px 9px", background:C.accentFade, color:C.accent, fontSize:10, cursor:"pointer" }}
                >
                  {localAsianDetailsOpen ? copy("Hide 5-mi Asian groups", "5마일 아시아계 상세 그룹 숨기기") : copy("View 5-mi Asian groups", "5마일 아시아계 상세 그룹 보기")}
                </button>
                {localAsianDetailsOpen && (
                  <div data-local-asian-details style={{ marginTop:10, paddingTop:10, borderTop:`1px solid ${C.border}`, color:C.text }}>
                    <div style={{ fontSize:11, fontWeight:600 }}>{copy("Current five-mile Asian groups", "현재 5마일 아시아계 상세 그룹")}</div>
                    <div style={{ color:C.muted, marginTop:2 }}>{localAsianDetailsShowAll
                      ? copy(`All ${localAsianGroupRows.length} detailed groups`, `전체 ${localAsianGroupRows.length}개 상세 그룹`)
                      : copy("Largest six groups", "상위 6개 그룹")}</div>
                    {localAsianReference.state === "loading" && <div style={{ padding:"12px 0", color:C.muted }}>{copy("Loading current five-mile Census groups...", "현재 5마일 Census 상세 그룹 로딩 중...")}</div>}
                    {localAsianReference.state === "error" && (
                      <div style={{ marginTop:8, padding:"9px", borderRadius:6, background:C.redFade, color:C.red }}>
                        {localAsianReference.error}
                        <button type="button" onClick={() => setLocalAsianReference({ state:"idle", data:null, error:"" })} style={{ marginLeft:8, border:`1px solid ${C.red}55`, borderRadius:5, padding:"3px 6px", background:"transparent", color:C.red, cursor:"pointer" }}>{copy("Retry", "다시 시도")}</button>
                      </div>
                    )}
                    {localAsianReference.state === "ready" && !localAsianDatasetCompatible && <div style={{ marginTop:8, padding:"9px", borderRadius:6, background:C.redFade, color:C.red }}>{copy("The detailed data does not match this warehouse-directory release.", "상세 데이터가 현재 웨어하우스 디렉터리 릴리스와 일치하지 않습니다.")}</div>}
                    {localAsianDatasetCompatible && !localAsianProfile && <div style={{ marginTop:8, padding:"9px", borderRadius:6, background:C.warnFade, color:C.warn }}>{copy("Detailed groups are unavailable for this U.S. warehouse.", "이 미국 웨어하우스의 상세 그룹을 사용할 수 없습니다.")}</div>}
                    {localAsianProfile?.status === "unavailable" && (
                      <div style={{ marginTop:8, padding:"9px", borderRadius:6, background:C.warnFade, color:C.warn }}>
                        {copy("No estimate is shown because the Census Bureau suppressed 2020-2024 ACS data for one or more tracts in this five-mile profile under Errata 148. Missing residents are not treated as zero.", "이 5마일 프로필의 하나 이상의 트랙에 대해 Census Bureau가 정오표 148에 따라 2020-2024 ACS 데이터를 비공개 처리했으므로 추정치를 표시하지 않습니다. 누락된 거주자를 0으로 처리하지 않습니다.")}
                      </div>
                    )}
                    {localAsianProfile?.status === "complete" && (
                      <>
                        <div style={{ overflowX:"auto", marginTop:8 }}>
                          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:10 }}>
                            <thead>
                              <tr style={{ color:C.muted, textAlign:"left", borderBottom:`1px solid ${C.border}` }}>
                                <th scope="col" style={{ padding:"6px 5px" }}>{copy("Group", "그룹")}</th>
                                <th scope="col" style={{ padding:"6px 5px", textAlign:"right" }}>{copy("Estimated population", "추정 인구")}</th>
                                <th scope="col" style={{ padding:"6px 5px", textAlign:"right" }}>{copy("Share of 5-mi profile", "5마일 프로필 인구 비중")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {visibleLocalAsianGroupRows.map(row => (
                                <tr key={row.id} data-local-asian-group={row.id} style={{ borderBottom:`1px solid ${C.border}` }}>
                                  <th scope="row" style={{ padding:"7px 5px", textAlign:"left", fontWeight:500 }}>{lang === "ko" ? ASIAN_GROUP_LABELS_KO[row.id] || row.label : row.label}</th>
                                  <td style={{ padding:"7px 5px", textAlign:"right", ...MONO }}>
                                    {formatNumber(row.count?.estimate)}
                                    <div style={{ color:C.muted, fontSize:8 }}>{metricMoe(row.count)}</div>
                                  </td>
                                  <td style={{ padding:"7px 5px", textAlign:"right", ...MONO }}>
                                    {formatDecimal(row.shareOfTotalPopulation?.estimate)}{demographicNumber(row.shareOfTotalPopulation?.estimate) === null ? "" : "%"}
                                    <div style={{ color:C.muted, fontSize:8 }}>{metricMoe(row.shareOfTotalPopulation, value => `${formatDecimal(value)} pp`)}</div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {localAsianGroupRows.length > 6 && (
                          <button type="button" data-local-asian-view-all onClick={() => setLocalAsianDetailsShowAll(showAll => !showAll)} style={{ marginTop:8, border:0, padding:"3px 0", background:"transparent", color:C.accent, fontSize:10, cursor:"pointer", textDecoration:"underline" }}>
                            {localAsianDetailsShowAll ? copy("Show largest 6", "상위 6개만 보기") : copy(`View all ${localAsianGroupRows.length}`, `전체 ${localAsianGroupRows.length}개 보기`)}
                          </button>
                        )}
                        <div style={{ marginTop:7, color:C.warn, lineHeight:1.45 }}>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="bi-demographic-profile" data-demographic-profile="city" style={{ border:`1px solid ${C.border}`, borderRadius:8, padding:"13px", background:C.card }}>
            <div data-demographic-slot="header" style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:10, marginBottom:11 }}>
              <div>
                <div style={{ fontSize:13, fontWeight:600, color:C.text }}>{cityReferenceTitle}</div>
                <div style={{ color:C.muted, fontSize:9, marginTop:3 }}>{cityReferenceSubtitle}</div>
              </div>
              <StatusChip label={outsideCensusPlace || censusCityUnavailable ? copy("5 mi only", "5마일만") : cityProfile ? "City" : "Census"} col={cityProfile ? C.green : C.muted}/>
            </div>
            {cityReference.state === "loading" && <div style={{ padding:"18px", textAlign:"center", color:C.muted, fontSize:10 }}>{copy("Loading bundled City Reference...", "번들 도시 기준 로딩 중...")}</div>}
            {cityReference.state === "error" && <div style={{ padding:"12px", borderRadius:7, background:C.redFade, color:C.red, fontSize:10 }}>{cityReference.error}</div>}
            {cityReference.state === "ready" && censusCityUnavailable && <div style={{ padding:"12px", borderRadius:7, background:C.warnFade, color:C.warn, fontSize:10, lineHeight:1.5 }}>{copy("U.S. Census city estimates are not available for this Canadian warehouse.", "캐나다 웨어하우스에는 미국 Census 도시 추정치를 사용할 수 없습니다.")}</div>}
            {cityReference.state === "ready" && selectedCountry === "US" && outsideCensusPlace && <div style={{ padding:"12px", borderRadius:7, background:C.warnFade, color:C.warn, fontSize:10, lineHeight:1.5 }}>{copy("This warehouse coordinate is outside every official Census place boundary. Its mailing city was not substituted, so no misleading City Reference is shown.", "이 웨어하우스 좌표는 모든 공식 Census 지역 경계 밖에 있습니다. 오해를 방지하기 위해 우편 주소의 도시를 대신 사용하지 않았습니다.")}</div>}
            {cityReference.state === "ready" && selectedCountry === "US" && !cityMapping && <div style={{ padding:"12px", borderRadius:7, background:C.redFade, color:C.red, fontSize:10 }}>{copy("No Census profile available.", "이 미국 웨어하우스가 번들 Census 매핑에 없습니다.")}</div>}
            {cityProfile && (
              <>
                <div data-demographic-slot="summary" style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(125px,1fr))", gap:8, marginBottom:13, alignContent:"start", alignItems:"start" }}>
                  <MarketMetric label={copy("Estimated Population", "추정 인구")} value={formatNumber(cityMetrics.population?.estimate)} sub={metricMoe(cityMetrics.population)} color={C.accent}/>
                  <MarketMetric label={copy("Households", "가구 수")} value={formatNumber(cityMetrics.households?.estimate)} sub={metricMoe(cityMetrics.households)} color={C.blue}/>
                  <MarketMetric label={copy("Median Household Income", "중위 가구소득")} value={formatMedianIncome(cityMetrics.medianHouseholdIncome)} sub={metricMoe(cityMetrics.medianHouseholdIncome, formatMoney)} color={C.green}/>
                  <MarketMetric label={copy("Mean Household Income", "평균 가구소득")} value={formatMoney(cityMetrics.meanHouseholdIncome?.estimate)} sub={metricMoe(cityMetrics.meanHouseholdIncome, formatMoney)} color={C.green}/>
                  <MarketMetric label={copy("Median Age", "중위 연령")} value={formatDecimal(cityMetrics.medianAge?.estimate)} sub={metricMoe(cityMetrics.medianAge, formatDecimal)} color={C.purple}/>
                </div>
                <div data-demographic-slot="race-heading" style={{ ...MONO, fontSize:9, color:C.muted, textTransform:"uppercase", letterSpacing:0.8, marginBottom:3 }}>{copy("Race and ethnicity", "인종 및 민족")}</div>
                {cityComposition.map(([label, value, moe, color], index) => <DemographicShareRow key={label} rowKey={["asian", "white", "black", "hispanic"][index]} label={label} value={value} moe={moe} color={color}/>)}
                {cityGenderRows.map(([label, value, moe, color], index) => <DemographicShareRow key={label} rowKey={["male", "female"][index]} label={label} value={value} moe={moe} color={color}/>)}
                <div data-demographic-slot="footer" style={{ color:C.muted, fontSize:9, lineHeight:1.5, marginTop:9 }}>
                  <button
                    type="button"
                    data-city-asian-details-toggle
                    aria-expanded={asianDetailsOpen}
                    onClick={() => setAsianDetailsOpen(open => !open)}
                    style={{ marginTop:10, border:`1px solid ${C.accent}55`, borderRadius:6, padding:"6px 9px", background:C.accentFade, color:C.accent, fontSize:10, cursor:"pointer" }}
                  >
                    {asianDetailsOpen ? copy("Hide detailed Asian groups", "아시아계 상세 그룹 숨기기") : copy("View detailed Asian groups", "아시아계 상세 그룹 보기")}
                  </button>
                  {asianDetailsOpen && (
                    <div data-city-asian-details style={{ marginTop:10, paddingTop:10, borderTop:`1px solid ${C.border}`, color:C.text }}>
                      <div style={{ fontSize:11, fontWeight:600 }}>{copy("Detailed Asian groups", "아시아계 상세 그룹")}</div>
                      <div style={{ color:C.muted, marginTop:2 }}>{asianDetailsShowAll
                        ? copy(`All ${asianGroupRows.length} detailed groups`, `전체 ${asianGroupRows.length}개 상세 그룹`)
                        : copy("Largest six groups", "상위 6개 그룹")}</div>
                      {asianReference.state === "loading" && <div style={{ padding:"12px 0", color:C.muted }}>{copy("Loading detailed Census groups...", "Census 상세 그룹 로딩 중...")}</div>}
                      {asianReference.state === "error" && (
                        <div style={{ marginTop:8, padding:"9px", borderRadius:6, background:C.redFade, color:C.red }}>
                          {asianReference.error}
                          <button type="button" onClick={() => setAsianReference({ state:"idle", data:null, error:"" })} style={{ marginLeft:8, border:`1px solid ${C.red}55`, borderRadius:5, padding:"3px 6px", background:"transparent", color:C.red, cursor:"pointer" }}>{copy("Retry", "다시 시도")}</button>
                        </div>
                      )}
                      {asianReference.state === "ready" && !asianDatasetCompatible && <div style={{ marginTop:8, padding:"9px", borderRadius:6, background:C.redFade, color:C.red }}>{copy("The detailed data does not match this City Reference release.", "상세 데이터가 현재 도시 기준 릴리스와 일치하지 않습니다.")}</div>}
                      {asianDatasetCompatible && !asianCityProfile && <div style={{ marginTop:8, padding:"9px", borderRadius:6, background:C.warnFade, color:C.warn }}>{copy("Detailed groups are unavailable for this Census place.", "이 Census 지역의 상세 그룹을 사용할 수 없습니다.")}</div>}
                      {asianCityProfile && (
                        <>
                          <div style={{ overflowX:"auto", marginTop:8 }}>
                            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:10 }}>
                              <thead>
                                <tr style={{ color:C.muted, textAlign:"left", borderBottom:`1px solid ${C.border}` }}>
                                  <th scope="col" style={{ padding:"6px 5px" }}>{copy("Group", "그룹")}</th>
                                  <th scope="col" style={{ padding:"6px 5px", textAlign:"right" }}>{copy("Estimated population", "추정 인구")}</th>
                                  <th scope="col" style={{ padding:"6px 5px", textAlign:"right" }}>{copy("Share of city", "도시 인구 비중")}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {visibleAsianGroupRows.map(row => (
                                  <tr key={row.id} data-asian-group={row.id} style={{ borderBottom:`1px solid ${C.border}` }}>
                                    <th scope="row" style={{ padding:"7px 5px", textAlign:"left", fontWeight:500 }}>{lang === "ko" ? ASIAN_GROUP_LABELS_KO[row.id] || row.label : row.label}</th>
                                    <td style={{ padding:"7px 5px", textAlign:"right", ...MONO }}>
                                      {formatNumber(row.count?.estimate)}
                                      <div style={{ color:C.muted, fontSize:8 }}>{metricMoe(row.count)}</div>
                                    </td>
                                    <td style={{ padding:"7px 5px", textAlign:"right", ...MONO }}>
                                      {formatDecimal(row.shareOfTotalPopulation?.estimate)}{demographicNumber(row.shareOfTotalPopulation?.estimate) === null ? "" : "%"}
                                      <div style={{ color:C.muted, fontSize:8 }}>{metricMoe(row.shareOfTotalPopulation, value => `${formatDecimal(value)} pp`)}</div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {asianGroupRows.length > 6 && (
                            <button type="button" data-city-asian-view-all onClick={() => setAsianDetailsShowAll(showAll => !showAll)} style={{ marginTop:8, border:0, padding:"3px 0", background:"transparent", color:C.accent, fontSize:10, cursor:"pointer", textDecoration:"underline" }}>
                              {asianDetailsShowAll ? copy("Show largest 6", "상위 6개만 보기") : copy(`View all ${asianGroupRows.length}`, `전체 ${asianGroupRows.length}개 보기`)}
                            </button>
                          )}
                          <div style={{ marginTop:7, color:C.warn, lineHeight:1.45 }}>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        </div>

        <div style={{ padding:"10px 12px", borderRadius:7, background:C.accentFade, border:`1px solid ${C.accent}22`, color:C.text, fontSize:10, lineHeight:1.55 }}>
          <strong>{copy("Marketing use:", "마케팅 활용:")}</strong> {copy("Area demographics; not shopper profiles or proof of sales causation.", "두 프로필 모두 시장 수준의 크리에이티브 및 미디어 테스트 신호로 활용하세요. 이는 인근 거주자를 설명하며 실제 Costco 구매자를 확인하거나 인구통계 특성이 매출을 유발했음을 증명하지 않습니다.")}
        </div>
      </Panel>
    </div>
  );
}

function RankingsView({
  onReady = () => {},
  compactRequestKey = "",
  model = null,
  ranked = [],
  whs = [],
  setSelId = () => {},
  selId = "",
  dateRange = { start:DATA_START, end:DATA_END },
  campaignPid = "",
  campaignCid = "",
  productMeta = {},
  campaignMeta = {},
  analysisSection = "pacing",
  setAnalysisSection = () => {},
  analysisOptions = {},
  setAnalysisOptions = () => {},
  compareA = "",
  compareB = "",
  productOptions = [],
  warehouseProfileQuery = null,
  warehouseProfileProductKey = "",
  onWarehousePublicationStale = () => {},
}) {
  const { t } = useUiText();
  const sectionKinds = {
    pacing:"pacing-v2",
    affinity:"sales-affinity-v1",
    demographics:"market-demographics-v1",
    comparison:"comparison-v1",
    events:"event-impact-v1",
    warehouses:"warehouse-ranking-v1",
  };

  useEffect(() => {
    if (analysisSection !== "demographics" && model && model.kind === sectionKinds[analysisSection] && typeof requestAnimationFrame === "function") {
      let secondFrame = 0;
      const firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => onReady({ section:analysisSection, requestKey:compactRequestKey }));
      });
      return () => {
        cancelAnimationFrame(firstFrame);
        if (secondFrame) cancelAnimationFrame(secondFrame);
      };
    }
    return undefined;
  }, [onReady, analysisSection, compactRequestKey, model]);

  const markDemographicsReady = useCallback(() => {
    if (model?.kind !== sectionKinds.demographics) return;
    onReady({ section:"demographics", requestKey:compactRequestKey });
  }, [compactRequestKey, model, onReady]);

  const sections = [
    ["pacing", t("analysis.sectionPacing", "Pacing")],
    ["affinity", t("analysis.sectionAffinity", "Sales Affinity")],
    ["demographics", t("analysis.sectionDemographics", "Market Demographics")],
    ["comparison", t("analysis.sectionComparison", "Comparison")],
    ["events", t("analysis.sectionEvents", "Event Impact")],
    ["warehouses", t("analysis.sectionWarehouses", "Warehouses")],
  ];

  return (
    <div data-analysis-mounted-section={analysisSection}>
      <div style={{ display:"flex", gap:7, flexWrap:"wrap", marginBottom:14 }}>
        {sections.map(([key, label]) => (
          <button
            key={key}
            data-analysis-section-option={key}
            aria-pressed={analysisSection === key}
            onClick={() => setAnalysisSection(key)}
            style={{ border:"1px solid " + (analysisSection === key ? C.accent : C.border), background:analysisSection === key ? C.accentFade : C.card, color:analysisSection === key ? C.accent : C.muted, borderRadius:7, padding:"7px 10px", cursor:"pointer", fontSize:11, fontWeight:500 }}
          >
            {label}
          </button>
        ))}
      </div>
      {analysisSection === "pacing" && <CompactPacingAnalysisView model={model}/>}
      {analysisSection === "affinity" && <CompactSalesAffinityView result={model} selId={selId} analysisOptions={analysisOptions} setAnalysisOptions={setAnalysisOptions} campaignPid={campaignPid} campaignCid={campaignCid} productMeta={productMeta} campaignMeta={campaignMeta} dateRange={dateRange}/>}
      {analysisSection === "demographics" && <MarketDemographicsView ranked={ranked} whs={whs} selId={selId} setSelId={setSelId} portfolioSales={[]} prodSales={[]} salesContextOverride={model?.salesContext || null} dateRange={dateRange} campaignPid={campaignPid} campaignCid={campaignCid} productMeta={productMeta} campaignMeta={campaignMeta} onReady={markDemographicsReady}/>}
      {analysisSection === "comparison" && <CompactComparisonView model={model} analysisOptions={analysisOptions} setAnalysisOptions={setAnalysisOptions} compareA={compareA} compareB={compareB} productMeta={productMeta}/>}
      {analysisSection === "events" && <CompactEventsView model={model}/>}
      {analysisSection === "warehouses" && <WarehouseAnalysisView model={model} analysisOptions={analysisOptions} setAnalysisOptions={setAnalysisOptions} productOptions={productOptions} campaignMeta={campaignMeta} productMeta={productMeta} whs={whs} profileQuery={warehouseProfileQuery} profileProductKey={warehouseProfileProductKey} onPublicationStale={onWarehousePublicationStale}/>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════

export default RankingsView;
