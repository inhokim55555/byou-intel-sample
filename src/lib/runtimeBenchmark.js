export function benchmarkColdPage(url) {
  return url instanceof URL
    && url.pathname === "/"
    && url.searchParams.get("matrixBenchmark") === "1"
    && url.searchParams.get("matrixCold") === "1";
}

export function benchmarkColdRequestFromReferer(referer = "", expectedHost = "") {
  const host = String(expectedHost || "").trim().toLowerCase();
  if (!host) return false;
  try {
    const source = new URL(String(referer || ""));
    return source.host.toLowerCase() === host && benchmarkColdPage(source);
  } catch (_) {
    return false;
  }
}
