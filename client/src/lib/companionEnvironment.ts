import companionTemplate from "../../../companion_scripts/companion-config.example?raw";

/** Defaults are read from the same distributable template used by installers. */
export const companionDefaults: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    companionTemplate.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      return match ? [[match[1], match[2]]] : [];
    }),
  ),
);

export const defaultFcWebserverUrl =
  `http://${companionDefaults.FC_IP}:${companionDefaults.FC_WEBSERVER_PORT}`;

/** Write literal EnvironmentFile values; never add shell interpolation. */
export function formatEnvironmentValue(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error("Companion configuration values must be single-line text.");
  }
  if (!/[\s#"'\\$`]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildCompanionEnvironment(options: {
  hubUrl: string;
  droneId: string;
  apiKey?: string | null;
}): string {
  const hubUrl = options.hubUrl.replace(/\/+$/, "");
  const identity: Record<string, string> = {
    HUB_URL: hubUrl,
    WEB_SERVER_URL: hubUrl,
    DRONE_ID: options.droneId,
    API_KEY: options.apiKey || "<generate-an-api-key>",
  };
  return companionTemplate.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || !(match[1] in identity)) return line;
    return `${match[1]}=${formatEnvironmentValue(identity[match[1]])}`;
  }).join("\n").trimEnd();
}

/** Quote one argument for a POSIX shell command line (single quotes, escaped). */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The single-command companion installer. The script is served by the Hub at
 * /companion/install.sh and fetches the suite from the same Hub, so the only
 * address that matters is the one the Pi can reach.
 */
export function buildCompanionInstallCommand(options: {
  hubUrl: string;
  droneId: string;
  apiKey?: string | null;
  services?: string;
}): string {
  const hubUrl = options.hubUrl.replace(/\/+$/, "");
  const parts = [
    `curl -fsSL ${shellQuote(`${hubUrl}/companion/install.sh`)} | sudo bash -s --`,
    `--hub-url ${shellQuote(hubUrl)}`,
    `--drone-id ${shellQuote(options.droneId)}`,
  ];
  if (options.services) parts.push(`--services ${shellQuote(options.services)}`);
  parts.push(options.apiKey ? `--api-key ${shellQuote(options.apiKey)}` : "--api-key-prompt");
  return parts.join(" \\\n    ");
}

/** Why a Hub address may not work from the Pi, or null when it looks reachable. */
export function hubAddressWarning(hubUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(hubUrl);
  } catch {
    return "Enter the Hub's full address, e.g. http://192.168.144.200:3000";
  }
  const host = parsed.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return `${host} is this computer as seen from itself; the Pi cannot reach it. Enter the Hub's address on the drone subnet (e.g. http://192.168.144.200:3000) or its Tailscale address.`;
  }
  if (host === "0.0.0.0") {
    return "0.0.0.0 is a bind address, not a reachable one. Enter the Hub's drone-subnet or Tailscale address.";
  }
  return null;
}
