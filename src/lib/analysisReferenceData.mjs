import { readFile } from "node:fs/promises";

const MARKET_URL = new URL("../../public/data/costco-market-demographics.json", import.meta.url);
let marketPromise = null;

export function loadAnalysisReferenceData() {
  if (!marketPromise) {
    marketPromise = readFile(MARKET_URL, "utf8")
      .then(text => JSON.parse(text))
      .then(payload => {
        if (payload?.schema !== "byou-costco-market-demographics-v1") throw new Error("The Costco market demographic directory is incompatible.");
        return {
          marketSchema:payload.schema,
          marketGeneratedAt:String(payload.generatedAt || ""),
          marketStores:Array.isArray(payload.stores) ? payload.stores : [],
        };
      })
      .catch(error => {
        marketPromise = null;
        throw error;
      });
  }
  return marketPromise;
}
