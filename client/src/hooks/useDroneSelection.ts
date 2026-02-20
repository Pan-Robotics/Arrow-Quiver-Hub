import { useState, useEffect, useCallback } from "react";
import { trpc } from "@/lib/trpc";

const STORAGE_PREFIX = "quiver-hub-selected-drone";

/**
 * Build the localStorage key for a given app.
 * Each app gets its own key so drone selections are independent.
 */
function storageKey(appId: string): string {
  return `${STORAGE_PREFIX}:${appId}`;
}

/**
 * Shared hook for drone selection with per-app localStorage persistence.
 *
 * @param appId - Unique identifier for the calling app (e.g. "lidar", "telemetry", "camera").
 *                Each app stores its own selected drone independently.
 *
 * - Fetches the drone list via tRPC
 * - Restores the last-selected drone from localStorage on mount
 * - Falls back to the first available drone if the stored value is stale
 * - Persists every selection change to localStorage under an app-specific key
 * - Provides a stable setter that also writes to storage
 */
export function useDroneSelection(appId: string) {
  const key = storageKey(appId);

  const [selectedDrone, setSelectedDroneState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  });

  // Fetch list of drones
  const { data: drones, isLoading } = trpc.pointcloud.getDrones.useQuery();

  // Stable setter that also persists to localStorage
  const setSelectedDrone = useCallback((droneId: string | null) => {
    setSelectedDroneState(droneId);
    try {
      if (droneId) {
        localStorage.setItem(key, droneId);
      } else {
        localStorage.removeItem(key);
      }
    } catch {
      // localStorage may be unavailable (private browsing, quota exceeded)
    }
  }, [key]);

  // Auto-select logic: restore from storage or fall back to first drone
  useEffect(() => {
    if (!drones || drones.length === 0) return;

    const droneIds = drones.map((d) => d.droneId);

    if (selectedDrone && droneIds.includes(selectedDrone)) {
      // Stored value is still valid — keep it
      return;
    }

    // Stored value is stale or missing — pick the first drone
    setSelectedDrone(drones[0].droneId);
  }, [drones, selectedDrone, setSelectedDrone]);

  return {
    selectedDrone,
    setSelectedDrone,
    drones: drones ?? [],
    isLoading,
  };
}
