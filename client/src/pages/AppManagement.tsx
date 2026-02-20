import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
  Sparkles, 
  Trash2, 
  Edit, 
  Download, 
  Eye, 
  AlertCircle,
  Loader2,
  Radio,
  Gauge,
  Camera,
  ScrollText,
  X,
  Database,
  Code,
  Layout,
  Wifi,
  Info,
  Server,
} from "lucide-react";
import { toast } from "sonner";

interface AppManagementProps {
  onGoToStore?: () => void;
  onEditApp?: (appId: string) => void;
}

/** Metadata for built-in apps that don't have database entries */
const BUILT_IN_APP_INFO: Record<string, {
  name: string;
  description: string;
  icon: React.ElementType<{ size?: number; className?: string }>;
  category: string;
  dataStreams: string[];
  features: string[];
}> = {
  telemetry: {
    name: "Flight Telemetry",
    description: "Real-time flight data including attitude (roll/pitch/yaw), GPS position, altitude, speed, and battery monitoring from MAVLink and UAVCAN flight controllers.",
    icon: Gauge,
    category: "Monitoring",
    dataStreams: ["telemetry"],
    features: [
      "Attitude indicator (roll, pitch, yaw)",
      "GPS position display (latitude, longitude)",
      "Altitude and relative altitude tracking",
      "Battery voltage and remaining percentage",
      "Satellite count and GPS fix status",
      "In-air status detection",
    ],
  },
  camera: {
    name: "Camera Feed",
    description: "Live video stream from SIYI A8 mini gimbal camera with gimbal control, zoom, recording, and snapshot capabilities via RTSP-to-HLS streaming.",
    icon: Camera,
    category: "Media",
    dataStreams: ["camera_status"],
    features: [
      "Live RTSP video stream via HLS",
      "Gimbal yaw and pitch control",
      "Zoom level adjustment",
      "Recording start/stop",
      "Snapshot capture",
      "Camera connection status monitoring",
    ],
  },
  "logs-ota": {
    name: "Logs & OTA Updates",
    description: "Remote log streaming, system diagnostics, and over-the-air firmware updates for companion computers and flight controllers.",
    icon: ScrollText,
    category: "Maintenance",
    dataStreams: ["system_logs", "ota_status"],
    features: [
      "Real-time log streaming from companion computer",
      "System health and diagnostics monitoring",
      "Over-the-air firmware update deployment",
      "Update rollback and version management",
      "Log filtering and search",
      "Disk usage and resource monitoring",
    ],
  },
};

/** Check if an app is a built-in app (no database entry) */
function isBuiltInApp(app: any): boolean {
  // Built-in apps don't have a numeric `id` field from the database
  return !app.id || BUILT_IN_APP_INFO[app.appId] !== undefined;
}

/** Get display name for an app */
function getAppDisplayName(app: any): string {
  const builtIn = BUILT_IN_APP_INFO[app.appId];
  if (builtIn) return builtIn.name;
  return app.name || app.appId;
}

/** Get description for an app */
function getAppDescription(app: any): string {
  const builtIn = BUILT_IN_APP_INFO[app.appId];
  if (builtIn) return builtIn.description;
  return (app as any).description || "No description provided";
}

/** Get data source label */
function getDataSourceLabel(dataSource: string): string {
  switch (dataSource) {
    case 'custom_endpoint': return 'Custom REST Endpoint';
    case 'stream_subscription': return 'Stream Subscription';
    case 'passthrough': return 'Passthrough';
    default: return dataSource || 'Unknown';
  }
}

export default function AppManagement({ onGoToStore, onEditApp }: AppManagementProps = {}) {
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  
  // Get tRPC utils for cache invalidation
  const utils = trpc.useUtils();
  
  // Load user's installed apps
  const { data: userApps, isLoading } = trpc.appBuilder.getUserApps.useQuery();
  
  // Uninstall app mutation
  const uninstallMutation = trpc.appBuilder.uninstallApp.useMutation({
    onSuccess: () => {
      toast.success("App uninstalled successfully");
      utils.appBuilder.getUserApps.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to uninstall app: ${error.message}`);
    },
  });

  // Delete app mutation (completely removes app from store)
  const deleteMutation = trpc.appBuilder.deleteApp.useMutation({
    onSuccess: () => {
      toast.success("App deleted successfully");
      utils.appBuilder.getUserApps.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to delete app: ${error.message}`);
    },
  });

  const handleUninstall = (appId: string) => {
    if (confirm("Are you sure you want to uninstall this app?")) {
      uninstallMutation.mutate({ appId });
    }
  };

  const handleDelete = (appId: string, appName: string) => {
    const confirmed = confirm(
      `Are you sure you want to PERMANENTLY DELETE "${appName}"?\n\n` +
      "This will:\n" +
      "• Remove the app from the store\n" +
      "• Delete all version history\n" +
      "• Remove all user installations\n" +
      "• Delete all app data\n\n" +
      "This action CANNOT be undone!"
    );
    
    if (confirmed) {
      deleteMutation.mutate({ appId });
    }
  };

  const handleExport = (app: any) => {
    const exportData = {
      appId: app.appId,
      name: getAppDisplayName(app),
      description: getAppDescription(app),
      version: (app as any).version || '1.0.0',
      dataSource: (app as any).dataSource || (isBuiltInApp(app) ? 'built-in' : 'custom_endpoint'),
      parserCode: (app as any).parserCode,
      dataSchema: (app as any).dataSchema,
      uiSchema: (app as any).uiSchema,
      dataSourceConfig: (app as any).dataSourceConfig,
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${app.appId}_v${(app as any).version || '1.0.0'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    toast.success("App configuration exported");
  };

  /** Render the View modal for a built-in app */
  const renderBuiltInAppDetails = (app: any) => {
    const builtIn = BUILT_IN_APP_INFO[app.appId];
    if (!builtIn) return null;
    const Icon = builtIn.icon;

    return (
      <div className="space-y-6">
        {/* App Header */}
        <div className="flex items-start gap-4">
          <div className="p-3 bg-primary/10 rounded-lg">
            <Icon className="text-primary" size={32} />
          </div>
          <div className="flex-1">
            <h3 className="text-xl font-bold">{builtIn.name}</h3>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="secondary">Built-in</Badge>
              <Badge variant="outline">{builtIn.category}</Badge>
            </div>
          </div>
        </div>

        {/* Description */}
        <div>
          <h4 className="font-semibold mb-2 flex items-center gap-2">
            <Info size={16} className="text-muted-foreground" />
            Description
          </h4>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {builtIn.description}
          </p>
        </div>

        {/* Data Streams */}
        <div>
          <h4 className="font-semibold mb-2 flex items-center gap-2">
            <Wifi size={16} className="text-muted-foreground" />
            Data Streams
          </h4>
          <div className="flex flex-wrap gap-2">
            {builtIn.dataStreams.map((stream) => (
              <Badge key={stream} variant="outline" className="font-mono text-xs">
                {stream}
              </Badge>
            ))}
          </div>
        </div>

        {/* Features */}
        <div>
          <h4 className="font-semibold mb-2 flex items-center gap-2">
            <Sparkles size={16} className="text-muted-foreground" />
            Features
          </h4>
          <ul className="space-y-1.5">
            {builtIn.features.map((feature, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                {feature}
              </li>
            ))}
          </ul>
        </div>

        {/* Installation Info */}
        <div>
          <h4 className="font-semibold mb-2 flex items-center gap-2">
            <Server size={16} className="text-muted-foreground" />
            Installation Info
          </h4>
          <div className="bg-muted rounded-lg p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">App ID:</span>
              <span className="font-mono text-xs">{app.appId}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Type:</span>
              <span>Built-in System App</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Installed:</span>
              <span className="text-xs">{new Date(app.installedAt).toLocaleDateString()}</span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  /** Render the View modal for a custom app */
  const renderCustomAppDetails = (app: any) => {
    // Parse data source config
    let dataSourceConfig = null;
    try {
      if (app.dataSourceConfig) {
        dataSourceConfig = typeof app.dataSourceConfig === 'string' 
          ? JSON.parse(app.dataSourceConfig) 
          : app.dataSourceConfig;
      }
    } catch { /* ignore parse errors */ }

    // Parse schemas
    let dataSchema = {};
    let uiSchema = {};
    try {
      dataSchema = app.dataSchema ? (typeof app.dataSchema === 'string' ? JSON.parse(app.dataSchema) : app.dataSchema) : {};
    } catch { /* ignore */ }
    try {
      uiSchema = app.uiSchema ? (typeof app.uiSchema === 'string' ? JSON.parse(app.uiSchema) : app.uiSchema) : {};
    } catch { /* ignore */ }

    const dataSource = app.dataSource || 'custom_endpoint';

    return (
      <div className="space-y-6">
        {/* App Header */}
        <div className="flex items-start gap-4">
          <div className="p-3 bg-primary/10 rounded-lg">
            <Sparkles className="text-primary" size={32} />
          </div>
          <div className="flex-1">
            <h3 className="text-xl font-bold">{app.name}</h3>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant={app.published === 'published' ? 'default' : 'secondary'}>
                {app.published || 'draft'}
              </Badge>
              <Badge variant="outline">v{app.version || '1.0.0'}</Badge>
              <Badge variant="outline">{getDataSourceLabel(dataSource)}</Badge>
            </div>
            {app.description && (
              <p className="text-sm text-muted-foreground mt-2">{app.description}</p>
            )}
          </div>
        </div>

        {/* App Info */}
        <div>
          <h4 className="font-semibold mb-2 flex items-center gap-2">
            <Info size={16} className="text-muted-foreground" />
            App Info
          </h4>
          <div className="bg-muted rounded-lg p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">App ID:</span>
              <span className="font-mono text-xs">{app.appId}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Version:</span>
              <span>{app.version || '1.0.0'}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Data Source:</span>
              <span>{getDataSourceLabel(dataSource)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Installed:</span>
              <span className="text-xs">{new Date(app.installedAt).toLocaleDateString()}</span>
            </div>
          </div>
        </div>

        {/* Data Source Config (for stream subscriptions) */}
        {dataSource === 'stream_subscription' && dataSourceConfig && (
          <div>
            <h4 className="font-semibold mb-2 flex items-center gap-2">
              <Wifi size={16} className="text-muted-foreground" />
              Stream Subscriptions
            </h4>
            {dataSourceConfig.streams ? (
              <div className="space-y-2">
                {dataSourceConfig.streams.map((stream: any, i: number) => (
                  <div key={i} className="bg-muted rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline" className="font-mono text-xs">{stream.streamId}</Badge>
                      <span className="text-xs text-muted-foreground">via {stream.streamEvent}</span>
                    </div>
                    {stream.selectedFields && stream.selectedFields.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {stream.selectedFields.map((field: string) => (
                          <Badge key={field} variant="secondary" className="text-xs font-mono">
                            {field}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <pre className="bg-muted p-4 rounded-lg text-xs overflow-auto max-h-48">
                {JSON.stringify(dataSourceConfig, null, 2)}
              </pre>
            )}
          </div>
        )}

        {/* REST Endpoint (for custom_endpoint apps) */}
        {dataSource === 'custom_endpoint' && (
          <div>
            <h4 className="font-semibold mb-2 flex items-center gap-2">
              <Server size={16} className="text-muted-foreground" />
              REST Endpoint
            </h4>
            <code className="text-xs bg-muted px-3 py-2 rounded-lg block font-mono">
              POST /api/rest/payload/{app.appId}/ingest
            </code>
          </div>
        )}

        {/* Parser Code */}
        <div>
          <h4 className="font-semibold mb-2 flex items-center gap-2">
            <Code size={16} className="text-muted-foreground" />
            Parser Code
          </h4>
          <pre className="bg-muted p-4 rounded-lg text-xs overflow-auto max-h-64 font-mono">
            {app.parserCode || 'No parser code'}
          </pre>
        </div>

        {/* Data Schema */}
        <div>
          <h4 className="font-semibold mb-2 flex items-center gap-2">
            <Database size={16} className="text-muted-foreground" />
            Data Schema
          </h4>
          <pre className="bg-muted p-4 rounded-lg text-xs overflow-auto max-h-48 font-mono">
            {JSON.stringify(dataSchema, null, 2)}
          </pre>
        </div>

        {/* UI Schema */}
        <div>
          <h4 className="font-semibold mb-2 flex items-center gap-2">
            <Layout size={16} className="text-muted-foreground" />
            UI Schema
          </h4>
          <pre className="bg-muted p-4 rounded-lg text-xs overflow-auto max-h-48 font-mono">
            {JSON.stringify(uiSchema, null, 2)}
          </pre>
        </div>
      </div>
    );
  };

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto mb-4 animate-spin text-muted-foreground" size={48} />
          <p className="text-muted-foreground">Loading your apps...</p>
        </div>
      </div>
    );
  }

  if (!userApps || userApps.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center max-w-md">
          <AlertCircle className="mx-auto mb-4 text-muted-foreground" size={48} />
          <h2 className="text-2xl font-bold mb-2">No Apps Installed</h2>
          <p className="text-muted-foreground mb-6">
            You haven't installed any custom apps yet. Visit the App Store to browse and install apps.
          </p>
          <Button onClick={() => onGoToStore?.()}>
            <Sparkles className="mr-2" size={16} />
            Go to App Store
          </Button>
        </div>
      </div>
    );
  }

  const selectedAppData = selectedApp ? userApps.find(a => a.appId === selectedApp) : null;

  return (
    <div className="container mx-auto py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">App Management</h1>
        <p className="text-muted-foreground">
          Manage your installed apps, view configurations, and export for deployment
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {userApps.map((app) => {
          const builtIn = isBuiltInApp(app);
          const builtInInfo = BUILT_IN_APP_INFO[app.appId];
          const Icon = builtInInfo?.icon || Sparkles;

          return (
            <Card key={app.appId} className="hover:shadow-lg transition-shadow">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="p-2 bg-primary/10 rounded-lg">
                    <Icon className="text-primary" size={24} />
                  </div>
                  <div className="flex items-center gap-2">
                    {builtIn && (
                      <Badge variant="outline" className="text-xs">Built-in</Badge>
                    )}
                    <Badge variant="secondary">v{(app as any).version || '1.0.0'}</Badge>
                  </div>
                </div>
                <CardTitle className="mt-4">{getAppDisplayName(app)}</CardTitle>
                <CardDescription className="line-clamp-2">
                  {getAppDescription(app)}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 mb-4">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">App ID:</span>
                    <span className="font-mono text-xs">{app.appId}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Installed:</span>
                    <span className="text-xs">
                      {new Date(app.installedAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Type:</span>
                    <Badge variant={builtIn ? 'outline' : ((app as any).published === 'published' ? 'default' : 'secondary')}>
                      {builtIn ? 'Built-in' : ((app as any).published || 'custom')}
                    </Badge>
                  </div>
                  {!builtIn && (app as any).dataSource && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Data Source:</span>
                      <span className="text-xs">{getDataSourceLabel((app as any).dataSource)}</span>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setSelectedApp(app.appId)}
                    className="flex-1"
                  >
                    <Eye size={14} className="mr-1" />
                    View
                  </Button>
                  {/* Only show Edit button for custom apps (not built-in) */}
                  {!builtIn && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onEditApp?.(app.appId)}
                    >
                      <Edit size={14} className="mr-1" />
                      Edit
                    </Button>
                  )}
                  {/* Only show Export for custom apps */}
                  {!builtIn && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleExport(app)}
                    >
                      <Download size={14} className="mr-1" />
                      Export
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleUninstall(app.appId)}
                    disabled={uninstallMutation.isPending}
                  >
                    <Trash2 size={14} className="mr-1" />
                    Uninstall
                  </Button>
                </div>
                
                {/* Delete button - only for custom apps */}
                {!builtIn && (app as any).id && (
                  <div className="mt-3 pt-3 border-t">
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleDelete(app.appId, getAppDisplayName(app))}
                      disabled={deleteMutation.isPending}
                      className="w-full"
                    >
                      <Trash2 size={14} className="mr-1" />
                      {deleteMutation.isPending ? "Deleting..." : "Delete App Permanently"}
                    </Button>
                  </div>
                )}

                {/* REST Endpoint - only for custom_endpoint apps */}
                {!builtIn && (app as any).dataSource === 'custom_endpoint' && (
                  <div className="mt-4 pt-4 border-t">
                    <p className="text-xs text-muted-foreground mb-2">REST Endpoint:</p>
                    <code className="text-xs bg-muted px-2 py-1 rounded block truncate font-mono">
                      POST /api/rest/payload/{app.appId}/ingest
                    </code>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* View Details Modal */}
      {selectedApp && selectedAppData && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <Card className="max-w-4xl w-full max-h-[80vh] overflow-auto">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>App Details</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setSelectedApp(null)}>
                  <X size={16} className="mr-1" />
                  Close
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {isBuiltInApp(selectedAppData)
                ? renderBuiltInAppDetails(selectedAppData)
                : renderCustomAppDetails(selectedAppData)
              }
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
