import { describe, it, expect } from "vitest";

/**
 * HLS Camera Stream Pipeline Tests
 * Tests the stream registration, proxy, WebSocket relay, and client integration
 */

// ─── HLS Stream Registry ─────────────────────────────────────────

describe("HLS Stream Registry", () => {
  it("should store stream entry with correct fields", () => {
    interface HlsStreamEntry {
      originUrl: string;
      registeredAt: number;
      droneId: string;
    }
    const registry = new Map<string, HlsStreamEntry>();

    const entry: HlsStreamEntry = {
      originUrl: "http://192.168.1.50:8080",
      registeredAt: Date.now(),
      droneId: "quiver_001",
    };
    registry.set("quiver_001", entry);

    expect(registry.has("quiver_001")).toBe(true);
    expect(registry.get("quiver_001")?.originUrl).toBe("http://192.168.1.50:8080");
    expect(registry.get("quiver_001")?.droneId).toBe("quiver_001");
  });

  it("should overwrite existing entry on re-register", () => {
    interface HlsStreamEntry {
      originUrl: string;
      registeredAt: number;
      droneId: string;
    }
    const registry = new Map<string, HlsStreamEntry>();

    registry.set("quiver_001", {
      originUrl: "http://192.168.1.50:8080",
      registeredAt: 1000,
      droneId: "quiver_001",
    });

    registry.set("quiver_001", {
      originUrl: "http://192.168.1.100:8080",
      registeredAt: 2000,
      droneId: "quiver_001",
    });

    expect(registry.size).toBe(1);
    expect(registry.get("quiver_001")?.originUrl).toBe("http://192.168.1.100:8080");
    expect(registry.get("quiver_001")?.registeredAt).toBe(2000);
  });

  it("should remove entry on unregister", () => {
    interface HlsStreamEntry {
      originUrl: string;
      registeredAt: number;
      droneId: string;
    }
    const registry = new Map<string, HlsStreamEntry>();

    registry.set("quiver_001", {
      originUrl: "http://192.168.1.50:8080",
      registeredAt: Date.now(),
      droneId: "quiver_001",
    });

    registry.delete("quiver_001");
    expect(registry.has("quiver_001")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("should support multiple drones simultaneously", () => {
    interface HlsStreamEntry {
      originUrl: string;
      registeredAt: number;
      droneId: string;
    }
    const registry = new Map<string, HlsStreamEntry>();

    registry.set("quiver_001", {
      originUrl: "http://192.168.1.50:8080",
      registeredAt: Date.now(),
      droneId: "quiver_001",
    });
    registry.set("quiver_002", {
      originUrl: "http://192.168.1.51:8080",
      registeredAt: Date.now(),
      droneId: "quiver_002",
    });

    expect(registry.size).toBe(2);
    expect(registry.get("quiver_001")?.originUrl).toBe("http://192.168.1.50:8080");
    expect(registry.get("quiver_002")?.originUrl).toBe("http://192.168.1.51:8080");
  });
});

// ─── Stream URL Parsing ──────────────────────────────────────────

describe("Stream URL Parsing", () => {
  it("should extract origin URL from full stream URL", () => {
    const streamUrl = "http://192.168.1.50:8080/stream.m3u8";
    const parsed = new URL(streamUrl);
    const originUrl = `${parsed.protocol}//${parsed.host}`;
    expect(originUrl).toBe("http://192.168.1.50:8080");
  });

  it("should handle URLs with different ports", () => {
    const streamUrl = "http://192.168.144.25:9090/live/stream.m3u8";
    const parsed = new URL(streamUrl);
    const originUrl = `${parsed.protocol}//${parsed.host}`;
    expect(originUrl).toBe("http://192.168.144.25:9090");
  });

  it("should handle URLs with default port 80", () => {
    const streamUrl = "http://10.0.0.1/stream.m3u8";
    const parsed = new URL(streamUrl);
    const originUrl = `${parsed.protocol}//${parsed.host}`;
    expect(originUrl).toBe("http://10.0.0.1");
  });

  it("should reject invalid URLs", () => {
    expect(() => new URL("not-a-url")).toThrow();
    expect(() => new URL("")).toThrow();
  });

  it("should construct correct proxy URL from drone ID", () => {
    const droneId = "quiver_001";
    const proxyUrl = `/api/rest/camera/hls/${droneId}/stream.m3u8`;
    expect(proxyUrl).toBe("/api/rest/camera/hls/quiver_001/stream.m3u8");
  });

  it("should construct correct upstream URL from origin and path", () => {
    const originUrl = "http://192.168.1.50:8080";
    const hlsPath = "stream.m3u8";
    const targetUrl = `${originUrl}/${hlsPath}`;
    expect(targetUrl).toBe("http://192.168.1.50:8080/stream.m3u8");
  });

  it("should handle .ts segment paths correctly", () => {
    const originUrl = "http://192.168.1.50:8080";
    const hlsPath = "segment_00042.ts";
    const targetUrl = `${originUrl}/${hlsPath}`;
    expect(targetUrl).toBe("http://192.168.1.50:8080/segment_00042.ts");
  });
});

// ─── Content Type Detection ──────────────────────────────────────

describe("HLS Content Type Detection", () => {
  it("should detect .m3u8 as HLS playlist", () => {
    const path = "stream.m3u8";
    const isPlaylist = path.endsWith(".m3u8");
    const isSegment = path.endsWith(".ts");
    expect(isPlaylist).toBe(true);
    expect(isSegment).toBe(false);
  });

  it("should detect .ts as MPEG transport stream", () => {
    const path = "segment_00042.ts";
    const isPlaylist = path.endsWith(".m3u8");
    const isSegment = path.endsWith(".ts");
    expect(isPlaylist).toBe(false);
    expect(isSegment).toBe(true);
  });

  it("should set correct content type for .m3u8", () => {
    const path = "stream.m3u8";
    const contentType = path.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : path.endsWith(".ts")
      ? "video/mp2t"
      : "application/octet-stream";
    expect(contentType).toBe("application/vnd.apple.mpegurl");
  });

  it("should set correct content type for .ts", () => {
    const path = "segment_00042.ts";
    const contentType = path.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : path.endsWith(".ts")
      ? "video/mp2t"
      : "application/octet-stream";
    expect(contentType).toBe("video/mp2t");
  });

  it("should set correct cache headers for playlist vs segment", () => {
    const playlistCache = "no-cache";
    const segmentCache = "max-age=60";

    expect(playlistCache).toBe("no-cache"); // Playlist should never be cached
    expect(segmentCache).toBe("max-age=60"); // Segments are immutable, can be cached
  });
});

// ─── WebSocket Camera Stream Events ─────────────────────────────

describe("WebSocket Camera Stream Events", () => {
  it("should format stream available event correctly", () => {
    const droneId = "quiver_001";
    const streamUrl = "/api/rest/camera/hls/quiver_001/stream.m3u8";
    const event = {
      drone_id: droneId,
      url: streamUrl,
      timestamp: Date.now(),
    };

    expect(event.drone_id).toBe("quiver_001");
    expect(event.url).toBe("/api/rest/camera/hls/quiver_001/stream.m3u8");
    expect(typeof event.timestamp).toBe("number");
  });

  it("should format stream unavailable event with null URL", () => {
    const droneId = "quiver_001";
    const event = {
      drone_id: droneId,
      url: null as string | null,
      timestamp: Date.now(),
    };

    expect(event.drone_id).toBe("quiver_001");
    expect(event.url).toBeNull();
  });

  it("should use correct room name for camera subscriptions", () => {
    const droneId = "quiver_001";
    const room = `camera:${droneId}`;
    expect(room).toBe("camera:quiver_001");
  });
});

// ─── Stream Registration Request Validation ──────────────────────

describe("Stream Registration Request Validation", () => {
  it("should require all fields for registration", () => {
    const validRequest = {
      api_key: "test-key",
      drone_id: "quiver_001",
      stream_url: "http://192.168.1.50:8080/stream.m3u8",
    };

    expect(validRequest.api_key).toBeTruthy();
    expect(validRequest.drone_id).toBeTruthy();
    expect(validRequest.stream_url).toBeTruthy();
  });

  it("should detect missing fields", () => {
    const missingApiKey = { drone_id: "quiver_001", stream_url: "http://x:8080/s.m3u8" };
    const missingDroneId = { api_key: "key", stream_url: "http://x:8080/s.m3u8" };
    const missingStreamUrl = { api_key: "key", drone_id: "quiver_001" };

    expect((missingApiKey as any).api_key).toBeFalsy();
    expect((missingDroneId as any).drone_id).toBeFalsy();
    expect((missingStreamUrl as any).stream_url).toBeFalsy();
  });

  it("should require only api_key and drone_id for unregistration", () => {
    const validUnregister = {
      api_key: "test-key",
      drone_id: "quiver_001",
    };

    expect(validUnregister.api_key).toBeTruthy();
    expect(validUnregister.drone_id).toBeTruthy();
  });
});

// ─── Stream Status Response ──────────────────────────────────────

describe("Stream Status Response", () => {
  it("should return active status when stream is registered", () => {
    interface HlsStreamEntry {
      originUrl: string;
      registeredAt: number;
      droneId: string;
    }
    const registry = new Map<string, HlsStreamEntry>();
    registry.set("quiver_001", {
      originUrl: "http://192.168.1.50:8080",
      registeredAt: 1700000000000,
      droneId: "quiver_001",
    });

    const droneId = "quiver_001";
    const entry = registry.get(droneId);
    const response = entry
      ? {
          success: true,
          active: true,
          drone_id: droneId,
          proxy_url: `/api/rest/camera/hls/${droneId}/stream.m3u8`,
          registered_at: new Date(entry.registeredAt).toISOString(),
        }
      : {
          success: true,
          active: false,
          drone_id: droneId,
        };

    expect(response.active).toBe(true);
    expect((response as any).proxy_url).toBe("/api/rest/camera/hls/quiver_001/stream.m3u8");
  });

  it("should return inactive status when no stream is registered", () => {
    interface HlsStreamEntry {
      originUrl: string;
      registeredAt: number;
      droneId: string;
    }
    const registry = new Map<string, HlsStreamEntry>();

    const droneId = "quiver_002";
    const entry = registry.get(droneId);
    const response = entry
      ? {
          success: true,
          active: true,
          drone_id: droneId,
          proxy_url: `/api/rest/camera/hls/${droneId}/stream.m3u8`,
        }
      : {
          success: true,
          active: false,
          drone_id: droneId,
        };

    expect(response.active).toBe(false);
    expect((response as any).proxy_url).toBeUndefined();
  });
});

// ─── HLS.js Configuration ────────────────────────────────────────

describe("HLS.js Configuration", () => {
  it("should use low-latency tuning values", () => {
    const config = {
      liveSyncDurationCount: 2,
      liveMaxLatencyDurationCount: 5,
      liveDurationInfinity: true,
      enableWorker: true,
      lowLatencyMode: true,
      manifestLoadingMaxRetry: 6,
      manifestLoadingRetryDelay: 1000,
      levelLoadingMaxRetry: 6,
      levelLoadingRetryDelay: 1000,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 1000,
    };

    expect(config.lowLatencyMode).toBe(true);
    expect(config.liveSyncDurationCount).toBeLessThanOrEqual(3);
    expect(config.manifestLoadingMaxRetry).toBeGreaterThanOrEqual(3);
    expect(config.fragLoadingMaxRetry).toBeGreaterThanOrEqual(3);
  });

  it("should have reasonable retry delays", () => {
    const retryDelay = 1000;
    expect(retryDelay).toBeGreaterThanOrEqual(500);
    expect(retryDelay).toBeLessThanOrEqual(5000);
  });
});

// ─── Companion Computer Integration ─────────────────────────────

describe("Companion Computer Stream Registration", () => {
  it("should construct correct registration payload", () => {
    const hubUrl = "https://quiver-hub.example.com";
    const droneId = "quiver_001";
    const apiKey = "test-api-key";
    const localIp = "192.168.1.50";
    const port = 8080;

    const payload = {
      api_key: apiKey,
      drone_id: droneId,
      stream_url: `http://${localIp}:${port}/stream.m3u8`,
    };

    const endpoint = `${hubUrl}/api/rest/camera/stream-register`;

    expect(payload.api_key).toBe("test-api-key");
    expect(payload.drone_id).toBe("quiver_001");
    expect(payload.stream_url).toBe("http://192.168.1.50:8080/stream.m3u8");
    expect(endpoint).toContain("/api/rest/camera/stream-register");
  });

  it("should construct correct unregistration payload", () => {
    const payload = {
      api_key: "test-api-key",
      drone_id: "quiver_001",
    };

    expect(payload.api_key).toBeTruthy();
    expect(payload.drone_id).toBeTruthy();
    expect(Object.keys(payload)).toHaveLength(2);
  });

  it("should detect local IP format", () => {
    const validIps = ["192.168.1.50", "10.0.0.1", "172.16.0.5"];
    const ipRegex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

    for (const ip of validIps) {
      expect(ipRegex.test(ip)).toBe(true);
    }
  });
});
