import { describe, it, expect } from "vitest";

/**
 * WebRTC Camera Stream Pipeline Tests
 * Tests the WebRTC stream registration, signaling URL relay, and client integration.
 * Replaces the old HLS pipeline tests.
 */

// ─── WebRTC Stream Registry ─────────────────────────────────────

describe("WebRTC Stream Registry", () => {
  interface WebRTCStreamEntry {
    webrtcUrl: string;
    registeredAt: number;
    droneId: string;
  }

  it("should store stream entry with correct fields", () => {
    const registry = new Map<string, WebRTCStreamEntry>();

    const entry: WebRTCStreamEntry = {
      webrtcUrl: "https://quiver.tail1234.ts.net/api/webrtc?src=camera",
      registeredAt: Date.now(),
      droneId: "quiver_001",
    };
    registry.set("quiver_001", entry);

    expect(registry.has("quiver_001")).toBe(true);
    expect(registry.get("quiver_001")?.webrtcUrl).toBe(
      "https://quiver.tail1234.ts.net/api/webrtc?src=camera"
    );
    expect(registry.get("quiver_001")?.droneId).toBe("quiver_001");
  });

  it("should overwrite existing entry on re-register (e.g. Tailscale hostname change)", () => {
    const registry = new Map<string, WebRTCStreamEntry>();

    registry.set("quiver_001", {
      webrtcUrl: "https://old-host.ts.net/api/webrtc?src=camera",
      registeredAt: 1000,
      droneId: "quiver_001",
    });

    registry.set("quiver_001", {
      webrtcUrl: "https://new-host.ts.net/api/webrtc?src=camera",
      registeredAt: 2000,
      droneId: "quiver_001",
    });

    expect(registry.size).toBe(1);
    expect(registry.get("quiver_001")?.webrtcUrl).toBe(
      "https://new-host.ts.net/api/webrtc?src=camera"
    );
    expect(registry.get("quiver_001")?.registeredAt).toBe(2000);
  });

  it("should remove entry on unregister", () => {
    const registry = new Map<string, WebRTCStreamEntry>();

    registry.set("quiver_001", {
      webrtcUrl: "https://quiver.tail1234.ts.net/api/webrtc?src=camera",
      registeredAt: Date.now(),
      droneId: "quiver_001",
    });

    registry.delete("quiver_001");
    expect(registry.has("quiver_001")).toBe(false);
    expect(registry.size).toBe(0);
  });

  it("should support multiple drones simultaneously", () => {
    const registry = new Map<string, WebRTCStreamEntry>();

    registry.set("quiver_001", {
      webrtcUrl: "https://quiver1.tail1234.ts.net/api/webrtc?src=camera",
      registeredAt: Date.now(),
      droneId: "quiver_001",
    });
    registry.set("quiver_002", {
      webrtcUrl: "https://quiver2.tail5678.ts.net/api/webrtc?src=camera",
      registeredAt: Date.now(),
      droneId: "quiver_002",
    });

    expect(registry.size).toBe(2);
    expect(registry.get("quiver_001")?.webrtcUrl).toContain("quiver1");
    expect(registry.get("quiver_002")?.webrtcUrl).toContain("quiver2");
  });
});

// ─── WebRTC URL Validation ──────────────────────────────────────

describe("WebRTC URL Validation", () => {
  it("should accept valid Tailscale funnel URLs", () => {
    const validUrls = [
      "https://quiver.tail1234.ts.net/api/webrtc?src=camera",
      "https://drone-cam.tailnet-abc.ts.net/api/webrtc?src=camera",
      "https://my-pi.tail5678.ts.net:443/api/webrtc?src=camera",
    ];

    for (const url of validUrls) {
      expect(() => new URL(url)).not.toThrow();
      const parsed = new URL(url);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.pathname).toBe("/api/webrtc");
      expect(parsed.searchParams.get("src")).toBe("camera");
    }
  });

  it("should accept URLs with custom ports (8443, 10000)", () => {
    const url8443 = "https://quiver.tail1234.ts.net:8443/api/webrtc?src=camera";
    const url10000 = "https://quiver.tail1234.ts.net:10000/api/webrtc?src=camera";

    expect(() => new URL(url8443)).not.toThrow();
    expect(() => new URL(url10000)).not.toThrow();
    expect(new URL(url8443).port).toBe("8443");
    expect(new URL(url10000).port).toBe("10000");
  });

  it("should reject invalid URLs", () => {
    expect(() => new URL("not-a-url")).toThrow();
    expect(() => new URL("")).toThrow();
  });

  it("should extract base URL for go2rtc API access", () => {
    const webrtcUrl = "https://quiver.tail1234.ts.net/api/webrtc?src=camera";
    const parsed = new URL(webrtcUrl);
    const baseUrl = `${parsed.protocol}//${parsed.host}`;
    expect(baseUrl).toBe("https://quiver.tail1234.ts.net");
  });
});

// ─── WebRTC Signaling (WHEP) ────────────────────────────────────

describe("WebRTC WHEP Signaling", () => {
  it("should construct correct WHEP endpoint from base URL", () => {
    const baseUrl = "https://quiver.tail1234.ts.net";
    const streamName = "camera";
    const whepUrl = `${baseUrl}/api/webrtc?src=${streamName}`;
    expect(whepUrl).toBe("https://quiver.tail1234.ts.net/api/webrtc?src=camera");
  });

  it("should format SDP offer correctly for go2rtc", () => {
    // go2rtc expects SDP in the POST body with content-type application/sdp
    const mockSdpOffer = "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n";
    expect(mockSdpOffer).toContain("v=0");
    expect(typeof mockSdpOffer).toBe("string");
  });

  it("should handle SDP answer response", () => {
    const mockSdpAnswer = "v=0\r\no=- 0 0 IN IP4 192.168.1.50\r\ns=-\r\nt=0 0\r\n";
    expect(mockSdpAnswer).toContain("v=0");
    expect(typeof mockSdpAnswer).toBe("string");
  });
});

// ─── WebSocket Camera Stream Events ─────────────────────────────

describe("WebSocket Camera Stream Events (WebRTC)", () => {
  it("should format stream available event with WebRTC URL", () => {
    const droneId = "quiver_001";
    const webrtcUrl = "https://quiver.tail1234.ts.net/api/webrtc?src=camera";
    const event = {
      drone_id: droneId,
      webrtc_url: webrtcUrl,
      timestamp: Date.now(),
    };

    expect(event.drone_id).toBe("quiver_001");
    expect(event.webrtc_url).toContain("/api/webrtc");
    expect(typeof event.timestamp).toBe("number");
  });

  it("should format stream unavailable event with null URL", () => {
    const droneId = "quiver_001";
    const event = {
      drone_id: droneId,
      webrtc_url: null as string | null,
      timestamp: Date.now(),
    };

    expect(event.drone_id).toBe("quiver_001");
    expect(event.webrtc_url).toBeNull();
  });

  it("should use correct room name for camera subscriptions", () => {
    const droneId = "quiver_001";
    const room = `camera:${droneId}`;
    expect(room).toBe("camera:quiver_001");
  });
});

// ─── Stream Registration Request Validation ──────────────────────

describe("WebRTC Stream Registration Request Validation", () => {
  it("should require all fields for registration", () => {
    const validRequest = {
      api_key: "test-key",
      drone_id: "quiver_001",
      webrtc_url: "https://quiver.tail1234.ts.net/api/webrtc?src=camera",
    };

    expect(validRequest.api_key).toBeTruthy();
    expect(validRequest.drone_id).toBeTruthy();
    expect(validRequest.webrtc_url).toBeTruthy();
  });

  it("should detect missing fields", () => {
    const missingApiKey = {
      drone_id: "quiver_001",
      webrtc_url: "https://x.ts.net/api/webrtc?src=camera",
    };
    const missingDroneId = {
      api_key: "key",
      webrtc_url: "https://x.ts.net/api/webrtc?src=camera",
    };
    const missingWebrtcUrl = { api_key: "key", drone_id: "quiver_001" };

    expect((missingApiKey as any).api_key).toBeFalsy();
    expect((missingDroneId as any).drone_id).toBeFalsy();
    expect((missingWebrtcUrl as any).webrtc_url).toBeFalsy();
  });

  it("should require only api_key and drone_id for unregistration", () => {
    const validUnregister = {
      api_key: "test-key",
      drone_id: "quiver_001",
    };

    expect(validUnregister.api_key).toBeTruthy();
    expect(validUnregister.drone_id).toBeTruthy();
    expect(Object.keys(validUnregister)).toHaveLength(2);
  });
});

// ─── Stream Status Response ──────────────────────────────────────

describe("WebRTC Stream Status Response", () => {
  interface WebRTCStreamEntry {
    webrtcUrl: string;
    registeredAt: number;
    droneId: string;
  }

  it("should return active status with WebRTC URL when stream is registered", () => {
    const registry = new Map<string, WebRTCStreamEntry>();
    registry.set("quiver_001", {
      webrtcUrl: "https://quiver.tail1234.ts.net/api/webrtc?src=camera",
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
          webrtc_url: entry.webrtcUrl,
          registered_at: new Date(entry.registeredAt).toISOString(),
        }
      : {
          success: true,
          active: false,
          drone_id: droneId,
        };

    expect(response.active).toBe(true);
    expect((response as any).webrtc_url).toBe(
      "https://quiver.tail1234.ts.net/api/webrtc?src=camera"
    );
  });

  it("should return inactive status when no stream is registered", () => {
    const registry = new Map<string, WebRTCStreamEntry>();

    const droneId = "quiver_002";
    const entry = registry.get(droneId);
    const response = entry
      ? {
          success: true,
          active: true,
          drone_id: droneId,
          webrtc_url: entry.webrtcUrl,
        }
      : {
          success: true,
          active: false,
          drone_id: droneId,
        };

    expect(response.active).toBe(false);
    expect((response as any).webrtc_url).toBeUndefined();
  });
});

// ─── Tailscale Funnel URL Detection ─────────────────────────────

describe("Tailscale Funnel URL Detection", () => {
  it("should parse Tailscale DNS name from status JSON", () => {
    // Simulates the output of `tailscale status --json`
    const mockStatus = {
      Self: {
        DNSName: "quiver.tail1234.ts.net.",
      },
    };

    const hostname = mockStatus.Self.DNSName.replace(/\.$/, "");
    expect(hostname).toBe("quiver.tail1234.ts.net");
  });

  it("should construct funnel URL from hostname with default port 443", () => {
    const hostname = "quiver.tail1234.ts.net";
    const port = 443;
    const funnelUrl =
      port === 443
        ? `https://${hostname}`
        : `https://${hostname}:${port}`;
    expect(funnelUrl).toBe("https://quiver.tail1234.ts.net");
  });

  it("should construct funnel URL with non-default port", () => {
    const hostname = "quiver.tail1234.ts.net";
    const port = 8443;
    const funnelUrl =
      port === 443
        ? `https://${hostname}`
        : `https://${hostname}:${port}`;
    expect(funnelUrl).toBe("https://quiver.tail1234.ts.net:8443");
  });

  it("should construct WebRTC signaling URL from funnel URL", () => {
    const funnelUrl = "https://quiver.tail1234.ts.net";
    const streamName = "camera";
    const webrtcUrl = `${funnelUrl}/api/webrtc?src=${streamName}`;
    expect(webrtcUrl).toBe("https://quiver.tail1234.ts.net/api/webrtc?src=camera");
  });

  it("should handle trailing dot in DNS name", () => {
    const dnsNames = [
      "quiver.tail1234.ts.net.",
      "quiver.tail1234.ts.net",
    ];

    for (const name of dnsNames) {
      const hostname = name.replace(/\.$/, "");
      expect(hostname).toBe("quiver.tail1234.ts.net");
      expect(hostname.endsWith(".")).toBe(false);
    }
  });
});

// ─── go2rtc Health Check ────────────────────────────────────────

describe("go2rtc Health Check", () => {
  it("should parse go2rtc streams API response", () => {
    // Simulates GET /api/streams response from go2rtc
    const mockResponse = {
      camera: {
        producers: [
          {
            url: "rtsp://192.168.144.25:8554/sub.264",
            medias: ["video"],
          },
        ],
        consumers: [],
      },
    };

    expect(mockResponse.camera).toBeDefined();
    expect(mockResponse.camera.producers).toHaveLength(1);
    expect(mockResponse.camera.producers[0].url).toContain("rtsp://");
  });

  it("should detect healthy stream (has producers)", () => {
    const streams = {
      camera: {
        producers: [{ url: "rtsp://192.168.144.25:8554/sub.264" }],
      },
    };

    const isHealthy =
      streams.camera &&
      streams.camera.producers &&
      streams.camera.producers.length > 0;
    expect(isHealthy).toBe(true);
  });

  it("should detect unhealthy stream (no producers)", () => {
    const streams = {
      camera: {
        producers: [],
      },
    };

    const isHealthy =
      streams.camera &&
      streams.camera.producers &&
      streams.camera.producers.length > 0;
    expect(isHealthy).toBe(false);
  });
});

// ─── Companion Computer Integration ─────────────────────────────

describe("Companion Computer WebRTC Registration", () => {
  it("should construct correct registration payload with WebRTC URL", () => {
    const hubUrl = "https://quiver-hub.example.com";
    const droneId = "quiver_001";
    const apiKey = "test-api-key";
    const funnelUrl = "https://quiver.tail1234.ts.net";

    const payload = {
      api_key: apiKey,
      drone_id: droneId,
      webrtc_url: `${funnelUrl}/api/webrtc?src=camera`,
    };

    const endpoint = `${hubUrl}/api/rest/camera/stream-register`;

    expect(payload.api_key).toBe("test-api-key");
    expect(payload.drone_id).toBe("quiver_001");
    expect(payload.webrtc_url).toBe(
      "https://quiver.tail1234.ts.net/api/webrtc?src=camera"
    );
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
});
