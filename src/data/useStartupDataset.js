import { useEffect, useMemo } from "react";
import { createStartupLoader } from "./startupLoader.js";

export default function useStartupDataset({ applyStartupDataset, showToast, setSharedDatasetStatus, setDatasetTimings, startupLoadStartedAtRef }) {
  const load = useMemo(() => createStartupLoader({ applyStartupDataset, showToast, setSharedDatasetStatus, setDatasetTimings, startupLoadStartedAtRef }), [applyStartupDataset, showToast, setSharedDatasetStatus, setDatasetTimings, startupLoadStartedAtRef]);
  useEffect(() => () => load.cancel(), [load]);
  return load;
}
