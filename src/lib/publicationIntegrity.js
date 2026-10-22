import crypto from "node:crypto";

const MANIFEST_SCHEMA = "byou-intel-publication-manifest-v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function publicationDatabaseVersion(manifest = null, legacyActiveVersion = "") {
  const manifestVersion = String(manifest?.databaseVersionId || "").trim();
  if (manifest && !manifestVersion) {
    throw Object.assign(new Error("The active publication is not bound to a database version."), {
      status:503,
      code:"PUBLICATION_DATABASE_VERSION_UNAVAILABLE",
    });
  }
  return manifestVersion || String(legacyActiveVersion || "").trim();
}

export function previousDatabaseVersionForRetention(preparedPreviousVersionId = "", preUpdateActiveVersionId = "") {
  return String(preparedPreviousVersionId || preUpdateActiveVersionId || "").trim();
}

export function selectPublicationReadSource({ manifest = null, filePublishedAt = "", databaseVersionId = "", databasePublishedAt = "" } = {}) {
  const manifestVersionId = String(manifest?.databaseVersionId || "").trim();
  const resolvedDatabaseVersionId = String(databaseVersionId || "").trim();
  const targetPublishedAt = String(manifest?.publishedAt || filePublishedAt || "").trim();
  const databaseTimestamp = String(databasePublishedAt || "").trim();
  if (manifest && !manifestVersionId) return { source:"file", databaseVersionId:"", reason:"manifest-unbound" };
  if (!resolvedDatabaseVersionId || !targetPublishedAt || !databaseTimestamp) return { source:"file", databaseVersionId:"", reason:"database-unavailable" };
  if (manifest && resolvedDatabaseVersionId !== manifestVersionId) return { source:"file", databaseVersionId:"", reason:"database-version-mismatch" };
  if (Date.parse(targetPublishedAt) !== Date.parse(databaseTimestamp)) return { source:"file", databaseVersionId:"", reason:"publication-mismatch" };
  return { source:"database", databaseVersionId:resolvedDatabaseVersionId, reason:"matched" };
}

export function runtimeFileFallbackAllowed({ railwayProduction = false, readSource = "", prepared = false } = {}) {
  return String(readSource || "") === "database" || !railwayProduction || prepared === true;
}

export function buildPublicationManifest({ publicationId, publishedAt, datasetText, startupText, databaseVersionId = "" } = {}) {
  if (!UUID_PATTERN.test(String(publicationId || "")) || !Number.isFinite(Date.parse(String(publishedAt || "")))) {
    throw new Error("Publication manifests require a server-issued ID and timestamp.");
  }
  return {
    schema:MANIFEST_SCHEMA,
    publicationId:String(publicationId),
    publishedAt:String(publishedAt),
    dataset:{ file:"dataset.json", sha256:sha256Text(datasetText), bytes:Buffer.byteLength(String(datasetText)) },
    startup:{ file:"startup.json", sha256:sha256Text(startupText), bytes:Buffer.byteLength(String(startupText)) },
    databaseVersionId:String(databaseVersionId || ""),
  };
}

export function validatePublicationManifest(value = {}) {
  if (value?.schema !== MANIFEST_SCHEMA
    || !UUID_PATTERN.test(String(value?.publicationId || ""))
    || !Number.isFinite(Date.parse(String(value?.publishedAt || "")))
    || value?.dataset?.file !== "dataset.json"
    || value?.startup?.file !== "startup.json"
    || !/^[0-9a-f]{64}$/.test(String(value?.dataset?.sha256 || ""))
    || !/^[0-9a-f]{64}$/.test(String(value?.startup?.sha256 || ""))
    || !Number.isSafeInteger(value?.dataset?.bytes) || value.dataset.bytes < 0
    || !Number.isSafeInteger(value?.startup?.bytes) || value.startup.bytes < 0) {
    throw new Error("The active publication manifest is invalid.");
  }
  return value;
}
