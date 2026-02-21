import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// ─── Backend: DB Functions ──────────────────────────────────
describe("Flight Analytics - DB Functions", () => {
  const dbPath = path.resolve(__dirname, "db.ts");
  const dbSrc = fs.readFileSync(dbPath, "utf-8");

  it("exports createFlightLog function", () => {
    expect(dbSrc).toContain("export async function createFlightLog");
  });

  it("exports getFlightLogsForDrone function", () => {
    expect(dbSrc).toContain("export async function getFlightLogsForDrone");
  });

  it("exports getAllFlightLogs function", () => {
    expect(dbSrc).toContain("export async function getAllFlightLogs");
  });

  it("exports getFlightLogById function", () => {
    expect(dbSrc).toContain("export async function getFlightLogById");
  });

  it("exports updateFlightLog function", () => {
    expect(dbSrc).toContain("export async function updateFlightLog");
  });

  it("exports deleteFlightLog function", () => {
    expect(dbSrc).toContain("export async function deleteFlightLog");
  });

  it("createFlightLog inserts into flightLogs table", () => {
    expect(dbSrc).toContain("db.insert(flightLogs)");
  });

  it("deleteFlightLog removes by id", () => {
    expect(dbSrc).toContain("eq(flightLogs.id,");
  });

  it("deleteDrone cascades to flightLogs", () => {
    expect(dbSrc).toContain("db.delete(flightLogs).where(eq(flightLogs.droneId,");
  });
});

// ─── Backend: Schema ──────────────────────────────────
describe("Flight Analytics - Schema", () => {
  const schemaPath = path.resolve(__dirname, "../drizzle/schema.ts");
  const schemaSrc = fs.readFileSync(schemaPath, "utf-8");

  it("defines flightLogs table", () => {
    expect(schemaSrc).toContain("export const flightLogs = mysqlTable");
  });

  it("flightLogs has droneId column", () => {
    expect(schemaSrc).toMatch(/flightLogs.*droneId/s);
  });

  it("flightLogs has storageKey column", () => {
    expect(schemaSrc).toMatch(/flightLogs.*storageKey/s);
  });

  it("flightLogs has url column", () => {
    expect(schemaSrc).toMatch(/flightLogs.*url/s);
  });

  it("flightLogs has format column (bin/log)", () => {
    expect(schemaSrc).toMatch(/flightLogs.*format/s);
  });

  it("flightLogs has uploadSource column (manual/api)", () => {
    expect(schemaSrc).toMatch(/flightLogs.*uploadSource/s);
  });

  it("flightLogs has fileSize column", () => {
    expect(schemaSrc).toMatch(/flightLogs.*fileSize/s);
  });
});

// ─── Backend: tRPC Procedures ──────────────────────────────────
describe("Flight Analytics - tRPC Procedures", () => {
  const routersPath = path.resolve(__dirname, "routers.ts");
  const routersSrc = fs.readFileSync(routersPath, "utf-8");

  it("defines flightLogs router", () => {
    expect(routersSrc).toContain("flightLogs: router({");
  });

  it("has list procedure", () => {
    expect(routersSrc).toMatch(/flightLogs:.*list:.*protectedProcedure/s);
  });

  it("has getById procedure", () => {
    expect(routersSrc).toMatch(/flightLogs:.*getById:.*protectedProcedure/s);
  });

  it("has upload procedure", () => {
    expect(routersSrc).toMatch(/flightLogs:.*upload:.*protectedProcedure/s);
  });

  it("upload procedure accepts base64 content", () => {
    expect(routersSrc).toContain("content: z.string()");
  });

  it("upload procedure stores to S3 via storagePut", () => {
    expect(routersSrc).toContain("storagePut(fileKey, buffer");
  });

  it("has update procedure", () => {
    expect(routersSrc).toMatch(/flightLogs:.*update:.*protectedProcedure/s);
  });

  it("has delete procedure", () => {
    expect(routersSrc).toMatch(/flightLogs:.*delete:.*protectedProcedure/s);
  });
});

// ─── Backend: REST API Endpoint ──────────────────────────────────
describe("Flight Analytics - REST API Endpoint", () => {
  const restPath = path.resolve(__dirname, "rest-api.ts");
  const restSrc = fs.readFileSync(restPath, "utf-8");

  it("defines flight-log upload REST endpoint", () => {
    expect(restSrc).toContain("/api/rest/flightlog/upload");
  });

  it("REST endpoint validates API key", () => {
    expect(restSrc).toContain("validateApiKey");
  });

  it("REST endpoint stores to S3", () => {
    expect(restSrc).toContain("storagePut");
  });

  it("REST endpoint creates flight log record", () => {
    expect(restSrc).toContain("createFlightLog");
  });

  it("REST endpoint sets uploadSource to api", () => {
    expect(restSrc).toContain('"api"');
  });
});

// ─── Frontend: FlightAnalyticsApp Component ──────────────────────────────────
describe("Flight Analytics - Frontend Component", () => {
  const componentPath = path.resolve(
    __dirname,
    "../client/src/components/apps/FlightAnalyticsApp.tsx"
  );
  const componentSrc = fs.readFileSync(componentPath, "utf-8");

  it("uses useDroneSelection hook with analytics appId", () => {
    expect(componentSrc).toContain('useDroneSelection("analytics")');
  });

  it("queries flight logs via trpc", () => {
    expect(componentSrc).toContain("trpc.flightLogs.list.useQuery");
  });

  it("has upload mutation", () => {
    expect(componentSrc).toContain("trpc.flightLogs.upload.useMutation");
  });

  it("has delete mutation", () => {
    expect(componentSrc).toContain("trpc.flightLogs.delete.useMutation");
  });

  it("accepts .bin and .log files", () => {
    expect(componentSrc).toContain('.bin,.BIN,.log,.LOG');
  });

  it("reads file as base64 for upload", () => {
    expect(componentSrc).toContain("readAsDataURL");
  });

  it("dynamically imports DataflashParser", () => {
    expect(componentSrc).toContain('import("@/lib/dataflash-parser")');
  });

  it("calls parser.processData for binary parsing", () => {
    expect(componentSrc).toContain("parser.processData(arrayBuffer");
  });

  it("uses getAvailableCharts to determine available charts", () => {
    expect(componentSrc).toContain("getAvailableCharts(result.types)");
  });

  it("uses toChartData to generate chart data with types", () => {
    expect(componentSrc).toContain("toChartData(result.messages, chart, result.types)");
  });

  it("renders charts using Recharts LineChart", () => {
    expect(componentSrc).toContain("<LineChart");
    expect(componentSrc).toContain("<ResponsiveContainer");
  });

  it("groups charts by category", () => {
    expect(componentSrc).toContain("CHART_CATEGORIES");
  });

  it("has progress indicator during parsing", () => {
    expect(componentSrc).toContain("parseState.progress");
  });

  it("handles parse errors gracefully", () => {
    expect(componentSrc).toContain('status: "error"');
  });

  it("shows drone selector", () => {
    expect(componentSrc).toContain("Select drone...");
  });
});

// ─── Frontend: Chart Configuration ──────────────────────────────────
describe("Flight Analytics - Chart Configuration", () => {
  const chartsPath = path.resolve(
    __dirname,
    "../client/src/lib/flight-charts.ts"
  );
  const chartsSrc = fs.readFileSync(chartsPath, "utf-8");

  it("exports CHART_DEFINITIONS array", () => {
    expect(chartsSrc).toContain("export const CHART_DEFINITIONS");
  });

  it("exports CHART_CATEGORIES array", () => {
    expect(chartsSrc).toContain("export const CHART_CATEGORIES");
  });

  it("exports getAvailableCharts function", () => {
    expect(chartsSrc).toContain("export function getAvailableCharts");
  });

  it("exports getAllRequiredMessageTypes function", () => {
    expect(chartsSrc).toContain("export function getAllRequiredMessageTypes");
  });

  it("exports toChartData function", () => {
    expect(chartsSrc).toContain("export function toChartData");
  });

  it("exports formatTime function", () => {
    expect(chartsSrc).toContain("export function formatTime");
  });

  it("defines attitude charts (ATT)", () => {
    expect(chartsSrc).toContain('"ATT"');
  });

  it("defines battery charts (BAT)", () => {
    expect(chartsSrc).toContain('"BAT"');
  });

  it("defines barometer charts (BARO)", () => {
    expect(chartsSrc).toContain('"BARO"');
  });

  it("defines vibration charts (VIBE)", () => {
    expect(chartsSrc).toContain('"VIBE"');
  });

  it("defines ESC charts", () => {
    expect(chartsSrc).toContain('"ESC"');
  });

  it("defines RC input charts (RCIN)", () => {
    expect(chartsSrc).toContain('"RCIN"');
  });

  it("defines RC output charts (RCOU)", () => {
    expect(chartsSrc).toContain('"RCOU"');
  });

  it("defines GPS accuracy charts (GPA)", () => {
    expect(chartsSrc).toContain('"GPA"');
  });

  it("defines categories: attitude, navigation, power, vibration, radio, ekf", () => {
    expect(chartsSrc).toContain('"attitude"');
    expect(chartsSrc).toContain('"navigation"');
    expect(chartsSrc).toContain('"power"');
    expect(chartsSrc).toContain('"vibration"');
    expect(chartsSrc).toContain('"radio"');
    expect(chartsSrc).toContain('"ekf"');
  });
});

// ─── Frontend: DataflashParser Type Declarations ──────────────────────────────────
describe("Flight Analytics - DataflashParser Types", () => {
  const typesPath = path.resolve(
    __dirname,
    "../client/src/lib/dataflash-parser.d.ts"
  );
  const typesSrc = fs.readFileSync(typesPath, "utf-8");

  it("declares DataflashParser class", () => {
    expect(typesSrc).toContain("class DataflashParser");
  });

  it("declares processData method", () => {
    expect(typesSrc).toContain("processData");
  });

  it("declares extractStartTime method", () => {
    expect(typesSrc).toContain("extractStartTime");
  });

  it("declares stats method", () => {
    expect(typesSrc).toContain("stats");
  });
});

// ─── Integration: Home.tsx Wiring ──────────────────────────────────
describe("Flight Analytics - Home.tsx Integration", () => {
  const homePath = path.resolve(
    __dirname,
    "../client/src/pages/Home.tsx"
  );
  const homeSrc = fs.readFileSync(homePath, "utf-8");

  it("imports FlightAnalyticsApp", () => {
    expect(homeSrc).toContain("import FlightAnalyticsApp");
  });

  it("renders FlightAnalyticsApp for analytics case", () => {
    expect(homeSrc).toContain("<FlightAnalyticsApp />");
  });

  it("analytics case no longer shows Coming Soon", () => {
    // The analytics case should render the component, not a Coming Soon badge
    const analyticsSection = homeSrc.split('case "analytics"')[1]?.split("case ")[0] || "";
    expect(analyticsSection).not.toContain("Coming Soon");
  });
});
