/**
 * Flight log chart definitions.
 * Maps ArduPilot DataFlash message types to Recharts chart configurations.
 * Ported from the Python Flight-Log-Analyser plot definitions.
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
  messageType: string; // primary message type to parse
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
    description: "Number of satellites and HDOP",
    messageType: "GPA",
    additionalMessages: ["GPS"],
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
    description: "Accelerometer clipping events",
    messageType: "VIBE",
    fields: [
      { key: "Clip0", label: "Clip Count 0", color: COLORS.red },
      { key: "Clip1", label: "Clip Count 1", color: COLORS.green },
      { key: "Clip2", label: "Clip Count 2", color: COLORS.blue },
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
 */
export function getAvailableCharts(
  availableMessageTypes: Record<string, unknown>
): ChartDefinition[] {
  return CHART_DEFINITIONS.filter((chart) => {
    // Primary message type must exist
    if (!availableMessageTypes[chart.messageType]) return false;
    // Additional messages must also exist if specified
    if (chart.additionalMessages) {
      return chart.additionalMessages.every((msg) => availableMessageTypes[msg]);
    }
    return true;
  });
}

/**
 * Convert parsed DataFlash data to Recharts-compatible array format.
 * Downsamples large datasets to maxPoints for performance.
 */
export function toChartData(
  parsedMessages: Record<string, any>,
  chart: ChartDefinition,
  maxPoints: number = 2000
): Array<Record<string, number>> {
  const msgData = parsedMessages[chart.messageType];
  if (!msgData || !msgData.time_boot_ms) return [];

  const timeArray = msgData.time_boot_ms;
  const totalPoints = timeArray.length;

  // Determine downsample step
  const step = Math.max(1, Math.floor(totalPoints / maxPoints));

  const data: Array<Record<string, number>> = [];

  for (let i = 0; i < totalPoints; i += step) {
    const point: Record<string, number> = {
      time: timeArray[i] / 1000, // Convert ms to seconds
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
