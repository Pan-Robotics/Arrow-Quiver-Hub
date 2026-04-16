import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Wifi, WifiOff, Loader2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Connection states:
 * - "disconnected": No WebSocket connection / socket not connected
 * - "connecting": WebSocket is connecting or waiting for first data
 * - "connected": WebSocket connected AND data received within the staleness window
 * - "stale": WebSocket connected but no data received within the staleness window
 */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "stale";

interface ConnectionStatusProps {
  /**
   * Whether the WebSocket transport is connected.
   * This alone does NOT mean "connected" — data must also be flowing.
   */
  socketConnected: boolean;

  /**
   * Timestamp (Date or epoch ms) of the last data packet received.
   * When null/undefined, the component shows "connecting" (if socket is up)
   * or "disconnected" (if socket is down).
   */
  lastDataAt?: Date | number | null;

  /**
   * How many seconds without data before the connection is considered "stale".
   * Default: 15 seconds.
   */
  staleThresholdSeconds?: number;

  /**
   * Optional label override. Defaults to the state name.
   */
  label?: string;

  /**
   * Optional extra detail shown in tooltip (e.g., "3 streams", "WebRTC Live").
   */
  detail?: string;

  /**
   * Visual size variant.
   * - "sm": compact dot + text, no badge border (for inline use)
   * - "md": badge with icon (default, for headers)
   */
  size?: "sm" | "md";

  /**
   * Optional className for the outer container.
   */
  className?: string;
}

const STATE_CONFIG: Record<ConnectionState, {
  dotColor: string;
  badgeClass: string;
  icon: typeof Wifi;
  defaultLabel: string;
  pulse: boolean;
}> = {
  disconnected: {
    dotColor: "bg-zinc-500",
    badgeClass: "text-zinc-400 border-zinc-600",
    icon: WifiOff,
    defaultLabel: "Disconnected",
    pulse: false,
  },
  connecting: {
    dotColor: "bg-yellow-500",
    badgeClass: "text-yellow-400 border-yellow-500/30",
    icon: Loader2,
    defaultLabel: "Connecting",
    pulse: true,
  },
  connected: {
    dotColor: "bg-green-500",
    badgeClass: "text-green-400 border-green-400/30",
    icon: Wifi,
    defaultLabel: "Connected",
    pulse: false,
  },
  stale: {
    dotColor: "bg-amber-500",
    badgeClass: "text-amber-400 border-amber-500/30",
    icon: Wifi,
    defaultLabel: "Stale",
    pulse: true,
  },
};

function deriveState(
  socketConnected: boolean,
  lastDataAt: Date | number | null | undefined,
  staleThresholdMs: number,
): ConnectionState {
  if (!socketConnected) return "disconnected";

  // Socket is connected but no data ever received
  if (lastDataAt == null) return "connecting";

  const lastMs = lastDataAt instanceof Date ? lastDataAt.getTime() : lastDataAt;
  const elapsed = Date.now() - lastMs;

  if (elapsed <= staleThresholdMs) return "connected";
  return "stale";
}

/**
 * Unified connection status indicator used across all Quiver Hub apps.
 *
 * Shows the real connection state based on both WebSocket connectivity
 * AND whether data is actually flowing (not just socket.connected).
 *
 * Usage:
 * ```tsx
 * <ConnectionStatus
 *   socketConnected={socket?.connected ?? false}
 *   lastDataAt={lastDataTimestamp}
 *   staleThresholdSeconds={15}
 * />
 * ```
 */
export function ConnectionStatus({
  socketConnected,
  lastDataAt,
  staleThresholdSeconds = 15,
  label,
  detail,
  size = "md",
  className = "",
}: ConnectionStatusProps) {
  const staleThresholdMs = staleThresholdSeconds * 1000;
  const [state, setState] = useState<ConnectionState>(() =>
    deriveState(socketConnected, lastDataAt, staleThresholdMs)
  );

  // Re-derive state on prop changes
  useEffect(() => {
    setState(deriveState(socketConnected, lastDataAt, staleThresholdMs));
  }, [socketConnected, lastDataAt, staleThresholdMs]);

  // Tick every second to catch staleness transitions
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setState(deriveState(socketConnected, lastDataAt, staleThresholdMs));
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [socketConnected, lastDataAt, staleThresholdMs]);

  const config = STATE_CONFIG[state];
  const Icon = config.icon;
  const displayLabel = label ?? config.defaultLabel;

  // Build tooltip text
  const tooltipLines: string[] = [displayLabel];
  if (state === "stale" && lastDataAt != null) {
    const lastMs = lastDataAt instanceof Date ? lastDataAt.getTime() : lastDataAt;
    const agoSec = Math.round((Date.now() - lastMs) / 1000);
    tooltipLines.push(`Last data: ${agoSec}s ago`);
  }
  if (state === "connecting") {
    tooltipLines.push("Waiting for first data packet...");
  }
  if (detail) {
    tooltipLines.push(detail);
  }

  if (size === "sm") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={`flex items-center gap-1.5 ${className}`}>
            <span
              className={`w-2 h-2 rounded-full ${config.dotColor} ${config.pulse ? "animate-pulse" : ""}`}
            />
            <span className="text-xs text-muted-foreground">{displayLabel}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {tooltipLines.map((line, i) => (
            <p key={i} className={i > 0 ? "text-xs text-muted-foreground" : ""}>
              {line}
            </p>
          ))}
        </TooltipContent>
      </Tooltip>
    );
  }

  // md (default) — Badge style
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className={`gap-1 ${config.badgeClass} ${className}`}>
          <Icon
            size={12}
            className={Icon === Loader2 ? "animate-spin" : ""}
          />
          {displayLabel}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {tooltipLines.map((line, i) => (
          <p key={i} className={i > 0 ? "text-xs text-muted-foreground" : ""}>
            {line}
          </p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Hook to track last-data timestamp. Call `markDataReceived()` whenever
 * a data packet arrives. Returns the timestamp for use with <ConnectionStatus>.
 */
export function useLastDataTimestamp() {
  const [lastDataAt, setLastDataAt] = useState<number | null>(null);

  const markDataReceived = () => {
    setLastDataAt(Date.now());
  };

  const reset = () => {
    setLastDataAt(null);
  };

  return { lastDataAt, markDataReceived, reset };
}
