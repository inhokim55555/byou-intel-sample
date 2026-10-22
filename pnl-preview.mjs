import crypto from "node:crypto";

const PREVIEW_TTL_MS = 15 * 60 * 1000;

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ""));
  const right = Buffer.from(String(rightValue || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function pnlNormalizedPayloadDigest(normalized) {
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function signature(secret, encodedPayload) {
  return crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function createPnlPreviewReceipt({ normalized, email, secret, now = Date.now() }) {
  const payload = {
    purpose:"byou-pnl-import-preview",
    v:1,
    email:String(email || "").trim().toLowerCase(),
    digest:pnlNormalizedPayloadDigest(normalized),
    expiresAt:now + PREVIEW_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { token:`${encoded}.${signature(secret, encoded)}`, expiresAt:payload.expiresAt };
}

export function verifyPnlPreviewReceipt({ token, normalized, email, secret, now = Date.now() }) {
  const [encoded, suppliedSignature] = String(token || "").split(".");
  if (!encoded || !suppliedSignature || !safeEqual(suppliedSignature, signature(secret, encoded))) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return payload?.purpose === "byou-pnl-import-preview"
      && payload?.v === 1
      && Number(payload.expiresAt || 0) > now
      && safeEqual(payload.email, String(email || "").trim().toLowerCase())
      && safeEqual(payload.digest, pnlNormalizedPayloadDigest(normalized));
  } catch {
    return false;
  }
}
