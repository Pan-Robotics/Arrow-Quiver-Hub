import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useDroneSelection } from "@/hooks/useDroneSelection";
import { io, Socket } from "socket.io-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ScrollText,
  Download,
  Upload,
  Trash2,
  RefreshCw,
  Loader2,
  FileText,
  HardDrive,
  Cpu,
  Thermometer,
  MemoryStick,
  Wifi,
  WifiOff,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Clock,
  Zap,
  Terminal,
  Play,
  Square,
  ArrowDown,
  BarChart3,
  Save,
  Globe,
  Signal,
} from "lucide-react";
import { toast } from "sonner";
import { ConnectionStatus, useLastDataTimestamp } from "@/components/ui/ConnectionStatus";

// ─── Types ──────────────────────────────────────────────────────────────────

interface FcLog {
  id: number;
  droneId: string;
  remotePath: string;
  filename: string;
  fileSize: number | null;
  status: "discovered" | "downloading" | "uploading" | "completed" | "failed";
  progress: number | null;
  storageKey: string | null;
  url: string | null;
  errorMessage: string | null;
  discoveredAt: Date;
  downloadedAt: Date | null;
}

interface FirmwareUpdate {
  id: number;
  droneId: string;
  filename: string;
  fileSize: number;
  storageKey: string;
  url: string;
  status: "uploaded" | "queued" | "transferring" | "flashing" | "verifying" | "completed" | "failed";
  flashStage: string | null;
  progress: number | null;
  errorMessage: string | null;
  initiatedBy: number | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

interface DiagnosticsSnapshot {
  id: number;
  droneId: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  cpuTempC: number | null;
  uptimeSeconds: number | null;
  services: unknown;
  network: unknown;
  timestamp: Date;
}

interface LogProgressEvent {
  drone_id: string;
  logId: number;
  status: string;
  progress: number;
  errorMessage?: string;
  url?: string;
  filename?: string;
}

interface FirmwareProgressEvent {
  drone_id: string;
  updateId: number;
  status: string;
  flashStage?: string;
  progress: number;
  errorMessage?: string;
}

interface FcWebserverHealth {
  url: string;
  reachable: boolean;
  latency_ms: number | null;
  last_checked: string;
}

interface DiagnosticsEvent {
  drone_id: string;
  cpuPercent?: number;
  memoryPercent?: number;
  diskPercent?: number;
  cpuTempC?: number;
  uptimeSeconds?: number;
  services?: Record<string, string>;
  network?: Record<string, any>;
  fcWebserver?: FcWebserverHealth | null;
  timestamp: string;
}

interface LogStreamEvent {
  drone_id: string;
  service: string;
  lines: string[];
  timestamp: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let b = bytes;
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatUptime(seconds: number | null | undefined): string {
  if (!seconds) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(dateVal: string | Date | null | undefined): string {
  if (!dateVal) return "—";
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
  return d.toLocaleString();
}

function statusBadge(status: string) {
  const variants: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ReactNode }> = {
    discovered: { variant: "secondary", icon: <FileText size={12} /> },
    downloading: { variant: "default", icon: <Loader2 size={12} className="animate-spin" /> },
    uploading: { variant: "default", icon: <Upload size={12} /> },
    completed: { variant: "outline", icon: <CheckCircle2 size={12} className="text-green-400" /> },
    failed: { variant: "destructive", icon: <XCircle size={12} /> },
    uploaded: { variant: "secondary", icon: <Upload size={12} /> },
    queued: { variant: "secondary", icon: <Clock size={12} /> },
    transferring: { variant: "default", icon: <Loader2 size={12} className="animate-spin" /> },
    flashing: { variant: "default", icon: <Zap size={12} className="animate-pulse" /> },
    verifying: { variant: "default", icon: <Loader2 size={12} className="animate-spin" /> },
  };
  const v = variants[status] || { variant: "secondary" as const, icon: null };
  return (
    <Badge variant={v.variant} className="gap-1 capitalize">
      {v.icon}
      {status}
    </Badge>
  );
}

function serviceStatusIcon(status: string) {
  switch (status) {
    case "active":
      return <CheckCircle2 size={14} className="text-green-400" />;
    case "inactive":
      return <XCircle size={14} className="text-zinc-500" />;
    case "failed":
      return <AlertCircle size={14} className="text-red-400" />;
    default:
      return <AlertCircle size={14} className="text-yellow-400" />;
  }
}

// ─── FC Logs Tab ────────────────────────────────────────────────────────────

function FcLogsTab({
  droneId,
  socket,
  isAnalyticsInstalled,
}: {
  droneId: string;
  socket: Socket | null;
  isAnalyticsInstalled: boolean;
}) {
  const utils = trpc.useUtils();
  const { data: logs, isLoading } = trpc.fcLogs.list.useQuery(
    { droneId, limit: 200 },
    { refetchInterval: 10000 }
  );

  // Track which log IDs are pending auto-download-to-PC after companion finishes
  const pendingBrowserDownloads = useRef<Set<number>>(new Set());
  // Track which log IDs are currently being saved to PC
  const [savingToPc, setSavingToPc] = useState<Set<number>>(new Set());

  const scanMutation = trpc.fcLogs.requestScan.useMutation({
    onSuccess: () => toast.success("FC log scan requested"),
    onError: (e) => toast.error(`Scan failed: ${e.message}`),
  });

  const downloadMutation = trpc.fcLogs.requestDownload.useMutation({
    onSuccess: (_data, variables) => {
      toast.success("Downloading log from FC...", {
        description: "The companion is fetching the log. It will auto-save to your PC when ready.",
      });
      // Mark this log for auto-download once it reaches "completed" state
      pendingBrowserDownloads.current.add(variables.logId);
    },
    onError: (e) => toast.error(`Download failed: ${e.message}`),
  });

  const deleteMutation = trpc.fcLogs.delete.useMutation({
    onSuccess: () => {
      toast.success("Log deleted");
      utils.fcLogs.list.invalidate();
    },
    onError: (e) => toast.error(`Delete failed: ${e.message}`),
  });

  // ─── FC Web Server Health ─────────────────────────────────────────────
  const [fcWebserverHealth, setFcWebserverHealth] = useState<FcWebserverHealth | null>(null);

  useEffect(() => {
    if (!socket) return;

    const handleDiag = (data: DiagnosticsEvent) => {
      if (data.drone_id !== droneId) return;
      if (data.fcWebserver !== undefined) {
        setFcWebserverHealth(data.fcWebserver ?? null);
      }
    };

    socket.on("diagnostics", handleDiag);
    return () => {
      socket.off("diagnostics", handleDiag);
    };
  }, [socket, droneId]);

  const sendToAnalyticsMutation = trpc.fcLogs.sendToAnalytics.useMutation({
    onSuccess: (data) => {
      toast.success(`"${data.filename}" sent to Flight Analytics`, {
        description: "Open the Flight Analytics app to parse and analyze this log.",
      });
    },
    onError: (e) => toast.error(`Failed to send to analytics: ${e.message}`),
  });

  const handleSendToAnalytics = (log: FcLog) => {
    if (!isAnalyticsInstalled) {
      toast.error("Flight Analytics app is not installed", {
        description: "Install the Flight Analytics app from the App Store first, then try again.",
        duration: 5000,
      });
      return;
    }
    sendToAnalyticsMutation.mutate({ id: log.id });
  };

  /**
   * Trigger a browser file download via the server-side proxy.
   * The proxy streams the file from S3 with Content-Disposition: attachment,
   * so the browser shows a native "Save As" dialog.
   */
  const triggerBrowserDownload = useCallback((logId: number, filename: string) => {
    setSavingToPc((prev) => new Set(prev).add(logId));
    // Use a hidden iframe/anchor to trigger the download via the proxy endpoint
    const a = document.createElement("a");
    a.href = `/api/rest/logs/fc-download/${logId}`;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    // Clean up after a short delay
    setTimeout(() => {
      document.body.removeChild(a);
      setSavingToPc((prev) => {
        const next = new Set(prev);
        next.delete(logId);
        return next;
      });
    }, 2000);
  }, []);

  // Listen for real-time progress updates & auto-trigger browser download
  useEffect(() => {
    if (!socket) return;

    const handleProgress = (data: LogProgressEvent) => {
      if (data.drone_id !== droneId) return;

      utils.fcLogs.list.invalidate();

      // Auto-trigger browser download when a pending log reaches "completed"
      if (
        data.status === "completed" &&
        data.url &&
        pendingBrowserDownloads.current.has(data.logId)
      ) {
        pendingBrowserDownloads.current.delete(data.logId);
        const filename = data.filename || `fc_log_${data.logId}.BIN`;
        toast.success(`"${filename}" ready — saving to PC`, {
          description: "Your browser should prompt a file download.",
        });
        triggerBrowserDownload(data.logId, filename);
      }
    };

    socket.on("fc_log_progress", handleProgress);
    return () => {
      socket.off("fc_log_progress", handleProgress);
    };
  }, [socket, droneId, utils, triggerBrowserDownload]);

  /**
   * Handle the download button click.
   * - Completed logs: immediately trigger browser download via proxy.
   * - Discovered/failed logs: dispatch companion job, then auto-download when done.
   */
  const handleDownloadFromFC = (log: FcLog) => {
    downloadMutation.mutate({
      droneId,
      logId: log.id,
      remotePath: log.remotePath,
    });
  };

  const handleSaveToPC = (log: FcLog) => {
    triggerBrowserDownload(log.id, log.filename);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">Flight Controller Logs</h3>
          <p className="text-sm text-muted-foreground">
            Scan and download .BIN log files from the FC SD card
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* FC Web Server Health Indicator */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium cursor-default">
                <Globe size={13} />
                <span>FC Web</span>
                {fcWebserverHealth === null ? (
                  <span className="inline-block w-2 h-2 rounded-full bg-zinc-500" />
                ) : fcWebserverHealth.reachable ? (
                  <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                ) : (
                  <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                )}
                {fcWebserverHealth?.reachable && fcWebserverHealth.latency_ms !== null && (
                  <span className="text-muted-foreground">{fcWebserverHealth.latency_ms}ms</span>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              {fcWebserverHealth === null ? (
                <p>FC web server status unknown. Waiting for diagnostics data from the companion.</p>
              ) : fcWebserverHealth.reachable ? (
                <div className="space-y-1">
                  <p className="font-medium text-green-400">FC Web Server Reachable</p>
                  <p className="text-xs">URL: {fcWebserverHealth.url}</p>
                  <p className="text-xs">Latency: {fcWebserverHealth.latency_ms}ms</p>
                  <p className="text-xs text-muted-foreground">Last checked: {new Date(fcWebserverHealth.last_checked).toLocaleTimeString()}</p>
                </div>
              ) : (
                <div className="space-y-1">
                  <p className="font-medium text-red-400">FC Web Server Unreachable</p>
                  <p className="text-xs">URL: {fcWebserverHealth.url}</p>
                  <p className="text-xs text-muted-foreground">Log downloads will fall back to MAVFTP (slower).</p>
                  <p className="text-xs text-muted-foreground">Check: WEB_ENABLE=1, WEB_BIND_PORT, network cable.</p>
                  <p className="text-xs text-muted-foreground">Last checked: {new Date(fcWebserverHealth.last_checked).toLocaleTimeString()}</p>
                </div>
              )}
            </TooltipContent>
          </Tooltip>

        <Button
          onClick={() => scanMutation.mutate({ droneId })}
          disabled={scanMutation.isPending}
          size="sm"
          className="gap-1"
        >
          {scanMutation.isPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          Scan FC
        </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="animate-spin text-muted-foreground" size={32} />
        </div>
      ) : !logs || logs.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <FileText className="mx-auto mb-3 text-muted-foreground" size={48} />
            <p className="text-muted-foreground mb-2">No FC logs discovered yet</p>
            <p className="text-sm text-muted-foreground">
              Click "Scan FC" to discover log files on the flight controller
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <ScrollArea className="max-h-[600px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Filename</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Discovered</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log: FcLog) => (
                  <TableRow key={log.id}>
                    <TableCell className="font-mono text-sm">{log.filename}</TableCell>
                    <TableCell className="text-muted-foreground">{formatBytes(log.fileSize)}</TableCell>
                    <TableCell>{statusBadge(log.status)}</TableCell>
                    <TableCell>
                      {(log.status === "downloading" || log.status === "uploading") && (
                        <div className="flex items-center gap-2 min-w-[120px]">
                          <Progress value={log.progress || 0} className="h-2 flex-1" />
                          <span className="text-xs text-muted-foreground w-8">
                            {log.progress || 0}%
                          </span>
                        </div>
                      )}
                      {log.status === "completed" && (
                        <span className="text-xs text-green-400">Done</span>
                      )}
                      {log.status === "failed" && (
                        <Tooltip>
                          <TooltipTrigger>
                            <span className="text-xs text-red-400 cursor-help">Error</span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="max-w-[300px]">{log.errorMessage || "Unknown error"}</p>
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(log.discoveredAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {/* Completed logs: Save to PC + Send to Analytics */}
                        {log.status === "completed" && log.url ? (
                          <>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => handleSendToAnalytics(log)}
                                  disabled={sendToAnalyticsMutation.isPending}
                                >
                                  {sendToAnalyticsMutation.isPending ? (
                                    <Loader2 size={14} className="animate-spin" />
                                  ) : (
                                    <BarChart3 size={14} />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                {isAnalyticsInstalled
                                  ? "Send to Flight Analytics"
                                  : "Flight Analytics not installed"}
                              </TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-blue-400 hover:text-blue-300"
                                  onClick={() => handleSaveToPC(log)}
                                  disabled={savingToPc.has(log.id)}
                                >
                                  {savingToPc.has(log.id) ? (
                                    <Loader2 size={14} className="animate-spin" />
                                  ) : (
                                    <Save size={14} />
                                  )}
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Save to PC</TooltipContent>
                            </Tooltip>
                          </>
                        ) : log.status === "discovered" || log.status === "failed" ? (
                          /* Discovered/failed logs: Download from FC (then auto-save to PC) */
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                onClick={() => handleDownloadFromFC(log)}
                                disabled={downloadMutation.isPending || pendingBrowserDownloads.current.has(log.id)}
                              >
                                {pendingBrowserDownloads.current.has(log.id) ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <Download size={14} />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {pendingBrowserDownloads.current.has(log.id)
                                ? "Downloading from FC..."
                                : "Download from FC & save to PC"}
                            </TooltipContent>
                          </Tooltip>
                        ) : (log.status === "downloading" || log.status === "uploading") ? (
                          /* In-progress logs: show spinner */
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                disabled
                              >
                                <Loader2 size={14} className="animate-spin" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Download in progress...</TooltipContent>
                          </Tooltip>
                        ) : null}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => deleteMutation.mutate({ id: log.id })}
                            >
                              <Trash2 size={14} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Delete record</TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </Card>
      )}
    </div>
  );
}

// ─── OTA Updates Tab ────────────────────────────────────────────────────────

function OtaUpdatesTab({
  droneId,
  socket,
}: {
  droneId: string;
  socket: Socket | null;
}) {
  const utils = trpc.useUtils();
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: updates, isLoading } = trpc.firmware.list.useQuery(
    { droneId, limit: 50 },
    { refetchInterval: 10000 }
  );

  const uploadMutation = trpc.firmware.upload.useMutation({
    onSuccess: () => {
      toast.success("Firmware uploaded");
      utils.firmware.list.invalidate();
      setShowUploadDialog(false);
      setUploadFile(null);
    },
    onError: (e) => toast.error(`Upload failed: ${e.message}`),
  });

  const flashMutation = trpc.firmware.requestFlash.useMutation({
    onSuccess: () => toast.success("Firmware flash initiated"),
    onError: (e) => toast.error(`Flash failed: ${e.message}`),
  });

  const deleteFwMutation = trpc.firmware.delete.useMutation({
    onSuccess: () => {
      toast.success("Firmware update deleted");
      utils.firmware.list.invalidate();
    },
    onError: (e) => toast.error(`Delete failed: ${e.message}`),
  });

  const clearFailedMutation = trpc.firmware.clearFailed.useMutation({
    onSuccess: (data) => {
      toast.success(`Cleared ${data.deletedCount} failed/stale update(s)`);
      utils.firmware.list.invalidate();
    },
    onError: (e) => toast.error(`Clear failed: ${e.message}`),
  });

  // Listen for real-time firmware progress
  useEffect(() => {
    if (!socket) return;

    const handleProgress = (data: FirmwareProgressEvent) => {
      if (data.drone_id === droneId) {
        utils.firmware.list.invalidate();
      }
    };

    socket.on("firmware_progress", handleProgress);
    return () => {
      socket.off("firmware_progress", handleProgress);
    };
  }, [socket, droneId, utils]);

  const handleUpload = async () => {
    if (!uploadFile) return;
    setIsUploading(true);

    try {
      const buffer = await uploadFile.arrayBuffer();
      const content = btoa(
        new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
      );

      uploadMutation.mutate({
        droneId,
        filename: uploadFile.name,
        content,
      });
    } catch (e) {
      toast.error("Failed to read firmware file");
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">OTA Firmware Updates</h3>
          <p className="text-sm text-muted-foreground">
            Upload .abin or .apj firmware and flash to the flight controller via FC HTTP pull (OTA)
          </p>
        </div>
        <div className="flex items-center gap-2">
          {updates && updates.some((fw: FirmwareUpdate) => fw.status === "failed" || fw.status === "uploaded") && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1 text-red-400 hover:text-red-300"
              onClick={() => clearFailedMutation.mutate({ droneId })}
              disabled={clearFailedMutation.isPending}
            >
              <Trash2 size={14} />
              Clear Failed
            </Button>
          )}
          <Button onClick={() => setShowUploadDialog(true)} size="sm" className="gap-1">
            <Upload size={14} />
            Upload Firmware
          </Button>
        </div>
      </div>

      {/* Upload Dialog */}
      <Dialog open={showUploadDialog} onOpenChange={setShowUploadDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Firmware</DialogTitle>
            <DialogDescription>
              Select an ArduPilot firmware file to upload. Both <strong>.abin</strong> and <strong>.apj</strong> formats
              are supported. (.apj files are automatically converted to .abin before flashing.)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Firmware File</Label>
              <Input
                ref={fileInputRef}
                type="file"
                accept=".abin,.apj"
                onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
              />
              {uploadFile && (
                <p className="text-sm text-muted-foreground">
                  {uploadFile.name} ({formatBytes(uploadFile.size)})
                </p>
              )}
            </div>
            <div className="rounded-md bg-amber-500/10 border border-amber-500/20 p-3">
              <div className="flex items-start gap-2">
                <AlertCircle size={16} className="text-amber-400 mt-0.5 shrink-0" />
                <div className="text-sm text-amber-200">
                  <p className="font-medium mb-1">Safety Warning</p>
                  <p>
                    Flashing incorrect firmware can brick the flight controller. Ensure the firmware
                    matches your FC hardware (e.g., CubeOrange, Pixhawk6X). Download firmware from{" "}
                    <a href="https://firmware.ardupilot.org" target="_blank" rel="noopener" className="underline">firmware.ardupilot.org</a>.
                    Both .abin (native OTA) and .apj (auto-converted) formats are accepted.
                  </p>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowUploadDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleUpload}
              disabled={!uploadFile || isUploading || uploadMutation.isPending}
            >
              {isUploading || uploadMutation.isPending ? (
                <Loader2 size={14} className="animate-spin mr-2" />
              ) : (
                <Upload size={14} className="mr-2" />
              )}
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="animate-spin text-muted-foreground" size={32} />
        </div>
      ) : !updates || updates.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <Zap className="mx-auto mb-3 text-muted-foreground" size={48} />
            <p className="text-muted-foreground mb-2">No firmware updates</p>
            <p className="text-sm text-muted-foreground">
              Upload a firmware file to begin an OTA update
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {updates.map((fw: FirmwareUpdate) => (
            <Card key={fw.id}>
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-md bg-muted">
                      <Zap size={20} className="text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-mono text-sm font-medium">{fw.filename}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatBytes(fw.fileSize)} · {formatDate(fw.createdAt)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {statusBadge(fw.status)}
                    {fw.flashStage && (
                      <Badge variant="outline" className="font-mono text-xs">
                        {fw.flashStage}
                      </Badge>
                    )}
                    {(fw.status === "uploaded" || fw.status === "failed") && (
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1"
                          onClick={() => flashMutation.mutate({ droneId, updateId: fw.id })}
                          disabled={flashMutation.isPending}
                        >
                          <Zap size={14} />
                          Flash
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-red-400"
                          onClick={() => deleteFwMutation.mutate({ id: fw.id })}
                          disabled={deleteFwMutation.isPending}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
                {(fw.status === "transferring" || fw.status === "flashing" || fw.status === "verifying") && (
                  <div className="mt-3 flex items-center gap-2">
                    <Progress value={fw.progress || 0} className="h-2 flex-1" />
                    <span className="text-xs text-muted-foreground w-8">
                      {fw.progress || 0}%
                    </span>
                  </div>
                )}
                {fw.errorMessage && (
                  <div className="mt-2 text-xs text-red-400 flex items-center gap-1">
                    <AlertCircle size={12} />
                    {fw.errorMessage}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── System Diagnostics Tab ─────────────────────────────────────────────────

function DiagnosticsTab({
  droneId,
  socket,
}: {
  droneId: string;
  socket: Socket | null;
}) {
  const [liveDiag, setLiveDiag] = useState<DiagnosticsEvent | null>(null);

  const { data: latestDiag } = trpc.diagnostics.latest.useQuery(
    { droneId },
    { refetchInterval: 15000 }
  );

  const { data: history } = trpc.diagnostics.history.useQuery(
    { droneId, limit: 60 },
    { refetchInterval: 30000 }
  );

  // Listen for real-time diagnostics
  useEffect(() => {
    if (!socket) return;

    const handleDiag = (data: DiagnosticsEvent) => {
      if (data.drone_id === droneId) {
        setLiveDiag(data);
      }
    };

    socket.on("diagnostics", handleDiag);
    return () => {
      socket.off("diagnostics", handleDiag);
    };
  }, [socket, droneId]);

  const diag = liveDiag || (latestDiag as DiagnosticsSnapshot | null | undefined);

  const cpuPercent = (liveDiag?.cpuPercent ?? (latestDiag as any)?.cpuPercent) ?? null;
  const memoryPercent = (liveDiag?.memoryPercent ?? (latestDiag as any)?.memoryPercent) ?? null;
  const diskPercent = (liveDiag?.diskPercent ?? (latestDiag as any)?.diskPercent) ?? null;
  const cpuTempC = (liveDiag?.cpuTempC ?? (latestDiag as any)?.cpuTempC) ?? null;
  const uptimeSeconds = (liveDiag?.uptimeSeconds ?? (latestDiag as any)?.uptimeSeconds) ?? null;
  const services = (liveDiag?.services ?? (latestDiag as any)?.services) ?? null;
  const network = (liveDiag?.network ?? (latestDiag as any)?.network) ?? null;

  function gaugeColor(value: number | null, thresholds: [number, number] = [60, 85]): string {
    if (value === null) return "text-muted-foreground";
    if (value >= thresholds[1]) return "text-red-400";
    if (value >= thresholds[0]) return "text-amber-400";
    return "text-green-400";
  }

  function tempColor(temp: number | null): string {
    if (temp === null) return "text-muted-foreground";
    if (temp >= 80) return "text-red-400";
    if (temp >= 65) return "text-amber-400";
    return "text-green-400";
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground">System Diagnostics</h3>
        <p className="text-sm text-muted-foreground">
          Real-time health metrics from the companion computer
        </p>
      </div>

      {/* Resource Gauges */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="py-4 text-center">
            <Cpu size={24} className={`mx-auto mb-2 ${gaugeColor(cpuPercent)}`} />
            <p className="text-2xl font-bold">{cpuPercent !== null ? `${cpuPercent}%` : "—"}</p>
            <p className="text-xs text-muted-foreground">CPU Usage</p>
            {cpuPercent !== null && (
              <Progress value={cpuPercent} className="h-1.5 mt-2" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-4 text-center">
            <MemoryStick size={24} className={`mx-auto mb-2 ${gaugeColor(memoryPercent)}`} />
            <p className="text-2xl font-bold">{memoryPercent !== null ? `${memoryPercent}%` : "—"}</p>
            <p className="text-xs text-muted-foreground">Memory</p>
            {memoryPercent !== null && (
              <Progress value={memoryPercent} className="h-1.5 mt-2" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-4 text-center">
            <HardDrive size={24} className={`mx-auto mb-2 ${gaugeColor(diskPercent)}`} />
            <p className="text-2xl font-bold">{diskPercent !== null ? `${diskPercent}%` : "—"}</p>
            <p className="text-xs text-muted-foreground">Disk</p>
            {diskPercent !== null && (
              <Progress value={diskPercent} className="h-1.5 mt-2" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="py-4 text-center">
            <Thermometer size={24} className={`mx-auto mb-2 ${tempColor(cpuTempC)}`} />
            <p className="text-2xl font-bold">{cpuTempC !== null ? `${cpuTempC}°C` : "—"}</p>
            <p className="text-xs text-muted-foreground">CPU Temp</p>
            {cpuTempC !== null && (
              <Progress value={Math.min((cpuTempC / 100) * 100, 100)} className="h-1.5 mt-2" />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Uptime */}
      <Card>
        <CardContent className="py-3 flex items-center gap-3">
          <Clock size={18} className="text-muted-foreground" />
          <div>
            <span className="text-sm font-medium">Uptime: </span>
            <span className="text-sm text-muted-foreground">{formatUptime(uptimeSeconds)}</span>
          </div>
          {liveDiag && (
            <Badge variant="outline" className="ml-auto gap-1 text-green-400 border-green-400/30">
              <Wifi size={12} />
              Live
            </Badge>
          )}
          {!liveDiag && latestDiag && (
            <Badge variant="outline" className="ml-auto gap-1 text-muted-foreground">
              <WifiOff size={12} />
              Last seen {formatDate((latestDiag as any).timestamp)}
            </Badge>
          )}
        </CardContent>
      </Card>

      {/* Services */}
      {services && typeof services === "object" && Object.keys(services as Record<string, string>).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Services</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(services as Record<string, string>).map(([name, status]) => (
                <div key={name} className="flex items-center gap-2 py-1">
                  {serviceStatusIcon(status)}
                  <span className="text-sm font-mono">{name}</span>
                  <span className="text-xs text-muted-foreground capitalize ml-auto">{status}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Network */}
      {network && typeof network === "object" && Object.keys(network as Record<string, any>).length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Network Interfaces</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Interface</TableHead>
                  <TableHead>IP Address</TableHead>
                  <TableHead>RX</TableHead>
                  <TableHead>TX</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(network as Record<string, any>).map(([iface, info]: [string, any]) => (
                  <TableRow key={iface}>
                    <TableCell className="font-mono text-sm">{iface}</TableCell>
                    <TableCell className="text-sm">{info.ip || "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatBytes(info.rx_bytes)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatBytes(info.tx_bytes)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {!diag && !latestDiag && (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <Cpu className="mx-auto mb-3 text-muted-foreground" size={48} />
            <p className="text-muted-foreground mb-2">No diagnostics data</p>
            <p className="text-sm text-muted-foreground">
              The companion computer will report system health every 10 seconds
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Remote Logs Tab ────────────────────────────────────────────────────────

function RemoteLogsTab({
  droneId,
  socket,
}: {
  droneId: string;
  socket: Socket | null;
}) {
  const [selectedService, setSelectedService] = useState("logs-ota");
  const [isStreaming, setIsStreaming] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const services = [
    { value: "telemetry-forwarder", label: "Telemetry Forwarder" },
    { value: "logs-ota", label: "Logs & OTA" },
    { value: "camera-stream", label: "Camera Stream" },
    { value: "siyi-camera", label: "SIYI Camera" },
    { value: "quiver-hub-client", label: "Hub Client" },
  ];

  // Listen for log stream events
  useEffect(() => {
    if (!socket) return;

    const handleLogStream = (data: LogStreamEvent) => {
      if (data.drone_id === droneId && data.service === selectedService) {
        setLogLines((prev) => {
          const combined = [...prev, ...data.lines];
          // Keep last 1000 lines
          return combined.slice(-1000);
        });
      }
    };

    socket.on("log_stream", handleLogStream);
    return () => {
      socket.off("log_stream", handleLogStream);
    };
  }, [socket, droneId, selectedService]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logLines, autoScroll]);

  const startStream = () => {
    if (!socket?.connected) {
      toast.error("Not connected to Hub");
      return;
    }
    setLogLines([]);
    socket.emit("log_stream_request", {
      droneId,
      service: selectedService,
      action: "start",
      lines: 100,
    });
    setIsStreaming(true);
    toast.success(`Streaming ${selectedService} logs`);
  };

  const stopStream = () => {
    if (socket?.connected) {
      socket.emit("log_stream_request", {
        droneId,
        service: selectedService,
        action: "stop",
      });
    }
    setIsStreaming(false);
  };

  // Stop stream when switching services
  const handleServiceChange = (value: string) => {
    if (isStreaming) {
      stopStream();
    }
    setSelectedService(value);
    setLogLines([]);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">Remote Logs</h3>
          <p className="text-sm text-muted-foreground">
            Stream journalctl output from the companion computer in real-time
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedService} onValueChange={handleServiceChange}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {services.map((svc) => (
                <SelectItem key={svc.value} value={svc.value}>
                  {svc.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {isStreaming ? (
            <Button onClick={stopStream} variant="destructive" size="sm" className="gap-1">
              <Square size={14} />
              Stop
            </Button>
          ) : (
            <Button onClick={startStream} size="sm" className="gap-1">
              <Play size={14} />
              Stream
            </Button>
          )}
        </div>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b">
          <div className="flex items-center gap-2">
            <Terminal size={14} className="text-muted-foreground" />
            <span className="text-xs font-mono text-muted-foreground">
              {selectedService}.service
            </span>
            {isStreaming && (
              <Badge variant="outline" className="text-green-400 border-green-400/30 text-xs gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                Live
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{logLines.length} lines</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs"
              onClick={() => setAutoScroll(!autoScroll)}
            >
              <ArrowDown size={12} className={autoScroll ? "text-green-400" : "text-muted-foreground"} />
              Auto-scroll
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs"
              onClick={() => setLogLines([])}
            >
              Clear
            </Button>
          </div>
        </div>
        <div
          ref={scrollRef}
          className="h-[500px] overflow-auto bg-zinc-950 p-3 font-mono text-xs leading-5"
        >
          {logLines.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              {isStreaming ? (
                <div className="flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  Waiting for log output...
                </div>
              ) : (
                <p>Click "Stream" to start viewing logs</p>
              )}
            </div>
          ) : (
            logLines.map((line, i) => (
              <div
                key={i}
                className={`whitespace-pre-wrap break-all ${
                  line.includes("ERROR") || line.includes("error")
                    ? "text-red-400"
                    : line.includes("WARNING") || line.includes("warning")
                    ? "text-amber-400"
                    : "text-zinc-300"
                }`}
              >
                {line}
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function LogsOtaApp() {
  const { selectedDrone, setSelectedDrone, drones, isLoading: dronesLoading } =
    useDroneSelection("logs-ota");

  const [socket, setSocket] = useState<Socket | null>(null);
  const [activeTab, setActiveTab] = useState("fc-logs");
  const { lastDataAt, markDataReceived, reset: resetDataTimestamp } = useLastDataTimestamp();

  // Check if Flight Analytics app is installed
  const { data: installedApps } = trpc.appBuilder.getUserApps.useQuery();
  const isAnalyticsInstalled = useMemo(
    () => (installedApps || []).some((app) => app.appId === "analytics"),
    [installedApps]
  );

  // Socket.IO connection
  useEffect(() => {
    if (!selectedDrone) return;

    resetDataTimestamp();

    const socketInstance = io({
      path: "/socket.io/",
      transports: ["websocket"],
    });

    socketInstance.on("connect", () => {
      socketInstance.emit("subscribe_logs", selectedDrone);
    });

    socketInstance.on("disconnect", () => {
      // Will auto-reconnect
    });

    // Track any data events to mark connection as truly active
    const dataEvents = ["fc_log_progress", "firmware_progress", "diagnostics", "log_stream_data"];
    dataEvents.forEach(evt => {
      socketInstance.on(evt, () => markDataReceived());
    });

    setSocket(socketInstance);

    return () => {
      socketInstance.emit("unsubscribe_logs", selectedDrone);
      socketInstance.disconnect();
    };
  }, [selectedDrone]);

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b bg-card">
        <div className="flex items-center gap-3">
          <ScrollText size={22} className="text-primary" />
          <div>
            <h1 className="text-lg font-semibold">Logs & OTA Updates</h1>
            <p className="text-xs text-muted-foreground">
              FC logs, firmware updates, diagnostics, and remote log streaming
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Drone Selector */}
          {dronesLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="animate-spin text-muted-foreground" size={16} />
              <span className="text-sm text-muted-foreground">Loading drones...</span>
            </div>
          ) : drones && drones.length > 0 ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Drone:</span>
              <Select value={selectedDrone || undefined} onValueChange={setSelectedDrone}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Select drone" />
                </SelectTrigger>
                <SelectContent>
                  {drones.map((drone) => (
                    <SelectItem key={drone.id} value={drone.droneId}>
                      {drone.name || drone.droneId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No drones registered</div>
          )}

          {/* Connection status */}
          <ConnectionStatus
            socketConnected={socket?.connected ?? false}
            lastDataAt={lastDataAt}
            staleThresholdSeconds={30}
          />
        </div>
      </div>

      {/* Content */}
      {!selectedDrone ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <ScrollText className="mx-auto mb-4 text-muted-foreground" size={64} />
            <p className="text-muted-foreground">Select a drone to view logs and diagnostics</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col">
            <div className="px-6 pt-3">
              <TabsList className="grid w-full max-w-[600px] grid-cols-4">
                <TabsTrigger value="fc-logs" className="gap-1">
                  <FileText size={14} />
                  FC Logs
                </TabsTrigger>
                <TabsTrigger value="ota" className="gap-1">
                  <Zap size={14} />
                  OTA Updates
                </TabsTrigger>
                <TabsTrigger value="diagnostics" className="gap-1">
                  <Cpu size={14} />
                  Diagnostics
                </TabsTrigger>
                <TabsTrigger value="remote-logs" className="gap-1">
                  <Terminal size={14} />
                  Remote Logs
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="flex-1 overflow-auto px-6 py-4">
              <TabsContent value="fc-logs" className="mt-0">
                <FcLogsTab droneId={selectedDrone} socket={socket} isAnalyticsInstalled={isAnalyticsInstalled} />
              </TabsContent>
              <TabsContent value="ota" className="mt-0">
                <OtaUpdatesTab droneId={selectedDrone} socket={socket} />
              </TabsContent>
              <TabsContent value="diagnostics" className="mt-0">
                <DiagnosticsTab droneId={selectedDrone} socket={socket} />
              </TabsContent>
              <TabsContent value="remote-logs" className="mt-0">
                <RemoteLogsTab droneId={selectedDrone} socket={socket} />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      )}
    </div>
  );
}
