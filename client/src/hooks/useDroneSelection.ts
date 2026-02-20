import { useState, useEffect, useCallback } from "react";
import { trpc } from "@/lib/trpc";

const STORAGE_KEY = "quiver-hub-selected-drone";

/**
 * Shared hook for drone selection with localStorage persistence.
 *
 * - Fetches the drone list via tRPC
 * - Restores the last-selected drone from localStorage on mount
 * - Falls back to the first available drone if the stored value is stale
 * - Persists every selection change to localStorage
 * - Provides a stable setter that also writes to storage
 */
export function useDroneSelection() {
  const [selectedDrone, setSelectedDroneState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
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
        localStorage.setItem(STORAGE_KEY, droneId);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // localStorage may be unavailable (private browsing, quota exceeded)
    }
  }, []);

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
