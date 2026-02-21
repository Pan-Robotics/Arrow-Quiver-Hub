import { useState, useCallback, useMemo, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { useDroneSelection } from "@/hooks/useDroneSelection";
import {
  CHART_DEFINITIONS,
  CHART_CATEGORIES,
  getAvailableCharts,
  getAllRequiredMessageTypes,
  toChartData,
  formatTime,
  type ChartDefinition,
} from "@/lib/flight-charts";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
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

interface ParseState {
  status: "idle" | "downloading" | "parsing" | "complete" | "error";
  progress: number;
  error?: string;
  availableCharts: ChartDefinition[];
  chartData: Record<string, Array<Record<string, number>>>;
  logStartTime?: Date;
  messageTypes?: Record<string, unknown>;
  stats?: Record<string, { count: number; msg_size: number; size: number }>;
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
      }
      setDeleteTargetId(null);
    },
    onError: (err) => toast.error(`Delete failed: ${err.message}`),
  });

  // UI state
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadNotes, setUploadNotes] = useState("");
  const [selectedLogId, setSelectedLogId] = useState<number | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>(
    Object.fromEntries(CHART_CATEGORIES.map((c) => [c.id, true]))
  );
  const [parseState, setParseState] = useState<ParseState>({
    status: "idle",
    progress: 0,
    availableCharts: [],
    chartData: {},
  });

  const fileInputRef = useRef<HTMLInputElement>(null);


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

  // Parse a flight log - downloads via server proxy to avoid compression issues
  const handleAnalyze = useCallback(async (logId: number, _fileUrl: string) => {
    setSelectedLogId(logId);
    setParseState({
      status: "downloading",
      progress: 0,
      availableCharts: [],
      chartData: {},
    });

    try {
      // Download the binary file via server proxy (avoids proxy compression mangling binary data)
      setParseState((prev) => ({ ...prev, status: "downloading", progress: 10 }));
      
      // Call the tRPC endpoint directly via fetch to get base64-encoded binary
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

      // Dynamically import the parser to avoid bundling issues
      const { default: DataflashParser } = await import("@/lib/dataflash-parser");
      const parser = new DataflashParser(false);

      // Get all message types needed for our charts
      const requiredMsgs = getAllRequiredMessageTypes();
      // Also include default messages for metadata
      const defaultMsgs = ["CMD", "MSG", "FILE", "MODE", "AHR2", "GPS", "POS", "PARM", "STAT", "EV"];
      const allMsgs = Array.from(new Set(requiredMsgs.concat(defaultMsgs)));

      console.log('[FlightAnalytics] Parsing with msgs:', allMsgs);

      setParseState((prev) => ({ ...prev, progress: 40 }));

      // Parse the binary data
      const result = parser.processData(arrayBuffer, allMsgs);



      setParseState((prev) => ({ ...prev, progress: 70 }));

      // Determine which charts have data
      const available = getAvailableCharts(result.types);

      // Generate chart data for each available chart
      const chartData: Record<string, Array<Record<string, number>>> = {};
      for (const chart of available) {
        const cd = toChartData(result.messages, chart, result.types);
        chartData[chart.id] = cd;
      }

      setParseState((prev) => ({ ...prev, progress: 90 }));

      // Extract start time
      let logStartTime: Date | undefined;
      try {
        logStartTime = parser.extractStartTime();
      } catch {
        // GPS time may not be available
      }

      // Get stats
      let stats: Record<string, { count: number; msg_size: number; size: number }> | undefined;
      try {
        stats = parser.stats();
      } catch {
        // Stats may fail on some logs
      }

      setParseState({
        status: "complete",
        progress: 100,
        availableCharts: available,
        chartData,
        logStartTime,
        messageTypes: result.types,
        stats,
      });

      toast.success(`Parsed ${available.length} chart(s) from log`);
    } catch (err: any) {
      setParseState({
        status: "error",
        progress: 0,
        error: err.message || "Failed to parse flight log",
        availableCharts: [],
        chartData: {},
      });
      toast.error(`Parse failed: ${err.message}`);
    }
  }, []);

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
          {/* Drone selector */}
          <Select
            value={selectedDrone || ""}
            onValueChange={setSelectedDrone}
            disabled={dronesLoading}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Select drone..." />
            </SelectTrigger>
            <SelectContent>
              {drones.map((d: any) => (
                <SelectItem key={d.droneId} value={d.droneId}>
                  {d.name || d.droneId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Upload button */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".bin,.BIN,.log,.LOG"
            className="hidden"
            onChange={handleFileSelect}
          />
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={!selectedDrone}
            size="sm"
          >
            <Upload className="h-4 w-4 mr-1" />
            Upload Log
          </Button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Log list */}
        <div className="w-80 border-r bg-card/50 flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b">
            <h3 className="font-medium text-sm text-muted-foreground">Flight Logs</h3>
          </div>
          <div className="flex-1 overflow-y-auto">
            {!selectedDrone ? (
              <div className="p-4 text-center text-muted-foreground text-sm">
                Select a drone to view logs
              </div>
            ) : logsQuery.isLoading ? (
              <div className="p-4 flex justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !logsQuery.data?.length ? (
              <div className="p-4 text-center text-muted-foreground text-sm">
                <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No flight logs yet</p>
                <p className="text-xs mt-1">Upload a .BIN or .log file to get started</p>
              </div>
            ) : (
              <div className="divide-y">
                {logsQuery.data.map((log: any) => (
                  <div
                    key={log.id}
                    className={`p-3 cursor-pointer hover:bg-accent/50 transition-colors ${
                      selectedLogId === log.id ? "bg-accent" : ""
                    }`}
                    onClick={() => handleAnalyze(log.id, log.fileUrl)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{log.filename}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="outline" className="text-xs">
                            <HardDrive className="h-3 w-3 mr-1" />
                            {formatSize(log.fileSize)}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            <Clock className="h-3 w-3 inline mr-1" />
                            {new Date(log.uploadedAt).toLocaleDateString()}
                          </span>
                        </div>
                        {log.notes && (
                          <p className="text-xs text-muted-foreground mt-1 truncate">{log.notes}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 ml-2">
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
            )}
          </div>
        </div>

        {/* Right panel: Charts */}
        <div className="flex-1 overflow-y-auto">
          {parseState.status === "idle" && (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              <div className="text-center">
                <BarChart3 className="h-16 w-16 mx-auto mb-4 opacity-30" />
                <p className="text-lg font-medium">Select a flight log to analyze</p>
                <p className="text-sm mt-1">
                  Upload a .BIN or .log file, then click to parse and view charts
                </p>
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
                  onClick={() =>
                    setParseState({ status: "idle", progress: 0, availableCharts: [], chartData: {} })
                  }
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
                            data={parseState.chartData[chart.id] || []}
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
            </div>
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

// ─── Individual Chart Component ──────────────────────────────
function FlightChart({
  chart,
  data,
}: {
  chart: ChartDefinition;
  data: Array<Record<string, number>>;
}) {
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
        <CardTitle className="text-sm">{chart.title}</CardTitle>
        <CardDescription className="text-xs">{chart.description}</CardDescription>
      </CardHeader>
      <CardContent className="pb-3">
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
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
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
