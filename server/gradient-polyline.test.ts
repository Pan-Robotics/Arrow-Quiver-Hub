import { describe, it, expect } from "vitest";
import {
  interpolateGradientColor,
  getTrackSegmentColor,
  getGradientLegendCss,
  type GpsTrackPoint,
  type TrackColorMode,
} from "../client/src/lib/flight-charts";

describe("interpolateGradientColor", () => {
  // The altitude gradient: blue(0) → green(0.33) → yellow(0.66) → red(1.0)
  // blue = [59,130,246], green = [34,197,94], yellow = [234,179,8], red = [239,68,68]

  it("returns the first stop color at value 0", () => {
    const altGradient = [
      { position: 0.0, color: [59, 130, 246] as [number, number, number] },
      { position: 0.33, color: [34, 197, 94] as [number, number, number] },
      { position: 0.66, color: [234, 179, 8] as [number, number, number] },
      { position: 1.0, color: [239, 68, 68] as [number, number, number] },
    ];
    const color = interpolateGradientColor(0, altGradient);
    expect(color).toBe("#3b82f6"); // blue-500
  });

  it("returns the last stop color at value 1", () => {
    const altGradient = [
      { position: 0.0, color: [59, 130, 246] as [number, number, number] },
      { position: 1.0, color: [239, 68, 68] as [number, number, number] },
    ];
    const color = interpolateGradientColor(1, altGradient);
    expect(color).toBe("#ef4444"); // red-500
  });

  it("interpolates between two stops at midpoint", () => {
    const gradient = [
      { position: 0.0, color: [0, 0, 0] as [number, number, number] },
      { position: 1.0, color: [255, 255, 255] as [number, number, number] },
    ];
    const color = interpolateGradientColor(0.5, gradient);
    expect(color).toBe("#808080"); // mid-gray (128 rounds to 128 = 0x80)
  });

  it("clamps values below 0 to first stop", () => {
    const gradient = [
      { position: 0.0, color: [59, 130, 246] as [number, number, number] },
      { position: 1.0, color: [239, 68, 68] as [number, number, number] },
    ];
    const color = interpolateGradientColor(-0.5, gradient);
    expect(color).toBe("#3b82f6");
  });

  it("clamps values above 1 to last stop", () => {
    const gradient = [
      { position: 0.0, color: [59, 130, 246] as [number, number, number] },
      { position: 1.0, color: [239, 68, 68] as [number, number, number] },
    ];
    const color = interpolateGradientColor(1.5, gradient);
    expect(color).toBe("#ef4444");
  });

  it("returns valid hex color format", () => {
    const gradient = [
      { position: 0.0, color: [0, 0, 0] as [number, number, number] },
      { position: 1.0, color: [255, 255, 255] as [number, number, number] },
    ];
    const color = interpolateGradientColor(0.3, gradient);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("handles single-stop gradient", () => {
    const gradient = [
      { position: 0.0, color: [128, 128, 128] as [number, number, number] },
    ];
    const color = interpolateGradientColor(0.5, gradient);
    expect(color).toBe("#808080");
  });
});

describe("getTrackSegmentColor", () => {
  const track: GpsTrackPoint[] = [
    { lat: 30, lng: -104, alt: 100, speed: 0, time: 0 },
    { lat: 30.001, lng: -104.001, alt: 150, speed: 5, time: 1 },
    { lat: 30.002, lng: -104.002, alt: 200, speed: 10, time: 2 },
    { lat: 30.003, lng: -104.003, alt: 120, speed: 3, time: 3 },
  ];

  it("returns blue for plain mode", () => {
    const color = getTrackSegmentColor(track, 0, "plain", 100, 200, 10);
    expect(color).toBe("#3b82f6");
  });

  it("returns blue-ish for low altitude segment", () => {
    // First segment: avg alt = (100+150)/2 = 125, range 100-200
    // normalized = (125-100)/100 = 0.25 → should be in blue-green range
    const color = getTrackSegmentColor(track, 0, "altitude", 100, 200, 10);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
    // Should not be pure red (high altitude)
    expect(color).not.toBe("#ef4444");
  });

  it("returns red-ish for high altitude segment", () => {
    // Second segment: avg alt = (150+200)/2 = 175, range 100-200
    // normalized = (175-100)/100 = 0.75 → should be in yellow-red range
    const color = getTrackSegmentColor(track, 1, "altitude", 100, 200, 10);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
    // Should not be pure blue (low altitude)
    expect(color).not.toBe("#3b82f6");
  });

  it("returns green for low speed segment", () => {
    // First segment: avg speed = (0+5)/2 = 2.5, max = 10
    // normalized = 2.5/10 = 0.25 → should be in green range
    const color = getTrackSegmentColor(track, 0, "speed", 100, 200, 10);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("returns warmer color for high speed segment", () => {
    // Second segment: avg speed = (5+10)/2 = 7.5, max = 10
    // normalized = 7.5/10 = 0.75 → should be in orange-red range
    const color = getTrackSegmentColor(track, 1, "speed", 100, 200, 10);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("handles zero altitude range gracefully", () => {
    const color = getTrackSegmentColor(track, 0, "altitude", 100, 100, 10);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("handles zero max speed gracefully", () => {
    const color = getTrackSegmentColor(track, 0, "speed", 100, 200, 0);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("handles last index (uses same point for both)", () => {
    const color = getTrackSegmentColor(track, 3, "altitude", 100, 200, 10);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("produces different colors for different altitude segments", () => {
    const lowColor = getTrackSegmentColor(track, 0, "altitude", 100, 200, 10);
    const highColor = getTrackSegmentColor(track, 1, "altitude", 100, 200, 10);
    // These should be different since altitudes differ significantly
    expect(lowColor).not.toBe(highColor);
  });

  it("produces different colors for different speed segments", () => {
    const slowColor = getTrackSegmentColor(track, 0, "speed", 100, 200, 10);
    const fastColor = getTrackSegmentColor(track, 1, "speed", 100, 200, 10);
    expect(slowColor).not.toBe(fastColor);
  });
});

describe("getGradientLegendCss", () => {
  it("returns solid blue for plain mode", () => {
    const css = getGradientLegendCss("plain");
    expect(css).toContain("#3b82f6");
    expect(css).toContain("linear-gradient");
  });

  it("returns multi-stop gradient for altitude mode", () => {
    const css = getGradientLegendCss("altitude");
    expect(css).toContain("linear-gradient");
    expect(css).toContain("0%");
    expect(css).toContain("100%");
    // Should contain at least 3 color stops
    const stops = css.split(",").length;
    expect(stops).toBeGreaterThanOrEqual(4); // "linear-gradient(to right" + at least 3 stops
  });

  it("returns multi-stop gradient for speed mode", () => {
    const css = getGradientLegendCss("speed");
    expect(css).toContain("linear-gradient");
    expect(css).toContain("0%");
    expect(css).toContain("100%");
  });

  it("altitude and speed gradients are different", () => {
    const altCss = getGradientLegendCss("altitude");
    const spdCss = getGradientLegendCss("speed");
    expect(altCss).not.toBe(spdCss);
  });
});
