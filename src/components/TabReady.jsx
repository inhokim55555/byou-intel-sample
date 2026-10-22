import { useEffect } from "react";

// Runs only after the lazy child successfully commits, never for its fallback.
export default function TabReady({ requestKey, onReady, children }) {
  useEffect(() => { onReady(requestKey); }, [requestKey, onReady]);
  return children;
}
