import React from "react";

class RuntimeRenderErrorBoundary extends React.Component {
  state = { error:null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error("[BYOU Intel] Runtime view render failed", {
      label:this.props.label,
      errorName:error?.name || "Error",
    });
  }

  componentDidUpdate(previousProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) this.setState({ error:null });
  }

  retry = () => {
    this.setState({ error:null });
    this.props.onRetry?.();
  };

  render() {
    if (!this.state.error) return this.props.children;
    const { label, lang = "en" } = this.props;
    return <section data-runtime-render-error="true" role="alert" style={{padding:24,background:"#fff",border:"1px solid #D9DEE7",borderRadius:6}}>
      <div>
        {lang === "ko"
          ? `${label} 화면을 표시하지 못했습니다. 다시 시도해 주세요.`
          : `Could not display ${label}. Please retry.`}
      </div>
      <button type="button" onClick={this.retry} style={{marginTop:12,padding:"7px 14px",cursor:"pointer"}}>{lang === "ko" ? "다시 시도" : "Retry"}</button>
    </section>;
  }
}

export default function RuntimeViewBoundary({ state, label, lang = "en", onRetry, resetKey = "", detail = "", children }) {
  if (state === "ready") return <RuntimeRenderErrorBoundary label={label} lang={lang} onRetry={onRetry} resetKey={resetKey}>{children}</RuntimeRenderErrorBoundary>;
  const error = state === "error";
  return <section data-runtime-status={state} aria-busy={!error} style={{padding:24,background:"#fff",border:"1px solid #D9DEE7",borderRadius:6}}>
    <div role={error ? "alert" : "status"} aria-live="polite">
      {lang === "ko"
        ? (error ? `${label} 데이터를 불러오지 못했습니다. 다시 시도해 주세요.` : `${label} 데이터를 불러오는 중...`)
        : (error ? `Could not load ${label}. Please retry.` : `Loading ${label}…`)}
    </div>
    {error && detail ? <div style={{marginTop:8,fontSize:12,color:"#6B7280"}}>{detail}</div> : null}
    {error && <button type="button" onClick={onRetry} style={{marginTop:12,padding:"7px 14px",cursor:"pointer"}}>{lang === "ko" ? "다시 시도" : "Retry"}</button>}
  </section>;
}
