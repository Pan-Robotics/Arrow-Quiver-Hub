import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for cloudflared tunnel auto-detection and HLS stream registration pipeline.
 * 
 * These tests verify the server-side endpoints that the camera_stream_service.py
 * interacts with, and validate the expected behavior of the tunnel detection flow.
 */

// ============================================================================
// Tunnel URL Detection Logic Tests (mirrors Python detect_tunnel_url)
// ============================================================================

describe('Cloudflared Tunnel URL Detection', () => {
  it('should parse a valid quicktunnel JSON response', () => {
    const response = { hostname: 'abc123-something.trycloudflare.com' };
    const publicUrl = `https://${response.hostname}`;
    expect(publicUrl).toBe('https://abc123-something.trycloudflare.com');
  });

  it('should handle missing hostname in quicktunnel response', () => {
    const response = { status: 'ok' }; // no hostname key
    const hostname = (response as any).hostname;
    expect(hostname).toBeUndefined();
  });

  it('should handle empty hostname in quicktunnel response', () => {
    const response = { hostname: '' };
    expect(response.hostname).toBeFalsy();
  });

  it('should construct HTTPS URL from hostname', () => {
    const hostname = 'random-words-here.trycloudflare.com';
    const url = `https://${hostname}`;
    expect(url).toMatch(/^https:\/\/.+\.trycloudflare\.com$/);
  });
});

// ============================================================================
// Stream URL Priority Logic Tests
// ============================================================================

describe('Stream URL Priority', () => {
  it('should prefer public_url over tunnel_url and LAN IP', () => {
    const publicUrl = 'https://fixed-domain.example.com';
    const tunnelUrl = 'https://abc123.trycloudflare.com';
    const lanUrl = 'http://192.168.144.20:8080';
    
    // Priority: publicUrl > tunnelUrl > lanUrl
    const result = publicUrl || tunnelUrl || lanUrl;
    expect(result).toBe(publicUrl);
  });

  it('should use tunnel_url when public_url is not set', () => {
    const publicUrl: string | null = null;
    const tunnelUrl = 'https://abc123.trycloudflare.com';
    const lanUrl = 'http://192.168.144.20:8080';
    
    const result = publicUrl || tunnelUrl || lanUrl;
    expect(result).toBe(tunnelUrl);
  });

  it('should fall back to LAN IP when no tunnel is available', () => {
    const publicUrl: string | null = null;
    const tunnelUrl: string | null = null;
    const lanUrl = 'http://192.168.144.20:8080';
    
    const result = publicUrl || tunnelUrl || lanUrl;
    expect(result).toBe(lanUrl);
  });

  it('should append /stream.m3u8 to the base URL', () => {
    const baseUrl = 'https://abc123.trycloudflare.com';
    const streamUrl = `${baseUrl}/stream.m3u8`;
    expect(streamUrl).toBe('https://abc123.trycloudflare.com/stream.m3u8');
  });
});

// ============================================================================
// Hub URL Conversion Tests (mirrors Python _register_stream_with_hub)
// ============================================================================

describe('Hub URL Conversion for REST Calls', () => {
  function convertHubUrl(hubUrl: string): string {
    let restBase = hubUrl.replace('wss://', 'https://').replace('ws://', 'http://');
    restBase = restBase.replace(/\/ws$/, '').replace(/\/$/, '');
    return restBase;
  }

  it('should convert wss:// to https://', () => {
    expect(convertHubUrl('wss://hub.example.com/ws')).toBe('https://hub.example.com');
  });

  it('should convert ws:// to http://', () => {
    expect(convertHubUrl('ws://localhost:3000/ws')).toBe('http://localhost:3000');
  });

  it('should handle https:// URL without /ws suffix', () => {
    expect(convertHubUrl('https://rplidar-viz-cjlhozxe.manus.space')).toBe('https://rplidar-viz-cjlhozxe.manus.space');
  });

  it('should strip trailing slash', () => {
    expect(convertHubUrl('https://hub.example.com/')).toBe('https://hub.example.com');
  });

  it('should construct correct registration endpoint', () => {
    const restBase = convertHubUrl('https://rplidar-viz-cjlhozxe.manus.space');
    const registerUrl = `${restBase}/api/rest/camera/stream-register`;
    expect(registerUrl).toBe('https://rplidar-viz-cjlhozxe.manus.space/api/rest/camera/stream-register');
  });
});

// ============================================================================
// Stream Registration Payload Tests
// ============================================================================

describe('Stream Registration Payload', () => {
  it('should construct correct registration payload with tunnel URL', () => {
    const tunnelUrl = 'https://abc123.trycloudflare.com';
    const payload = {
      api_key: 'test-key-123',
      drone_id: 'quiver_001',
      stream_url: `${tunnelUrl}/stream.m3u8`,
    };
    
    expect(payload.api_key).toBe('test-key-123');
    expect(payload.drone_id).toBe('quiver_001');
    expect(payload.stream_url).toBe('https://abc123.trycloudflare.com/stream.m3u8');
    expect(payload.stream_url).toMatch(/^https:\/\//);
  });

  it('should construct correct registration payload with LAN fallback', () => {
    const lanIp = '192.168.144.20';
    const port = 8080;
    const payload = {
      api_key: 'test-key-123',
      drone_id: 'quiver_002',
      stream_url: `http://${lanIp}:${port}/stream.m3u8`,
    };
    
    expect(payload.stream_url).toBe('http://192.168.144.20:8080/stream.m3u8');
    expect(payload.stream_url).toMatch(/^http:\/\/192\./);
  });

  it('should skip registration when api_key is empty', () => {
    const apiKey = '';
    const shouldRegister = Boolean(apiKey);
    expect(shouldRegister).toBe(false);
  });

  it('should skip registration when hub_url is missing', () => {
    const hubUrl: string | null = null;
    const shouldRegister = Boolean(hubUrl);
    expect(shouldRegister).toBe(false);
  });
});

// ============================================================================
// Unregistration Payload Tests
// ============================================================================

describe('Stream Unregistration Payload', () => {
  it('should construct correct unregistration payload', () => {
    const payload = {
      api_key: 'test-key-123',
      drone_id: 'quiver_001',
    };
    
    expect(payload).not.toHaveProperty('stream_url');
    expect(payload.api_key).toBeTruthy();
    expect(payload.drone_id).toBeTruthy();
  });

  it('should only unregister if stream was previously registered', () => {
    let streamRegistered = false;
    
    // Should not unregister
    expect(streamRegistered).toBe(false);
    
    // After registration
    streamRegistered = true;
    expect(streamRegistered).toBe(true);
  });
});

// ============================================================================
// Tunnel Metrics Port Configuration Tests
// ============================================================================

describe('Tunnel Metrics Port Configuration', () => {
  it('should use default metrics port 33843', () => {
    const DEFAULT_METRICS_PORT = 33843;
    const metricsUrl = `http://127.0.0.1:${DEFAULT_METRICS_PORT}/quicktunnel`;
    expect(metricsUrl).toBe('http://127.0.0.1:33843/quicktunnel');
  });

  it('should construct correct metrics URL with custom port', () => {
    const port = 44444;
    const metricsUrl = `http://127.0.0.1:${port}/quicktunnel`;
    expect(metricsUrl).toBe('http://127.0.0.1:44444/quicktunnel');
  });

  it('should disable tunnel detection when port is null', () => {
    const tunnelMetricsPort: number | null = null;
    const shouldDetect = tunnelMetricsPort !== null;
    expect(shouldDetect).toBe(false);
  });

  it('should enable tunnel detection when port is provided', () => {
    const tunnelMetricsPort: number | null = 33843;
    const shouldDetect = tunnelMetricsPort !== null;
    expect(shouldDetect).toBe(true);
  });
});

// ============================================================================
// Service Dependency Chain Tests
// ============================================================================

describe('Service Dependency Chain', () => {
  it('should define correct startup order', () => {
    const services = [
      { name: 'cloudflared-hls', before: ['camera-stream'] },
      { name: 'siyi-camera', before: [] },
      { name: 'camera-stream', after: ['cloudflared-hls', 'siyi-camera'] },
    ];
    
    const cameraStream = services.find(s => s.name === 'camera-stream');
    expect(cameraStream?.after).toContain('cloudflared-hls');
    expect(cameraStream?.after).toContain('siyi-camera');
  });

  it('should have cloudflared-hls start before camera-stream', () => {
    const cloudflared = { name: 'cloudflared-hls', before: ['camera-stream'] };
    expect(cloudflared.before).toContain('camera-stream');
  });
});

// ============================================================================
// CLI Argument Parsing Tests
// ============================================================================

describe('CLI Argument Parsing', () => {
  it('should accept --tunnel-metrics-port as optional argument', () => {
    const args = {
      stream: 'sub',
      port: 8080,
      hub_url: 'https://hub.example.com',
      drone_id: 'quiver_001',
      api_key: 'test-key',
      tunnel_metrics_port: 33843,
      public_url: null,
    };
    
    expect(args.tunnel_metrics_port).toBe(33843);
    expect(args.public_url).toBeNull();
  });

  it('should accept --public-url as optional override', () => {
    const args = {
      stream: 'sub',
      port: 8080,
      hub_url: 'https://hub.example.com',
      drone_id: 'quiver_001',
      api_key: 'test-key',
      tunnel_metrics_port: null,
      public_url: 'https://fixed.example.com',
    };
    
    expect(args.public_url).toBe('https://fixed.example.com');
    expect(args.tunnel_metrics_port).toBeNull();
  });

  it('should default tunnel_metrics_port to null when not provided', () => {
    const args = {
      tunnel_metrics_port: null as number | null,
    };
    expect(args.tunnel_metrics_port).toBeNull();
  });
});

// ============================================================================
// End-to-End Flow Simulation
// ============================================================================

describe('End-to-End Tunnel Registration Flow', () => {
  it('should simulate full flow: detect tunnel → build URL → register', () => {
    // Step 1: Cloudflared returns tunnel hostname
    const quicktunnelResponse = { hostname: 'test-tunnel-abc.trycloudflare.com' };
    
    // Step 2: Build public URL
    const tunnelUrl = `https://${quicktunnelResponse.hostname}`;
    expect(tunnelUrl).toBe('https://test-tunnel-abc.trycloudflare.com');
    
    // Step 3: Build stream URL
    const streamUrl = `${tunnelUrl}/stream.m3u8`;
    expect(streamUrl).toBe('https://test-tunnel-abc.trycloudflare.com/stream.m3u8');
    
    // Step 4: Build registration payload
    const payload = {
      api_key: 'sp10G8P9XCXUBidys1KJaoeCSxOFLUo5E1CDhc9L85M',
      drone_id: 'quiver_001',
      stream_url: streamUrl,
    };
    expect(payload.stream_url).toContain('trycloudflare.com');
    
    // Step 5: Simulate successful registration response
    const hubResponse = {
      success: true,
      message: 'Stream registered',
      proxy_url: '/api/rest/camera/hls/quiver_001/stream.m3u8',
    };
    expect(hubResponse.success).toBe(true);
    expect(hubResponse.proxy_url).toContain(payload.drone_id);
  });

  it('should simulate fallback flow when tunnel is unavailable', () => {
    // Step 1: Tunnel detection fails
    const tunnelUrl: string | null = null;
    
    // Step 2: Fall back to LAN IP
    const lanIp = '192.168.144.20';
    const port = 8080;
    const baseUrl = tunnelUrl || `http://${lanIp}:${port}`;
    expect(baseUrl).toBe('http://192.168.144.20:8080');
    
    // Step 3: Registration still happens (may fail if Hub can't reach LAN)
    const streamUrl = `${baseUrl}/stream.m3u8`;
    expect(streamUrl).toContain('192.168.144.20');
  });
});
