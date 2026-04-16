import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Loader2, AlertCircle } from "lucide-react";
import { io, Socket } from "socket.io-client";
import { ConnectionStatus, useLastDataTimestamp } from "@/components/ui/ConnectionStatus";
import PointCloudCanvas from "@/components/widgets/PointCloudCanvas";
import PointCloudCanvas2D from "@/components/widgets/PointCloudCanvas2D";
import LineChartWidget from "@/components/widgets/LineChartWidget";
import BarChartWidget from "@/components/widgets/BarChartWidget";
import { Button } from "@/components/ui/button";
import { Box, Grid2x2 } from "lucide-react";

interface Widget {
  id: string;
  type: string;
  position: { row: number; col: number; rowSpan?: number; colSpan?: number };
  size?: { width?: number | "auto"; height?: number | "auto" };
  config: Record<string, any>;
  dataBinding?: { field: string };
}

interface UISchema {
  columns: number;
  widgets: Widget[];
}

interface AppRendererProps {
  appId: string;
}

/** Per-stream subscription config */
interface StreamSubscription {
  streamId: string;
  streamEvent: string;
  subscribeEvent: string;
  subscribeParam: string;
  selectedFields: string[];
  fieldAliases: Record<string, string>;
}

/** Multi-stream config format */
interface MultiStreamConfig {
  streams: StreamSubscription[];
  fieldMappings: Record<string, string>; // widgetField -> "streamId:fieldPath"
}

/** Legacy single-stream config */
interface LegacyStreamConfig {
  streamId: string;
  streamEvent: string;
  subscribeEvent: string;
  subscribeParam: string;
  fieldMappings: Record<string, string>;
}

/**
 * Canvas widget with 2D/3D render mode toggle.
 * Matches the RPLidar LidarApp visualization approach.
 */
function CanvasWidget({
  widget,
  value,
  config,
}: {
  widget: Widget;
  value: any;
  config: Record<string, any>;
}) {
  const [renderMode, setRenderMode] = useState<'2d' | '3d'>('2d');

  // Parse point data - handle both string and array inputs
  const parsedPoints = useMemo(() => {
    if (!value) return [];
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return [];
      }
    }
    if (Array.isArray(value)) return value;
    return [];
  }, [value]);

  return (
    <Card key={widget.id} className="p-4">
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm text-muted-foreground">{config.label || "Canvas"}</p>
          {/* 2D/3D Render Mode Toggle */}
          <div className="flex items-center gap-1 bg-muted rounded-md p-0.5">
            <Button
              variant={renderMode === '2d' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setRenderMode('2d')}
              className="h-7 px-2 text-xs"
            >
              <Grid2x2 size={12} className="mr-1" />
              2D
            </Button>
            <Button
              variant={renderMode === '3d' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setRenderMode('3d')}
              className="h-7 px-2 text-xs"
            >
              <Box size={12} className="mr-1" />
              3D
            </Button>
          </div>
        </div>
        <div className="w-full" style={{ height: config.height || 400 }}>
          {renderMode === '2d' ? (
            <PointCloudCanvas2D
              points={parsedPoints}
              colorMode={config.colorMode || 'distance'}
              minDistance={config.minDistance || 0}
              maxDistance={config.maxDistance || 5000}
              pointSize={config.pointSize || 3}
              showGrid={config.showGrid !== false}
              showAxes={config.showAxes !== false}
            />
          ) : (
            <PointCloudCanvas
              points={parsedPoints}
              colorMode={config.colorMode || 'distance'}
              minDistance={config.minDistance || 0}
              maxDistance={config.maxDistance || 5000}
              pointSize={config.pointSize || 4}
              showGrid={config.showGrid !== false}
              showAxes={config.showAxes !== false}
            />
          )}
        </div>
      </div>
    </Card>
  );
}

export default function AppRenderer({ appId }: AppRendererProps) {
  const [liveData, setLiveData] = useState<Record<string, any>>({});
  const [socket, setSocket] = useState<Socket | null>(null);
  // Ref to accumulate data from multiple streams without stale closure issues
  const liveDataRef = useRef<Record<string, any>>({});
  const { lastDataAt, markDataReceived } = useLastDataTimestamp();
  
  // Load app configuration
  const { data: apps } = trpc.appBuilder.listApps.useQuery({ publishedOnly: false });
  const app = apps?.find(a => a.appId === appId);

  // Parse UI schema
  const uiSchema: UISchema | null = app?.uiSchema 
    ? (typeof app.uiSchema === 'string' ? JSON.parse(app.uiSchema) : app.uiSchema)
    : null;

  // Parse data source config
  const dataSource = (app as any)?.dataSource || 'custom_endpoint';
  const dataSourceConfig = useMemo(() => {
    const raw = (app as any)?.dataSourceConfig;
    if (!raw) return null;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return null; }
    }
    return raw;
  }, [app]);

  // Normalize config to multi-stream format (handles legacy single-stream)
  const normalizedConfig = useMemo((): MultiStreamConfig | null => {
    if (dataSource !== 'stream_subscription' || !dataSourceConfig) return null;

    // New multi-stream format
    if (dataSourceConfig.streams && Array.isArray(dataSourceConfig.streams)) {
      return dataSourceConfig as MultiStreamConfig;
    }

    // Legacy single-stream format: convert to multi-stream
    if (dataSourceConfig.streamId) {
      const legacy = dataSourceConfig as LegacyStreamConfig;
      return {
        streams: [{
          streamId: legacy.streamId,
          streamEvent: legacy.streamEvent,
          subscribeEvent: legacy.subscribeEvent,
          subscribeParam: legacy.subscribeParam,
          selectedFields: legacy.fieldMappings ? Object.values(legacy.fieldMappings) : [],
          fieldAliases: {},
        }],
        fieldMappings: legacy.fieldMappings || {},
      };
    }

    return null;
  }, [dataSource, dataSourceConfig]);

  // Helper to extract nested values using dot notation (e.g., "stats.point_count")
  const getNestedValue = useCallback((obj: any, path: string): any => {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }, []);

  // Parse a field mapping string into streamId and fieldPath
  // Handles app: prefixed IDs (e.g., "app:weather-station:temperature")
  const parseFieldMapping = useCallback((mapping: string): { streamId: string; fieldPath: string } | null => {
    if (mapping.startsWith('app:')) {
      const afterApp = mapping.substring(4);
      const colonIdx = afterApp.indexOf(':');
      if (colonIdx === -1) return null;
      return {
        streamId: 'app:' + afterApp.substring(0, colonIdx),
        fieldPath: afterApp.substring(colonIdx + 1),
      };
    }
    const colonIdx = mapping.indexOf(':');
    if (colonIdx === -1) return null;
    return {
      streamId: mapping.substring(0, colonIdx),
      fieldPath: mapping.substring(colonIdx + 1),
    };
  }, []);

  // Apply field mappings from a specific stream to update merged data
  const applyStreamData = useCallback((
    streamId: string,
    rawData: any,
    fieldMappings: Record<string, string>
  ) => {
    const updates: Record<string, any> = {};
    
    for (const [widgetField, mapping] of Object.entries(fieldMappings)) {
      const parsed = parseFieldMapping(mapping);
      if (!parsed) continue;
      
      if (parsed.streamId === streamId) {
        updates[widgetField] = getNestedValue(rawData, parsed.fieldPath);
      }
    }

    if (Object.keys(updates).length > 0) {
      // Merge with existing data from other streams
      const newData = { ...liveDataRef.current, ...updates };
      liveDataRef.current = newData;
      setLiveData(newData);
    }
  }, [getNestedValue, parseFieldMapping]);

  // Connect to WebSocket for live data
  useEffect(() => {
    const newSocket = io({
      path: "/socket.io/",
    });

    newSocket.on("connect", () => {
      console.log("[AppRenderer] WebSocket connected, dataSource:", dataSource);

      if (dataSource === 'stream_subscription' && normalizedConfig) {
        // Multi-stream: subscribe to each unique stream
        const subscribedStreams = new Set<string>();
        
        for (const sub of normalizedConfig.streams) {
          if (subscribedStreams.has(sub.streamId)) continue;
          subscribedStreams.add(sub.streamId);
          
          console.log(`[AppRenderer] Subscribing to stream: ${sub.streamId}`);
          
          if (sub.streamId.startsWith('app:')) {
            const sourceAppId = sub.streamId.replace('app:', '');
            newSocket.emit('subscribe_app', sourceAppId);
          } else {
            newSocket.emit('subscribe_stream', sub.streamId);
          }
        }
      } else {
        // Default: subscribe to this app's own data channel
        newSocket.emit("subscribe_app", appId);
      }
    });

    // Handle app_data events (for custom_endpoint, passthrough, or app: stream subscriptions)
    newSocket.on("app_data", (message: { appId: string; data: any; timestamp: string }) => {
      if (dataSource === 'stream_subscription' && normalizedConfig) {
        // Check if any stream subscriptions are for custom apps
        for (const sub of normalizedConfig.streams) {
          if (sub.streamId.startsWith('app:')) {
            const sourceAppId = sub.streamId.replace('app:', '');
            if (message.appId === sourceAppId) {
              applyStreamData(sub.streamId, message.data, normalizedConfig.fieldMappings);
            }
          }
        }
      } else if (message.appId === appId) {
        liveDataRef.current = message.data;
        setLiveData(message.data);
        markDataReceived();
      }
    });

    // Handle built-in stream events (pointcloud, telemetry, camera_status)
    if (dataSource === 'stream_subscription' && normalizedConfig) {
      const builtInEvents = new Set<string>();
      
      for (const sub of normalizedConfig.streams) {
        if (!sub.streamId.startsWith('app:')) {
          builtInEvents.add(sub.streamId);
        }
      }

      for (const eventName of Array.from(builtInEvents)) {
        newSocket.on(eventName, (message: any) => {
          console.log(`[AppRenderer] Received ${eventName} stream data`);
          applyStreamData(eventName, message, normalizedConfig.fieldMappings);
          markDataReceived();
        });
      }
    }

    newSocket.on("disconnect", () => {
      console.log("[AppRenderer] WebSocket disconnected");
    });

    setSocket(newSocket);

    return () => {
      if (newSocket) {
        if (dataSource === 'stream_subscription' && normalizedConfig) {
          const unsubscribedStreams = new Set<string>();
          for (const sub of normalizedConfig.streams) {
            if (unsubscribedStreams.has(sub.streamId)) continue;
            unsubscribedStreams.add(sub.streamId);
            
            if (sub.streamId.startsWith('app:')) {
              const sourceAppId = sub.streamId.replace('app:', '');
              newSocket.emit('unsubscribe_app', sourceAppId);
            } else {
              newSocket.emit('unsubscribe_stream', sub.streamId);
            }
          }
        } else {
          newSocket.emit("unsubscribe_app", appId);
        }
        newSocket.disconnect();
      }
    };
  }, [appId, dataSource, normalizedConfig, applyStreamData]);

  if (!app) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto mb-4 animate-spin text-muted-foreground" size={48} />
          <p className="text-muted-foreground">Loading app...</p>
        </div>
      </div>
    );
  }

  if (!uiSchema || !uiSchema.widgets || uiSchema.widgets.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="mx-auto mb-4 text-yellow-500" size={48} />
          <h2 className="text-xl font-semibold mb-2">No UI Configured</h2>
          <p className="text-muted-foreground">This app doesn't have a UI layout yet.</p>
        </div>
      </div>
    );
  }

  const renderWidget = (widget: Widget) => {
    const dataField = widget.dataBinding?.field;
    const value = dataField ? (liveData[dataField] ?? 0) : 0;
    const config = widget.config || {};

    switch (widget.type) {
      case "text":
        return (
          <Card key={widget.id} className="p-6">
            <div className="text-center">
              <p className="text-sm text-muted-foreground mb-2">{config.label || dataField || "Value"}</p>
              <p className="text-4xl font-bold">
                {typeof value === 'number' ? value.toFixed(config.decimalPlaces || 1) : String(value)}
              </p>
              {config.unit && <p className="text-sm text-muted-foreground mt-1">{config.unit}</p>}
            </div>
          </Card>
        );

      case "gauge":
        const min = config.min || 0;
        const max = config.max || 100;
        const numValue = typeof value === 'number' ? value : 0;
        const percentage = ((numValue - min) / (max - min)) * 100;
        
        return (
          <Card key={widget.id} className="p-6">
            <div className="text-center">
              <p className="text-sm text-muted-foreground mb-4">{config.label || dataField || "Value"}</p>
              <div className="relative w-32 h-32 mx-auto">
                <svg className="w-full h-full" viewBox="0 0 100 100">
                  <circle
                    cx="50"
                    cy="50"
                    r="45"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="8"
                    className="text-muted"
                    opacity="0.2"
                  />
                  <circle
                    cx="50"
                    cy="50"
                    r="45"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="8"
                    className="text-primary"
                    strokeDasharray={`${percentage * 2.827} 283`}
                    strokeDashoffset="0"
                    transform="rotate(-90 50 50)"
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-2xl font-bold">{numValue.toFixed(config.decimalPlaces || 0)}</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {min} - {max} {config.unit || ""}
              </p>
            </div>
          </Card>
        );

      case "led":
        const threshold = config.threshold || 0;
        const isOn = typeof value === 'boolean' ? value : (typeof value === 'number' ? value > threshold : false);
        
        return (
          <Card key={widget.id} className="p-6">
            <div className="text-center">
              <p className="text-sm text-muted-foreground mb-4">{config.label || dataField || "Value"}</p>
              <div className={`w-16 h-16 mx-auto rounded-full ${isOn ? 'bg-green-500 shadow-lg shadow-green-500/50' : 'bg-gray-300'} transition-all`} />
              <p className="text-sm font-semibold mt-4">{isOn ? 'ON' : 'OFF'}</p>
            </div>
          </Card>
        );

      case "line_chart":
      case "line-chart":
        return (
          <Card key={widget.id} className="p-4">
            <div>
              <p className="text-sm text-muted-foreground mb-2">{config.label || "Line Chart"}</p>
              <LineChartWidget
                data={value}
                label={config.label || "Value"}
                color={config.color || "#8884d8"}
                showGrid={config.showGrid !== false}
                showLegend={config.showLegend !== false}
                height={config.height || 300}
              />
            </div>
          </Card>
        );

      case "bar_chart":
      case "bar-chart":
        return (
          <Card key={widget.id} className="p-4">
            <div>
              <p className="text-sm text-muted-foreground mb-2">{config.label || "Bar Chart"}</p>
              <BarChartWidget
                data={value}
                label={config.label || "Value"}
                color={config.color || "#82ca9d"}
                showGrid={config.showGrid !== false}
                showLegend={config.showLegend !== false}
                height={config.height || 300}
              />
            </div>
          </Card>
        );

      case "map":
        const latField = config.latitudeField || 'latitude';
        const lonField = config.longitudeField || 'longitude';
        const latitude = liveData[latField] || 0;
        const longitude = liveData[lonField] || 0;
        const zoom = config.zoom || 13;
        
        return (
          <Card key={widget.id} className="p-6">
            <div className="text-center">
              <p className="text-sm text-muted-foreground mb-2">{config.label || "GPS Location"}</p>
              <div className="bg-muted rounded-lg p-4 mb-2">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs text-muted-foreground">Latitude:</span>
                  <span className="text-sm font-mono font-semibold">{latitude.toFixed(6)}°</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Longitude:</span>
                  <span className="text-sm font-mono font-semibold">{longitude.toFixed(6)}°</span>
                </div>
              </div>
              <div className="w-full h-48 bg-muted rounded-lg flex items-center justify-center">
                <p className="text-xs text-muted-foreground">Map visualization: {latitude.toFixed(4)}, {longitude.toFixed(4)}</p>
              </div>
              {config.showCoordinates !== false && (
                <p className="text-xs text-muted-foreground mt-2">
                  Zoom: {zoom}x
                </p>
              )}
            </div>
          </Card>
        );

      case "video":
        const videoUrl = typeof value === 'string' ? value : (config.videoUrl || '');
        
        return (
          <Card key={widget.id} className="p-6">
            <div className="text-center">
              <p className="text-sm text-muted-foreground mb-2">{config.label || "Video Stream"}</p>
              {videoUrl ? (
                <div className="w-full aspect-video bg-black rounded-lg overflow-hidden">
                  <video 
                    src={videoUrl} 
                    controls={config.controls !== false}
                    autoPlay={config.autoplay === true}
                    muted={config.muted === true}
                    loop={config.loop === true}
                    className="w-full h-full object-contain"
                  >
                    Your browser does not support the video tag.
                  </video>
                </div>
              ) : (
                <div className="w-full aspect-video bg-muted rounded-lg flex items-center justify-center">
                  <p className="text-xs text-muted-foreground">No video URL provided</p>
                </div>
              )}
              {config.showUrl && videoUrl && (
                <p className="text-xs text-muted-foreground mt-2 truncate">{videoUrl}</p>
              )}
            </div>
          </Card>
        );

      case "canvas":
        return (
          <CanvasWidget
            key={widget.id}
            widget={widget}
            value={value}
            config={config}
          />
        );

      case "connection_status":
        return (
          <Card key={widget.id} className="p-6">
            <div className="flex items-center justify-center">
              <ConnectionStatus
                socketConnected={socket?.connected ?? false}
                lastDataAt={lastDataAt}
                label={config.label}
                staleThresholdSeconds={config.staleThreshold || 15}
                size={config.size || "md"}
                detail={config.detail}
              />
            </div>
          </Card>
        );

      default:
        return (
          <Card key={widget.id} className="p-6">
            <div className="text-center">
              <p className="text-sm text-muted-foreground">Unknown widget type: {widget.type}</p>
            </div>
          </Card>
        );
    }
  };

  return (
    <div className="h-full p-6 overflow-auto">
      {/* App Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{app.name}</h1>
        <p className="text-muted-foreground">{app.description}</p>
        <div className="mt-2">
          <ConnectionStatus
            socketConnected={socket?.connected ?? false}
            lastDataAt={lastDataAt}
            size="sm"
            detail={normalizedConfig && normalizedConfig.streams.length > 1 ? `${normalizedConfig.streams.length} streams` : undefined}
          />
        </div>
      </div>

      {/* Widget Grid */}
      <div
        className="grid gap-4"
        style={{
          gridTemplateColumns: `repeat(${uiSchema.columns || 3}, 1fr)`,
        }}
      >
        {uiSchema.widgets.map((widget) => (
          <div
            key={widget.id}
            style={{
              gridColumn: `${widget.position.col} / span ${widget.position.colSpan || 1}`,
              gridRow: `${widget.position.row} / span ${widget.position.rowSpan || 1}`,
            }}
          >
            {renderWidget(widget)}
          </div>
        ))}
      </div>
    </div>
  );
}
