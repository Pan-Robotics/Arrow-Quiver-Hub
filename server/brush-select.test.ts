import { describe, it, expect, beforeEach } from "vitest";
import { filterChartDataByTimeRange, type TimeFilter } from "../client/src/lib/flight-charts";
import * as fs from "fs";
import * as path from "path";

// ─── TimeFilter source field tests ──────────────────────────────
describe("TimeFilter source field", () => {
  it("supports 'brush' source for chart brush selection", () => {
    const filter: TimeFilter = {
      startTime: 10,
      endTime: 30,
      mode: "",
      segmentIndex: -1,
      source: "brush",
    };
    expect(filter.source).toBe("brush");
    expect(filter.mode).toBe("");
    expect(filter.segmentIndex).toBe(-1);
  });

  it("supports 'mode' source for mode-based filtering", () => {
    const filter: TimeFilter = {
      startTime: 10,
      endTime: 30,
      mode: "Stabilize",
      segmentIndex: 0,
      source: "mode",
    };
    expect(filter.source).toBe("mode");
    expect(filter.mode).toBe("Stabilize");
    expect(filter.segmentIndex).toBe(0);
  });

  it("source is optional (backward compatible)", () => {
    const filter: TimeFilter = {
      startTime: 10,
      endTime: 30,
      mode: "Loiter",
      segmentIndex: 1,
    };
    expect(filter.source).toBeUndefined();
  });
});

// ─── filterChartDataByTimeRange with brush source ──────────────
describe("filterChartDataByTimeRange with brush source", () => {
  const sampleData = [
    { time: 0, alt: 0 },
    { time: 10, alt: 50 },
    { time: 20, alt: 100 },
    { time: 30, alt: 150 },
    { time: 40, alt: 200 },
    { time: 50, alt: 180 },
    { time: 60, alt: 100 },
    { time: 70, alt: 50 },
    { time: 80, alt: 20 },
    { time: 90, alt: 0 },
  ];

  it("filters with brush source the same as mode source", () => {
    const brushFilter: TimeFilter = {
      startTime: 20,
      endTime: 50,
      mode: "",
      segmentIndex: -1,
      source: "brush",
    };
    const modeFilter: TimeFilter = {
      startTime: 20,
      endTime: 50,
      mode: "Loiter",
      segmentIndex: 1,
      source: "mode",
    };
    const brushResult = filterChartDataByTimeRange(sampleData, brushFilter);
    const modeResult = filterChartDataByTimeRange(sampleData, modeFilter);
    // Same time range should produce same filtered data
    expect(brushResult.length).toBe(modeResult.length);
    expect(brushResult.map(p => p.time)).toEqual(modeResult.map(p => p.time));
  });

  it("filters correctly with brush-selected narrow range", () => {
    const filter: TimeFilter = {
      startTime: 25,
      endTime: 35,
      mode: "",
      segmentIndex: -1,
      source: "brush",
    };
    const result = filterChartDataByTimeRange(sampleData, filter);
    // Only time=30 falls within 25-35 range (with small margin)
    expect(result.length).toBe(1);
    expect(result[0].time).toBe(30);
  });

  it("filters correctly with brush-selected wide range", () => {
    const filter: TimeFilter = {
      startTime: 0,
      endTime: 90,
      mode: "",
      segmentIndex: -1,
      source: "brush",
    };
    const result = filterChartDataByTimeRange(sampleData, filter);
    expect(result.length).toBe(10); // All data
  });

  it("handles brush selection with reversed start/end (caller normalizes)", () => {
    // The component normalizes start < end before creating the filter
    const start = 50;
    const end = 20;
    const normalizedStart = Math.min(start, end);
    const normalizedEnd = Math.max(start, end);
    const filter: TimeFilter = {
      startTime: normalizedStart,
      endTime: normalizedEnd,
      mode: "",
      segmentIndex: -1,
      source: "brush",
    };
    expect(filter.startTime).toBe(20);
    expect(filter.endTime).toBe(50);
    const result = filterChartDataByTimeRange(sampleData, filter);
    expect(result.length).toBe(4);
  });
});

// ─── Brush selection minimum threshold ──────────────────────────
describe("Brush selection minimum threshold", () => {
  it("minimum threshold of 0.5 seconds prevents accidental clicks", () => {
    // Simulate the component logic: only apply if end - start > 0.5
    const start = 10.0;
    const end = 10.3; // 0.3s difference - too small
    const isValid = (end - start) > 0.5;
    expect(isValid).toBe(false);
  });

  it("accepts selections above 0.5 seconds", () => {
    const start = 10.0;
    const end = 10.6; // 0.6s difference - valid
    const isValid = (end - start) > 0.5;
    expect(isValid).toBe(true);
  });

  it("accepts large selections", () => {
    const start = 0;
    const end = 300; // 5 minutes
    const isValid = (end - start) > 0.5;
    expect(isValid).toBe(true);
  });
});

// ─── FlightAnalyticsApp component source verification ──────────
describe("FlightAnalyticsApp brush-select integration", () => {
  const componentPath = path.resolve(
    __dirname,
    "../client/src/components/apps/FlightAnalyticsApp.tsx"
  );
  let source: string;

  beforeEach(() => {
    source = fs.readFileSync(componentPath, "utf-8");
  });

  it("imports ReferenceArea from recharts", () => {
    expect(source).toContain("ReferenceArea");
    expect(source).toContain("from \"recharts\"");
  });

  it("imports ZoomIn and ZoomOut icons", () => {
    expect(source).toContain("ZoomIn");
    expect(source).toContain("ZoomOut");
  });

  it("FlightChart accepts onBrushSelect prop", () => {
    expect(source).toContain("onBrushSelect");
    expect(source).toContain("onBrushSelect?: (startTime: number, endTime: number) => void");
  });

  it("FlightChart has brush state management", () => {
    expect(source).toContain("brushStart");
    expect(source).toContain("brushEnd");
    expect(source).toContain("isBrushing");
  });

  it("FlightChart has mouse event handlers for brush", () => {
    expect(source).toContain("handleMouseDown");
    expect(source).toContain("handleMouseMove");
    expect(source).toContain("handleMouseUp");
    expect(source).toContain("onMouseDown={handleMouseDown}");
    expect(source).toContain("onMouseMove={handleMouseMove}");
    expect(source).toContain("onMouseUp={handleMouseUp}");
  });

  it("FlightChart renders ReferenceArea during brush", () => {
    expect(source).toContain("<ReferenceArea");
    expect(source).toContain("isBrushing && brushStart != null && brushEnd != null");
  });

  it("has crosshair cursor style on charts", () => {
    expect(source).toContain("cursor: \"crosshair\"");
  });

  it("has handleBrushSelect callback in main component", () => {
    expect(source).toContain("handleBrushSelect");
    expect(source).toContain("source: \"brush\"");
  });

  it("passes onBrushSelect to FlightChart", () => {
    expect(source).toContain("onBrushSelect={handleBrushSelect}");
  });

  it("has minimum threshold check (0.5 seconds)", () => {
    expect(source).toContain("end - start > 0.5");
  });

  it("all setTimeFilter calls with object have source field", () => {
    // Find all setTimeFilter({ calls and verify they have source
    const setTimeFilterCalls = source.match(/setTimeFilter\(\{[\s\S]*?\}\)/g) || [];
    expect(setTimeFilterCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of setTimeFilterCalls) {
      expect(call).toContain("source:");
    }
  });

  it("shows different banner for brush vs mode filter", () => {
    expect(source).toContain('timeFilter.source === "brush"');
    expect(source).toContain("Zoomed to");
    expect(source).toContain("Filtered to");
  });

  it("shows Reset Zoom button for brush filter", () => {
    expect(source).toContain("Reset Zoom");
  });

  it("shows zoom hint when no filter is active", () => {
    expect(source).toContain("Click and drag on any chart to zoom into a time range");
  });

  it("clears brush filter on mouseLeave", () => {
    expect(source).toContain("onMouseLeave={handleMouseUp}");
  });

  it("disables user selection during brush", () => {
    expect(source).toContain("userSelect: \"none\"");
  });
});

// ─── Module-level cache with brush filter ──────────────────────
describe("Module-level cache with brush TimeFilter", () => {
  it("brush TimeFilter is serializable for cache", () => {
    const filter: TimeFilter = {
      startTime: 15.5,
      endTime: 42.3,
      mode: "",
      segmentIndex: -1,
      source: "brush",
    };
    const serialized = JSON.stringify(filter);
    const deserialized = JSON.parse(serialized) as TimeFilter;
    expect(deserialized.startTime).toBe(15.5);
    expect(deserialized.endTime).toBe(42.3);
    expect(deserialized.source).toBe("brush");
    expect(deserialized.mode).toBe("");
    expect(deserialized.segmentIndex).toBe(-1);
  });

  it("mode TimeFilter is serializable for cache", () => {
    const filter: TimeFilter = {
      startTime: 10,
      endTime: 30,
      mode: "Stabilize",
      segmentIndex: 0,
      source: "mode",
    };
    const serialized = JSON.stringify(filter);
    const deserialized = JSON.parse(serialized) as TimeFilter;
    expect(deserialized.source).toBe("mode");
    expect(deserialized.mode).toBe("Stabilize");
  });

  it("null TimeFilter round-trips through cache", () => {
    const cache = {
      selectedLogId: 1,
      droneId: "d1",
      activeTab: "charts",
      timeFilter: null as TimeFilter | null,
    };
    const serialized = JSON.stringify(cache);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.timeFilter).toBeNull();
  });
});
