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
