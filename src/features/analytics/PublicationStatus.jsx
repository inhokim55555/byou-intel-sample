import React, { useMemo } from "react";
import { C, useUiText } from "../../ui/dashboardShared.jsx";
import { publicationCheckState, publicationCoverage } from "../../lib/publicationStatus.js";

export default function PublicationStatus({ dataset, status = {} }) {
  const { lang } = useUiText();
  const ko = lang === "ko";
  const coverage = useMemo(() => publicationCoverage(dataset), [dataset]);
  const state = publicationCheckState(status);
  const labels = ko ? {
    unknown:"발행 정보 확인 중", unconfirmed:"저장된 발행본 — 최신 여부 미확인",
    validated:"서버에서 저장된 발행본 확인 완료", downloaded:"서버 발행본 불러오기 완료",
    official:"공식 인라인", warehouse:"웨어하우스", online:"온라인",
  } : {
    unknown:"Publication not yet confirmed", unconfirmed:"Saved publication — latest version not confirmed",
    validated:"Saved publication checked with server", downloaded:"Publication loaded from server",
    official:"Official inline", warehouse:"Warehouse", online:"Online",
  };
  const timestamp = Number.isFinite(Date.parse(status.publishedAt)) ? new Date(status.publishedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—";
  const matches = !!dataset?.publishedAt && dataset.publishedAt === status.publishedAt;
  return <section aria-label={ko ? "발행 및 데이터 범위" : "Publication and data coverage"} style={{ background:C.card, border:`1px solid ${C.border}`, borderRadius:6, padding:12, marginBottom:14, fontSize:11 }}>
    <div role="status" style={{ color:state === "unconfirmed" ? C.warn : C.text, marginBottom:8 }}>
      {labels[state]} · {ko ? "발행 시각" : "Published"}: {timestamp}
    </div>
    <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
      {coverage.map(lane => <div key={lane.lane} data-coverage-lane={lane.lane} style={{ background:C.bg, borderRadius:5, padding:"7px 10px" }}>
        <strong style={{ fontWeight:500 }}>{labels[lane.lane]}</strong>: {!matches || lane.state === "unknown"
          ? (ko ? "범위 정보 없음" : "Coverage unavailable")
          : lane.state === "empty" ? (ko ? "전달된 행 없음 — 매출 0을 뜻하지 않음" : "No rows supplied — not zero sales")
          : lane.state === "undated" ? (ko ? "보고 날짜 없음" : "Reporting dates unavailable")
          : `${lane.start} → ${lane.end} · ${lane.dates.toLocaleString()} ${ko ? "보고 날짜" : lane.dates === 1 ? "reported date" : "reported dates"}`}
      </div>)}
    </div>
    <div style={{ color:C.muted, marginTop:8, lineHeight:1.5 }}>{ko
      ? "전체 발행본의 관측 날짜 범위입니다. 선택한 필터나 로컬 업로드에 해당하는 범위가 아니며, 모든 날짜·제품·매장의 완전성을 보장하지 않습니다. 발행 시각과 원본 데이터의 최신 날짜는 다릅니다."
      : "Observed dates across the whole publication, not the selected filters or local uploads. This does not prove every day, product or store is covered. Publication time is not the source-data date."}</div>
  </section>;
}
