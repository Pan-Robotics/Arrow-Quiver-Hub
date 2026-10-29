import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildCompanionEnvironment,
  companionDefaults,
  defaultFcWebserverUrl,
  formatEnvironmentValue,
} from "../client/src/lib/companionEnvironment";

const options = { hubUrl: "https://hub.example", droneId: "survey_drone", apiKey: "test-drone-key" };
function assignments(content: string) {
  return Object.fromEntries(content.split("\n").flatMap((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    return match ? [[match[1], match[2]]] : [];
  }));
}

describe("Drone Configuration companion environment", () => {
  it("uses every authoritative template default except the selected Hub/drone identity", () => {
    const expected = assignments(readFileSync("companion_scripts/companion-config.example", "utf8"));
    const actual = assignments(buildCompanionEnvironment(options));
    expect(actual).toEqual({ ...expected, HUB_URL: options.hubUrl, WEB_SERVER_URL: options.hubUrl, DRONE_ID: options.droneId, API_KEY: options.apiKey });
    expect(companionDefaults).toEqual(expected);
  });
  it("contains the supplied reserved addresses and payload-port defaults", () => {
    const config = assignments(buildCompanionEnvironment(options));
    expect(config).toMatchObject({
      NETWORK_SUBNET: "192.168.144.0/24", COMPANION_IP: "192.168.144.49", FC_IP: "192.168.144.51",
      CUBENODE_IP: "192.168.144.50", SIYI_AIR_IP: "192.168.144.11", SIYI_GROUND_IP: "192.168.144.12",
      ANDROID_GCS_IP: "192.168.144.20", SIYI_CAMERA_IP: "192.168.144.25", SIYI_CAMERA_RESERVED_IP: "192.168.144.60",
      PAYLOAD_IP_START: "192.168.144.100", PAYLOAD_IP_END: "192.168.144.199",
      PAYLOAD_BOTTOM_IP: "192.168.144.100", PAYLOAD_SIDE1_IP: "192.168.144.101", PAYLOAD_SIDE2_IP: "192.168.144.102",
    });
    expect(defaultFcWebserverUrl).toBe("http://192.168.144.51:8080");
  });
  it("does not pin derived endpoints or a developer-specific installation path", () => {
    const snippet = buildCompanionEnvironment(options);
    for (const key of ["FC_WEBSERVER_URL", "FC_TCP_URL", "RTSP_URL", "GO2RTC_API_URL", "MAVLINK_URL", "INSTALL_DIR", "CONFIG_DIR", "PARSERS_DIR"]) {
      expect(snippet).not.toMatch(new RegExp(`^${key}=`, "m"));
    }
    expect(snippet).not.toMatch(/alexd|\/home\/pi|\/home\/julius/);
    expect(snippet).toContain("FIRMWARE_SERVER_PORT=8070");
    expect(snippet).toContain("LOG_STORE_DIR=/var/lib/quiver/fc_logs");
  });
  it("normalizes the Hub origin and reflects a newly selected drone/key", () => {
    const config = assignments(buildCompanionEnvironment({ hubUrl: "https://other.example///", droneId: "other_drone", apiKey: "new-key" }));
    expect(config.HUB_URL).toBe("https://other.example");
    expect(config.WEB_SERVER_URL).toBe(config.HUB_URL);
    expect(config.DRONE_ID).toBe("other_drone");
    expect(config.API_KEY).toBe("new-key");
  });
  it("shows a clear placeholder when no active API key exists", () => {
    expect(buildCompanionEnvironment({ hubUrl: options.hubUrl, droneId: options.droneId })).toContain("API_KEY=<generate-an-api-key>");
  });
  it("rejects newline/null assignment injection", () => {
    for (const value of ["bad\nFC_IP=evil", "bad\rvalue", "bad\0value"]) {
      expect(() => formatEnvironmentValue(value)).toThrow("single-line");
    }
  });
  it("round-trips the copied snippet through the actual Python runtime with literal credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "quiver-ui-env-"));
    try {
      const filename = join(directory, "companion.config");
      const key = 'literal $HOME # key "quoted" \\ path';
      writeFileSync(filename, buildCompanionEnvironment({ ...options, apiKey: key }));
      const script = `import sys,json; sys.path.insert(0,${JSON.stringify(resolve("companion_scripts"))}); import companion_config; v=companion_config.load_environment(); print(json.dumps({k:v[k] for k in ['HUB_URL','WEB_SERVER_URL','DRONE_ID','API_KEY','FC_WEBSERVER_URL','RTSP_URL']}))`;
      const result = spawnSync("python3", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", QUIVER_ENV_FILE: filename } });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ HUB_URL: options.hubUrl, WEB_SERVER_URL: options.hubUrl, DRONE_ID: options.droneId, API_KEY: key, FC_WEBSERVER_URL: defaultFcWebserverUrl, RTSP_URL: "rtsp://192.168.144.25:8554/sub.264" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("the UI displays and copies the same snippet and exposes the new save/restart guidance", () => {
    const source = readFileSync("client/src/pages/DroneConfig.tsx", "utf8");
    expect(source).toContain("buildCompanionEnvironment({ hubUrl: baseUrl, droneId: selectedDrone, apiKey: activeKey?.key })");
    expect(source).toContain('copyToClipboard(envSnippet, ".env configuration")');
    expect(source).toContain("{envSnippet}");
    expect(source).toContain("firmware_puller.param");
    expect(source).toContain("no DHCP on the Pi");
    expect(source).not.toContain("192.168.144.20:8080");
  });
});
