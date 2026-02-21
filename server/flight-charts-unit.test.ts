import { describe, it, expect } from "vitest";
import {
  resolveMessageKey,
  getAvailableCharts,
  toChartData,
  getAllRequiredMessageTypes,
  formatTime,
  CHART_DEFINITIONS,
  CHART_CATEGORIES,
} from "../client/src/lib/flight-charts";

// ─── resolveMessageKey ──────────────────────────────────
describe("resolveMessageKey", () => {
  it("returns direct match when bare name exists", () => {
    const types = { ATT: {}, RATE: {} };
    expect(resolveMessageKey("ATT", types)).toBe("ATT");
  });

  it("returns instance [0] when bare name is missing", () => {
    const types = { "BARO[0]": {}, "BARO[1]": {} };
    expect(resolveMessageKey("BARO", types)).toBe("BARO[0]");
  });

  it("returns first matching instance when [0] is missing", () => {
    const types = { "ESC[1]": {}, "ESC[2]": {} };
    const result = resolveMessageKey("ESC", types);
    expect(result).toMatch(/^ESC\[\d+\]$/);
  });

  it("returns null when no match exists", () => {
    const types = { ATT: {}, RATE: {} };
    expect(resolveMessageKey("BARO", types)).toBeNull();
  });

  it("prefers direct match over instance variant", () => {
    // When both BARO and BARO[0] exist, direct match wins
    const types = { BARO: {}, "BARO[0]": {} };
    expect(resolveMessageKey("BARO", types)).toBe("BARO");
  });

  it("handles empty types object", () => {
    expect(resolveMessageKey("ATT", {})).toBeNull();
  });
});

// ─── toChartData ──────────────────────────────────
describe("toChartData", () => {
  const attChart = CHART_DEFINITIONS.find((c) => c.id === "att-rp")!;
  const baroChart = CHART_DEFINITIONS.find((c) => c.id === "baro-alt")!;

  it("returns data for direct message key match", () => {
    const messages = {
      ATT: {
        time_boot_ms: [1000, 2000, 3000],
        DesRoll: [1.1, 2.2, 3.3],
        Roll: [1.0, 2.0, 3.0],
        DesPitch: [0.5, 0.6, 0.7],
        Pitch: [0.4, 0.5, 0.6],
      },
    };
    const types = { ATT: {} };
    const data = toChartData(messages, attChart, types);
    expect(data.length).toBe(3);
    expect(data[0]).toHaveProperty("time");
    expect(data[0]).toHaveProperty("DesRoll");
    expect(data[0]).toHaveProperty("Roll");
    // Time is relative: (1000 - globalMin(1000)) / 1000 = 0s
    expect(data[0].time).toBe(0);
    expect(data[1].time).toBe(1); // (2000 - 1000) / 1000 = 1s
    expect(data[2].time).toBe(2); // (3000 - 1000) / 1000 = 2s
  });

  it("uses relative time matching extractFlightModes", () => {
    // Simulate a log where time_boot_ms starts at a large offset (e.g. 50000ms)
    const messages = {
      ATT: {
        time_boot_ms: [50000, 51000, 52000],
        DesRoll: [1, 2, 3],
        Roll: [1, 2, 3],
        DesPitch: [0, 0, 0],
        Pitch: [0, 0, 0],
      },
      MODE: {
        time_boot_ms: [50000, 51500],
        Mode: ["Stabilize", "Loiter"],
        ModeNum: [0, 5],
      },
    };
    const types = { ATT: {}, MODE: {} };
    const data = toChartData(messages, attChart, types);
    // globalMinTime = 50000, so times should be 0, 1, 2
    expect(data[0].time).toBe(0);
    expect(data[1].time).toBe(1);
    expect(data[2].time).toBe(2);
  });

  it("resolves instance key BARO[0] for BARO chart", () => {
    const messages = {
      "BARO[0]": {
        time_boot_ms: [1000, 2000],
        Alt: [100, 101],
        Press: [1013, 1012],
        Temp: [25, 26],
      },
    };
    // types has both BARO and BARO[0], but messages only has BARO[0]
    const types = { BARO: {}, "BARO[0]": {} };
    const data = toChartData(messages, baroChart, types);
    expect(data.length).toBe(2);
    expect(data[0]).toHaveProperty("Alt");
    expect(data[0].Alt).toBe(100);
  });

  it("returns empty array when message type not found", () => {
    const messages = { ATT: { time_boot_ms: [1000] } };
    const types = { ATT: {} };
    const data = toChartData(messages, baroChart, types);
    expect(data).toEqual([]);
  });

  it("returns empty array when time_boot_ms is missing", () => {
    const messages = { ATT: { Roll: [1, 2, 3] } };
    const types = { ATT: {} };
    const data = toChartData(messages, attChart, types);
    expect(data).toEqual([]);
  });

  it("downsamples large datasets", () => {
    const n = 10000;
    const messages = {
      ATT: {
        time_boot_ms: Array.from({ length: n }, (_, i) => i * 100),
        DesRoll: Array.from({ length: n }, () => 1),
        Roll: Array.from({ length: n }, () => 1),
        DesPitch: Array.from({ length: n }, () => 0),
        Pitch: Array.from({ length: n }, () => 0),
      },
    };
    const types = { ATT: {} };
    const data = toChartData(messages, attChart, types, 500);
    expect(data.length).toBeLessThanOrEqual(500);
    expect(data.length).toBeGreaterThan(0);
  });

  it("handles NaN and Infinity values by replacing with 0", () => {
    const messages = {
      ATT: {
        time_boot_ms: [1000, 2000],
        DesRoll: [NaN, Infinity],
        Roll: [1.0, -Infinity],
        DesPitch: [0.5, 0.6],
        Pitch: [0.4, 0.5],
      },
    };
    const types = { ATT: {} };
    const data = toChartData(messages, attChart, types);
    expect(data[0].DesRoll).toBe(0);
    expect(data[1].DesRoll).toBe(0);
    expect(data[1].Roll).toBe(0);
  });
});

// ─── getAvailableCharts ──────────────────────────────────
describe("getAvailableCharts", () => {
  it("returns charts when their message types exist", () => {
    const types = { ATT: {}, RATE: {}, RCIN: {}, RCOU: {} };
    const charts = getAvailableCharts(types);
    expect(charts.length).toBeGreaterThan(0);
    const ids = charts.map((c) => c.id);
    expect(ids).toContain("att-rp");
    expect(ids).toContain("att-yaw");
    expect(ids).toContain("rate-rp");
    expect(ids).toContain("rcin");
    expect(ids).toContain("rcou");
  });

  it("returns charts for instance-based types", () => {
    const types = {
      ATT: {},
      "BARO[0]": {},
      "GPS[0]": {},
      "GPA[0]": {},
      "BAT[0]": {},
      "ESC[0]": {},
      "VIBE[0]": {},
      "XKF4[0]": {},
      RATE: {},
      RCIN: {},
      RCOU: {},
    };
    const charts = getAvailableCharts(types);
    const ids = charts.map((c) => c.id);
    expect(ids).toContain("baro-alt");
    expect(ids).toContain("gps-speed");
    expect(ids).toContain("gps-quality");
    expect(ids).toContain("bat-voltage");
    expect(ids).toContain("esc-rpm");
    expect(ids).toContain("vibe");
    expect(ids).toContain("ekf-vel");
  });

  it("returns empty for no matching types", () => {
    const charts = getAvailableCharts({});
    expect(charts).toEqual([]);
  });

  it("returns all 17 charts when all types present", () => {
    const types = {
      ATT: {},
      RATE: {},
      BARO: {},
      "BARO[0]": {},
      GPS: {},
      "GPS[0]": {},
      GPA: {},
      "GPA[0]": {},
      BAT: {},
      "BAT[0]": {},
      ESC: {},
      "ESC[0]": {},
      VIBE: {},
      "VIBE[0]": {},
      RCIN: {},
      RCOU: {},
      XKF4: {},
      "XKF4[0]": {},
    };
    const charts = getAvailableCharts(types);
    expect(charts.length).toBe(17);
  });
});

// ─── getAllRequiredMessageTypes ──────────────────────────────────
describe("getAllRequiredMessageTypes", () => {
  it("returns unique message types", () => {
    const types = getAllRequiredMessageTypes();
    expect(types.length).toBeGreaterThan(0);
    expect(new Set(types).size).toBe(types.length);
  });

  it("includes all chart message types", () => {
    const types = getAllRequiredMessageTypes();
    expect(types).toContain("ATT");
    expect(types).toContain("RATE");
    expect(types).toContain("BARO");
    expect(types).toContain("GPS");
    expect(types).toContain("GPA");
    expect(types).toContain("BAT");
    expect(types).toContain("ESC");
    expect(types).toContain("VIBE");
    expect(types).toContain("RCIN");
    expect(types).toContain("RCOU");
    expect(types).toContain("XKF4");
  });
});

// ─── formatTime ──────────────────────────────────
describe("formatTime", () => {
  it("formats seconds to M:SS", () => {
    expect(formatTime(65)).toBe("1:05");
  });

  it("formats hours", () => {
    expect(formatTime(3661)).toBe("1:01:01");
  });

  it("handles zero", () => {
    expect(formatTime(0)).toBe("0:00");
  });

  it("handles NaN", () => {
    expect(formatTime(NaN)).toBe("0:00");
  });

  it("handles negative", () => {
    expect(formatTime(-5)).toBe("0:00");
  });
});

// ─── CHART_DEFINITIONS structure ──────────────────────────────────
describe("CHART_DEFINITIONS structure", () => {
  it("has 17 chart definitions", () => {
    expect(CHART_DEFINITIONS.length).toBe(17);
  });

  it("all charts have required fields", () => {
    for (const chart of CHART_DEFINITIONS) {
      expect(chart.id).toBeTruthy();
      expect(chart.title).toBeTruthy();
      expect(chart.messageType).toBeTruthy();
      expect(chart.fields.length).toBeGreaterThan(0);
      expect(chart.xKey).toBe("time_boot_ms");
      expect(chart.category).toBeTruthy();
    }
  });

  it("all chart IDs are unique", () => {
    const ids = CHART_DEFINITIONS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all fields have key, label, and color", () => {
    for (const chart of CHART_DEFINITIONS) {
      for (const field of chart.fields) {
        expect(field.key).toBeTruthy();
        expect(field.label).toBeTruthy();
        expect(field.color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});

// ─── CHART_CATEGORIES structure ──────────────────────────────────
describe("CHART_CATEGORIES structure", () => {
  it("has 6 categories", () => {
    expect(CHART_CATEGORIES.length).toBe(6);
  });

  it("all categories have id and label", () => {
    for (const cat of CHART_CATEGORIES) {
      expect(cat.id).toBeTruthy();
      expect(cat.label).toBeTruthy();
    }
  });

  it("every chart belongs to a valid category", () => {
    const catIds = CHART_CATEGORIES.map((c) => c.id);
    for (const chart of CHART_DEFINITIONS) {
      expect(catIds).toContain(chart.category);
    }
  });
});
