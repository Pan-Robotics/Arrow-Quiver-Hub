import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Key,
  Plus,
  Copy,
  Eye,
  EyeOff,
  Shield,
  ShieldOff,
  Trash2,
  Upload,
  FileText,
  History,
  Settings,
  Globe,
  Wifi,
  Terminal,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Pencil,
  Check,
  X,
  Zap,
  Loader2,
  CircleCheck,
  CircleX,
  Clock,
} from "lucide-react";

export default function DroneConfig() {
  const { user, loading: authLoading, isAuthenticated } = useAuth();

  const [selectedDrone, setSelectedDrone] = useState<string>("quiver_001");
  const [file, setFile] = useState<File | null>(null);
  const [targetPath, setTargetPath] = useState<string>("/home/pi/config/");
  const [description, setDescription] = useState<string>("");
  const [uploading, setUploading] = useState(false);

  // API key state
  const [showNewKeyDialog, setShowNewKeyDialog] = useState(false);
  const [newKeyDescription, setNewKeyDescription] = useState("");
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<Set<number>>(new Set());

  // New drone registration
  const [showRegisterDialog, setShowRegisterDialog] = useState(false);
  const [newDroneId, setNewDroneId] = useState("");
  const [newDroneName, setNewDroneName] = useState("");

  // Edit drone state
  const [showEditDroneDialog, setShowEditDroneDialog] = useState(false);
  const [editDroneId, setEditDroneId] = useState("");
  const [editDroneName, setEditDroneName] = useState("");
  const [editDroneOriginalId, setEditDroneOriginalId] = useState("");

  // Inline edit API key description
  const [editingKeyId, setEditingKeyId] = useState<number | null>(null);
  const [editKeyDescription, setEditKeyDescription] = useState("");

  // Test connection state
  const [testResults, setTestResults] = useState<{
    success: boolean;
    drone_id: string;
    total_latency_ms: number;
    tests: { name: string; endpoint: string; status: "pass" | "fail" | "skip"; latency_ms: number; message: string }[];
    tested_at: string;
  } | null>(null);
  const [showTestResults, setShowTestResults] = useState(false);

  const utils = trpc.useUtils();

  // Fetch drones
  const { data: dronesData } = trpc.drones.list.useQuery();
  const drones = dronesData?.drones || [];

  // Fetch API keys for selected drone
  const { data: apiKeysData, isLoading: apiKeysLoading } = trpc.drones.getApiKeys.useQuery(
    { droneId: selectedDrone },
    { enabled: !!selectedDrone && isAuthenticated }
  );
  const apiKeysList = apiKeysData?.keys || [];

  // Fetch jobs for selected drone
  const { data: jobsData } = trpc.droneJobs.getAllJobs.useQuery(
    { droneId: selectedDrone, limit: 20 },
    { enabled: !!selectedDrone }
  );
  const jobs = jobsData?.jobs || [];

  // Fetch files for selected drone
  const { data: filesData } = trpc.droneJobs.getFiles.useQuery(
    { droneId: selectedDrone },
    { enabled: !!selectedDrone }
  );
  const files = filesData?.files || [];

  // Mutations
  const generateKeyMutation = trpc.drones.generateApiKey.useMutation({
    onSuccess: (data) => {
      setNewlyCreatedKey(data.apiKey.key);
      toast.success("API key generated successfully!");
      utils.drones.getApiKeys.invalidate({ droneId: selectedDrone });
    },
    onError: (error) => {
      toast.error(`Failed to generate API key: ${error.message}`);
    },
  });

  const revokeKeyMutation = trpc.drones.revokeApiKey.useMutation({
    onSuccess: () => {
      toast.success("API key revoked");
      utils.drones.getApiKeys.invalidate({ droneId: selectedDrone });
    },
    onError: (error) => {
      toast.error(`Failed to revoke key: ${error.message}`);
    },
  });

  const reactivateKeyMutation = trpc.drones.reactivateApiKey.useMutation({
    onSuccess: () => {
      toast.success("API key reactivated");
      utils.drones.getApiKeys.invalidate({ droneId: selectedDrone });
    },
    onError: (error) => {
      toast.error(`Failed to reactivate key: ${error.message}`);
    },
  });

  const deleteKeyMutation = trpc.drones.deleteApiKey.useMutation({
    onSuccess: () => {
      toast.success("API key deleted permanently");
      utils.drones.getApiKeys.invalidate({ droneId: selectedDrone });
    },
    onError: (error) => {
      toast.error(`Failed to delete key: ${error.message}`);
    },
  });

  const registerDroneMutation = trpc.drones.register.useMutation({
    onSuccess: () => {
      toast.success("Drone registered successfully!");
      setShowRegisterDialog(false);
      setNewDroneId("");
      setNewDroneName("");
      utils.drones.list.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to register drone: ${error.message}`);
    },
  });

  const updateDroneMutation = trpc.drones.update.useMutation({
    onSuccess: (data) => {
      toast.success("Drone updated successfully!");
      setShowEditDroneDialog(false);
      // If droneId changed, update the selected drone
      if (data.drone && data.drone.droneId !== editDroneOriginalId) {
        setSelectedDrone(data.drone.droneId);
      }
      utils.drones.list.invalidate();
      utils.drones.getApiKeys.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to update drone: ${error.message}`);
    },
  });

  const updateApiKeyDescMutation = trpc.drones.updateApiKeyDescription.useMutation({
    onSuccess: () => {
      toast.success("API key description updated");
      setEditingKeyId(null);
      setEditKeyDescription("");
      utils.drones.getApiKeys.invalidate({ droneId: selectedDrone });
    },
    onError: (error) => {
      toast.error(`Failed to update description: ${error.message}`);
    },
  });

  const testConnectionMutation = trpc.drones.testConnection.useMutation({
    onSuccess: (data) => {
      setTestResults(data);
      setShowTestResults(true);
      if (data.success) {
        toast.success(`All ${data.tests.length} connection tests passed (${data.total_latency_ms}ms)`);
      } else {
        const failed = data.tests.filter((t) => t.status === "fail").length;
        toast.error(`${failed} of ${data.tests.length} tests failed`);
      }
    },
    onError: (error) => {
      toast.error(`Connection test failed: ${error.message}`);
    },
  });

  const uploadFileMutation = trpc.droneJobs.uploadFile.useMutation({
    onSuccess: () => {
      toast.success("File uploaded successfully!");
      setFile(null);
      setDescription("");
      utils.droneJobs.getFiles.invalidate({ droneId: selectedDrone });
      utils.droneJobs.getAllJobs.invalidate({ droneId: selectedDrone });
    },
    onError: (error) => {
      toast.error(`Upload failed: ${error.message}`);
    },
  });

  const deleteFileMutation = trpc.droneJobs.deleteFile.useMutation({
    onSuccess: () => {
      toast.success("File deleted successfully!");
      utils.droneJobs.getFiles.invalidate({ droneId: selectedDrone });
    },
    onError: (error) => {
      toast.error(`Delete failed: ${error.message}`);
    },
  });

  // Derive base URL from current window location
  const baseUrl = useMemo(() => {
    if (typeof window !== "undefined") {
      return window.location.origin;
    }
    return "";
  }, []);

  // Get the first active API key for the .env snippet
  const activeKey = apiKeysList.find((k: any) => k.isActive);

  // Build the .env snippet
  const envSnippet = useMemo(() => {
    const lines = [
      `# Quiver Hub Connection Configuration`,
      `# Drone: ${selectedDrone}`,
      `# Generated: ${new Date().toISOString().split("T")[0]}`,
      ``,
      `QUIVER_HUB_URL=${baseUrl}`,
      `QUIVER_DRONE_ID=${selectedDrone}`,
      `QUIVER_API_KEY=${activeKey ? activeKey.key : "<generate-an-api-key>"}`,
      ``,
      `# REST API Endpoints`,
      `QUIVER_POINTCLOUD_ENDPOINT=${baseUrl}/api/rest/pointcloud/ingest`,
      `QUIVER_TELEMETRY_ENDPOINT=${baseUrl}/api/rest/telemetry/ingest`,
      `QUIVER_CAMERA_ENDPOINT=${baseUrl}/api/rest/camera/status`,
      ``,
      `# WebSocket`,
      `QUIVER_WS_URL=${baseUrl.replace("http", "ws")}`,
      ``,
      `# Drone Job Polling (for file downloads & commands)`,
      `QUIVER_JOBS_ENDPOINT=${baseUrl}/api/trpc/droneJobs.getPendingJobs`,
    ];
    return lines.join("\n");
  }, [baseUrl, selectedDrone, activeKey]);

  // Copy to clipboard helper
  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      toast.success(`${label} copied to clipboard`);
    }).catch(() => {
      toast.error("Failed to copy to clipboard");
    });
  };

  // Toggle key visibility
  const toggleKeyVisibility = (keyId: number) => {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(keyId)) {
        next.delete(keyId);
      } else {
        next.add(keyId);
      }
      return next;
    });
  };

  // Mask API key
  const maskKey = (key: string) => {
    if (key.length <= 8) return "••••••••";
    return key.substring(0, 4) + "••••••••••••••••••••••••••••" + key.substring(key.length - 4);
  };

  // Handle file upload
  const handleUpload = async () => {
    if (!file) {
      toast.error("Please select a file");
      return;
    }
    if (!targetPath) {
      toast.error("Please specify target path");
      return;
    }

    setUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string).split(",")[1];
        let mimeType = file.type;
        if (file.name.endsWith(".py")) {
          mimeType = "text/plain";
        }
        await uploadFileMutation.mutateAsync({
          droneId: selectedDrone,
          filename: file.name,
          content: base64,
          mimeType: mimeType || "application/octet-stream",
          description,
          targetPath: targetPath + file.name,
        });
        setUploading(false);
      };
      reader.onerror = () => {
        toast.error("Failed to read file");
        setUploading(false);
      };
      reader.readAsDataURL(file);
    } catch (error) {
      setUploading(false);
    }
  };

  const handleGenerateKey = () => {
    generateKeyMutation.mutate({
      droneId: selectedDrone,
      description: newKeyDescription || undefined,
    });
  };

  const handleTestConnection = () => {
    if (!activeKey) {
      toast.error("No active API key found. Generate one first.");
      return;
    }
    setTestResults(null);
    setShowTestResults(false);
    testConnectionMutation.mutate({
      droneId: selectedDrone,
      apiKey: activeKey.key,
    });
  };

  const formatTime = (date: Date | string) => {
    return new Date(date).toLocaleString();
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "bg-green-500/10 text-green-500";
      case "failed":
        return "bg-red-500/10 text-red-500";
      case "in_progress":
        return "bg-blue-500/10 text-blue-500";
      default:
        return "bg-yellow-500/10 text-yellow-500";
    }
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Authentication Banner */}
        {!isAuthenticated && !authLoading && (
          <Card className="border-yellow-500/50 bg-yellow-500/5">
            <CardContent className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <div className="rounded-full bg-yellow-500/20 p-2">
                  <Settings className="h-5 w-5 text-yellow-500" />
                </div>
                <div>
                  <p className="font-medium">Sign in required</p>
                  <p className="text-sm text-muted-foreground">
                    You need to sign in to manage API keys and drone configuration
                  </p>
                </div>
              </div>
              <Button
                onClick={() => {
                  window.location.href = getLoginUrl();
                }}
                className="shrink-0"
              >
                Sign In
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Drone Configuration</h1>
            <p className="text-muted-foreground">
              Manage API keys, view connection details, and configure your drones
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowRegisterDialog(true)}
              disabled={!isAuthenticated}
            >
              <Plus className="w-4 h-4 mr-1" />
              Register Drone
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const drone = drones.find((d: any) => d.droneId === selectedDrone);
                setEditDroneOriginalId(selectedDrone);
                setEditDroneId(selectedDrone);
                setEditDroneName(drone?.name || "");
                setShowEditDroneDialog(true);
              }}
              disabled={!isAuthenticated || !selectedDrone}
            >
              <Pencil className="w-4 h-4 mr-1" />
              Edit Drone
            </Button>
            <Select value={selectedDrone} onValueChange={setSelectedDrone}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Select drone" />
              </SelectTrigger>
              <SelectContent>
                {drones.map((drone: any) => (
                  <SelectItem key={drone.droneId} value={drone.droneId}>
                    {drone.name || drone.droneId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* ============================================= */}
        {/* API KEYS & CONNECTION INFO - PROMINENT SECTION */}
        {/* ============================================= */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* API Keys Card */}
          <Card className="border-primary/30">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Key className="w-5 h-5 text-primary" />
                    API Keys
                  </CardTitle>
                  <CardDescription>
                    Generate and manage API keys for <span className="font-mono text-foreground">{selectedDrone}</span>
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    setNewKeyDescription("");
                    setNewlyCreatedKey(null);
                    setShowNewKeyDialog(true);
                  }}
                  disabled={!isAuthenticated}
                >
                  <Plus className="w-4 h-4 mr-1" />
                  Generate Key
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {apiKeysLoading ? (
                <div className="flex items-center justify-center py-8">
                  <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : apiKeysList.length === 0 ? (
                <div className="text-center py-8 space-y-3">
                  <Key className="w-10 h-10 mx-auto text-muted-foreground/50" />
                  <div>
                    <p className="text-sm font-medium">No API keys yet</p>
                    <p className="text-xs text-muted-foreground">
                      Generate an API key to connect this drone to the hub
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {apiKeysList.map((apiKey: any) => (
                    <div
                      key={apiKey.id}
                      className={`p-3 border rounded-lg space-y-2 ${
                        apiKey.isActive
                          ? "border-border"
                          : "border-red-500/30 bg-red-500/5 opacity-60"
                      }`}
                    >
                      {/* Description row - inline editable */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          {apiKey.isActive ? (
                            <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                          ) : (
                            <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                          )}
                          {editingKeyId === apiKey.id ? (
                            <div className="flex items-center gap-1.5 flex-1 min-w-0">
                              <Input
                                value={editKeyDescription}
                                onChange={(e) => setEditKeyDescription(e.target.value)}
                                placeholder="Key description"
                                className="h-7 text-sm"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    updateApiKeyDescMutation.mutate({
                                      keyId: apiKey.id,
                                      description: editKeyDescription || null,
                                    });
                                  } else if (e.key === "Escape") {
                                    setEditingKeyId(null);
                                  }
                                }}
                              />
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-green-500 hover:text-green-600 shrink-0"
                                onClick={() => {
                                  updateApiKeyDescMutation.mutate({
                                    keyId: apiKey.id,
                                    description: editKeyDescription || null,
                                  });
                                }}
                                disabled={updateApiKeyDescMutation.isPending}
                                title="Save"
                              >
                                <Check className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-foreground shrink-0"
                                onClick={() => setEditingKeyId(null)}
                                title="Cancel"
                              >
                                <X className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          ) : (
                            <>
                              <span className="text-sm font-medium truncate">
                                {apiKey.description || "API Key"}
                              </span>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 shrink-0"
                                onClick={() => {
                                  setEditingKeyId(apiKey.id);
                                  setEditKeyDescription(apiKey.description || "");
                                }}
                                title="Edit description"
                              >
                                <Pencil className="w-3 h-3" />
                              </Button>
                            </>
                          )}
                          <Badge
                            variant={apiKey.isActive ? "default" : "destructive"}
                            className="text-xs shrink-0"
                          >
                            {apiKey.isActive ? "Active" : "Revoked"}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => toggleKeyVisibility(apiKey.id)}
                            title={visibleKeys.has(apiKey.id) ? "Hide key" : "Show key"}
                          >
                            {visibleKeys.has(apiKey.id) ? (
                              <EyeOff className="w-3.5 h-3.5" />
                            ) : (
                              <Eye className="w-3.5 h-3.5" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => copyToClipboard(apiKey.key, "API key")}
                            title="Copy key"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </Button>
                          {apiKey.isActive ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-orange-500 hover:text-orange-600"
                              onClick={() => revokeKeyMutation.mutate({ keyId: apiKey.id })}
                              title="Revoke key"
                            >
                              <ShieldOff className="w-3.5 h-3.5" />
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-green-500 hover:text-green-600"
                              onClick={() => reactivateKeyMutation.mutate({ keyId: apiKey.id })}
                              title="Reactivate key"
                            >
                              <Shield className="w-3.5 h-3.5" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-red-500 hover:text-red-600"
                            onClick={() => {
                              if (confirm("Permanently delete this API key? This cannot be undone.")) {
                                deleteKeyMutation.mutate({ keyId: apiKey.id });
                              }
                            }}
                            title="Delete key permanently"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                      <div className="font-mono text-xs bg-muted/50 rounded px-2 py-1.5 break-all">
                        {visibleKeys.has(apiKey.id) ? apiKey.key : maskKey(apiKey.key)}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Created: {formatTime(apiKey.createdAt)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Connection Info Card */}
          <Card className="border-primary/30">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Globe className="w-5 h-5 text-primary" />
                    Connection Info
                  </CardTitle>
                  <CardDescription>
                    Endpoints and configuration for <span className="font-mono text-foreground">{selectedDrone}</span>
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={handleTestConnection}
                    disabled={testConnectionMutation.isPending || !activeKey}
                  >
                    {testConnectionMutation.isPending ? (
                      <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    ) : (
                      <Zap className="w-4 h-4 mr-1" />
                    )}
                    {testConnectionMutation.isPending ? "Testing..." : "Test Connection"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyToClipboard(envSnippet, ".env configuration")}
                  >
                    <Copy className="w-4 h-4 mr-1" />
                    Copy .env
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Test Connection Results */}
              {showTestResults && testResults && (
                <div className={`border rounded-lg p-4 space-y-3 ${
                  testResults.success
                    ? "border-green-500/50 bg-green-500/5"
                    : "border-red-500/50 bg-red-500/5"
                }`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {testResults.success ? (
                        <CircleCheck className="w-5 h-5 text-green-500" />
                      ) : (
                        <CircleX className="w-5 h-5 text-red-500" />
                      )}
                      <span className="font-semibold text-sm">
                        {testResults.success ? "All Tests Passed" : "Some Tests Failed"}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {testResults.total_latency_ms}ms total
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => setShowTestResults(false)}
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    {testResults.tests.map((test, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between py-1.5 px-3 rounded bg-background/50"
                      >
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          {test.status === "pass" ? (
                            <CircleCheck className="w-4 h-4 text-green-500 shrink-0" />
                          ) : test.status === "fail" ? (
                            <CircleX className="w-4 h-4 text-red-500 shrink-0" />
                          ) : (
                            <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium">{test.name}</span>
                            <p className="text-xs text-muted-foreground truncate">{test.message}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <code className="text-xs text-muted-foreground">{test.endpoint}</code>
                          <Badge
                            variant={test.status === "pass" ? "default" : "destructive"}
                            className="text-xs"
                          >
                            {test.latency_ms}ms
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground text-right">
                    Tested at {new Date(testResults.tested_at).toLocaleTimeString()}
                  </p>
                </div>
              )}

              {/* Quick Reference Endpoints */}
              <div className="space-y-3">
                <div className="flex items-start gap-3 p-2.5 bg-muted/30 rounded-lg">
                  <Globe className="w-4 h-4 mt-0.5 text-blue-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-muted-foreground">Hub Base URL</p>
                    <div className="flex items-center gap-1.5">
                      <code className="text-sm font-mono break-all">{baseUrl}</code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        onClick={() => copyToClipboard(baseUrl, "Base URL")}
                      >
                        <Copy className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-2.5 bg-muted/30 rounded-lg">
                  <Terminal className="w-4 h-4 mt-0.5 text-green-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-muted-foreground">Point Cloud Ingest</p>
                    <div className="flex items-center gap-1.5">
                      <code className="text-xs font-mono break-all">POST {baseUrl}/api/rest/pointcloud/ingest</code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        onClick={() => copyToClipboard(`${baseUrl}/api/rest/pointcloud/ingest`, "Point Cloud endpoint")}
                      >
                        <Copy className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-2.5 bg-muted/30 rounded-lg">
                  <Terminal className="w-4 h-4 mt-0.5 text-yellow-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-muted-foreground">Telemetry Ingest</p>
                    <div className="flex items-center gap-1.5">
                      <code className="text-xs font-mono break-all">POST {baseUrl}/api/rest/telemetry/ingest</code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        onClick={() => copyToClipboard(`${baseUrl}/api/rest/telemetry/ingest`, "Telemetry endpoint")}
                      >
                        <Copy className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-2.5 bg-muted/30 rounded-lg">
                  <Terminal className="w-4 h-4 mt-0.5 text-purple-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-muted-foreground">Camera Status</p>
                    <div className="flex items-center gap-1.5">
                      <code className="text-xs font-mono break-all">POST {baseUrl}/api/rest/camera/status</code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        onClick={() => copyToClipboard(`${baseUrl}/api/rest/camera/status`, "Camera endpoint")}
                      >
                        <Copy className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex items-start gap-3 p-2.5 bg-muted/30 rounded-lg">
                  <Wifi className="w-4 h-4 mt-0.5 text-cyan-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-muted-foreground">WebSocket</p>
                    <div className="flex items-center gap-1.5">
                      <code className="text-sm font-mono break-all">{baseUrl.replace("http", "ws")}</code>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        onClick={() => copyToClipboard(baseUrl.replace("http", "ws"), "WebSocket URL")}
                      >
                        <Copy className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              <Separator />

              {/* Full .env Snippet */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    <FileText className="w-4 h-4" />
                    .env File
                  </p>
                </div>
                <pre className="text-xs font-mono bg-muted/50 border rounded-lg p-3 overflow-x-auto whitespace-pre max-h-[240px] overflow-y-auto">
                  {envSnippet}
                </pre>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ============================================= */}
        {/* FILE UPLOAD & MANAGEMENT */}
        {/* ============================================= */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* File Upload Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Upload className="w-5 h-5" />
                Upload File
              </CardTitle>
              <CardDescription>
                Upload parser files, configuration files, or any other files to the drone
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>File</Label>
                <Input
                  type="file"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                  disabled={uploading}
                />
              </div>

              <div className="space-y-2">
                <Label>Target Path on Raspberry Pi</Label>
                <Input
                  value={targetPath}
                  onChange={(e) => setTargetPath(e.target.value)}
                  placeholder="/home/pi/config/"
                  disabled={uploading}
                />
                <p className="text-xs text-muted-foreground">
                  Specify the directory where the file should be saved on the Pi
                </p>
              </div>

              <div className="space-y-2">
                <Label>Description (Optional)</Label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g., Updated parser for sensor data"
                  disabled={uploading}
                  rows={2}
                />
              </div>

              <Button
                onClick={handleUpload}
                disabled={!file || uploading}
                className="w-full"
              >
                {uploading ? "Uploading..." : "Upload File"}
              </Button>
            </CardContent>
          </Card>

          {/* Files List */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="w-5 h-5" />
                Uploaded Files
              </CardTitle>
              <CardDescription>
                Files available for download by the drone
              </CardDescription>
            </CardHeader>
            <CardContent>
              {files.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No files uploaded yet
                </p>
              ) : (
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {files.map((file: any) => (
                    <div
                      key={file.id}
                      className="flex items-center justify-between p-3 border rounded-lg"
                    >
                      <div className="flex-1">
                        <p className="font-medium text-sm">{file.filename}</p>
                        <p className="text-xs text-muted-foreground">
                          {file.description || "No description"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Uploaded: {formatTime(file.createdAt)} &middot; Size:{" "}
                          {(file.fileSize / 1024).toFixed(2)} KB
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteFileMutation.mutate({ fileId: file.fileId })}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Job History */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="w-5 h-5" />
              Job History
            </CardTitle>
            <CardDescription>
              Recent jobs sent to the drone
            </CardDescription>
          </CardHeader>
          <CardContent>
            {jobs.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No jobs yet
              </p>
            ) : (
              <div className="space-y-2 max-h-[400px] overflow-y-auto">
                {jobs.map((job: any) => (
                  <div
                    key={job.id}
                    className="flex items-start justify-between p-3 border rounded-lg"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm">{job.type}</p>
                        <span
                          className={`text-xs px-2 py-1 rounded-full ${getStatusColor(
                            job.status
                          )}`}
                        >
                          {job.status}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        Created: {formatTime(job.createdAt)}
                      </p>
                      {job.acknowledgedAt && (
                        <p className="text-xs text-muted-foreground">
                          Acknowledged: {formatTime(job.acknowledgedAt)}
                        </p>
                      )}
                      {job.completedAt && (
                        <p className="text-xs text-muted-foreground">
                          Completed: {formatTime(job.completedAt)}
                        </p>
                      )}
                      {job.errorMessage && (
                        <p className="text-xs text-red-500 mt-1">
                          Error: {job.errorMessage}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ============================================= */}
        {/* DIALOGS */}
        {/* ============================================= */}

        {/* Generate API Key Dialog */}
        <Dialog open={showNewKeyDialog} onOpenChange={setShowNewKeyDialog}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Key className="w-5 h-5" />
                Generate API Key
              </DialogTitle>
              <DialogDescription>
                Create a new API key for <span className="font-mono font-semibold">{selectedDrone}</span>.
                The key will be shown only once after creation.
              </DialogDescription>
            </DialogHeader>

            {newlyCreatedKey ? (
              <div className="space-y-4">
                <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-lg space-y-2">
                  <div className="flex items-center gap-2 text-green-500">
                    <CheckCircle2 className="w-4 h-4" />
                    <span className="text-sm font-medium">Key generated successfully!</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Copy this key now. It will not be shown in full again.
                  </p>
                </div>
                <div className="relative">
                  <pre className="text-xs font-mono bg-muted/50 border rounded-lg p-3 pr-10 break-all whitespace-pre-wrap">
                    {newlyCreatedKey}
                  </pre>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute top-2 right-2 h-7 w-7"
                    onClick={() => copyToClipboard(newlyCreatedKey, "API key")}
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </Button>
                </div>
                <DialogFooter>
                  <Button
                    onClick={() => {
                      setShowNewKeyDialog(false);
                      setNewlyCreatedKey(null);
                    }}
                  >
                    Done
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Description (Optional)</Label>
                  <Input
                    value={newKeyDescription}
                    onChange={(e) => setNewKeyDescription(e.target.value)}
                    placeholder="e.g., RPLidar forwarder key"
                  />
                  <p className="text-xs text-muted-foreground">
                    A label to help you identify this key later
                  </p>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setShowNewKeyDialog(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleGenerateKey}
                    disabled={generateKeyMutation.isPending}
                  >
                    {generateKeyMutation.isPending ? "Generating..." : "Generate Key"}
                  </Button>
                </DialogFooter>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Register Drone Dialog */}
        <Dialog open={showRegisterDialog} onOpenChange={setShowRegisterDialog}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Register New Drone</DialogTitle>
              <DialogDescription>
                Add a new drone to the hub. You can generate API keys for it after registration.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Drone ID</Label>
                <Input
                  value={newDroneId}
                  onChange={(e) => setNewDroneId(e.target.value)}
                  placeholder="e.g., quiver_002"
                />
                <p className="text-xs text-muted-foreground">
                  Unique identifier used in API calls (lowercase, no spaces)
                </p>
              </div>
              <div className="space-y-2">
                <Label>Display Name (Optional)</Label>
                <Input
                  value={newDroneName}
                  onChange={(e) => setNewDroneName(e.target.value)}
                  placeholder="e.g., Field Survey Drone"
                />
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowRegisterDialog(false)}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() =>
                    registerDroneMutation.mutate({
                      droneId: newDroneId,
                      name: newDroneName || undefined,
                    })
                  }
                  disabled={!newDroneId || registerDroneMutation.isPending}
                >
                  {registerDroneMutation.isPending ? "Registering..." : "Register"}
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>

        {/* Edit Drone Dialog */}
        <Dialog open={showEditDroneDialog} onOpenChange={setShowEditDroneDialog}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Pencil className="w-5 h-5" />
                Edit Drone
              </DialogTitle>
              <DialogDescription>
                Update the drone ID or display name for <span className="font-mono font-semibold">{editDroneOriginalId}</span>.
                Changing the Drone ID will also update all associated API keys.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Drone ID</Label>
                <Input
                  value={editDroneId}
                  onChange={(e) => setEditDroneId(e.target.value)}
                  placeholder="e.g., quiver_002"
                />
                <p className="text-xs text-muted-foreground">
                  Unique identifier used in API calls (lowercase, no spaces).
                  Changing this will update the .env configuration.
                </p>
              </div>
              <div className="space-y-2">
                <Label>Display Name</Label>
                <Input
                  value={editDroneName}
                  onChange={(e) => setEditDroneName(e.target.value)}
                  placeholder="e.g., Field Survey Drone"
                />
                <p className="text-xs text-muted-foreground">
                  A friendly name shown in the drone selector. Leave blank to use the Drone ID.
                </p>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowEditDroneDialog(false)}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    updateDroneMutation.mutate({
                      currentDroneId: editDroneOriginalId,
                      droneId: editDroneId !== editDroneOriginalId ? editDroneId : undefined,
                      name: editDroneName || null,
                    });
                  }}
                  disabled={!editDroneId || updateDroneMutation.isPending}
                >
                  {updateDroneMutation.isPending ? "Saving..." : "Save Changes"}
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
