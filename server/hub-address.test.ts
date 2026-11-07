import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { droneFacingBaseUrl, hubCandidateAddresses, lanAddresses, tailnetIdentity } from "./hubAddress";
import { toPublicUrl } from "./storage";
import restApiRouter from "./rest-api";

const req = (host: string, protocol = "http") => ({ protocol, get: (h: string) => (h.toLowerCase() === "host" ? host : undefined) });

describe("drone-facing Hub address", () => {
  const saved = { PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL, PORT: process.env.PORT };
  beforeEach(() => {
    delete process.env.PUBLIC_BASE_URL;
    process.env.PORT = "3000";
  });
  afterEach(() => {
    if (saved.PUBLIC_BASE_URL === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = saved.PUBLIC_BASE_URL;
    if (saved.PORT === undefined) delete process.env.PORT; else process.env.PORT = saved.PORT;
  });

  it("PUBLIC_BASE_URL wins over everything", () => {
    process.env.PUBLIC_BASE_URL = "https://quiver-hub-op1.tailnet.ts.net/";
    expect(droneFacingBaseUrl(req("localhost:3000"))).toBe("https://quiver-hub-op1.tailnet.ts.net");
    expect(toPublicUrl("/files/firmware/x.abin", req("127.0.0.1:3000"))).toBe("https://quiver-hub-op1.tailnet.ts.net/files/firmware/x.abin");
    expect(hubCandidateAddresses()[0]).toEqual({ kind: "configured", url: "https://quiver-hub-op1.tailnet.ts.net", label: "PUBLIC_BASE_URL (configured)" });
  });

  it("keeps a non-loopback request host (operator reached the Hub by a drone-reachable name)", () => {
    expect(droneFacingBaseUrl(req("192.168.144.200:3000"))).toBe("http://192.168.144.200:3000");
    expect(droneFacingBaseUrl(req("hub.tailnet.ts.net", "https"))).toBe("https://hub.tailnet.ts.net");
  });

  it("never hands a drone the operator's localhost: falls back to the tailnet address or the port", () => {
    const base = droneFacingBaseUrl(req("localhost:3000"));
    const id = tailnetIdentity("3000");
    if (id.serveUrl) expect(base).toBe(id.serveUrl);
    else if (id.dnsName) expect(base).toBe(`http://${id.dnsName}:3000`);
    else if (id.ipv4) expect(base).toBe(`http://${id.ipv4}:3000`);
    else expect(base).toBe("http://localhost:3000");
    expect(droneFacingBaseUrl(req("0.0.0.0:3000"))).not.toMatch(/0\.0\.0\.0/);
  });

  it("orders candidates tailnet > LAN > loopback and de-duplicates", () => {
    const candidates = hubCandidateAddresses("3000");
    const kinds = candidates.map(c => c.kind);
    const rank = (k: string) => ["configured", "tailnet-https", "tailnet", "lan", "loopback"].indexOf(k);
    expect([...kinds].sort((a, b) => rank(a) - rank(b))).toEqual(kinds);
    expect(kinds[kinds.length - 1]).toBe("loopback");
    expect(new Set(candidates.map(c => c.url)).size).toBe(candidates.length);
    for (const ip of lanAddresses()) expect(candidates.some(c => c.url === `http://${ip}:3000`)).toBe(true);
    expect(lanAddresses().some(ip => ip.startsWith("127.") || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip))).toBe(false);
  });
});

describe("POST /api/rest/drone/connection (companion self-registration)", () => {
  let server: Server;
  let base = "";
  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/rest", restApiRouter);
    await new Promise<void>(r => { server = app.listen(0, "127.0.0.1", () => r()); });
    const a = server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });
  afterEach(async () => { await new Promise<void>(r => server.close(() => r())); });

  const post = (body: unknown) => fetch(`${base}/api/rest/drone/connection`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("requires api_key and drone_id, and rejects an unknown key before touching anything", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ drone_id: "d" })).status).toBe(400);
    // No database under Vitest: every key is unknown -> 401, never a record change.
    const r = await post({ api_key: "nope", drone_id: "d", ingest_mode: "pull", tailnet_host: "d.tailnet.ts.net" });
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("Invalid API key");
    const g = await fetch(`${base}/api/rest/drone/connection?api_key=nope&drone_id=d`);
    expect(g.status).toBe(401);
  });
});
