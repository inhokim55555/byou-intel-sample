import { parentPort } from "node:worker_threads";
import { buildInventoryViewModel } from "./inventoryViewModel.js";

if (!parentPort) throw new Error("Inventory view worker requires a parent thread.");

parentPort.on("message", ({ id, input, options }) => {
  try {
    parentPort.postMessage({ id, result:buildInventoryViewModel(input, options) });
  } catch (error) {
    parentPort.postMessage({
      id,
      error:{
        name:String(error?.name || "Error"),
        message:String(error?.message || "Inventory calculation failed."),
        code:String(error?.code || ""),
        status:Number(error?.status || 0),
      },
    });
  }
});
