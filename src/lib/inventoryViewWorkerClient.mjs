import { Worker } from "node:worker_threads";

let worker = null;
let nextRequestId = 1;
let activeRequest = null;
let queuedRequest = null;

function releaseWorkerIfIdle() {
  if (!activeRequest && !queuedRequest) worker?.unref();
}

function failOutstanding(error) {
  const requests = [activeRequest, queuedRequest].filter(Boolean);
  activeRequest = null;
  queuedRequest = null;
  for (const request of requests) request.reject(error);
  releaseWorkerIfIdle();
}

function busyError() {
  const error = new Error("Inventory is busy processing another selection. Retry the latest selection shortly.");
  error.code = "INVENTORY_WORKER_BUSY";
  error.status = 503;
  return error;
}

function dispatchQueuedRequest() {
  if (activeRequest || !queuedRequest) {
    releaseWorkerIfIdle();
    return;
  }
  const request = queuedRequest;
  queuedRequest = null;
  dispatchRequest(request);
}

function dispatchRequest(request) {
  const activeWorker = inventoryWorker();
  activeRequest = request;
  activeWorker.ref();
  try {
    activeWorker.postMessage({ id:request.id, input:request.input, options:request.options });
  } catch (error) {
    activeRequest = null;
    request.reject(error);
    dispatchQueuedRequest();
  }
}

function inventoryWorker() {
  if (worker) return worker;
  const created = new Worker(new URL("./inventoryViewWorker.mjs", import.meta.url), { type:"module" });
  worker = created;
  created.on("message", message => {
    const request = activeRequest;
    if (!request || request.id !== message?.id) return;
    activeRequest = null;
    if (message.error) {
      const error = new Error(message.error.message || "Inventory calculation failed.");
      error.name = message.error.name || "Error";
      if (message.error.code) error.code = message.error.code;
      if (message.error.status) error.status = message.error.status;
      request.reject(error);
    } else {
      request.resolve(message.result);
    }
    dispatchQueuedRequest();
  });
  created.on("error", error => {
    if (worker !== created) return;
    worker = null;
    failOutstanding(error);
  });
  created.on("exit", code => {
    if (worker !== created) return;
    worker = null;
    if (activeRequest || queuedRequest) failOutstanding(new Error(`Inventory calculation worker exited with code ${code}.`));
  });
  created.unref();
  return created;
}

export function buildInventoryViewModelAsync(input = {}, options = {}) {
  const id = nextRequestId;
  nextRequestId += 1;
  return new Promise((resolve, reject) => {
    const request = { id, input, options, resolve, reject };
    if (!activeRequest) dispatchRequest(request);
    else if (!queuedRequest) queuedRequest = request;
    else reject(busyError());
  });
}
