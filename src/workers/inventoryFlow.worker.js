import { buildInventoryFlowChart } from "../lib/inventoryFlow.js";

self.onmessage = ({data}) => {
  try {
    const started = performance.now();
    const chartData = buildInventoryFlowChart(data.jobs, data.dateRange);
    self.postMessage({ok:true,chartData,processingMs:performance.now() - started});
  } catch (error) {
    // Report why the chart failed so the UI can show a reason instead of a bare error state.
    self.postMessage({ok:false,error:String(error?.message || "Inventory flow chart could not be built.")});
  }
};
