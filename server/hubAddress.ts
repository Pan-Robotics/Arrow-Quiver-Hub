/**
 * How is this Hub reachable from a drone?
 *
 * Drones are almost never on the Hub's LAN: they are on a 4G/Wi-Fi uplink with
 * a Tailscale identity, and the Hub is on the same tailnet. So the address a
 * companion computer must use is the Hub's tailnet address, not the browser's
 * `localhost` and not a LAN IP. This module detects the Hub's candidate
 * addresses (tailnet first) for the installer command, the pull-mode
 * registration reply, and absolute URLs embedded in companion jobs.
 *
 * Detection only reads Tailscale state (`tailscale status --json`,
 * `tailscale serve status --json`); nothing here changes it.
 */
import { spawnSync } from "node:child_process";
import os from "node:os";

export type HubAddressKind = "configured" | "tailnet-https" | "tailnet" | "lan" | "loopback";

export interface HubAddress {
  kind: HubAddressKind;
  url: string;
  label: string;
}

export interface TailnetIdentity {
  dnsName: string | null;
  ipv4: string | null;
  /** HTTPS URL served by `tailscale serve` for the Hub port, if configured. */
  serveUrl: string | null;
  online: boolean;
}

const CACHE_MS = 30_000;
let cached: { at: number; port: string; identity: TailnetIdentity } | null = null;

function runTailscale(args: string[]): string | null {
  try {
    // Short timeout: this can sit in a request path (job creation). A hung CLI
    // must degrade to "no tailnet identity", not stall the Hub.
    const res = spawnSync("tailscale", args, { encoding: "utf8", timeout: 2_000 });
    return res.status === 0 ? res.stdout : null;
  } catch {
    return null;
  }
}

/** Parse `tailscale serve status --json` for an HTTPS mapping onto our port. */
function findServeUrl(dnsName: string | null, port: string): string | null {
  if (!dnsName) return null;
  const raw = runTailscale(["serve", "status", "--json"]);
  if (!raw) return null;
  try {
    const status = JSON.parse(raw) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
    for (const [hostPort, site] of Object.entries(status.Web ?? {})) {
      const handlers = site?.Handlers ?? {};
      const proxies = Object.values(handlers).map(h => h?.Proxy ?? "");
      if (!proxies.some(p => p.endsWith(`:${port}`) || p === `http://127.0.0.1:${port}` || p === `http://localhost:${port}`)) continue;
      const [host, servePort] = hostPort.split(":");
      if (!host) continue;
      return servePort && servePort !== "443" ? `https://${host}:${servePort}` : `https://${host}`;
    }
  } catch {
    /* unparseable: treat as not served */
  }
  return null;
}

/** This Hub's Tailscale identity (cached for 30 s). Safe when Tailscale is absent. */
export function tailnetIdentity(port = process.env.PORT || "3000"): TailnetIdentity {
  if (cached && cached.port === port && Date.now() - cached.at < CACHE_MS) return cached.identity;
  let identity: TailnetIdentity = { dnsName: null, ipv4: null, serveUrl: null, online: false };
  const raw = runTailscale(["status", "--json"]);
  if (raw) {
    try {
      const status = JSON.parse(raw) as { Self?: { DNSName?: string; TailscaleIPs?: string[]; Online?: boolean }; BackendState?: string };
      const dnsName = (status.Self?.DNSName ?? "").replace(/\.$/, "") || null;
      const ipv4 = (status.Self?.TailscaleIPs ?? []).find(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null;
      const online = status.BackendState === "Running";
      identity = { dnsName, ipv4, online, serveUrl: online ? findServeUrl(dnsName, port) : null };
    } catch {
      /* not JSON: treat as absent */
    }
  }
  cached = { at: Date.now(), port, identity };
  return identity;
}

/** Non-loopback IPv4 addresses of this machine, Tailscale's CGNAT range excluded. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) continue; // tailscale0
      if (/^docker|^br-|^veth|^virbr/.test(name)) continue;
      out.push(a.address);
    }
  }
  return out;
}

/**
 * Candidate base URLs for reaching this Hub from a drone, best first:
 * PUBLIC_BASE_URL (operator-configured) > tailnet HTTPS (tailscale serve) >
 * tailnet HTTP on the Hub port > LAN IPs > loopback.
 */
export function hubCandidateAddresses(port = process.env.PORT || "3000"): HubAddress[] {
  const out: HubAddress[] = [];
  const configured = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  if (configured) out.push({ kind: "configured", url: configured, label: "PUBLIC_BASE_URL (configured)" });
  const id = tailnetIdentity(port);
  if (id.serveUrl) out.push({ kind: "tailnet-https", url: id.serveUrl, label: "Tailnet (tailscale serve, HTTPS)" });
  if (id.dnsName) out.push({ kind: "tailnet", url: `http://${id.dnsName}:${port}`, label: "Tailnet (MagicDNS name)" });
  else if (id.ipv4) out.push({ kind: "tailnet", url: `http://${id.ipv4}:${port}`, label: "Tailnet (IPv4)" });
  for (const ip of lanAddresses()) out.push({ kind: "lan", url: `http://${ip}:${port}`, label: `LAN (${ip})` });
  out.push({ kind: "loopback", url: `http://127.0.0.1:${port}`, label: "This machine only" });
  // De-duplicate while preserving order.
  const seen = new Set<string>();
  return out.filter(a => (seen.has(a.url) ? false : (seen.add(a.url), true)));
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").split(":")[0];
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
}

/**
 * Base URL for a drone-facing absolute URL. Explicit configuration wins; a
 * browser request from the operator's own machine (localhost) is useless to a
 * drone, so the tailnet address is used instead when the Hub has one; any
 * other request host (LAN IP, tailnet name the operator typed) is kept.
 */
export function droneFacingBaseUrl(req?: { protocol?: string; get?: (header: string) => string | undefined }, port = process.env.PORT || "3000"): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const host = req?.get?.("host");
  if (host && !isLoopbackHost(host)) return `${req?.protocol || "http"}://${host}`;
  const id = tailnetIdentity(port);
  if (id.serveUrl) return id.serveUrl;
  if (id.dnsName) return `http://${id.dnsName}:${port}`;
  if (id.ipv4) return `http://${id.ipv4}:${port}`;
  if (host) return `${req?.protocol || "http"}://${host}`;
  return `http://localhost:${port}`;
}
