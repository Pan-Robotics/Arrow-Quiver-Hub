import { describe, it, expect } from "vitest";
import {
  extractFlightModes,
  extractGpsTrack,
  getModeColor,
  type FlightModeSegment,
  type GpsTrackPoint,
} from "../client/src/lib/flight-charts";

describe("extractFlightModes", () => {
  it("returns empty array when no MODE messages", () => {
    const result = extractFlightModes({});
    expect(result).toEqual([]);
  });

  it("returns empty array when MODE has no time_boot_ms", () => {
    const result = extractFlightModes({ MODE: { Mode: ["Stabilize"] } });
    expect(result).toEqual([]);
  });

  it("returns empty array when MODE has empty arrays", () => {
    const result = extractFlightModes({
      MODE: { time_boot_ms: [], Mode: [], ModeNum: [] },
    });
    expect(result).toEqual([]);
  });

  it("parses text format MODE messages (string mode names)", () => {
    const messages = {
      MODE: {
        time_boot_ms: [1000, 5000, 10000],
        Mode: ["Stabilize", "Loiter", "RTL"],
        ModeNum: [0, 5, 6],
      },
      ATT: {
        time_boot_ms: [0, 15000],
      },
    };

    const result = extractFlightModes(messages);
    expect(result).toHaveLength(3);

    expect(result[0].mode).toBe("Stabilize");
    expect(result[0].modeNum).toBe(0);
    expect(result[0].startTime).toBeCloseTo(1, 0); // 1000ms from start (0ms)
    expect(result[0].endTime).toBeCloseTo(5, 0);

    expect(result[1].mode).toBe("Loiter");
    expect(result[1].modeNum).toBe(5);

    expect(result[2].mode).toBe("RTL");
    expect(result[2].modeNum).toBe(6);
    // Last segment ends at global max time (15000ms from ATT)
    expect(result[2].endTime).toBeCloseTo(15, 0);
  });

  it("parses binary format MODE messages (numeric mode with COPTER_MODES lookup)", () => {
    const messages = {
      MODE: {
        time_boot_ms: [2000, 8000],
        Mode: [0, 16],
        ModeNum: [0, 16],
      },
    };

    const result = extractFlightModes(messages);
    expect(result).toHaveLength(2);
    expect(result[0].mode).toBe("Stabilize");
    expect(result[1].mode).toBe("PosHold");
  });

  it("uses asText when available for binary format", () => {
    const messages = {
      MODE: {
        time_boot_ms: [1000, 5000],
        Mode: [0, 16],
        ModeNum: [0, 16],
        asText: ["STABILIZE", "POSHOLD"],
      },
    };

    const result = extractFlightModes(messages);
    expect(result[0].mode).toBe("STABILIZE");
    expect(result[1].mode).toBe("POSHOLD");
  });

  it("handles single mode segment", () => {
    const messages = {
      MODE: {
        time_boot_ms: [1000],
        Mode: ["AltHold"],
        ModeNum: [2],
      },
    };

    const result = extractFlightModes(messages);
    expect(result).toHaveLength(1);
    expect(result[0].mode).toBe("AltHold");
    expect(result[0].startTime).toBe(0);
    expect(result[0].endTime).toBe(0); // Only one point, same start/end
  });

  it("calculates correct durations", () => {
    const messages = {
      MODE: {
        time_boot_ms: [0, 10000, 30000],
        Mode: ["Stabilize", "Auto", "Land"],
        ModeNum: [0, 3, 9],
      },
    };

    const result = extractFlightModes(messages);
    expect(result[0].duration).toBeCloseTo(10, 0); // 10 seconds
    expect(result[1].duration).toBeCloseTo(20, 0); // 20 seconds
    expect(result[2].duration).toBeCloseTo(0, 0); // Last segment ends at same time
  });

  it("falls back to Mode N for unknown mode numbers", () => {
    const messages = {
      MODE: {
        time_boot_ms: [1000],
        Mode: [99],
        ModeNum: [99],
      },
    };

    const result = extractFlightModes(messages);
    expect(result[0].mode).toBe("Mode 99");
  });
});

describe("extractGpsTrack", () => {
  it("returns empty array when no GPS messages", () => {
    const result = extractGpsTrack({});
    expect(result).toEqual([]);
  });

  it("returns empty array when GPS has no Lat/Lng", () => {
    const result = extractGpsTrack({
      GPS: { time_boot_ms: [1000] },
    });
    expect(result).toEqual([]);
  });

  it("parses text format GPS (degrees)", () => {
    const messages = {
      "GPS": {
        time_boot_ms: [1000, 2000, 3000],
        Lat: [30.932, 30.933, 30.934],
        Lng: [-104.04, -104.041, -104.042],
        Alt: [100, 110, 120],
        Spd: [5, 10, 15],
      },
    };

    const result = extractGpsTrack(messages);
    expect(result).toHaveLength(3);
    expect(result[0].lat).toBeCloseTo(30.932, 3);
    expect(result[0].lng).toBeCloseTo(-104.04, 2);
    expect(result[0].alt).toBe(100);
    expect(result[0].speed).toBe(5);
  });

  it("parses binary format GPS (1e-7 degrees)", () => {
    const messages = {
      "GPS": {
        time_boot_ms: [1000, 2000],
        Lat: [309320000, 309330000],
        Lng: [-1040400000, -1040410000],
        Alt: [100, 110],
        Spd: [5, 10],
      },
    };

    const result = extractGpsTrack(messages);
    expect(result).toHaveLength(2);
    expect(result[0].lat).toBeCloseTo(30.932, 3);
    expect(result[0].lng).toBeCloseTo(-104.04, 2);
  });

  it("resolves instance-based GPS keys like GPS[0]", () => {
    const messages = {
      "GPS[0]": {
        time_boot_ms: [1000, 2000],
        Lat: [30.5, 30.6],
        Lng: [-104.0, -104.1],
        Alt: [100, 110],
        Spd: [5, 10],
      },
    };

    const result = extractGpsTrack(messages);
    expect(result).toHaveLength(2);
    expect(result[0].lat).toBeCloseTo(30.5, 1);
  });

  it("skips invalid coordinates (0,0)", () => {
    const messages = {
      "GPS": {
        time_boot_ms: [1000, 2000, 3000],
        Lat: [0, 30.5, 30.6],
        Lng: [0, -104.0, -104.1],
        Alt: [0, 100, 110],
        Spd: [0, 5, 10],
      },
    };

    const result = extractGpsTrack(messages);
    expect(result).toHaveLength(2); // First point (0,0) skipped
    expect(result[0].lat).toBeCloseTo(30.5, 1);
  });

  it("calculates relative time from global min", () => {
    const messages = {
      "ATT": {
        time_boot_ms: [0, 5000],
      },
      "GPS": {
        time_boot_ms: [2000, 4000],
        Lat: [30.5, 30.6],
        Lng: [-104.0, -104.1],
        Alt: [100, 110],
        Spd: [5, 10],
      },
    };

    const result = extractGpsTrack(messages);
    expect(result[0].time).toBeCloseTo(2, 0); // 2000ms from global start (0ms)
    expect(result[1].time).toBeCloseTo(4, 0);
  });

  it("handles missing Alt and Spd fields gracefully", () => {
    const messages = {
      "GPS": {
        time_boot_ms: [1000],
        Lat: [30.5],
        Lng: [-104.0],
      },
    };

    const result = extractGpsTrack(messages);
    expect(result).toHaveLength(1);
    expect(result[0].alt).toBe(0);
    expect(result[0].speed).toBe(0);
  });

  it("downsamples large datasets to max 5000 points", () => {
    const n = 10000;
    const messages = {
      "GPS": {
        time_boot_ms: Array.from({ length: n }, (_, i) => i * 100),
        Lat: Array.from({ length: n }, (_, i) => 30 + i * 0.0001),
        Lng: Array.from({ length: n }, (_, i) => -104 + i * 0.0001),
        Alt: Array.from({ length: n }, () => 100),
        Spd: Array.from({ length: n }, () => 5),
      },
    };

    const result = extractGpsTrack(messages);
    expect(result.length).toBeLessThanOrEqual(5000);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("getModeColor", () => {
  it("returns specific colors for known modes", () => {
    expect(getModeColor("Stabilize")).toBe("#3b82f6");
    expect(getModeColor("RTL")).toBe("#ef4444");
    expect(getModeColor("Loiter")).toBe("#06b6d4");
    expect(getModeColor("Auto")).toBe("#a855f7");
    expect(getModeColor("PosHold")).toBe("#8b5cf6");
  });

  it("returns gray fallback for unknown modes", () => {
    expect(getModeColor("UnknownMode")).toBe("#6b7280");
    expect(getModeColor("Mode 99")).toBe("#6b7280");
  });
});
