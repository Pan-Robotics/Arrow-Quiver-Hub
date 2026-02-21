import { describe, it, expect } from "vitest";
import {
  extractFlightSummary,
  chartDataToCsv,
  CHART_DEFINITIONS,
  type FlightSummary,
} from "../client/src/lib/flight-charts";

// ─── extractFlightSummary ──────────────────────────────────
describe("extractFlightSummary", () => {
  it("returns default values for empty messages", () => {
    const summary = extractFlightSummary({});
    expect(summary.totalFlightTime).toBeNull();
    expect(summary.maxAltitude).toBeNull();
    expect(summary.maxSpeed).toBeNull();
    expect(summary.batteryConsumed).toBeNull();
    expect(summary.maxVibration).toBeNull();
    expect(summary.maxEscRpm).toBeNull();
    expect(summary.totalMessages).toBe(0);
    expect(summary.logDuration).toBeNull();
  });

  it("extracts flight duration from time_boot_ms", () => {
    const messages = {
      ATT: {
        time_boot_ms: [1000, 5000, 10000, 60000],
        Roll: [0, 1, 2, 3],
      },
    };
    const summary = extractFlightSummary(messages);
    // Duration = (60000 - 1000) / 1000 = 59 seconds
    expect(summary.logDuration).toBe(59);
    expect(summary.totalFlightTime).toBe(59);
  });

  it("extracts max altitude from BARO", () => {
    const messages = {
      "BARO[0]": {
        time_boot_ms: [1000, 2000, 3000],
        Alt: [10, 50, 30],
        Press: [1013, 1008, 1010],
        Temp: [25, 24, 25],
      },
    };
    const summary = extractFlightSummary(messages);
    expect(summary.maxAltitude).toBe(50);
  });

  it("extracts max altitude from bare BARO key", () => {
    const messages = {
      BARO: {
        time_boot_ms: [1000, 2000],
        Alt: [20, 80],
      },
    };
    const summary = extractFlightSummary(messages);
    expect(summary.maxAltitude).toBe(80);
  });

  it("extracts GPS speed and altitude", () => {
    const messages = {
      "GPS[0]": {
        time_boot_ms: [1000, 2000, 3000, 4000],
        Spd: [0, 5, 15, 8],
        Alt: [100, 110, 120, 115],
        Status: [3, 3, 3, 3],
        NSats: [10, 12, 14, 13],
      },
    };
    const summary = extractFlightSummary(messages);
    expect(summary.maxSpeed).toBe(15);
    expect(summary.avgSpeed).toBeCloseTo(7, 0); // (0+5+15+8)/4 = 7
    expect(summary.maxGpsAltitude).toBe(120);
    expect(summary.gpsFixType).toBe(3);
    expect(summary.numSatellites).toBe(14);
  });

  it("extracts battery stats", () => {
    const messages = {
      "BAT[0]": {
        time_boot_ms: [1000, 2000, 3000, 4000],
        Volt: [16.8, 16.5, 16.0, 15.5],
        Curr: [5, 20, 35, 10],
        CurrTot: [0, 100, 300, 400],
      },
    };
    const summary = extractFlightSummary(messages);
    expect(summary.batteryStartVoltage).toBe(16.8);
    expect(summary.batteryEndVoltage).toBe(15.5);
    expect(summary.batteryMinVoltage).toBe(15.5);
    expect(summary.batteryConsumed).toBe(400);
    expect(summary.maxCurrent).toBe(35);
  });

  it("extracts vibration data", () => {
    const messages = {
      "VIBE[0]": {
        time_boot_ms: [1000, 2000, 3000],
        VibeX: [1, 2, 3],
        VibeY: [1, 2, 3],
        VibeZ: [1, 2, 3],
        Clip: [0, 0, 5],
      },
    };
    const summary = extractFlightSummary(messages);
    // Magnitude at i=2: sqrt(9+9+9) = sqrt(27) ≈ 5.196
    expect(summary.maxVibration).toBeCloseTo(5.196, 2);
    expect(summary.avgVibration).toBeGreaterThan(0);
    expect(summary.maxClipping).toBe(5);
  });

  it("extracts ESC RPM", () => {
    const messages = {
      "ESC[0]": {
        time_boot_ms: [1000, 2000, 3000],
        RPM: [0, 15000, 22000],
        Volt: [16.8, 16.5, 16.0],
        Curr: [0, 10, 20],
      },
    };
    const summary = extractFlightSummary(messages);
    expect(summary.maxEscRpm).toBe(22000);
  });

  it("handles comprehensive flight data with all message types", () => {
    const messages = {
      ATT: {
        time_boot_ms: [0, 30000, 60000, 120000],
        Roll: [0, 5, -3, 0],
        Pitch: [0, 2, -1, 0],
        Yaw: [0, 90, 180, 270],
      },
      RATE: {
        time_boot_ms: [0, 30000, 60000],
        R: [0, 10, -5],
        P: [0, 5, -3],
      },
      "BARO[0]": {
        time_boot_ms: [0, 30000, 60000, 120000],
        Alt: [0, 25, 50, 10],
      },
      "GPS[0]": {
        time_boot_ms: [0, 30000, 60000],
        Spd: [0, 10, 5],
        Alt: [100, 125, 110],
        Status: [3, 3, 3],
        NSats: [12, 14, 13],
      },
      "BAT[0]": {
        time_boot_ms: [0, 60000, 120000],
        Volt: [16.8, 16.0, 15.2],
        Curr: [0, 25, 15],
        CurrTot: [0, 200, 350],
      },
      "VIBE[0]": {
        time_boot_ms: [0, 60000],
        VibeX: [0.5, 1.5],
        VibeY: [0.3, 1.0],
        VibeZ: [0.2, 0.8],
        Clip: [0, 0],
      },
      "ESC[0]": {
        time_boot_ms: [0, 60000],
        RPM: [0, 18000],
        Volt: [16.8, 16.0],
        Curr: [0, 20],
      },
      RCIN: {
        time_boot_ms: [0, 60000],
        C1: [1500, 1600],
        C2: [1500, 1400],
        C3: [1000, 1500],
        C4: [1500, 1500],
      },
      RCOU: {
        time_boot_ms: [0, 60000],
        C1: [1000, 1500],
        C2: [1000, 1500],
        C3: [1000, 1500],
        C4: [1000, 1500],
      },
    };

    const summary = extractFlightSummary(messages);

    // Duration: (120000 - 0) / 1000 = 120 seconds
    expect(summary.logDuration).toBe(120);
    expect(summary.totalFlightTime).toBe(120);
    expect(summary.maxAltitude).toBe(50);
    expect(summary.maxGpsAltitude).toBe(125);
    expect(summary.maxSpeed).toBe(10);
    expect(summary.avgSpeed).toBeCloseTo(5, 0);
    expect(summary.batteryStartVoltage).toBe(16.8);
    expect(summary.batteryEndVoltage).toBe(15.2);
    expect(summary.batteryConsumed).toBe(350);
    expect(summary.maxCurrent).toBe(25);
    expect(summary.gpsFixType).toBe(3);
    expect(summary.numSatellites).toBe(14);
    expect(summary.maxEscRpm).toBe(18000);
    expect(summary.maxVibration).toBeGreaterThan(0);
    expect(summary.maxClipping).toBe(0);
    expect(summary.totalMessages).toBe(9);
  });

  it("handles NaN and Infinity in data gracefully", () => {
    const messages = {
      "BARO[0]": {
        time_boot_ms: [1000, 2000, 3000],
        Alt: [10, NaN, 30],
      },
      "GPS[0]": {
        time_boot_ms: [1000, 2000],
        Spd: [Infinity, 5],
        Alt: [100, -Infinity],
      },
    };
    const summary = extractFlightSummary(messages);
    expect(summary.maxAltitude).toBe(30); // NaN skipped
    expect(summary.maxSpeed).toBe(5); // Infinity skipped
    expect(summary.maxGpsAltitude).toBe(100); // -Infinity skipped
  });

  it("handles missing fields in messages", () => {
    const messages = {
      "BAT[0]": {
        time_boot_ms: [1000, 2000],
        Volt: [16.8, 16.0],
        // No Curr, no CurrTot
      },
    };
    const summary = extractFlightSummary(messages);
    expect(summary.batteryStartVoltage).toBe(16.8);
    expect(summary.batteryEndVoltage).toBe(16.0);
    expect(summary.batteryConsumed).toBeNull();
    expect(summary.maxCurrent).toBeNull();
  });
});

// ─── chartDataToCsv ──────────────────────────────────
describe("chartDataToCsv", () => {
  const attChart = CHART_DEFINITIONS.find((c) => c.id === "att-rp")!;
  const baroChart = CHART_DEFINITIONS.find((c) => c.id === "baro-alt")!;

  it("generates CSV with correct headers", () => {
    const data = [
      { time: 1.0, DesRoll: 1.1, Roll: 1.0, DesPitch: 0.5, Pitch: 0.4 },
      { time: 2.0, DesRoll: 2.2, Roll: 2.0, DesPitch: 0.6, Pitch: 0.5 },
    ];
    const csv = chartDataToCsv(attChart, data);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("time_seconds,DesRoll,Roll,DesPitch,Pitch");
    expect(lines.length).toBe(3); // header + 2 data rows
  });

  it("formats numeric values correctly", () => {
    const data = [
      { time: 1.234, Alt: 100.5 },
    ];
    const csv = chartDataToCsv(baroChart, data);
    const lines = csv.split("\n");
    expect(lines[1]).toContain("1.234");
    expect(lines[1]).toContain("100.5");
  });

  it("returns empty string for empty data", () => {
    const csv = chartDataToCsv(attChart, []);
    expect(csv).toBe("");
  });

  it("handles missing field values", () => {
    const data = [
      { time: 1.0, DesRoll: 1.1 },
      // Missing Roll, DesPitch, Pitch
    ];
    const csv = chartDataToCsv(attChart, data);
    const lines = csv.split("\n");
    // Should have empty values for missing fields
    const values = lines[1].split(",");
    expect(values[0]).toBe("1.000"); // time
    expect(values[1]).toBe("1.1"); // DesRoll
    expect(values[2]).toBe(""); // Roll - missing
  });

  it("handles NaN and Infinity values", () => {
    const data = [
      { time: 1.0, Alt: NaN },
      { time: 2.0, Alt: Infinity },
    ];
    const csv = chartDataToCsv(baroChart, data);
    const lines = csv.split("\n");
    // NaN and Infinity should be empty
    expect(lines[1].split(",")[1]).toBe("");
    expect(lines[2].split(",")[1]).toBe("");
  });

  it("generates valid CSV for all chart types", () => {
    for (const chart of CHART_DEFINITIONS) {
      const data = [
        { time: 1.0, ...Object.fromEntries(chart.fields.map((f) => [f.key, 42])) },
      ];
      const csv = chartDataToCsv(chart, data);
      expect(csv).toBeTruthy();
      const lines = csv.split("\n");
      expect(lines.length).toBe(2); // header + 1 row
      // Header should contain time_seconds and all field keys
      expect(lines[0]).toContain("time_seconds");
      for (const field of chart.fields) {
        expect(lines[0]).toContain(field.key);
      }
    }
  });
});
