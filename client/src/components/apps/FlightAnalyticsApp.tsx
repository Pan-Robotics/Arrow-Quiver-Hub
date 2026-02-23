import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { useDroneSelection } from "@/hooks/useDroneSelection";
import {
  CHART_DEFINITIONS,
  CHART_CATEGORIES,
  getAvailableCharts,
  getAllRequiredMessageTypes,
  toChartData,
  formatTime,
  extractFlightSummary,
  extractFlightModes,
  extractGpsTrack,
  getModeColor,
  chartDataToCsv,
  downloadCsv,
  getTrackSegmentColor,
  getGradientLegendCss,
  filterChartDataByTimeRange,
  type ChartDefinition,
  type FlightSummary,
  type FlightModeSegment,
  type GpsTrackPoint,
  type TrackColorMode,
  type TimeFilter,
} from "@/lib/flight-charts";
import { MapView } from "@/components/Map";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceArea,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  BarChart3,
  Upload,
  FileText,
  Loader2,
  Trash2,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Clock,
  HardDrive,
  RotateCw,
  Navigation,
  Battery,
  Activity,
  Radio,
  Brain,
  Download,
  Eye,
  Image,
  Timer,
  Mountain,
  Gauge,
  Zap,
  Satellite,
  Vibrate,
  Cog,
  MapPin,
  GitCompare,
  Plane,
  Palette,
  Filter,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";

// Category icon mapping
const categoryIcons: Record<string, React.ReactNode> = {
  attitude: <RotateCw className="h-4 w-4" />,
  navigation: <Navigation className="h-4 w-4" />,
  power: <Battery className="h-4 w-4" />,
  vibration: <Activity className="h-4 w-4" />,
  radio: <Radio className="h-4 w-4" />,
  ekf: <Brain className="h-4 w-4" />,
};

// LocalStorage persistence for active log
const ANALYTICS_STORAGE_KEY = "flight-analytics-state";

interface PersistedAnalyticsState {
  selectedLogId: number;
  droneId: string;
  activeTab: string;
}

function saveAnalyticsState(state: PersistedAnalyticsState) {
  try {
    localStorage.setItem(ANALYTICS_STORAGE_KEY, JSON.stringify(state));
  } catch { /* localStorage may be unavailable */ }
}

function loadAnalyticsState(): PersistedAnalyticsState | null {
  try {
    const raw = localStorage.getItem(ANALYTICS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.selectedLogId === "number" && typeof parsed.droneId === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function clearAnalyticsState() {
  try {
    localStorage.removeItem(ANALYTICS_STORAGE_KEY);
  } catch { /* localStorage may be unavailable */ }
}

interface ParseState {
  status: "idle" | "downloading" | "parsing" | "complete" | "error";
  progress: number;
  error?: string;
  availableCharts: ChartDefinition[];
  chartData: Record<string, Array<Record<string, number>>>;
  logStartTime?: Date;
  messageTypes?: Record<string, unknown>;
  stats?: Record<string, { count: number; msg_size: number; size: number }>;
  flightSummary?: FlightSummary;
  flightModes?: FlightModeSegment[];
  gpsTrack?: GpsTrackPoint[];
  parsedMessages?: Record<string, any>;
}

// Store for compare feature
interface CompareSlot {
  logId: number;
  filename: string;
  parseState: ParseState;
}

// ─── Module-level cache ──────────────────────────────────────
// Survives component unmount/remount (app switching) but not full page refresh.
// On page refresh, we fall back to localStorage logId and re-parse from S3.
interface AnalyticsCache {
  selectedLogId: number;
  droneId: string;
  activeTab: string;
  parseState: ParseState;
  timeFilter: TimeFilter | null;
  // Compare mode state
  compareMode?: boolean;
  compareSlotA?: CompareSlot | null;
  compareSlotB?: CompareSlot | null;
  compareTarget?: "A" | "B";
}

let _analyticsCache: AnalyticsCache | null = null;

export function getAnalyticsCache(): AnalyticsCache | null {
  return _analyticsCache;
}

export function setAnalyticsCache(cache: AnalyticsCache | null) {
  _analyticsCache = cache;
}

export function clearAnalyticsCache() {
  _analyticsCache = null;
}

export default function FlightAnalyticsApp() {
  const { selectedDrone, drones, setSelectedDrone, isLoading: dronesLoading } = useDroneSelection("analytics");

  // Flight log queries
  const logsQuery = trpc.flightLogs.list.useQuery(
    { droneId: selectedDrone || "" },
    { enabled: !!selectedDrone }
  );

  const uploadMutation = trpc.flightLogs.upload.useMutation({
    onSuccess: () => {
      logsQuery.refetch();
      toast.success("Flight log uploaded successfully");
      setUploadDialogOpen(false);
      setUploadFile(null);
      setUploadNotes("");
    },
    onError: (err) => toast.error(`Upload failed: ${err.message}`),
  });

  const deleteMutation = trpc.flightLogs.delete.useMutation({
    onSuccess: () => {
      logsQuery.refetch();
      toast.success("Flight log deleted");
      if (selectedLogId === deleteTargetId) {
        setSelectedLogId(null);
        setParseState({ status: "idle", progress: 0, availableCharts: [], chartData: {} });
        setTimeFilter(null);
        clearAnalyticsState();
        clearAnalyticsCache();
      }
      setDeleteTargetId(null);
    },
    onError: (err) => toast.error(`Delete failed: ${err.message}`),
  });

  // UI state
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadNotes, setUploadNotes] = useState("");

  // Restore from module-level cache (instant, survives app switch) or start idle.
  // We read the cache once during initialization via useState lazy initializers.
  const [selectedLogId, setSelectedLogId] = useState<number | null>(() => {
    const c = getAnalyticsCache();
    return c?.selectedLogId ?? null;
  });
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<string>(() => {
    const c = getAnalyticsCache();
    if (c) return c.activeTab;
    const persisted = loadAnalyticsState();
    return persisted?.activeTab || "charts";
  });
  const restoredRef = useRef(!!getAnalyticsCache()); // skip localStorage restore if cache hit
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>(
    Object.fromEntries(CHART_CATEGORIES.map((c) => [c.id, true]))
  );
  const [parseState, setParseState] = useState<ParseState>(() => {
    const c = getAnalyticsCache();
    return c?.parseState ?? { status: "idle", progress: 0, availableCharts: [], chartData: {} };
  });
  const [timeFilter, setTimeFilter] = useState<TimeFilter | null>(() => {
    const c = getAnalyticsCache();
    return c?.timeFilter ?? null;
  });

  // Compare flights state - restore from module-level cache for instant app-switch persistence
  const [compareMode, setCompareMode] = useState(() => {
    const c = getAnalyticsCache();
    return c?.compareMode ?? false;
  });
  const [compareSlotA, setCompareSlotA] = useState<CompareSlot | null>(() => {
    const c = getAnalyticsCache();
    return c?.compareSlotA ?? null;
  });
  const [compareSlotB, setCompareSlotB] = useState<CompareSlot | null>(() => {
    const c = getAnalyticsCache();
    return c?.compareSlotB ?? null;
  });
  const [compareTarget, setCompareTarget] = useState<"A" | "B">(() => {
    const c = getAnalyticsCache();
    return c?.compareTarget ?? "A";
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Persist state to both localStorage and module-level cache
  useEffect(() => {
    if (selectedDrone && (parseState.status === "complete" || compareMode)) {
      if (selectedLogId) {
        saveAnalyticsState({ selectedLogId, droneId: selectedDrone, activeTab });
      }
      setAnalyticsCache({
        selectedLogId: selectedLogId || 0,
        droneId: selectedDrone,
        activeTab,
        parseState,
        timeFilter,
        compareMode,
        compareSlotA,
        compareSlotB,
        compareTarget,
      });
    }
  }, [activeTab, selectedLogId, selectedDrone, parseState.status, parseState, timeFilter, compareMode, compareSlotA, compareSlotB, compareTarget]);

  // Pending restore state - set by the early useEffect, consumed by the later one
  const [pendingRestore, setPendingRestore] = useState<{ logId: number; url: string } | null>(null);

  // On mount: if we restored from module-level cache, ensure the drone selection matches
  useEffect(() => {
    const cache = getAnalyticsCache();
    if (cache && cache.parseState.status === "complete" && cache.droneId) {
      if (selectedDrone !== cache.droneId) {
        setSelectedDrone(cache.droneId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount only

  // Detect if we should restore persisted log from localStorage (page refresh fallback)
  // This only runs when the module-level cache was empty (restoredRef is false)
  useEffect(() => {
    if (restoredRef.current) return;
    if (!logsQuery.data || logsQuery.data.length === 0) return;
    if (parseState.status !== "idle") return;

    const persisted = loadAnalyticsState();
    if (!persisted) return;

    // Check if the persisted drone matches the current selection
    if (selectedDrone && persisted.droneId !== selectedDrone) return;

    // Check if the persisted log still exists in the list
    const logExists = logsQuery.data.some((l: any) => l.id === persisted.selectedLogId);
    if (!logExists) {
      clearAnalyticsState();
      return;
    }

    // If drone doesn't match current selection, switch to the persisted drone
    if (!selectedDrone && persisted.droneId) {
      setSelectedDrone(persisted.droneId);
    }

    restoredRef.current = true;

    // Queue the restore - will be consumed after handleAnalyze is defined
    // This is the only path that re-parses (page refresh scenario)
    const log = logsQuery.data.find((l: any) => l.id === persisted.selectedLogId);
    if (log) {
      setPendingRestore({ logId: persisted.selectedLogId, url: log.url || "" });
    }
  }, [logsQuery.data, selectedDrone, parseState.status, setSelectedDrone]);

  // Handle file selection
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const ext = file.name.toLowerCase();
      if (!ext.endsWith(".bin") && !ext.endsWith(".log")) {
        toast.error("Please select a .BIN or .log file");
        return;
      }
      setUploadFile(file);
      setUploadDialogOpen(true);
    }
  }, []);

  // Handle upload
  const handleUpload = useCallback(async () => {
    if (!uploadFile || !selectedDrone) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(",")[1];
      uploadMutation.mutate({
        droneId: selectedDrone,
        filename: uploadFile.name,
        content: base64,
        description: uploadNotes || undefined,
      });
    };
    reader.readAsDataURL(uploadFile);
  }, [uploadFile, selectedDrone, uploadNotes, uploadMutation]);

  // Core parse function - reusable for both normal and compare modes
  const parseFlightLog = useCallback(async (logId: number): Promise<ParseState> => {
    const state: ParseState = {
      status: "downloading",
      progress: 0,
      availableCharts: [],
      chartData: {},
    };

    try {
      // Download the binary file via server proxy
      const downloadResponse = await fetch(`/api/trpc/flightLogs.downloadBinary?input=${encodeURIComponent(JSON.stringify({ json: { id: logId } }))}`, {
        credentials: "include",
      });
      if (!downloadResponse.ok) throw new Error(`Failed to download log: ${downloadResponse.statusText}`);
      const downloadJson = await downloadResponse.json();
      const base64Data = downloadJson.result?.data?.json?.data;
      if (!base64Data) throw new Error("No binary data received from server");

      // Convert base64 back to ArrayBuffer
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const arrayBuffer = bytes.buffer;

      // Dynamically import the parser
      const { default: DataflashParser } = await import("@/lib/dataflash-parser");
      const parser = new DataflashParser(false);

      // Get all message types needed
      const requiredMsgs = getAllRequiredMessageTypes();
      const defaultMsgs = ["CMD", "MSG", "FILE", "MODE", "AHR2", "GPS", "POS", "PARM", "STAT", "EV"];
      const allMsgs = Array.from(new Set(requiredMsgs.concat(defaultMsgs)));

      // Parse the binary data
      const result = parser.processData(arrayBuffer, allMsgs);

      // Determine which charts have data
      const available = getAvailableCharts(result.types);

      // Generate chart data
      const chartData: Record<string, Array<Record<string, number>>> = {};
      for (const chart of available) {
        chartData[chart.id] = toChartData(result.messages, chart, result.types);
      }

      // Extract start time
      let logStartTime: Date | undefined;
      try {
        logStartTime = parser.extractStartTime();
      } catch { /* GPS time may not be available */ }

      // Get stats
      let stats: Record<string, { count: number; msg_size: number; size: number }> | undefined;
      try {
        stats = parser.stats();
      } catch { /* Stats may fail on some logs */ }

      // Extract flight summary, modes, and GPS track
      const flightSummary = extractFlightSummary(result.messages, logStartTime);
      const flightModes = extractFlightModes(result.messages);
      const gpsTrack = extractGpsTrack(result.messages);

      return {
        status: "complete",
        progress: 100,
        availableCharts: available,
        chartData,
        logStartTime,
        messageTypes: result.types,
        stats,
        flightSummary,
        flightModes,
        gpsTrack,
        parsedMessages: result.messages,
      };
    } catch (err: any) {
      return {
        status: "error",
        progress: 0,
        error: err.message || "Failed to parse flight log",
        availableCharts: [],
        chartData: {},
      };
    }
  }, []);

  // Parse a flight log - normal mode
  const handleAnalyze = useCallback(async (logId: number, _fileUrl: string) => {
    if (compareMode) {
      // In compare mode, load into the target slot
      const log = logsQuery.data?.find((l: any) => l.id === logId);
      const filename = log?.filename || `Log #${logId}`;

      if (compareTarget === "A") {
        setCompareSlotA({ logId, filename, parseState: { status: "parsing", progress: 50, availableCharts: [], chartData: {} } });
      } else {
        setCompareSlotB({ logId, filename, parseState: { status: "parsing", progress: 50, availableCharts: [], chartData: {} } });
      }

      const result = await parseFlightLog(logId);

      if (compareTarget === "A") {
        setCompareSlotA({ logId, filename, parseState: result });
        setCompareTarget("B"); // Auto-switch to slot B after loading A
      } else {
        setCompareSlotB({ logId, filename, parseState: result });
      }
      return;
    }

    setSelectedLogId(logId);
    setTimeFilter(null);
    setParseState({ status: "downloading", progress: 0, availableCharts: [], chartData: {} });

    setParseState((prev) => ({ ...prev, status: "downloading", progress: 10 }));

    try {
      // Download the binary file via server proxy
      const downloadResponse = await fetch(`/api/trpc/flightLogs.downloadBinary?input=${encodeURIComponent(JSON.stringify({ json: { id: logId } }))}`, {
        credentials: "include",
      });
      if (!downloadResponse.ok) throw new Error(`Failed to download log: ${downloadResponse.statusText}`);
      const downloadJson = await downloadResponse.json();
      const base64Data = downloadJson.result?.data?.json?.data;
      if (!base64Data) throw new Error("No binary data received from server");

      // Convert base64 back to ArrayBuffer
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const arrayBuffer = bytes.buffer;

      setParseState((prev) => ({ ...prev, status: "parsing", progress: 30 }));

      const { default: DataflashParser } = await import("@/lib/dataflash-parser");
      const parser = new DataflashParser(false);

      const requiredMsgs = getAllRequiredMessageTypes();
      const defaultMsgs = ["CMD", "MSG", "FILE", "MODE", "AHR2", "GPS", "POS", "PARM", "STAT", "EV"];
      const allMsgs = Array.from(new Set(requiredMsgs.concat(defaultMsgs)));

      setParseState((prev) => ({ ...prev, progress: 40 }));

      const result = parser.processData(arrayBuffer, allMsgs);

      setParseState((prev) => ({ ...prev, progress: 70 }));

      const available = getAvailableCharts(result.types);
      const chartData: Record<string, Array<Record<string, number>>> = {};
      for (const chart of available) {
        chartData[chart.id] = toChartData(result.messages, chart, result.types);
      }

      setParseState((prev) => ({ ...prev, progress: 85 }));

      let logStartTime: Date | undefined;
      try {
        logStartTime = parser.extractStartTime();
      } catch { /* GPS time may not be available */ }

      let stats: Record<string, { count: number; msg_size: number; size: number }> | undefined;
      try {
        stats = parser.stats();
      } catch { /* Stats may fail on some logs */ }

      const flightSummary = extractFlightSummary(result.messages, logStartTime);
      const flightModes = extractFlightModes(result.messages);
      const gpsTrack = extractGpsTrack(result.messages);

      setParseState({
        status: "complete",
        progress: 100,
        availableCharts: available,
        chartData,
        logStartTime,
        messageTypes: result.types,
        stats,
        flightSummary,
        flightModes,
        gpsTrack,
        parsedMessages: result.messages,
      });

      // Persist active log to localStorage and module-level cache
      if (selectedDrone) {
        saveAnalyticsState({ selectedLogId: logId, droneId: selectedDrone, activeTab });
        setAnalyticsCache({
          selectedLogId: logId,
          droneId: selectedDrone,
          activeTab,
          parseState: {
            status: "complete",
            progress: 100,
            availableCharts: available,
            chartData,
            logStartTime,
            messageTypes: result.types,
            stats,
            flightSummary,
            flightModes,
            gpsTrack,
            parsedMessages: result.messages,
          },
          timeFilter: null,
          compareMode,
          compareSlotA,
          compareSlotB,
          compareTarget,
        });
      }

      toast.success(`Parsed ${available.length} chart(s) from log`);
    } catch (err: any) {
      setParseState({
        status: "error",
        progress: 0,
        error: err.message || "Failed to parse flight log",
        availableCharts: [],
        chartData: {},
      });
      clearAnalyticsState();
      clearAnalyticsCache();
      toast.error(`Parse failed: ${err.message}`);
    }
  }, [compareMode, compareTarget, compareSlotA, compareSlotB, logsQuery.data, parseFlightLog, selectedDrone, activeTab]);

  // Consume pending restore after handleAnalyze is available
  useEffect(() => {
    if (pendingRestore) {
      handleAnalyze(pendingRestore.logId, pendingRestore.url);
      setPendingRestore(null);
    }
  }, [pendingRestore, handleAnalyze]);

  // Toggle category expansion
  const toggleCategory = useCallback((categoryId: string) => {
    setExpandedCategories((prev) => ({
      ...prev,
      [categoryId]: !prev[categoryId],
    }));
  }, []);

  // Group available charts by category
  const chartsByCategory = useMemo(() => {
    const groups: Record<string, ChartDefinition[]> = {};
    for (const chart of parseState.availableCharts) {
      if (!groups[chart.category]) groups[chart.category] = [];
      groups[chart.category].push(chart);
    }
    return groups;
  }, [parseState.availableCharts]);

  // Handle brush selection on any chart - applies a time filter to all charts
  const handleBrushSelect = useCallback((startTime: number, endTime: number) => {
    setTimeFilter({
      startTime,
      endTime,
      mode: "",
      segmentIndex: -1,
      source: "brush",
    });
  }, []);

  // Format file size
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const selectedLog = logsQuery.data?.find((l: any) => l.id === selectedLogId);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-card">
        <div className="flex items-center gap-3">
          <BarChart3 className="h-5 w-5 text-primary" />
          <h2 className="font-semibold text-lg">Flight Analytics</h2>
        </div>
        <div className="flex items-center gap-2">
          {/* Compare toggle */}
          <Button
            variant={compareMode ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setCompareMode(!compareMode);
              if (!compareMode) {
                setCompareSlotA(null);
                setCompareSlotB(null);
                setCompareTarget("A");
              }
            }}
          >
            <GitCompare className="h-4 w-4 mr-1" />
            Compare
          </Button>
          {/* Drone selector */}
          <Select
            value={selectedDrone || ""}
            onValueChange={setSelectedDrone}
            disabled={dronesLoading}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Select drone" />
            </SelectTrigger>
            <SelectContent>
              {drones.map((d: any) => (
                <SelectItem key={d.droneId} value={d.droneId}>
                  {d.name || d.droneId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Compare mode indicator */}
      {compareMode && (
        <div className="px-4 py-2 border-b bg-blue-500/10 text-sm flex items-center gap-3">
          <GitCompare className="h-4 w-4 text-blue-500" />
          <span className="text-blue-500 font-medium">Compare Mode</span>
          <span className="text-muted-foreground">—</span>
          <button
            className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
              compareTarget === "A" ? "bg-blue-500 text-white" : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
            onClick={() => setCompareTarget("A")}
          >
            Slot A: {compareSlotA?.filename || "Click a log"}
          </button>
          <span className="text-muted-foreground">vs</span>
          <button
            className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
              compareTarget === "B" ? "bg-orange-500 text-white" : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
            onClick={() => setCompareTarget("B")}
          >
            Slot B: {compareSlotB?.filename || "Click a log"}
          </button>
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar - log list */}
        <div className="w-72 border-r bg-card flex flex-col">
          <div className="p-3 border-b">
            <Button
              size="sm"
              className="w-full"
              onClick={() => fileInputRef.current?.click()}
              disabled={!selectedDrone}
            >
              <Upload className="h-4 w-4 mr-1" />
              Upload Log
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".bin,.BIN,.log,.LOG"
              className="hidden"
              onChange={handleFileSelect}
            />
          </div>

          <div className="flex-1 overflow-y-auto">
            {logsQuery.isLoading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {logsQuery.data?.length === 0 && (
              <div className="text-center py-8 px-4 text-muted-foreground text-sm">
                <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No flight logs yet</p>
                <p className="text-xs mt-1">Upload a .BIN or .log file to get started</p>
              </div>
            )}
            {logsQuery.data?.map((log: any) => (
              <div
                key={log.id}
                className={`p-3 border-b cursor-pointer hover:bg-accent/50 transition-colors ${
                  selectedLogId === log.id && !compareMode ? "bg-accent" : ""
                } ${compareSlotA?.logId === log.id ? "ring-2 ring-inset ring-blue-500" : ""} ${
                  compareSlotB?.logId === log.id ? "ring-2 ring-inset ring-orange-500" : ""
                }`}
              >
                <div className="flex items-start justify-between">
                  <div
                    className="flex-1 min-w-0"
                    onClick={() => handleAnalyze(log.id, log.fileUrl)}
                  >
                    <p className="text-sm font-medium truncate">{log.filename}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {new Date(log.createdAt).toLocaleDateString()} · {formatSize(log.fileSize || 0)}
                    </p>
                    {log.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{log.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 ml-2 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAnalyze(log.id, log.fileUrl);
                      }}
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTargetId(log.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right content - analysis view */}
        <div className="flex-1 overflow-y-auto">
          {/* Compare mode view */}
          {compareMode ? (
            <CompareView slotA={compareSlotA} slotB={compareSlotB} />
          ) : (
            <>
              {parseState.status === "idle" && (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  <div className="text-center">
                    <BarChart3 className="h-16 w-16 mx-auto mb-4 opacity-30" />
                    <p className="text-lg font-medium">Select a flight log to analyze</p>
                    <p className="text-sm mt-1">Choose a log from the sidebar or upload a new one</p>
                  </div>
                </div>
              )}

              {(parseState.status === "downloading" || parseState.status === "parsing") && (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <Loader2 className="h-12 w-12 mx-auto mb-4 animate-spin text-primary" />
                    <p className="text-lg font-medium">
                      {parseState.status === "downloading" ? "Downloading log..." : "Parsing flight data..."}
                    </p>
                    <div className="w-64 mx-auto mt-4 bg-muted rounded-full h-2">
                      <div
                        className="bg-primary h-2 rounded-full transition-all duration-300"
                        style={{ width: `${parseState.progress}%` }}
                      />
                    </div>
                    <p className="text-sm text-muted-foreground mt-2">{parseState.progress}%</p>
                  </div>
                </div>
              )}

              {parseState.status === "error" && (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <AlertCircle className="h-12 w-12 mx-auto mb-4 text-destructive" />
                    <p className="text-lg font-medium">Parse Error</p>
                    <p className="text-sm text-muted-foreground mt-1">{parseState.error}</p>
                    <Button
                      variant="outline"
                      className="mt-4"
                      onClick={() => {
                        setParseState({ status: "idle", progress: 0, availableCharts: [], chartData: {} });
                        setTimeFilter(null);
                        clearAnalyticsState();
                        clearAnalyticsCache();
                      }}
                    >
                      Try Again
                    </Button>
                  </div>
                </div>
              )}

              {parseState.status === "complete" && (
                <div className="p-4 space-y-4">
                  {/* Summary card */}
                  <Card>
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <CardTitle className="text-base flex items-center gap-2">
                            <CheckCircle2 className="h-4 w-4 text-green-500" />
                            Analysis Complete
                          </CardTitle>
                          <CardDescription>
                            {selectedLog?.filename} — {parseState.availableCharts.length} charts available
                          </CardDescription>
                        </div>
                        <div className="flex items-center gap-2">
                          {parseState.logStartTime && (
                            <Badge variant="outline">
                              <Clock className="h-3 w-3 mr-1" />
                              {parseState.logStartTime.toLocaleString()}
                            </Badge>
                          )}
                          {parseState.stats && (
                            <Badge variant="outline">
                              <HardDrive className="h-3 w-3 mr-1" />
                              {Object.keys(parseState.stats).length} message types
                            </Badge>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                  </Card>

                  {/* Flight Summary Panel */}
                  {parseState.flightSummary && (
                    <FlightSummaryPanel summary={parseState.flightSummary} />
                  )}

                  {/* Tabbed view: Charts / Map / Timeline */}
                  <Tabs value={activeTab} onValueChange={setActiveTab}>
                    <TabsList>
                      <TabsTrigger value="charts" className="gap-1.5">
                        <BarChart3 className="h-3.5 w-3.5" />
                        Charts
                      </TabsTrigger>
                      {parseState.flightModes && parseState.flightModes.length > 0 && (
                        <TabsTrigger value="timeline" className="gap-1.5">
                          <Plane className="h-3.5 w-3.5" />
                          Flight Modes
                        </TabsTrigger>
                      )}
                      {parseState.gpsTrack && parseState.gpsTrack.length > 0 && (
                        <TabsTrigger value="map" className="gap-1.5">
                          <MapPin className="h-3.5 w-3.5" />
                          GPS Track
                        </TabsTrigger>
                      )}
                    </TabsList>

                    <TabsContent value="charts" className="mt-4 space-y-4">
                      {/* Flight Mode Timeline (compact, always visible above charts) */}
                      {parseState.flightModes && parseState.flightModes.length > 0 && (
                        <FlightModeTimeline
                          segments={parseState.flightModes}
                          compact
                          activeSegmentIndex={timeFilter?.segmentIndex ?? null}
                          onSegmentClick={(seg, idx) => {
                            if (timeFilter?.segmentIndex === idx) {
                              setTimeFilter(null);
                            } else {
                              setTimeFilter({
                                startTime: seg.startTime,
                                endTime: seg.endTime,
                                mode: seg.mode,
                                segmentIndex: idx,
                                source: "mode",
                              });
                            }
                          }}
                        />
                      )}

                      {/* Active filter banner */}
                      {timeFilter && (
                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/20">
                          {timeFilter.source === "brush" ? (
                            <ZoomIn className="h-4 w-4 text-primary shrink-0" />
                          ) : (
                            <Filter className="h-4 w-4 text-primary shrink-0" />
                          )}
                          <div className="flex items-center gap-1.5 text-sm flex-wrap">
                            {timeFilter.source === "brush" ? (
                              <>
                                <span className="text-muted-foreground">Zoomed to</span>
                                <Badge variant="secondary" className="text-xs">
                                  {formatTime(timeFilter.startTime)} – {formatTime(timeFilter.endTime)}
                                </Badge>
                                <span className="text-muted-foreground opacity-70">
                                  ({formatTime(timeFilter.endTime - timeFilter.startTime)})
                                </span>
                              </>
                            ) : (
                              <>
                                <span className="text-muted-foreground">Filtered to</span>
                                <Badge
                                  className="text-white text-xs"
                                  style={{ backgroundColor: getModeColor(timeFilter.mode) }}
                                >
                                  {timeFilter.mode}
                                </Badge>
                                <span className="text-muted-foreground">
                                  {formatTime(timeFilter.startTime)} – {formatTime(timeFilter.endTime)}
                                  <span className="ml-1 opacity-70">
                                    ({formatTime(timeFilter.endTime - timeFilter.startTime)})
                                  </span>
                                </span>
                              </>
                            )}
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="ml-auto h-7 px-2 text-xs gap-1"
                            onClick={() => setTimeFilter(null)}
                          >
                            {timeFilter.source === "brush" ? (
                              <ZoomOut className="h-3.5 w-3.5" />
                            ) : (
                              <X className="h-3.5 w-3.5" />
                            )}
                            {timeFilter.source === "brush" ? "Reset Zoom" : "Clear"}
                          </Button>
                        </div>
                      )}

                      {/* Brush zoom hint */}
                      {!timeFilter && parseState.availableCharts.length > 0 && (
                        <p className="text-xs text-muted-foreground/60 flex items-center gap-1.5 px-1">
                          <ZoomIn className="h-3 w-3" />
                          Click and drag on any chart to zoom into a time range
                        </p>
                      )}

                      {/* Charts by category */}
                      {CHART_CATEGORIES.map((category) => {
                        const charts = chartsByCategory[category.id];
                        if (!charts || charts.length === 0) return null;
                        const isExpanded = expandedCategories[category.id] ?? false;

                        return (
                          <div key={category.id}>
                            <button
                              className="flex items-center gap-2 w-full text-left py-2 px-1 hover:bg-accent/50 rounded-md transition-colors"
                              onClick={() => toggleCategory(category.id)}
                            >
                              {isExpanded ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                              {categoryIcons[category.id]}
                              <span className="font-medium text-sm">{category.label}</span>
                              <Badge variant="secondary" className="ml-auto text-xs">
                                {charts.length}
                              </Badge>
                            </button>

                            {isExpanded && (
                              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-2 mb-4">
                                {charts.map((chart) => (
                                  <FlightChart
                                    key={chart.id}
                                    chart={chart}
                                    data={filterChartDataByTimeRange(
                                      parseState.chartData[chart.id] || [],
                                      timeFilter
                                    )}
                                    logFilename={selectedLog?.filename}
                                    onBrushSelect={handleBrushSelect}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {parseState.availableCharts.length === 0 && (
                        <Card>
                          <CardContent className="py-8 text-center text-muted-foreground">
                            <AlertCircle className="h-8 w-8 mx-auto mb-2 opacity-50" />
                            <p>No recognized chart data found in this log file.</p>
                            <p className="text-sm mt-1">
                              The log may not contain the expected ArduPilot message types.
                            </p>
                          </CardContent>
                        </Card>
                      )}
                    </TabsContent>

                    {parseState.flightModes && parseState.flightModes.length > 0 && (
                      <TabsContent value="timeline" className="mt-4">
                        <FlightModeTimeline
                          segments={parseState.flightModes}
                          activeSegmentIndex={timeFilter?.segmentIndex ?? null}
                          onSegmentClick={(seg, idx) => {
                            if (timeFilter?.segmentIndex === idx) {
                              setTimeFilter(null);
                            } else {
                              setTimeFilter({
                                startTime: seg.startTime,
                                endTime: seg.endTime,
                                mode: seg.mode,
                                segmentIndex: idx,
                                source: "mode",
                              });
                              setActiveTab("charts");
                            }
                          }}
                        />
                      </TabsContent>
                    )}

                    {parseState.gpsTrack && parseState.gpsTrack.length > 0 && (
                      <TabsContent value="map" className="mt-4">
                        <GpsGroundTrack
                          track={parseState.gpsTrack}
                          flightModes={parseState.flightModes}
                        />
                      </TabsContent>
                    )}
                  </Tabs>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Upload dialog */}
      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Flight Log</DialogTitle>
            <DialogDescription>
              Upload an ArduPilot .BIN or .log file for analysis
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>File</Label>
              <div className="flex items-center gap-2 mt-1 p-3 border rounded-md bg-muted/50">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm truncate">{uploadFile?.name}</span>
                <Badge variant="outline" className="ml-auto text-xs">
                  {uploadFile ? formatSize(uploadFile.size) : ""}
                </Badge>
              </div>
            </div>
            <div>
              <Label>Drone</Label>
              <div className="flex items-center gap-2 mt-1 p-3 border rounded-md bg-muted/50">
                <span className="text-sm">
                  {drones.find((d: any) => d.droneId === selectedDrone)?.name || selectedDrone}
                </span>
              </div>
            </div>
            <div>
              <Label htmlFor="upload-notes">Notes (optional)</Label>
              <Input
                id="upload-notes"
                placeholder="e.g., Test flight #3, windy conditions"
                value={uploadNotes}
                onChange={(e) => setUploadNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleUpload} disabled={uploadMutation.isPending}>
              {uploadMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 mr-1" />
                  Upload
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteTargetId !== null} onOpenChange={() => setDeleteTargetId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Flight Log</DialogTitle>
            <DialogDescription>
              This will permanently delete the flight log and its data from storage. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTargetId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTargetId && deleteMutation.mutate({ id: deleteTargetId })}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 mr-1" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Flight Mode Timeline ──────────────────────────────────────
function FlightModeTimeline({
  segments,
  compact = false,
  onSegmentClick,
  activeSegmentIndex,
}: {
  segments: FlightModeSegment[];
  compact?: boolean;
  onSegmentClick?: (segment: FlightModeSegment, index: number) => void;
  activeSegmentIndex?: number | null;
}) {
  if (segments.length === 0) return null;

  const totalDuration = segments[segments.length - 1].endTime;
  if (totalDuration <= 0) return null;

  // Group segments by mode for the legend
  const modeStats = useMemo(() => {
    const stats: Record<string, { totalTime: number; count: number; color: string }> = {};
    for (const seg of segments) {
      if (!stats[seg.mode]) {
        stats[seg.mode] = { totalTime: 0, count: 0, color: getModeColor(seg.mode) };
      }
      stats[seg.mode].totalTime += seg.duration;
      stats[seg.mode].count++;
    }
    return Object.entries(stats).sort((a, b) => b[1].totalTime - a[1].totalTime);
  }, [segments]);

  if (compact) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Plane className="h-4 w-4 text-primary" />
            Flight Mode Timeline
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-3">
          {/* Compact timeline bar */}
          <div className="relative h-8 rounded-md overflow-hidden flex">
            {segments.map((seg, i) => {
              const widthPct = (seg.duration / totalDuration) * 100;
              if (widthPct < 0.5) return null; // Skip tiny segments
              const isActive = activeSegmentIndex === i;
              const isFiltered = activeSegmentIndex != null && activeSegmentIndex !== i;
              return (
                <div
                  key={i}
                  className={`relative h-full flex items-center justify-center overflow-hidden group transition-all ${
                    onSegmentClick ? "cursor-pointer hover:brightness-110" : "cursor-default"
                  } ${isActive ? "ring-2 ring-white ring-inset brightness-110 z-10" : ""} ${
                    isFiltered ? "opacity-40" : ""
                  }`}
                  style={{
                    width: `${widthPct}%`,
                    backgroundColor: getModeColor(seg.mode),
                    minWidth: widthPct > 3 ? undefined : "2px",
                  }}
                  title={`${onSegmentClick ? "Click to filter: " : ""}${seg.mode}: ${formatTime(seg.startTime)} – ${formatTime(seg.endTime)} (${formatTime(seg.duration)})`}
                  onClick={() => onSegmentClick?.(seg, i)}
                >
                  {widthPct > 8 && (
                    <span className="text-[10px] font-medium text-white truncate px-1">
                      {seg.mode}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {/* Compact legend */}
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
            {modeStats.map(([mode, stat]) => (
              <div key={mode} className="flex items-center gap-1 text-xs text-muted-foreground">
                <div
                  className="w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ backgroundColor: stat.color }}
                />
                <span>{mode}</span>
                <span className="opacity-60">({formatTime(stat.totalTime)})</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Full timeline view
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Plane className="h-4 w-4 text-primary" />
          Flight Mode Timeline
        </CardTitle>
        <CardDescription>
          {segments.length} mode change{segments.length !== 1 ? "s" : ""} over {formatTime(totalDuration)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Full timeline bar */}
        <div className="relative h-12 rounded-lg overflow-hidden flex shadow-inner">
          {segments.map((seg, i) => {
            const widthPct = (seg.duration / totalDuration) * 100;
            if (widthPct < 0.3) return null;
            const isActive = activeSegmentIndex === i;
            const isFiltered = activeSegmentIndex != null && activeSegmentIndex !== i;
            return (
              <div
                key={i}
                className={`relative h-full flex flex-col items-center justify-center overflow-hidden border-r border-white/10 last:border-r-0 transition-all ${
                  onSegmentClick ? "cursor-pointer hover:brightness-110" : ""
                } ${isActive ? "ring-2 ring-white ring-inset brightness-110 z-10" : ""} ${
                  isFiltered ? "opacity-40" : ""
                }`}
                style={{
                  width: `${widthPct}%`,
                  backgroundColor: getModeColor(seg.mode),
                  minWidth: widthPct > 2 ? undefined : "3px",
                }}
                title={`${onSegmentClick ? "Click to filter: " : ""}${seg.mode}: ${formatTime(seg.startTime)} – ${formatTime(seg.endTime)} (${formatTime(seg.duration)})`}
                onClick={() => onSegmentClick?.(seg, i)}
              >
                {widthPct > 6 && (
                  <>
                    <span className="text-xs font-bold text-white truncate px-1">{seg.mode}</span>
                    {widthPct > 12 && (
                      <span className="text-[10px] text-white/80 truncate px-1">
                        {formatTime(seg.duration)}
                      </span>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>

        {/* Time axis */}
        <div className="flex justify-between text-[10px] text-muted-foreground px-1">
          <span>0:00</span>
          <span>{formatTime(totalDuration / 4)}</span>
          <span>{formatTime(totalDuration / 2)}</span>
          <span>{formatTime((totalDuration * 3) / 4)}</span>
          <span>{formatTime(totalDuration)}</span>
        </div>

        {/* Mode details table */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {modeStats.map(([mode, stat]) => (
            <div
              key={mode}
              className="flex items-center gap-2 p-2 rounded-md bg-muted/50 border border-border/50"
            >
              <div
                className="w-3 h-3 rounded-sm shrink-0"
                style={{ backgroundColor: stat.color }}
              />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{mode}</p>
                <p className="text-xs text-muted-foreground">
                  {formatTime(stat.totalTime)} · {stat.count}x
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Segment list */}
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {segments.map((seg, i) => (
            <div
              key={i}
              className={`flex items-center gap-2 text-sm py-1 px-2 rounded transition-colors ${
                onSegmentClick ? "cursor-pointer hover:bg-accent" : "hover:bg-muted/50"
              } ${activeSegmentIndex === i ? "bg-accent ring-1 ring-primary" : ""} ${
                activeSegmentIndex != null && activeSegmentIndex !== i ? "opacity-50" : ""
              }`}
              onClick={() => onSegmentClick?.(seg, i)}
            >
              <div
                className="w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: getModeColor(seg.mode) }}
              />
              <span className="font-medium w-24 truncate">{seg.mode}</span>
              <span className="text-muted-foreground text-xs">
                {formatTime(seg.startTime)} → {formatTime(seg.endTime)}
              </span>
              <span className="text-muted-foreground text-xs ml-auto">
                {formatTime(seg.duration)}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── GPS Ground Track Map ──────────────────────────────────────
function GpsGroundTrack({
  track,
  flightModes,
}: {
  track: GpsTrackPoint[];
  flightModes?: FlightModeSegment[];
}) {
  const mapRef = useRef<any>(null);
  const polylinesRef = useRef<any[]>([]);
  const markersRef = useRef<any[]>([]);
  const [colorMode, setColorMode] = useState<TrackColorMode>("altitude");

  if (track.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <MapPin className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>No GPS data available</p>
        </CardContent>
      </Card>
    );
  }

  // Calculate center and bounds
  const center = useMemo(() => {
    let sumLat = 0, sumLng = 0;
    for (const p of track) {
      sumLat += p.lat;
      sumLng += p.lng;
    }
    return { lat: sumLat / track.length, lng: sumLng / track.length };
  }, [track]);

  // Stats
  const trackStats = useMemo(() => {
    let maxAlt = -Infinity, minAlt = Infinity, maxSpd = 0;
    for (const p of track) {
      if (p.alt > maxAlt) maxAlt = p.alt;
      if (p.alt < minAlt) minAlt = p.alt;
      if (p.speed > maxSpd) maxSpd = p.speed;
    }
    return {
      points: track.length,
      maxAlt: maxAlt === -Infinity ? 0 : maxAlt,
      minAlt: minAlt === Infinity ? 0 : minAlt,
      maxSpeed: maxSpd,
      duration: track.length > 0 ? track[track.length - 1].time - track[0].time : 0,
    };
  }, [track]);

  // Draw or redraw polylines when color mode changes
  const drawPolylines = useCallback((map: any, mode: TrackColorMode) => {
    if (!window.google?.maps || !map) return;

    // Clear existing polylines
    for (const pl of polylinesRef.current) {
      pl.setMap(null);
    }
    polylinesRef.current = [];

    const { minAlt, maxAlt, maxSpeed } = trackStats;

    if (mode === "plain") {
      // Single blue polyline for plain mode
      const path = track.map((p) => ({ lat: p.lat, lng: p.lng }));
      const polyline = new window.google.maps.Polyline({
        path,
        geodesic: true,
        strokeColor: "#3b82f6",
        strokeOpacity: 0.9,
        strokeWeight: 3,
        map,
      });
      polylinesRef.current.push(polyline);
    } else {
      // Segmented gradient polylines — one per pair of consecutive points
      for (let i = 0; i < track.length - 1; i++) {
        const color = getTrackSegmentColor(track, i, mode, minAlt, maxAlt, maxSpeed);
        const segment = new window.google.maps.Polyline({
          path: [
            { lat: track[i].lat, lng: track[i].lng },
            { lat: track[i + 1].lat, lng: track[i + 1].lng },
          ],
          geodesic: true,
          strokeColor: color,
          strokeOpacity: 0.9,
          strokeWeight: 3.5,
          map,
        });
        polylinesRef.current.push(segment);
      }
    }
  }, [track, trackStats]);

  // Redraw polylines when color mode changes
  useEffect(() => {
    if (mapRef.current) {
      drawPolylines(mapRef.current, colorMode);
    }
  }, [colorMode, drawPolylines]);

  const handleMapReady = useCallback((map: any) => {
    mapRef.current = map;

    if (!window.google?.maps) return;

    // Draw initial polylines
    drawPolylines(map, colorMode);

    // Add start marker (green)
    const startMarker = new window.google.maps.Marker({
      position: { lat: track[0].lat, lng: track[0].lng },
      map,
      title: "Start",
      icon: {
        path: window.google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: "#22c55e",
        fillOpacity: 1,
        strokeColor: "#fff",
        strokeWeight: 2,
      },
    });
    markersRef.current.push(startMarker);

    // Add end marker (red)
    const lastPt = track[track.length - 1];
    const endMarker = new window.google.maps.Marker({
      position: { lat: lastPt.lat, lng: lastPt.lng },
      map,
      title: "End",
      icon: {
        path: window.google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: "#ef4444",
        fillOpacity: 1,
        strokeColor: "#fff",
        strokeWeight: 2,
      },
    });
    markersRef.current.push(endMarker);

    // Fit bounds to show entire track
    const bounds = new window.google.maps.LatLngBounds();
    for (const p of track) {
      bounds.extend({ lat: p.lat, lng: p.lng });
    }
    map.fitBounds(bounds, 50);

    // Add mode change markers if available
    if (flightModes && flightModes.length > 1) {
      for (let i = 1; i < flightModes.length; i++) {
        const modeTime = flightModes[i].startTime;
        // Find the closest GPS point to this time
        let closestIdx = 0;
        let closestDiff = Infinity;
        for (let j = 0; j < track.length; j++) {
          const diff = Math.abs(track[j].time - modeTime);
          if (diff < closestDiff) {
            closestDiff = diff;
            closestIdx = j;
          }
        }
        const point = track[closestIdx];
        const marker = new window.google.maps.Marker({
          position: { lat: point.lat, lng: point.lng },
          map,
          title: `Mode: ${flightModes[i].mode} at ${formatTime(modeTime)}`,
          icon: {
            path: window.google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
            scale: 5,
            fillColor: getModeColor(flightModes[i].mode),
            fillOpacity: 1,
            strokeColor: "#fff",
            strokeWeight: 1,
            rotation: 0,
          },
        });
        markersRef.current.push(marker);
      }
    }
  }, [track, flightModes, drawPolylines, colorMode]);

  // Legend label for gradient
  const legendLabel = colorMode === "altitude"
    ? `${trackStats.minAlt.toFixed(0)}m — ${trackStats.maxAlt.toFixed(0)}m`
    : colorMode === "speed"
    ? `0 — ${trackStats.maxSpeed.toFixed(1)} m/s`
    : "";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <MapPin className="h-4 w-4 text-primary" />
              GPS Ground Track
            </CardTitle>
            <CardDescription>
              {trackStats.points} points · {formatTime(trackStats.duration)} duration
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              <Mountain className="h-3 w-3 mr-1" />
              Alt: {trackStats.minAlt.toFixed(0)}–{trackStats.maxAlt.toFixed(0)}m
            </Badge>
            <Badge variant="outline" className="text-xs">
              <Gauge className="h-3 w-3 mr-1" />
              Max: {trackStats.maxSpeed.toFixed(1)} m/s
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pb-3">
        {/* Color mode toggle */}
        <div className="flex items-center gap-2 mb-3">
          <Palette className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground font-medium">Color by:</span>
          <div className="flex rounded-md border overflow-hidden">
            {(["plain", "altitude", "speed"] as TrackColorMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setColorMode(mode)}
                className={`px-3 py-1 text-xs font-medium transition-colors ${
                  colorMode === mode
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:bg-muted"
                }`}
              >
                {mode === "plain" ? "Plain" : mode === "altitude" ? "Altitude" : "Speed"}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-lg overflow-hidden border">
          <MapView
            center={center}
            zoom={16}
            className="w-full h-[450px]"
            onMapReady={handleMapReady}
          />
        </div>

        {/* Gradient legend bar */}
        {colorMode !== "plain" && (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-medium whitespace-nowrap">
              {colorMode === "altitude" ? "Altitude" : "Speed"}:
            </span>
            <div className="flex-1 flex items-center gap-1">
              <span className="text-xs text-muted-foreground">
                {colorMode === "altitude" ? `${trackStats.minAlt.toFixed(0)}m` : "0"}
              </span>
              <div
                className="flex-1 h-3 rounded-full"
                style={{ background: getGradientLegendCss(colorMode) }}
              />
              <span className="text-xs text-muted-foreground">
                {colorMode === "altitude" ? `${trackStats.maxAlt.toFixed(0)}m` : `${trackStats.maxSpeed.toFixed(1)} m/s`}
              </span>
            </div>
          </div>
        )}

        {/* Marker legend */}
        <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full bg-green-500 border border-white" />
            <span>Start</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full bg-red-500 border border-white" />
            <span>End</span>
          </div>
          {flightModes && flightModes.length > 1 && (
            <div className="flex items-center gap-1">
              <div className="w-0 h-0 border-l-[5px] border-r-[5px] border-b-[8px] border-l-transparent border-r-transparent border-b-purple-500" />
              <span>Mode Changes</span>
            </div>
          )}
          {colorMode === "plain" && (
            <div className="flex items-center gap-1">
              <div className="w-6 h-0.5 bg-blue-500 rounded" />
              <span>Flight Path</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Compare Flights View ──────────────────────────────────────
function CompareView({
  slotA,
  slotB,
}: {
  slotA: CompareSlot | null;
  slotB: CompareSlot | null;
}) {
  const [selectedChart, setSelectedChart] = useState<string>("att-rp");

  // All hooks MUST be called before any early return to satisfy Rules of Hooks
  const commonCharts = useMemo(() => {
    if (!slotA?.parseState?.availableCharts || !slotB?.parseState?.availableCharts) {
      return slotA?.parseState?.availableCharts || slotB?.parseState?.availableCharts || [];
    }
    const bIds = new Set(slotB.parseState.availableCharts.map((c) => c.id));
    return slotA.parseState.availableCharts.filter((c) => bIds.has(c.id));
  }, [slotA, slotB]);

  const allCharts = useMemo(() => {
    const charts = new Map<string, ChartDefinition>();
    for (const c of slotA?.parseState?.availableCharts || []) charts.set(c.id, c);
    for (const c of slotB?.parseState?.availableCharts || []) charts.set(c.id, c);
    return Array.from(charts.values());
  }, [slotA, slotB]);

  const currentChart = allCharts.find((c) => c.id === selectedChart) || allCharts[0];

  if (!slotA && !slotB) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <GitCompare className="h-16 w-16 mx-auto mb-4 opacity-30" />
          <p className="text-lg font-medium">Compare Flights</p>
          <p className="text-sm mt-1">Click two flight logs from the sidebar to compare them side-by-side</p>
          <p className="text-xs mt-2 text-muted-foreground">
            Use the Slot A / Slot B buttons in the header to select which slot to load into
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* Compare summary cards */}
      <div className="grid grid-cols-2 gap-4">
        <CompareSlotCard slot={slotA} label="A" color="blue" />
        <CompareSlotCard slot={slotB} label="B" color="orange" />
      </div>

      {/* Summary comparison */}
      {slotA?.parseState?.flightSummary && slotB?.parseState?.flightSummary && (
        <CompareSummaryTable
          summaryA={slotA.parseState.flightSummary}
          summaryB={slotB.parseState.flightSummary}
          nameA={slotA.filename}
          nameB={slotB.filename}
        />
      )}

      {/* Chart selector and side-by-side charts */}
      {allCharts.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Side-by-Side Charts</CardTitle>
              <Select value={selectedChart} onValueChange={setSelectedChart}>
                <SelectTrigger className="w-[250px]">
                  <SelectValue placeholder="Select chart" />
                </SelectTrigger>
                <SelectContent>
                  {allCharts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {currentChart && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs font-medium text-blue-500 mb-2">
                    {slotA?.filename || "Slot A (empty)"}
                  </p>
                  {slotA?.parseState?.chartData?.[currentChart.id] ? (
                    <CompareChart
                      chart={currentChart}
                      data={slotA.parseState.chartData[currentChart.id]}
                    />
                  ) : (
                    <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm bg-muted/30 rounded-md">
                      No data
                    </div>
                  )}
                </div>
                <div>
                  <p className="text-xs font-medium text-orange-500 mb-2">
                    {slotB?.filename || "Slot B (empty)"}
                  </p>
                  {slotB?.parseState?.chartData?.[currentChart.id] ? (
                    <CompareChart
                      chart={currentChart}
                      data={slotB.parseState.chartData[currentChart.id]}
                    />
                  ) : (
                    <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm bg-muted/30 rounded-md">
                      No data
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function CompareSlotCard({
  slot,
  label,
  color,
}: {
  slot: CompareSlot | null;
  label: string;
  color: "blue" | "orange";
}) {
  const borderColor = color === "blue" ? "border-blue-500" : "border-orange-500";
  const textColor = color === "blue" ? "text-blue-500" : "text-orange-500";

  if (!slot) {
    return (
      <Card className={`border-2 border-dashed ${borderColor}/30`}>
        <CardContent className="py-6 text-center text-muted-foreground">
          <p className={`text-sm font-medium ${textColor}`}>Slot {label}</p>
          <p className="text-xs mt-1">Click a log from the sidebar</p>
        </CardContent>
      </Card>
    );
  }

  if (slot.parseState.status === "parsing") {
    return (
      <Card className={`border-2 ${borderColor}/50`}>
        <CardContent className="py-6 text-center">
          <Loader2 className={`h-6 w-6 mx-auto mb-2 animate-spin ${textColor}`} />
          <p className="text-sm">Parsing {slot.filename}...</p>
        </CardContent>
      </Card>
    );
  }

  if (slot.parseState.status === "error") {
    return (
      <Card className={`border-2 ${borderColor}/50`}>
        <CardContent className="py-4">
          <p className={`text-sm font-medium ${textColor}`}>Slot {label}: {slot.filename}</p>
          <p className="text-xs text-destructive mt-1">Error: {slot.parseState.error}</p>
        </CardContent>
      </Card>
    );
  }

  const summary = slot.parseState.flightSummary;

  return (
    <Card className={`border-2 ${borderColor}/50`}>
      <CardContent className="py-3">
        <div className="flex items-center gap-2 mb-2">
          <CheckCircle2 className="h-4 w-4 text-green-500" />
          <p className={`text-sm font-medium ${textColor}`}>Slot {label}: {slot.filename}</p>
        </div>
        {summary && (
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <span className="text-muted-foreground">Duration</span>
              <p className="font-medium">{summary.totalFlightTime ? formatTime(summary.totalFlightTime) : "—"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Max Alt</span>
              <p className="font-medium">{summary.maxAltitude?.toFixed(1) ?? "—"} m</p>
            </div>
            <div>
              <span className="text-muted-foreground">Max Speed</span>
              <p className="font-medium">{summary.maxSpeed?.toFixed(1) ?? "—"} m/s</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CompareSummaryTable({
  summaryA,
  summaryB,
  nameA,
  nameB,
}: {
  summaryA: FlightSummary;
  summaryB: FlightSummary;
  nameA: string;
  nameB: string;
}) {
  const fmt = (val: number | null, dec = 1, suffix = ""): string => {
    if (val === null || !Number.isFinite(val)) return "—";
    return `${val.toFixed(dec)}${suffix}`;
  };

  const rows = [
    { label: "Flight Duration", a: summaryA.totalFlightTime ? formatTime(summaryA.totalFlightTime) : "—", b: summaryB.totalFlightTime ? formatTime(summaryB.totalFlightTime) : "—" },
    { label: "Max Altitude", a: fmt(summaryA.maxAltitude, 1, " m"), b: fmt(summaryB.maxAltitude, 1, " m") },
    { label: "Max Speed", a: fmt(summaryA.maxSpeed, 1, " m/s"), b: fmt(summaryB.maxSpeed, 1, " m/s") },
    { label: "Avg Speed", a: fmt(summaryA.avgSpeed, 1, " m/s"), b: fmt(summaryB.avgSpeed, 1, " m/s") },
    { label: "Battery Start", a: fmt(summaryA.batteryStartVoltage, 1, " V"), b: fmt(summaryB.batteryStartVoltage, 1, " V") },
    { label: "Battery End", a: fmt(summaryA.batteryEndVoltage, 1, " V"), b: fmt(summaryB.batteryEndVoltage, 1, " V") },
    { label: "Battery Consumed", a: fmt(summaryA.batteryConsumed, 0, " mAh"), b: fmt(summaryB.batteryConsumed, 0, " mAh") },
    { label: "Max Current", a: fmt(summaryA.maxCurrent, 1, " A"), b: fmt(summaryB.maxCurrent, 1, " A") },
    { label: "Max Vibration", a: fmt(summaryA.maxVibration, 2, " m/s²"), b: fmt(summaryB.maxVibration, 2, " m/s²") },
    { label: "Max ESC RPM", a: summaryA.maxEscRpm ? Math.round(summaryA.maxEscRpm).toLocaleString() : "—", b: summaryB.maxEscRpm ? Math.round(summaryB.maxEscRpm).toLocaleString() : "—" },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <GitCompare className="h-4 w-4 text-primary" />
          Summary Comparison
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">Metric</th>
                <th className="text-right py-2 px-3 text-blue-500 font-medium truncate max-w-[150px]">{nameA}</th>
                <th className="text-right py-2 px-3 text-orange-500 font-medium truncate max-w-[150px]">{nameB}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="py-1.5 px-3 text-muted-foreground">{row.label}</td>
                  <td className="py-1.5 px-3 text-right font-medium">{row.a}</td>
                  <td className="py-1.5 px-3 text-right font-medium">{row.b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function CompareChart({
  chart,
  data,
}: {
  chart: ChartDefinition;
  data: Array<Record<string, number>>;
}) {
  if (data.length === 0) return null;

  const hasDualAxis = chart.fields.some((f) => f.yAxisId === "right");

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
        <XAxis
          dataKey="time"
          tickFormatter={formatTime}
          tick={{ fontSize: 9 }}
          interval="preserveStartEnd"
        />
        <YAxis
          yAxisId="left"
          tick={{ fontSize: 9 }}
        />
        {hasDualAxis && (
          <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 9 }} />
        )}
        <Tooltip
          labelFormatter={(val) => `Time: ${formatTime(val as number)}`}
          contentStyle={{ fontSize: 10 }}
        />
        {chart.fields.map((field) => (
          <Line
            key={field.key}
            type="monotone"
            dataKey={field.key}
            name={field.label}
            stroke={field.color}
            yAxisId={field.yAxisId || "left"}
            dot={false}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ─── Flight Summary Panel ──────────────────────────────────────
function FlightSummaryPanel({ summary }: { summary: FlightSummary }) {
  const fmtDuration = (seconds: number | null): string => {
    if (seconds === null || !Number.isFinite(seconds)) return "—";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const fmtNum = (val: number | null, decimals = 1, suffix = ""): string => {
    if (val === null || !Number.isFinite(val)) return "—";
    return `${val.toFixed(decimals)}${suffix}`;
  };

  const fmtInt = (val: number | null, suffix = ""): string => {
    if (val === null || !Number.isFinite(val)) return "—";
    return `${Math.round(val).toLocaleString()}${suffix}`;
  };

  const gpsFixLabel = (fix: number | null): string => {
    if (fix === null) return "—";
    const labels: Record<number, string> = {
      0: "No GPS", 1: "No Fix", 2: "2D Fix", 3: "3D Fix",
      4: "DGPS", 5: "RTK Float", 6: "RTK Fixed",
    };
    return labels[fix] || `Type ${fix}`;
  };

  const statCards: Array<{
    label: string;
    value: string;
    icon: React.ReactNode;
    color: string;
    subtext?: string;
  }> = [
    {
      label: "Flight Duration",
      value: fmtDuration(summary.totalFlightTime),
      icon: <Timer className="h-4 w-4" />,
      color: "text-blue-400",
      subtext: summary.logDuration !== null ? `Log: ${fmtDuration(summary.logDuration)}` : undefined,
    },
    {
      label: "Max Altitude",
      value: fmtNum(summary.maxAltitude, 1, " m"),
      icon: <Mountain className="h-4 w-4" />,
      color: "text-emerald-400",
      subtext: summary.maxGpsAltitude !== null ? `GPS: ${fmtNum(summary.maxGpsAltitude, 1, " m")}` : undefined,
    },
    {
      label: "Max Speed",
      value: fmtNum(summary.maxSpeed, 1, " m/s"),
      icon: <Gauge className="h-4 w-4" />,
      color: "text-orange-400",
      subtext: summary.avgSpeed !== null ? `Avg: ${fmtNum(summary.avgSpeed, 1, " m/s")}` : undefined,
    },
    {
      label: "Battery",
      value: summary.batteryConsumed !== null ? fmtNum(summary.batteryConsumed, 0, " mAh") : fmtNum(summary.batteryStartVoltage, 1, " V"),
      icon: <Battery className="h-4 w-4" />,
      color: "text-yellow-400",
      subtext: summary.batteryStartVoltage !== null && summary.batteryEndVoltage !== null
        ? `${fmtNum(summary.batteryStartVoltage, 1)}V → ${fmtNum(summary.batteryEndVoltage, 1)}V`
        : summary.batteryMinVoltage !== null ? `Min: ${fmtNum(summary.batteryMinVoltage, 1)}V` : undefined,
    },
    {
      label: "Max Current",
      value: fmtNum(summary.maxCurrent, 1, " A"),
      icon: <Zap className="h-4 w-4" />,
      color: "text-red-400",
    },
    {
      label: "GPS Fix",
      value: gpsFixLabel(summary.gpsFixType),
      icon: <Satellite className="h-4 w-4" />,
      color: "text-cyan-400",
      subtext: summary.numSatellites !== null ? `${fmtInt(summary.numSatellites)} sats` : undefined,
    },
    {
      label: "Max Vibration",
      value: fmtNum(summary.maxVibration, 2, " m/s²"),
      icon: <Vibrate className="h-4 w-4" />,
      color: "text-purple-400",
      subtext: summary.avgVibration !== null ? `Avg: ${fmtNum(summary.avgVibration, 2, " m/s²")}` : undefined,
    },
    {
      label: "Max ESC RPM",
      value: fmtInt(summary.maxEscRpm),
      icon: <Cog className="h-4 w-4" />,
      color: "text-pink-400",
    },
  ];

  const visibleCards = statCards.filter((c) => c.value !== "—");

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          Flight Summary
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {visibleCards.map((card) => (
            <div
              key={card.label}
              className="flex flex-col gap-1 p-3 rounded-lg bg-muted/50 border border-border/50"
            >
              <div className="flex items-center gap-1.5">
                <span className={card.color}>{card.icon}</span>
                <span className="text-xs text-muted-foreground font-medium">{card.label}</span>
              </div>
              <span className="text-lg font-bold tracking-tight">{card.value}</span>
              {card.subtext && (
                <span className="text-xs text-muted-foreground">{card.subtext}</span>
              )}
            </div>
          ))}
        </div>
        <div className="mt-2 text-xs text-muted-foreground text-right">
          {summary.totalMessages} message categories parsed
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Individual Chart Component ──────────────────────────────
function FlightChart({
  chart,
  data,
  logFilename,
  onBrushSelect,
}: {
  chart: ChartDefinition;
  data: Array<Record<string, number>>;
  logFilename?: string;
  onBrushSelect?: (startTime: number, endTime: number) => void;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);

  // Brush selection state
  const [brushStart, setBrushStart] = useState<number | null>(null);
  const [brushEnd, setBrushEnd] = useState<number | null>(null);
  const [isBrushing, setIsBrushing] = useState(false);

  const handleMouseDown = useCallback((e: any) => {
    if (e && e.activeLabel != null) {
      setBrushStart(e.activeLabel);
      setBrushEnd(null);
      setIsBrushing(true);
    }
  }, []);

  const handleMouseMove = useCallback((e: any) => {
    if (isBrushing && e && e.activeLabel != null) {
      setBrushEnd(e.activeLabel);
    }
  }, [isBrushing]);

  const handleMouseUp = useCallback(() => {
    if (isBrushing && brushStart != null && brushEnd != null) {
      const start = Math.min(brushStart, brushEnd);
      const end = Math.max(brushStart, brushEnd);
      // Only apply if the selection is meaningful (at least 0.5 seconds)
      if (end - start > 0.5 && onBrushSelect) {
        onBrushSelect(start, end);
      }
    }
    setBrushStart(null);
    setBrushEnd(null);
    setIsBrushing(false);
  }, [isBrushing, brushStart, brushEnd, onBrushSelect]);

  const handleExportCsv = useCallback(() => {
    const csv = chartDataToCsv(chart, data);
    if (!csv) {
      toast.error("No data to export");
      return;
    }
    const baseName = logFilename?.replace(/\.(bin|log)$/i, "") || "flight";
    downloadCsv(`${baseName}_${chart.id}.csv`, csv);
    toast.success("CSV downloaded");
  }, [chart, data, logFilename]);

  const handleExportPng = useCallback(async () => {
    if (!chartRef.current) return;
    setExporting(true);
    try {
      const svgElement = chartRef.current.querySelector("svg");
      if (!svgElement) {
        toast.error("Chart not ready for export");
        return;
      }

      const clone = svgElement.cloneNode(true) as SVGElement;
      const bbox = svgElement.getBoundingClientRect();
      clone.setAttribute("width", String(bbox.width));
      clone.setAttribute("height", String(bbox.height));

      const allElements = clone.querySelectorAll("*");
      const origElements = svgElement.querySelectorAll("*");
      allElements.forEach((el, i) => {
        const computed = window.getComputedStyle(origElements[i]);
        const important = ["fill", "stroke", "stroke-width", "stroke-dasharray", "font-size", "font-family", "opacity", "text-anchor", "dominant-baseline"];
        for (const prop of important) {
          (el as HTMLElement).style.setProperty(prop, computed.getPropertyValue(prop));
        }
      });

      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(clone);
      const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
      const svgUrl = URL.createObjectURL(svgBlob);

      const canvas = document.createElement("canvas");
      const scale = 2;
      canvas.width = bbox.width * scale;
      canvas.height = bbox.height * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas context unavailable");

      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);

      const img = new window.Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(svgUrl);

        const pngUrl = canvas.toDataURL("image/png");
        const link = document.createElement("a");
        const baseName = logFilename?.replace(/\.(bin|log)$/i, "") || "flight";
        link.download = `${baseName}_${chart.id}.png`;
        link.href = pngUrl;
        link.click();
        toast.success("PNG downloaded");
        setExporting(false);
      };
      img.onerror = () => {
        URL.revokeObjectURL(svgUrl);
        toast.error("Failed to render chart image");
        setExporting(false);
      };
      img.src = svgUrl;
    } catch (err) {
      toast.error("Export failed");
      setExporting(false);
    }
  }, [chart, logFilename]);

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{chart.title}</CardTitle>
        </CardHeader>
        <CardContent className="py-4 text-center text-muted-foreground text-sm">
          No data available
        </CardContent>
      </Card>
    );
  }

  const hasDualAxis = chart.fields.some((f) => f.yAxisId === "right");

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-sm">{chart.title}</CardTitle>
            <CardDescription className="text-xs">{chart.description}</CardDescription>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleExportCsv}
              title="Export as CSV"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleExportPng}
              disabled={exporting}
              title="Export as PNG"
            >
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Image className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pb-3">
        <div ref={chartRef}>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart
              data={data}
              margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              style={{ cursor: "crosshair", userSelect: "none" }}
            >
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis
                dataKey="time"
                tickFormatter={formatTime}
                tick={{ fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis
                yAxisId="left"
                tick={{ fontSize: 10 }}
                label={
                  chart.yAxisLabel
                    ? { value: chart.yAxisLabel, angle: -90, position: "insideLeft", style: { fontSize: 10 } }
                    : undefined
                }
              />
              {hasDualAxis && (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize: 10 }}
                  label={
                    chart.yAxisRight
                      ? { value: chart.yAxisRight, angle: 90, position: "insideRight", style: { fontSize: 10 } }
                      : undefined
                  }
                />
              )}
              <Tooltip
                labelFormatter={(val) => `Time: ${formatTime(val as number)}`}
                contentStyle={{ fontSize: 11 }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {chart.fields.map((field) => (
                <Line
                  key={field.key}
                  type="monotone"
                  dataKey={field.key}
                  name={field.label}
                  stroke={field.color}
                  yAxisId={field.yAxisId || "left"}
                  dot={false}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
              ))}
              {/* Brush selection overlay */}
              {isBrushing && brushStart != null && brushEnd != null && (
                <ReferenceArea
                  yAxisId="left"
                  x1={Math.min(brushStart, brushEnd)}
                  x2={Math.max(brushStart, brushEnd)}
                  fill="hsl(217, 91%, 60%)"
                  fillOpacity={0.2}
                  stroke="hsl(217, 91%, 60%)"
                  strokeOpacity={0.6}
                  strokeDasharray="3 3"
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
