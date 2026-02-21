import { describe, it, expect } from "vitest";
import { filterChartDataByTimeRange, type TimeFilter } from "../client/src/lib/flight-charts";

describe("filterChartDataByTimeRange", () => {
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

  it("returns all data when filter is null", () => {
    const result = filterChartDataByTimeRange(sampleData, null);
    expect(result).toBe(sampleData); // Same reference, no filtering
    expect(result.length).toBe(10);
  });

  it("returns empty array when data is empty", () => {
    const filter: TimeFilter = {
      startTime: 10,
      endTime: 30,
      mode: "Stabilize",
      segmentIndex: 0,
    };
    const result = filterChartDataByTimeRange([], filter);
    expect(result).toEqual([]);
  });

  it("filters data to the specified time range", () => {
    const filter: TimeFilter = {
      startTime: 20,
      endTime: 50,
      mode: "Loiter",
      segmentIndex: 1,
    };
    const result = filterChartDataByTimeRange(sampleData, filter);
    // Should include points at time 20, 30, 40, 50 (within range + 1% margin)
    expect(result.length).toBe(4);
    expect(result[0].time).toBe(20);
    expect(result[result.length - 1].time).toBe(50);
  });

  it("includes points at exact boundaries", () => {
    const filter: TimeFilter = {
      startTime: 30,
      endTime: 30,
      mode: "RTL",
      segmentIndex: 2,
    };
    const result = filterChartDataByTimeRange(sampleData, filter);
    expect(result.length).toBe(1);
    expect(result[0].time).toBe(30);
  });

  it("filters to the beginning of the flight", () => {
    const filter: TimeFilter = {
      startTime: 0,
      endTime: 20,
      mode: "Stabilize",
      segmentIndex: 0,
    };
    const result = filterChartDataByTimeRange(sampleData, filter);
    expect(result.length).toBe(3);
    expect(result[0].time).toBe(0);
    expect(result[2].time).toBe(20);
  });

  it("filters to the end of the flight", () => {
    const filter: TimeFilter = {
      startTime: 70,
      endTime: 90,
      mode: "Land",
      segmentIndex: 3,
    };
    const result = filterChartDataByTimeRange(sampleData, filter);
    expect(result.length).toBe(3);
    expect(result[0].time).toBe(70);
    expect(result[2].time).toBe(90);
  });

  it("returns empty when filter range has no matching data", () => {
    const filter: TimeFilter = {
      startTime: 95,
      endTime: 100,
      mode: "Unknown",
      segmentIndex: 5,
    };
    const result = filterChartDataByTimeRange(sampleData, filter);
    expect(result.length).toBe(0);
  });

  it("includes margin points for visual continuity", () => {
    // Filter from 20 to 40. Duration = 20, margin = 0.2 (1%)
    // So effective range is 19.8 to 40.2
    // Points at 20, 30, 40 should be included
    const filter: TimeFilter = {
      startTime: 20,
      endTime: 40,
      mode: "Auto",
      segmentIndex: 1,
    };
    const result = filterChartDataByTimeRange(sampleData, filter);
    expect(result.length).toBe(3);
    expect(result.map((p) => p.time)).toEqual([20, 30, 40]);
  });

  it("handles single-point data", () => {
    const singlePoint = [{ time: 50, alt: 100 }];
    const filter: TimeFilter = {
      startTime: 40,
      endTime: 60,
      mode: "Loiter",
      segmentIndex: 0,
    };
    const result = filterChartDataByTimeRange(singlePoint, filter);
    expect(result.length).toBe(1);
  });

  it("preserves all fields in filtered data", () => {
    const richData = [
      { time: 10, alt: 50, speed: 5, temp: 25 },
      { time: 20, alt: 100, speed: 10, temp: 24 },
      { time: 30, alt: 150, speed: 15, temp: 23 },
    ];
    const filter: TimeFilter = {
      startTime: 15,
      endTime: 25,
      mode: "Stabilize",
      segmentIndex: 0,
    };
    const result = filterChartDataByTimeRange(richData, filter);
    expect(result.length).toBe(1);
    expect(result[0]).toEqual({ time: 20, alt: 100, speed: 10, temp: 24 });
  });

  it("does not mutate original data", () => {
    const originalLength = sampleData.length;
    const filter: TimeFilter = {
      startTime: 20,
      endTime: 40,
      mode: "Loiter",
      segmentIndex: 1,
    };
    filterChartDataByTimeRange(sampleData, filter);
    expect(sampleData.length).toBe(originalLength);
  });
});
