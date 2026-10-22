import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

function decodeJsonString(raw) {
  try { return JSON.parse(`"${raw}"`); }
  catch { return ""; }
}

function rootPublishedAtScanner() {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let role = "";
  let token = "";
  let expectingRootKey = false;
  let currentRootKey = "";
  let expectingRootValue = false;
  let publishedAt = "";

  return {
    push(source) {
      if (publishedAt) return;
      for (const character of source) {
        if (inString) {
          if (escaped) {
            if (role !== "ignore") token += character;
            escaped = false;
            continue;
          }
          if (character === "\\") {
            if (role !== "ignore") token += character;
            escaped = true;
            continue;
          }
          if (character !== '"') {
            if (role !== "ignore") token += character;
            continue;
          }

          inString = false;
          if (role === "key") {
            currentRootKey = decodeJsonString(token);
            expectingRootKey = false;
          } else if (role === "publishedAt") {
            publishedAt = decodeJsonString(token);
          }
          if (depth === 1 && expectingRootValue) expectingRootValue = false;
          role = "";
          token = "";
          if (publishedAt) return;
          continue;
        }

        if (character === '"') {
          role = depth === 1 && expectingRootKey
            ? "key"
            : depth === 1 && expectingRootValue && currentRootKey === "publishedAt"
              ? "publishedAt"
              : "ignore";
          token = "";
          inString = true;
          continue;
        }
        if (character === "{" || character === "[") {
          if (depth === 0 && character === "{") expectingRootKey = true;
          else if (depth === 1 && expectingRootValue) expectingRootValue = false;
          depth += 1;
          continue;
        }
        if (character === "}" || character === "]") {
          depth = Math.max(0, depth - 1);
          continue;
        }
        if (depth !== 1) continue;
        if (character === ":" && currentRootKey && !expectingRootKey) {
          expectingRootValue = true;
          continue;
        }
        if (character === ",") {
          expectingRootKey = true;
          expectingRootValue = false;
          currentRootKey = "";
          continue;
        }
        if (expectingRootValue && !/\s/.test(character)) expectingRootValue = false;
      }
    },
    value() { return publishedAt; },
  };
}

export async function inspectJsonPublicationFile(filePath) {
  const hash = crypto.createHash("sha256");
  const decoder = new StringDecoder("utf8");
  const scanner = rootPublishedAtScanner();
  let bytes = 0;

  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.byteLength;
    scanner.push(decoder.write(chunk));
  }
  scanner.push(decoder.end());

  return { bytes, sha256:hash.digest("hex"), publishedAt:scanner.value() };
}
