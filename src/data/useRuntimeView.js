import { useEffect } from "react";
import { fetchRuntimeView } from "../lib/runtimeRequest.js";
import { ANALYSIS_COMPACT_REPRESENTATION, ANALYSIS_COMPACT_SCHEMA } from "../lib/analysisCompact.js";
import { SALES_COMPACT_REPRESENTATION, SALES_COMPACT_SCHEMA } from "../lib/salesCompact.js";

// Preserve the publication-keyed cache, compact models and stale-response guards.
export default function useRuntimeView({ analysisPaintRef, applyRuntimeViewDataset, detailLoadedRef, inventoryApprovalOverlayError, inventoryApprovalOverlayFailed, inventoryApprovalOverlayWaiting, latestRuntimeRequestKey, loadSharedDataset, refreshInventoryApprovalOverlay, restoreStartupSummaryDataset, runtimeProductKey, runtimeQuery, runtimeQueryEnabled, runtimeRequestKey, runtimeRetry, runtimeUrl, runtimeViewAbortRef, runtimeViewAppliedKeyRef, runtimeViewAppliedRef, runtimeViewCacheRef, setCampaignComparison, setDatasetTimings, setDetailDatasetStatus, setInventoryViewModel, setRuntimeRequestState, setSharedDatasetStatus, sharedDatasetStatus, showToast, startupLoadStartedAtRef }) {
  useEffect(() => {
    if (!sharedDatasetStatus.publishedAt) return;
    if (inventoryApprovalOverlayWaiting) {
      runtimeViewAbortRef.current?.abort();
      runtimeViewAppliedKeyRef.current = "";
      setInventoryViewModel(null);
      setRuntimeRequestState({key:runtimeRequestKey,status:inventoryApprovalOverlayFailed ? "error" : "loading"});
      setDetailDatasetStatus({
        state:inventoryApprovalOverlayFailed ? "error" : "loading",
        message:inventoryApprovalOverlayFailed
          ? inventoryApprovalOverlayError
          : "Refreshing Inventory approval state...",
      });
      return;
    }
    if (detailLoadedRef.current && runtimeQuery.representation !== ANALYSIS_COMPACT_REPRESENTATION) return;
    if (!runtimeQueryEnabled) {
      if (runtimeViewAppliedRef.current) restoreStartupSummaryDataset();
      else setCampaignComparison(null);
      runtimeViewAbortRef.current?.abort();
      setDetailDatasetStatus({ state:"loaded", message:"Showing the precomputed published summary. Choose a campaign, product, date, or geography for a focused database query." });
      setDatasetTimings(previous => ({ ...previous, serverQueryMs:0, viewDownloadMs:0, viewParseMs:0 }));
      setRuntimeRequestState({key:runtimeRequestKey,status:"ready"});
      runtimeViewAppliedKeyRef.current = runtimeRequestKey;
      if (["analytics", "rankings"].includes(runtimeQuery.view)) {
        requestAnimationFrame(() => requestAnimationFrame(() => setDatasetTimings(previous => ({ ...previous, analysisReadyMs:0 }))));
      }
      return;
    }
    if (runtimeViewAppliedKeyRef.current === runtimeRequestKey) return;
    runtimeViewAbortRef.current?.abort();
    setCampaignComparison(null);
    const controller = new AbortController();
    runtimeViewAbortRef.current = controller;
    const url = runtimeUrl;
    const cacheKey = runtimeRequestKey;
    const startedAt = performance.now();
    if (runtimeQuery.representation === ANALYSIS_COMPACT_REPRESENTATION) {
      const existingPaint = analysisPaintRef.current;
      analysisPaintRef.current = existingPaint?.startedAt
        ? { ...existingPaint, section:runtimeQuery.section, requestKey:cacheKey }
        : { startedAt, section:runtimeQuery.section, requestKey:cacheKey };
    }
    const cached = runtimeViewCacheRef.current.get(cacheKey);
    if (cached) {
      const cachedDataset = cached.dataset || cached;
      const cachedMetrics = cached.metrics || {};
      applyRuntimeViewDataset(cachedDataset, { ...cachedMetrics, viewCacheMs:0, viewDownloadMs:0, viewParseMs:0 });
      runtimeViewAppliedKeyRef.current = cacheKey;
      setRuntimeRequestState({
        key:cacheKey,
        status:"ready",
        downloadMs:0,
        parseMs:0,
        responseBytes:Number(cachedMetrics.responseBytes || 0),
        transferBytes:0,
        contentEncoding:"memory",
        queryMs:0,
        serverCached:undefined,
        browserCached:true,
      });
      if (runtimeQuery.view === "campaign") requestAnimationFrame(() => requestAnimationFrame(() => setDatasetTimings(previous => ({ ...previous, campaignQueryReadyMs:Math.round(performance.now() - (startupLoadStartedAtRef.current || performance.now())) }))));
      return () => controller.abort();
    }
    // A pending scope replaces the ready state even while the previous model
    // remains in memory. Returning to that model must restore cache + ready,
    // not exit early on its old applied key (A -> pending B -> A).
    runtimeViewAppliedKeyRef.current = "";
    setDetailDatasetStatus({ state:"loading", message:`Loading ${runtimeQuery.view} from the published database...` });
    setRuntimeRequestState({key:cacheKey,status:"loading"});
    (async () => {
      try {
        const expectedSchema = runtimeQuery.representation === "inventory-compact-v1"
          ? "byou-intel-inventory-compact-v1"
          : runtimeQuery.representation === ANALYSIS_COMPACT_REPRESENTATION
            ? ANALYSIS_COMPACT_SCHEMA
            : runtimeQuery.representation === SALES_COMPACT_REPRESENTATION
              ? SALES_COMPACT_SCHEMA
            : "byou-intel-view-v1";
        let runtimeResponse;
        for (let attempt = 0; ; attempt += 1) {
          try {
            runtimeResponse = await fetchRuntimeView(url,{signal:controller.signal,expectedSchema});
            break;
          } catch (error) {
            const retryLatestInventory = runtimeQuery.view === "inventory"
              && error?.code === "INVENTORY_WORKER_BUSY"
              && attempt < 6
              && !controller.signal.aborted
              && latestRuntimeRequestKey.current === cacheKey;
            if (!retryLatestInventory) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.min(1000, 250 * (2 ** attempt))));
            if (controller.signal.aborted || latestRuntimeRequestKey.current !== cacheKey) return;
          }
        }
        const {dataset,metrics} = runtimeResponse;
        const {viewDownloadMs,viewParseMs,responseBytes,transferBytes,contentEncoding,serverQueryMs,serverCached} = metrics;
        if (controller.signal.aborted || latestRuntimeRequestKey.current !== cacheKey) return;
        runtimeViewCacheRef.current.set(cacheKey, { dataset, metrics }, metrics.cacheBytes ?? responseBytes);
        applyRuntimeViewDataset(dataset, { viewDownloadMs, viewParseMs, responseBytes, transferBytes, contentEncoding });
        runtimeViewAppliedKeyRef.current = cacheKey;
        setRuntimeRequestState({key:cacheKey,status:"ready",downloadMs:viewDownloadMs,parseMs:viewParseMs,responseBytes,transferBytes,contentEncoding,queryMs:serverQueryMs,serverCached,browserCached:false});
        if (runtimeQuery.view === "campaign") {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const campaignQueryReadyMs = Math.round(performance.now() - (startupLoadStartedAtRef.current || startedAt));
            setDatasetTimings(previous => ({ ...previous, campaignQueryReadyMs }));
            try {
              performance.mark("byou-campaign-ready");
              performance.measure("byou-login-to-campaign-ready", "byou-startup-load-start", "byou-campaign-ready");
            } catch {}
          }));
        }
        if (runtimeQuery.view === "analytics") {
          requestAnimationFrame(() => requestAnimationFrame(() => setDatasetTimings(previous => ({ ...previous, analysisReadyMs:Math.round(performance.now() - startedAt) }))));
        }
      } catch (error) {
        if (controller.signal.aborted || error.name === "AbortError" || latestRuntimeRequestKey.current !== cacheKey) return;
        if (error.status === 409 && error.code !== "STALE_RUNTIME_PUBLICATION" && runtimeQuery.view === "inventory") {
          const refreshed = await refreshInventoryApprovalOverlay();
          if (refreshed) return;
        }
        if (error.status === 409) {
          await loadSharedDataset({manual:true});
          return;
        }
        const message = error.message || "The dashboard query failed.";
        setRuntimeRequestState({key:cacheKey,status:"error"});
        setDetailDatasetStatus({ state:"error", message });
        setSharedDatasetStatus(previous => ({ ...previous, warning:message }));
        showToast("Published dashboard query failed");
      }
    })();
    return () => controller.abort();
  }, [sharedDatasetStatus.publishedAt, runtimeQuery, runtimeProductKey, runtimeQueryEnabled, runtimeUrl, runtimeRequestKey, runtimeRetry, inventoryApprovalOverlayWaiting, inventoryApprovalOverlayFailed, inventoryApprovalOverlayError, applyRuntimeViewDataset, restoreStartupSummaryDataset, refreshInventoryApprovalOverlay, loadSharedDataset, showToast]);
}
