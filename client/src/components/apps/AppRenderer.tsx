import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card } from "@/components/ui/card";
import { Loader2, AlertCircle } from "lucide-react";
import { io, Socket } from "socket.io-client";

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

export default function AppRenderer({ appId }: AppRendererProps) {
  const [liveData, setLiveData] = useState<Record<string, any>>({});
  const [socket, setSocket] = useState<Socket | null>(null);
  
  // Load app configuration
  const { data: apps } = trpc.appBuilder.listApps.useQuery({ publishedOnly: false });
  const app = apps?.find(a => a.appId === appId);

  // Parse UI schema
  const uiSchema: UISchema | null = app?.uiSchema 
    ? (typeof app.uiSchema === 'string' ? JSON.parse(app.uiSchema) : app.uiSchema)
    : null;

  // Connect to WebSocket for live data
  useEffect(() => {
    const newSocket = io({
      path: "/socket.io/",
    });

    newSocket.on("connect", () => {
      console.log("[AppRenderer] WebSocket connected");
      newSocket.emit("subscribe_app", appId);
    });

    newSocket.on("app_data", (message: { appId: string; data: any; timestamp: string }) => {
      console.log("[AppRenderer] Received app data:", message);
      console.log("[AppRenderer] Data fields:", Object.keys(message.data));
      console.log("[AppRenderer] Data values:", message.data);
      if (message.appId === appId) {
        console.log("[AppRenderer] Setting liveData to:", message.data);
        setLiveData(message.data);
      }
    });

    newSocket.on("disconnect", () => {
      console.log("[AppRenderer] WebSocket disconnected");
    });

    setSocket(newSocket);

    return () => {
      if (newSocket) {
        newSocket.emit("unsubscribe_app", appId);
        newSocket.disconnect();
      }
    };
  }, [appId]);

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
    console.log(`[Widget ${widget.id}] dataField: ${dataField}, liveData:`, liveData, `value:`, dataField ? liveData[dataField] : undefined);
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
                  {/* Background circle */}
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
                  {/* Progress circle */}
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
      case "bar_chart":
      case "bar-chart":
        return (
          <Card key={widget.id} className="p-6">
            <div className="text-center">
              <p className="text-sm text-muted-foreground mb-2">{config.label || dataField || "Value"}</p>
              <p className="text-muted-foreground text-xs">Chart rendering coming soon...</p>
              <p className="text-2xl font-bold mt-4">{typeof value === 'number' ? value.toFixed(2) : String(value)}</p>
            </div>
          </Card>
        );

      case "map":
        // Map widget expects latitude and longitude fields
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
        // Canvas widget for custom visualizations (e.g., point clouds)
        const canvasData = value;
        
        return (
          <Card key={widget.id} className="p-6">
            <div className="text-center">
              <p className="text-sm text-muted-foreground mb-2">{config.label || "Canvas"}</p>
              <div className="w-full h-64 bg-muted rounded-lg flex items-center justify-center">
                <div className="text-center">
                  <p className="text-xs text-muted-foreground mb-2">Custom Canvas Visualization</p>
                  <p className="text-2xl font-bold">{typeof canvasData === 'object' ? JSON.stringify(canvasData).substring(0, 50) + '...' : String(canvasData)}</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {config.width || 'auto'} × {config.height || 'auto'}
              </p>
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
        <div className="mt-2 flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${socket?.connected ? 'bg-green-500' : 'bg-gray-400'}`} />
          <span className="text-xs text-muted-foreground">
            {socket?.connected ? 'Connected' : 'Disconnected'}
          </span>
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
