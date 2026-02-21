/**
 * Flight log chart definitions.
 * Maps ArduPilot DataFlash message types to Recharts chart configurations.
 * Ported from the Python Flight-Log-Analyser plot definitions.
 *
 * The DataflashParser returns instance-based message types for sensors with
 * multiple instances (e.g. BARO[0], ESC[0], BAT[0], VIBE[0], GPA[0], XKF4[0]).
 * This module handles resolving both bare names and instance variants.
 */

export interface ChartField {
  key: string;
  label: string;
  color: string;
  yAxisId?: "left" | "right";
}

export interface ChartDefinition {
  id: string;
  title: string;
  description: string;
  messageType: string; // primary message type to parse (e.g. "ATT", "BARO")
  additionalMessages?: string[]; // extra messages needed
  fields: ChartField[];
  xKey: string; // typically "time_boot_ms"
  yAxisLabel?: string;
  yAxisRight?: string;
  category: "attitude" | "navigation" | "power" | "vibration" | "radio" | "ekf";
}

// Color palette for chart lines
const COLORS = {
  red: "#ef4444",
  blue: "#3b82f6",
  green: "#22c55e",
  orange: "#f97316",
  purple: "#a855f7",
  cyan: "#06b6d4",
  pink: "#ec4899",
  yellow: "#eab308",
  lime: "#84cc16",
  teal: "#14b8a6",
  indigo: "#6366f1",
  amber: "#f59e0b",
  rose: "#f43f5e",
  emerald: "#10b981",
  sky: "#0ea5e9",
  violet: "#8b5cf6",
};

export const CHART_DEFINITIONS: ChartDefinition[] = [
  // ─── Attitude ───────────────────────────────────────────────
  {
    id: "att-rp",
    title: "Attitude: Roll & Pitch",
    description: "Desired vs actual roll and pitch angles",
    messageType: "ATT",
    fields: [
      { key: "DesRoll", label: "Desired Roll", color: COLORS.red },
      { key: "Roll", label: "Roll", color: COLORS.orange },
      { key: "DesPitch", label: "Desired Pitch", color: COLORS.blue },
      { key: "Pitch", label: "Pitch", color: COLORS.cyan },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "Degrees",
    category: "attitude",
  },
  {
    id: "att-yaw",
    title: "Attitude: Yaw",
    description: "Desired vs actual yaw heading",
    messageType: "ATT",
    fields: [
      { key: "DesYaw", label: "Desired Yaw", color: COLORS.red },
      { key: "Yaw", label: "Yaw", color: COLORS.blue },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "Degrees",
    category: "attitude",
  },

  // ─── Rate ───────────────────────────────────────────────────
  {
    id: "rate-rp",
    title: "Rate: Roll & Pitch",
    description: "Desired vs actual roll and pitch rates",
    messageType: "RATE",
    fields: [
      { key: "RDes", label: "Roll Rate Desired", color: COLORS.red },
      { key: "R", label: "Roll Rate", color: COLORS.orange },
      { key: "PDes", label: "Pitch Rate Desired", color: COLORS.blue },
      { key: "P", label: "Pitch Rate", color: COLORS.cyan },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "deg/s",
    category: "attitude",
  },
  {
    id: "rate-yaw",
    title: "Rate: Yaw",
    description: "Desired vs actual yaw rate",
    messageType: "RATE",
    fields: [
      { key: "YDes", label: "Yaw Rate Desired", color: COLORS.red },
      { key: "Y", label: "Yaw Rate", color: COLORS.blue },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "deg/s",
    category: "attitude",
  },

  // ─── Barometer ──────────────────────────────────────────────
  {
    id: "baro-alt",
    title: "Barometer: Altitude",
    description: "Barometric altitude reading",
    messageType: "BARO",
    fields: [
      { key: "Alt", label: "Altitude", color: COLORS.blue },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "Meters",
    category: "navigation",
  },
  {
    id: "baro-press",
    title: "Barometer: Pressure & Temperature",
    description: "Atmospheric pressure and temperature",
    messageType: "BARO",
    fields: [
      { key: "Press", label: "Pressure", color: COLORS.blue, yAxisId: "left" },
      { key: "Temp", label: "Temperature", color: COLORS.red, yAxisId: "right" },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "hPa",
    yAxisRight: "°C",
    category: "navigation",
  },

  // ─── GPS ────────────────────────────────────────────────────
  {
    id: "gps-speed",
    title: "GPS: Speed & Altitude",
    description: "Ground speed and GPS altitude",
    messageType: "GPS",
    fields: [
      { key: "Spd", label: "Speed", color: COLORS.green, yAxisId: "left" },
      { key: "Alt", label: "Altitude", color: COLORS.blue, yAxisId: "right" },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "m/s",
    yAxisRight: "Meters",
    category: "navigation",
  },
  {
    id: "gps-quality",
    title: "GPS: Quality",
    description: "Horizontal, vertical, and speed accuracy",
    messageType: "GPA",
    fields: [
      { key: "HAcc", label: "Horizontal Accuracy", color: COLORS.blue, yAxisId: "left" },
      { key: "VAcc", label: "Vertical Accuracy", color: COLORS.red, yAxisId: "left" },
      { key: "SAcc", label: "Speed Accuracy", color: COLORS.green, yAxisId: "right" },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "Meters",
    yAxisRight: "m/s",
    category: "navigation",
  },

  // ─── Battery ────────────────────────────────────────────────
  {
    id: "bat-voltage",
    title: "Battery: Voltage & Current",
    description: "Battery voltage and current draw",
    messageType: "BAT",
    fields: [
      { key: "Volt", label: "Voltage", color: COLORS.green, yAxisId: "left" },
      { key: "Curr", label: "Current", color: COLORS.red, yAxisId: "right" },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "Volts",
    yAxisRight: "Amps",
    category: "power",
  },
  {
    id: "bat-energy",
    title: "Battery: Energy Consumed",
    description: "Cumulative energy consumed",
    messageType: "BAT",
    fields: [
      { key: "CurrTot", label: "Current Total (mAh)", color: COLORS.orange },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "mAh",
    category: "power",
  },

  // ─── ESC ────────────────────────────────────────────────────
  {
    id: "esc-rpm",
    title: "ESC: RPM",
    description: "Electronic speed controller RPM",
    messageType: "ESC",
    fields: [
      { key: "RPM", label: "RPM", color: COLORS.blue },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "RPM",
    category: "power",
  },
  {
    id: "esc-current",
    title: "ESC: Voltage & Current",
    description: "ESC voltage and current draw",
    messageType: "ESC",
    fields: [
      { key: "Volt", label: "Voltage", color: COLORS.green, yAxisId: "left" },
      { key: "Curr", label: "Current", color: COLORS.red, yAxisId: "right" },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "Volts",
    yAxisRight: "Amps",
    category: "power",
  },

  // ─── Vibration ──────────────────────────────────────────────
  {
    id: "vibe",
    title: "Vibration Levels",
    description: "Accelerometer vibration on X, Y, Z axes",
    messageType: "VIBE",
    fields: [
      { key: "VibeX", label: "Vibe X", color: COLORS.red },
      { key: "VibeY", label: "Vibe Y", color: COLORS.green },
      { key: "VibeZ", label: "Vibe Z", color: COLORS.blue },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "m/s²",
    category: "vibration",
  },
  {
    id: "vibe-clip",
    title: "Vibration: Clipping",
    description: "Accelerometer clipping count",
    messageType: "VIBE",
    fields: [
      { key: "Clip", label: "Clip Count", color: COLORS.red },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "Count",
    category: "vibration",
  },

  // ─── RC Input/Output ───────────────────────────────────────
  {
    id: "rcin",
    title: "RC Input: Channels 1-4",
    description: "Radio control input channels (roll, pitch, throttle, yaw)",
    messageType: "RCIN",
    fields: [
      { key: "C1", label: "Ch1 (Roll)", color: COLORS.red },
      { key: "C2", label: "Ch2 (Pitch)", color: COLORS.blue },
      { key: "C3", label: "Ch3 (Throttle)", color: COLORS.green },
      { key: "C4", label: "Ch4 (Yaw)", color: COLORS.orange },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "PWM",
    category: "radio",
  },
  {
    id: "rcou",
    title: "RC Output: Servo Channels 1-4",
    description: "Servo output channels to motors",
    messageType: "RCOU",
    fields: [
      { key: "C1", label: "Servo 1", color: COLORS.red },
      { key: "C2", label: "Servo 2", color: COLORS.blue },
      { key: "C3", label: "Servo 3", color: COLORS.green },
      { key: "C4", label: "Servo 4", color: COLORS.orange },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "PWM",
    category: "radio",
  },

  // ─── EKF ────────────────────────────────────────────────────
  {
    id: "ekf-vel",
    title: "EKF: Velocity Innovation",
    description: "Extended Kalman Filter velocity innovations",
    messageType: "XKF4",
    fields: [
      { key: "SV", label: "Velocity Variance", color: COLORS.red },
      { key: "SP", label: "Position Variance", color: COLORS.blue },
      { key: "SH", label: "Height Variance", color: COLORS.green },
    ],
    xKey: "time_boot_ms",
    yAxisLabel: "Variance",
    category: "ekf",
  },
];

// Group charts by category
export const CHART_CATEGORIES = [
  { id: "attitude", label: "Attitude & Rate", icon: "RotateCw" },
  { id: "navigation", label: "Navigation & GPS", icon: "Navigation" },
  { id: "power", label: "Power & Battery", icon: "Battery" },
  { id: "vibration", label: "Vibration", icon: "Activity" },
  { id: "radio", label: "Radio Control", icon: "Radio" },
  { id: "ekf", label: "EKF", icon: "Brain" },
] as const;

/**
 * Resolve a message type name to the actual key in the parsed data.
 * The DataflashParser returns instance-based names for multi-instance sensors:
 *   BARO → BARO[0], ESC → ESC[0], BAT → BAT[0], VIBE → VIBE[0], etc.
 * This function checks for the bare name first, then falls back to [0] instance.
 */
export function resolveMessageKey(
  name: string,
  availableTypes: Record<string, unknown>
): string | null {
  // Direct match
  if (availableTypes[name]) return name;
  // Instance [0] fallback
  const inst0 = `${name}[0]`;
  if (availableTypes[inst0]) return inst0;
  // Check any instance
  const prefix = `${name}[`;
  for (const key of Object.keys(availableTypes)) {
    if (key.startsWith(prefix)) return key;
  }
  return null;
}

/**
 * Get which message types need to be parsed for a set of chart definitions.
 */
export function getRequiredMessageTypes(charts: ChartDefinition[]): string[] {
  const types = new Set<string>();
  for (const chart of charts) {
    types.add(chart.messageType);
    if (chart.additionalMessages) {
      for (const msg of chart.additionalMessages) {
        types.add(msg);
      }
    }
  }
  return Array.from(types);
}

/**
 * Get all message types needed for the full chart suite.
 */
export function getAllRequiredMessageTypes(): string[] {
  return getRequiredMessageTypes(CHART_DEFINITIONS);
}

/**
 * Filter chart definitions to only those whose data is available in the parsed log.
 * Handles instance-based message types (e.g. BARO[0] matches BARO).
 */
export function getAvailableCharts(
  availableMessageTypes: Record<string, unknown>
): ChartDefinition[] {
  return CHART_DEFINITIONS.filter((chart) => {
    // Primary message type must exist (direct or instance)
    if (!resolveMessageKey(chart.messageType, availableMessageTypes)) return false;
    // Additional messages must also exist if specified
    if (chart.additionalMessages) {
      return chart.additionalMessages.every(
        (msg) => resolveMessageKey(msg, availableMessageTypes) !== null
      );
    }
    return true;
  });
}

/**
 * Convert parsed DataFlash data to Recharts-compatible array format.
 * Handles instance-based message keys (e.g. BARO[0] for BARO charts).
 * Downsamples large datasets to maxPoints for performance.
 */
export function toChartData(
  parsedMessages: Record<string, any>,
  chart: ChartDefinition,
  availableTypes: Record<string, unknown>,
  maxPoints: number = 2000
): Array<Record<string, number>> {
  // Resolve against parsedMessages (not types) since messages use instance keys
  // e.g. types has both "BARO" and "BARO[0]" but messages only has "BARO[0]"
  const resolvedKey = resolveMessageKey(chart.messageType, parsedMessages);
  if (!resolvedKey) return [];

  const msgData = parsedMessages[resolvedKey];
  if (!msgData || !msgData.time_boot_ms) return [];

  const timeArray = msgData.time_boot_ms;
  const totalPoints = timeArray.length;

  // Find global min time across all messages for relative timestamps
  // This matches extractFlightModes() and extractGpsTrack() so time filters work correctly
  let globalMinTime = Infinity;
  for (const key of Object.keys(parsedMessages)) {
    const msg = parsedMessages[key];
    if (msg?.time_boot_ms && msg.time_boot_ms.length > 0) {
      const first = msg.time_boot_ms[0];
      if (Number.isFinite(first) && first < globalMinTime) globalMinTime = first;
    }
  }
  if (globalMinTime === Infinity) globalMinTime = timeArray[0];

  // Determine downsample step
  const step = Math.max(1, Math.floor(totalPoints / maxPoints));

  const data: Array<Record<string, number>> = [];

  for (let i = 0; i < totalPoints; i += step) {
    const point: Record<string, number> = {
      time: (timeArray[i] - globalMinTime) / 1000, // Relative seconds from log start
    };

    for (const field of chart.fields) {
      const fieldData = msgData[field.key];
      if (fieldData && i < fieldData.length) {
        const val = fieldData[i];
        // Filter out NaN and Infinity
        point[field.key] = Number.isFinite(val) ? val : 0;
      }
    }

    data.push(point);
  }

  return data;
}

// ─── Flight Summary Extraction ─────────────────────────────

export interface FlightSummary {
  totalFlightTime: number | null; // seconds
  maxAltitude: number | null; // meters (barometric)
  maxGpsAltitude: number | null; // meters (GPS)
  maxSpeed: number | null; // m/s
  avgSpeed: number | null; // m/s
  batteryStartVoltage: number | null; // volts
  batteryEndVoltage: number | null; // volts
  batteryMinVoltage: number | null; // volts
  batteryConsumed: number | null; // mAh
  maxCurrent: number | null; // amps
  maxVibration: number | null; // m/s²
  avgVibration: number | null; // m/s²
  maxClipping: number | null; // count
  gpsFixType: number | null; // 0-6
  numSatellites: number | null;
  maxEscRpm: number | null;
  totalMessages: number;
  logDuration: number | null; // seconds (from first to last message timestamp)
}

/**
 * Extract a flight summary from parsed DataFlash messages.
 * Uses resolveMessageKey to handle instance-based keys.
 */
export function extractFlightSummary(
  parsedMessages: Record<string, any>,
  startTime?: Date | null
): FlightSummary {
  const summary: FlightSummary = {
    totalFlightTime: null,
    maxAltitude: null,
    maxGpsAltitude: null,
    maxSpeed: null,
    avgSpeed: null,
    batteryStartVoltage: null,
    batteryEndVoltage: null,
    batteryMinVoltage: null,
    batteryConsumed: null,
    maxCurrent: null,
    maxVibration: null,
    avgVibration: null,
    maxClipping: null,
    gpsFixType: null,
    numSatellites: null,
    maxEscRpm: null,
    totalMessages: Object.keys(parsedMessages).length,
    logDuration: null,
  };

  // Helper to find a message by name or instance
  const findMsg = (name: string): any => {
    const key = resolveMessageKey(name, parsedMessages);
    return key ? parsedMessages[key] : null;
  };

  // Helper to get max of a numeric array
  const maxOf = (arr: number[] | undefined): number | null => {
    if (!arr || arr.length === 0) return null;
    let max = -Infinity;
    for (const v of arr) {
      if (Number.isFinite(v) && v > max) max = v;
    }
    return max === -Infinity ? null : max;
  };

  // Helper to get min of a numeric array
  const minOf = (arr: number[] | undefined): number | null => {
    if (!arr || arr.length === 0) return null;
    let min = Infinity;
    for (const v of arr) {
      if (Number.isFinite(v) && v < min) min = v;
    }
    return min === Infinity ? null : min;
  };

  // Helper to get average of a numeric array
  const avgOf = (arr: number[] | undefined): number | null => {
    if (!arr || arr.length === 0) return null;
    let sum = 0;
    let count = 0;
    for (const v of arr) {
      if (Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    return count > 0 ? sum / count : null;
  };

  // ─── Log Duration / Flight Time ───────────────────────────
  // Find the overall time range from any message with time_boot_ms
  let globalMinTime = Infinity;
  let globalMaxTime = -Infinity;
  for (const key of Object.keys(parsedMessages)) {
    const msg = parsedMessages[key];
    if (msg?.time_boot_ms && msg.time_boot_ms.length > 0) {
      const first = msg.time_boot_ms[0];
      const last = msg.time_boot_ms[msg.time_boot_ms.length - 1];
      if (Number.isFinite(first) && first < globalMinTime) globalMinTime = first;
      if (Number.isFinite(last) && last > globalMaxTime) globalMaxTime = last;
    }
  }
  if (globalMinTime < Infinity && globalMaxTime > -Infinity) {
    summary.logDuration = (globalMaxTime - globalMinTime) / 1000; // ms to seconds
    summary.totalFlightTime = summary.logDuration;
  }

  // ─── Barometer ────────────────────────────────────────────
  const baro = findMsg("BARO");
  if (baro?.Alt) {
    summary.maxAltitude = maxOf(baro.Alt);
  }

  // ─── GPS ──────────────────────────────────────────────────
  const gps = findMsg("GPS");
  if (gps) {
    if (gps.Spd) {
      summary.maxSpeed = maxOf(gps.Spd);
      summary.avgSpeed = avgOf(gps.Spd);
    }
    if (gps.Alt) {
      summary.maxGpsAltitude = maxOf(gps.Alt);
    }
    if (gps.Status) {
      summary.gpsFixType = maxOf(gps.Status);
    }
    if (gps.NSats) {
      summary.numSatellites = maxOf(gps.NSats);
    }
  }

  // ─── Battery ──────────────────────────────────────────────
  const bat = findMsg("BAT");
  if (bat) {
    if (bat.Volt && bat.Volt.length > 0) {
      summary.batteryStartVoltage = bat.Volt[0];
      summary.batteryEndVoltage = bat.Volt[bat.Volt.length - 1];
      summary.batteryMinVoltage = minOf(bat.Volt);
    }
    if (bat.CurrTot && bat.CurrTot.length > 0) {
      summary.batteryConsumed = bat.CurrTot[bat.CurrTot.length - 1];
    }
    if (bat.Curr) {
      summary.maxCurrent = maxOf(bat.Curr);
    }
  }

  // ─── Vibration ────────────────────────────────────────────
  const vibe = findMsg("VIBE");
  if (vibe) {
    // Compute vibration magnitude from X, Y, Z
    const vibeVals: number[] = [];
    const vibeX = vibe.VibeX || [];
    const vibeY = vibe.VibeY || [];
    const vibeZ = vibe.VibeZ || [];
    const len = Math.min(vibeX.length, vibeY.length, vibeZ.length);
    for (let i = 0; i < len; i++) {
      const mag = Math.sqrt(
        (vibeX[i] || 0) ** 2 + (vibeY[i] || 0) ** 2 + (vibeZ[i] || 0) ** 2
      );
      vibeVals.push(mag);
    }
    summary.maxVibration = maxOf(vibeVals);
    summary.avgVibration = avgOf(vibeVals);

    if (vibe.Clip) {
      summary.maxClipping = maxOf(vibe.Clip);
    }
  }

  // ─── ESC ──────────────────────────────────────────────────
  const esc = findMsg("ESC");
  if (esc?.RPM) {
    summary.maxEscRpm = maxOf(esc.RPM);
  }

  return summary;
}

// ─── Chart Export Utilities ────────────────────────────────

/**
 * Convert chart data to CSV string.
 */
export function chartDataToCsv(
  chart: ChartDefinition,
  data: Array<Record<string, number>>
): string {
  if (data.length === 0) return "";

  // Build header: time + all field keys
  const headers = ["time_seconds", ...chart.fields.map((f) => f.key)];
  const rows = [headers.join(",")];

  for (const point of data) {
    const row = [
      point.time?.toFixed(3) ?? "",
      ...chart.fields.map((f) => {
        const val = point[f.key];
        return val !== undefined && Number.isFinite(val) ? val.toString() : "";
      }),
    ];
    rows.push(row.join(","));
  }

  return rows.join("\n");
}

/**
 * Trigger a CSV file download in the browser.
 */
export function downloadCsv(filename: string, csvContent: string): void {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// ─── Flight Mode Timeline Extraction ──────────────────────

export interface FlightModeSegment {
  mode: string;
  modeNum: number;
  startTime: number; // seconds from log start
  endTime: number; // seconds from log start
  duration: number; // seconds
}

// ArduCopter mode mapping (fallback for binary logs)
const COPTER_MODES: Record<number, string> = {
  0: "Stabilize", 1: "Acro", 2: "AltHold", 3: "Auto",
  4: "Guided", 5: "Loiter", 6: "RTL", 7: "Circle",
  9: "Land", 11: "Drift", 13: "Sport", 14: "Flip",
  15: "AutoTune", 16: "PosHold", 17: "Brake", 18: "Throw",
  19: "Avoid_ADSB", 20: "Guided_NoGPS", 21: "SmartRTL",
  22: "FlowHold", 23: "Follow", 24: "ZigZag", 25: "SystemId",
  26: "Heli_Autorotate", 27: "Auto RTL",
};

// Mode color palette for timeline visualization
const MODE_COLORS: Record<string, string> = {
  Stabilize: "#3b82f6", Acro: "#f97316", AltHold: "#22c55e",
  Auto: "#a855f7", Guided: "#ec4899", Loiter: "#06b6d4",
  RTL: "#ef4444", Circle: "#eab308", Land: "#f43f5e",
  Drift: "#84cc16", Sport: "#14b8a6", Flip: "#f59e0b",
  AutoTune: "#6366f1", PosHold: "#8b5cf6", Brake: "#dc2626",
  Throw: "#d946ef", SmartRTL: "#fb923c", Follow: "#2dd4bf",
  ZigZag: "#a3e635",
};

export function getModeColor(mode: string): string {
  return MODE_COLORS[mode] || "#6b7280";
}

/**
 * Extract flight mode timeline segments from parsed messages.
 * Handles both text format (Mode is string) and binary format (Mode is number + asText).
 */
export function extractFlightModes(
  parsedMessages: Record<string, any>
): FlightModeSegment[] {
  const modeMsg = parsedMessages.MODE;
  if (!modeMsg || !modeMsg.time_boot_ms || modeMsg.time_boot_ms.length === 0) return [];

  const times = modeMsg.time_boot_ms;
  const modes = modeMsg.Mode;
  const modeNums = modeMsg.ModeNum;
  const asText = modeMsg.asText; // binary format provides this

  if (!modes || modes.length === 0) return [];

  // Find the global time range from all messages
  let globalMinTime = Infinity;
  let globalMaxTime = -Infinity;
  for (const key of Object.keys(parsedMessages)) {
    const msg = parsedMessages[key];
    if (msg?.time_boot_ms && msg.time_boot_ms.length > 0) {
      const first = msg.time_boot_ms[0];
      const last = msg.time_boot_ms[msg.time_boot_ms.length - 1];
      if (Number.isFinite(first) && first < globalMinTime) globalMinTime = first;
      if (Number.isFinite(last) && last > globalMaxTime) globalMaxTime = last;
    }
  }
  if (globalMinTime === Infinity) globalMinTime = times[0];
  if (globalMaxTime === -Infinity) globalMaxTime = times[times.length - 1];

  const segments: FlightModeSegment[] = [];

  for (let i = 0; i < modes.length; i++) {
    let modeName: string;
    let modeNum: number;

    if (typeof modes[i] === "string") {
      // Text format: Mode is already a string
      modeName = modes[i];
      modeNum = modeNums?.[i] ?? 0;
    } else {
      // Binary format: Mode is a number, use asText or COPTER_MODES lookup
      modeNum = modes[i];
      modeName = asText?.[i] || COPTER_MODES[modeNum] || `Mode ${modeNum}`;
    }

    const startMs = times[i];
    const endMs = i < modes.length - 1 ? times[i + 1] : globalMaxTime;

    segments.push({
      mode: modeName,
      modeNum,
      startTime: (startMs - globalMinTime) / 1000, // relative seconds
      endTime: (endMs - globalMinTime) / 1000,
      duration: (endMs - startMs) / 1000,
    });
  }

  return segments;
}

// ─── GPS Ground Track Extraction ─────────────────────────

export interface GpsTrackPoint {
  lat: number;
  lng: number;
  alt: number;
  speed: number;
  time: number; // seconds from log start
}

/**
 * Extract GPS ground track from parsed messages.
 * Handles both text format (degrees) and binary format (1e-7 degrees).
 */
export function extractGpsTrack(
  parsedMessages: Record<string, any>
): GpsTrackPoint[] {
  // Find GPS message (may be GPS or GPS[0])
  const gpsKey = resolveMessageKey("GPS", parsedMessages);
  if (!gpsKey) return [];

  const gps = parsedMessages[gpsKey];
  if (!gps || !gps.Lat || !gps.Lng || !gps.time_boot_ms) return [];

  const points: GpsTrackPoint[] = [];
  const len = Math.min(gps.Lat.length, gps.Lng.length, gps.time_boot_ms.length);

  // Detect if coordinates are in 1e-7 degrees (binary format) or degrees (text format)
  // Binary format values are typically > 1e6 for lat/lng
  const firstLat = gps.Lat[0];
  const isRawInt = Math.abs(firstLat) > 1e6;
  const scale = isRawInt ? 1e-7 : 1;

  // Find global min time for relative timestamps
  let globalMinTime = Infinity;
  for (const key of Object.keys(parsedMessages)) {
    const msg = parsedMessages[key];
    if (msg?.time_boot_ms && msg.time_boot_ms.length > 0) {
      const first = msg.time_boot_ms[0];
      if (Number.isFinite(first) && first < globalMinTime) globalMinTime = first;
    }
  }
  if (globalMinTime === Infinity) globalMinTime = gps.time_boot_ms[0];

  // Downsample for large datasets (max 5000 points for map performance)
  const step = Math.max(1, Math.floor(len / 5000));

  for (let i = 0; i < len; i += step) {
    const lat = gps.Lat[i] * scale;
    const lng = gps.Lng[i] * scale;

    // Skip invalid coordinates
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) continue;

    points.push({
      lat,
      lng,
      alt: gps.Alt?.[i] ?? 0,
      speed: gps.Spd?.[i] ?? 0,
      time: (gps.time_boot_ms[i] - globalMinTime) / 1000,
    });
  }

  return points;
}

/**
 * Format time in seconds to MM:SS or HH:MM:SS
 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Gradient Polyline Color Utilities ──────────────────────────

export type TrackColorMode = "plain" | "altitude" | "speed";

/**
 * Gradient stop definition for color interpolation.
 * position is 0..1, color is [r, g, b] each 0..255.
 */
interface GradientStop {
  position: number;
  color: [number, number, number];
}

// Altitude gradient: blue (low) → green (mid) → yellow → red (high)
const ALTITUDE_GRADIENT: GradientStop[] = [
  { position: 0.0, color: [59, 130, 246] },   // blue-500
  { position: 0.33, color: [34, 197, 94] },    // green-500
  { position: 0.66, color: [234, 179, 8] },    // yellow-500
  { position: 1.0, color: [239, 68, 68] },     // red-500
];

// Speed gradient: green (slow) → yellow (mid) → orange → red (fast)
const SPEED_GRADIENT: GradientStop[] = [
  { position: 0.0, color: [34, 197, 94] },     // green-500
  { position: 0.33, color: [234, 179, 8] },     // yellow-500
  { position: 0.66, color: [249, 115, 22] },    // orange-500
  { position: 1.0, color: [239, 68, 68] },      // red-500
];

/**
 * Interpolate a color from a gradient based on a normalized value (0..1).
 * Returns a hex color string.
 */
export function interpolateGradientColor(
  value: number,
  gradient: GradientStop[]
): string {
  // Clamp to 0..1
  const t = Math.max(0, Math.min(1, value));

  // Find the two stops to interpolate between
  let lower = gradient[0];
  let upper = gradient[gradient.length - 1];

  for (let i = 0; i < gradient.length - 1; i++) {
    if (t >= gradient[i].position && t <= gradient[i + 1].position) {
      lower = gradient[i];
      upper = gradient[i + 1];
      break;
    }
  }

  // Calculate local interpolation factor
  const range = upper.position - lower.position;
  const localT = range === 0 ? 0 : (t - lower.position) / range;

  // Interpolate RGB
  const r = Math.round(lower.color[0] + (upper.color[0] - lower.color[0]) * localT);
  const g = Math.round(lower.color[1] + (upper.color[1] - lower.color[1]) * localT);
  const b = Math.round(lower.color[2] + (upper.color[2] - lower.color[2]) * localT);

  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/**
 * Get the color for a GPS track segment based on the color mode.
 * Returns a hex color string for the segment between point[i] and point[i+1].
 * Uses the average of the two points' values for smoother transitions.
 */
export function getTrackSegmentColor(
  track: GpsTrackPoint[],
  index: number,
  mode: TrackColorMode,
  minAlt: number,
  maxAlt: number,
  maxSpeed: number
): string {
  if (mode === "plain") return "#3b82f6";

  const p1 = track[index];
  const p2 = index + 1 < track.length ? track[index + 1] : p1;

  if (mode === "altitude") {
    const avgAlt = (p1.alt + p2.alt) / 2;
    const range = maxAlt - minAlt;
    const normalized = range === 0 ? 0.5 : (avgAlt - minAlt) / range;
    return interpolateGradientColor(normalized, ALTITUDE_GRADIENT);
  }

  if (mode === "speed") {
    const avgSpeed = (p1.speed + p2.speed) / 2;
    const normalized = maxSpeed === 0 ? 0 : avgSpeed / maxSpeed;
    return interpolateGradientColor(normalized, SPEED_GRADIENT);
  }

  return "#3b82f6";
}

/**
 * Generate an array of CSS gradient stops for a legend bar.
 * Returns a CSS linear-gradient string.
 */
export function getGradientLegendCss(mode: TrackColorMode): string {
  if (mode === "plain") return "linear-gradient(to right, #3b82f6, #3b82f6)";

  const gradient = mode === "altitude" ? ALTITUDE_GRADIENT : SPEED_GRADIENT;
  const stops = gradient
    .map((s) => {
      const hex = `#${s.color[0].toString(16).padStart(2, "0")}${s.color[1].toString(16).padStart(2, "0")}${s.color[2].toString(16).padStart(2, "0")}`;
      return `${hex} ${(s.position * 100).toFixed(0)}%`;
    })
    .join(", ");

  return `linear-gradient(to right, ${stops})`;
}

// ─── Time Range Filtering ───────────────────────────────────────

/**
 * Represents a time range filter applied from the flight mode timeline or brush selection.
 */
export interface TimeFilter {
  /** Start time in seconds (relative to flight start) */
  startTime: number;
  /** End time in seconds (relative to flight start) */
  endTime: number;
  /** The flight mode name that was clicked (empty string for brush selections) */
  mode: string;
  /** Index of the segment in the flight modes array (-1 for brush selections) */
  segmentIndex: number;
  /** Source of the filter: 'mode' for mode-based, 'brush' for chart brush selection */
  source?: "mode" | "brush";
}

/**
 * Filter chart data to only include points within a time range.
 * Chart data arrays have a `time` field (seconds since flight start).
 * Returns a new array with only the points within [startTime, endTime].
 * Includes a small margin (1%) on each side for visual continuity.
 */
export function filterChartDataByTimeRange(
  data: Array<Record<string, number>>,
  filter: TimeFilter | null
): Array<Record<string, number>> {
  if (!filter) return data;
  if (data.length === 0) return data;

  const duration = filter.endTime - filter.startTime;
  const margin = duration * 0.01; // 1% margin for visual continuity
  const start = filter.startTime - margin;
  const end = filter.endTime + margin;

  return data.filter((point) => {
    const t = point.time;
    return t >= start && t <= end;
  });
}
