/**
 * Leaflet + OpenStreetMap map view.
 *
 * No API key and no third-party JS. Tiles are fetched from the public
 * OpenStreetMap tile servers, so the base map needs internet access; the
 * flight track itself still draws without it.
 *
 * Usage:
 *   <MapView
 *     center={{ lat, lng }}
 *     zoom={16}
 *     onMapReady={(map) => { ...draw on the Leaflet map... }}
 *   />
 */

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { cn } from "@/lib/utils";

interface MapViewProps {
  className?: string;
  center?: { lat: number; lng: number };
  zoom?: number;
  onMapReady?: (map: L.Map) => void;
}

export function MapView({
  className,
  center = { lat: 37.7749, lng: -122.4194 },
  zoom = 12,
  onMapReady,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const onReadyRef = useRef(onMapReady);
  onReadyRef.current = onMapReady;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
    }).setView([center.lat, center.lng], zoom);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);

    mapRef.current = map;
    // Ensure tiles lay out correctly once the container has its final size.
    setTimeout(() => map.invalidateSize(), 0);
    onReadyRef.current?.(map);

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Initialize the map once on mount; callers redraw via the onMapReady map handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={containerRef} className={cn("w-full h-[500px]", className)} />
  );
}
