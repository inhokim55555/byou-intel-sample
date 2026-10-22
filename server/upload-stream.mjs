import { createReadStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

function limiter(limit) {
  let bytes = 0;
  return new Transform({ transform(chunk, encoding, next) {
    bytes += chunk.length;
    next(bytes > limit ? Object.assign(new Error("Dataset is larger than the configured upload limit."), { status:413 }) : null, chunk);
  } });
}

// Backpressure bounds transport memory to stream buffers, not dataset size.
// The final JSON validation still materializes a bounded object once on disk.
export async function streamUploadToFile(source, destination, { limit, encoding = "" } = {}) {
  encoding = String(encoding).trim().toLowerCase();
  if (encoding && !["identity", "gzip"].includes(encoding)) throw Object.assign(new Error("Unsupported dataset encoding."), { status:415 });
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("A positive upload limit is required.");
  const output = await open(destination, "wx");
  try {
    await pipeline(source, limiter(limit), ...(encoding === "gzip" ? [createGunzip(), limiter(limit)] : []), output.createWriteStream());
  } catch (error) {
    await output.close().catch(() => {});
    await rm(destination, { force:true }).catch(() => {});
    throw error;
  } finally {
    await output.close().catch(() => {});
  }
}

export function streamUploadParts(files) {
  return Readable.from((async function* () {
    for (const file of files) yield* createReadStream(file);
  })());
}
