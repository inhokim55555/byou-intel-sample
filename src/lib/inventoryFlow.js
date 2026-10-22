import { inventoryFlowEligibleRows } from "./dashboardScope.js";

// Keep the existing eligibility checks and date/product/campaign deduplication.
// This runs in a worker so historical prefix validation cannot block filters.
export function buildInventoryFlowChart(jobs = [], dateRange = {}) {
  const unique = new Map();
  for (const job of jobs) {
    for (const row of inventoryFlowEligibleRows(job.rows, job.warehouse, job.options)) {
      if (!row.date || row.date < dateRange.start || row.date > dateRange.end) continue;
      const key = [job.type,row.date,job.type === "inline" ? row.wid : "",row.pid,row.cid || job.campaignId].join("|");
      const prior = unique.get(key);
      if (!prior || job.latestDate > prior.latestDate || (job.latestDate === prior.latestDate && job.campaignId > prior.campaignId)) {
        unique.set(key,{row,type:job.type,latestDate:job.latestDate,campaignId:job.campaignId});
      }
    }
  }
  const byDate = new Map();
  for (const {row,type} of unique.values()) {
    if (!byDate.has(row.date)) byDate.set(row.date,{date:row.date,label:row.date.slice(5),inline:0,online:0});
    byDate.get(row.date)[type] += Number(row.inv || 0);
  }
  return [...byDate.values()].sort((a,b) => a.date.localeCompare(b.date));
}
