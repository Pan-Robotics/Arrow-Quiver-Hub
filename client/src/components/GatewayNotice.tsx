import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { gatewayCooldown } from "../lib/gatewayTransport";

export default function GatewayNotice({
  retryQueries,
}: {
  retryQueries: () => void;
}) {
  const snapshot = useSyncExternalStore(
    gatewayCooldown.subscribe,
    gatewayCooldown.getSnapshot,
    gatewayCooldown.getSnapshot
  );
  const [now, setNow] = useState(Date.now);
  const retried = useRef(0);
  useEffect(() => {
    if (!snapshot.active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot.active, snapshot.retryAt]);
  const seconds = Math.max(0, Math.ceil((snapshot.retryAt - now) / 1000));
  useEffect(() => {
    if (!snapshot.active || seconds > 0 || retried.current === snapshot.retryAt)
      return;
    retried.current = snapshot.retryAt;
    retryQueries();
  }, [snapshot.active, snapshot.retryAt, seconds, retryQueries]);
  if (!snapshot.active) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="fixed inset-x-4 top-3 z-[100] mx-auto max-w-3xl rounded-lg border border-amber-500/50 bg-amber-950 px-4 py-3 text-sm text-amber-100 shadow-lg"
    >
      <p className="font-semibold">
        {snapshot.status === 429
          ? "Server rate limit reached"
          : "Server temporarily unavailable"}
      </p>
      <p>
        {seconds > 0
          ? `API requests are paused. Queries will retry in about ${seconds} seconds.`
          : "Retrying queries when the server is available…"}{" "}
        Actions that change data are not automatically resent.
      </p>
    </div>
  );
}
