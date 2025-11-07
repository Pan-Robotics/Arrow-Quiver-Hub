import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, Maximize2, Activity } from "lucide-react";

interface Point {
  angle: number;
  distance: number;
  quality: number;
  x: number;
  y: number;
}

interface PointCloudData {
  drone_id: string;
  timestamp: string;
  points: Point[];
  stats: {
    point_count: number;
    valid_points: number;
    min_distance: number;
    max_distance: number;
    avg_distance: number;
    avg_quality: number;
  };
}

interface PointCloudViewerProps {
  droneId: string;
}

export default function PointCloudViewer({ droneId }: PointCloudViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [latestData, setLatestData] = useState<PointCloudData | null>(null);
  const [zoom, setZoom] = useState(1.0);
  const [maxRange, setMaxRange] = useState(12000); // 12 meters default

  // Initialize WebSocket connection with polling fallback
  useEffect(() => {
    let socketInstance: Socket | null = null;
    let pollingInterval: NodeJS.Timeout | null = null;

    // Try WebSocket first
    try {
      socketInstance = io({
        path: "/socket.io/",
        timeout: 5000,
      });

      socketInstance.on("connect", () => {
        console.log("WebSocket connected");
        setConnected(true);
        socketInstance!.emit("subscribe", droneId);
        // Clear polling if WebSocket connects
        if (pollingInterval) {
          clearInterval(pollingInterval);
          pollingInterval = null;
        }
      });

      socketInstance.on("disconnect", () => {
        console.log("WebSocket disconnected");
        setConnected(false);
        // Start polling fallback
        startPolling();
      });

      socketInstance.on("pointcloud", (data: PointCloudData) => {
        if (data.drone_id === droneId) {
          setLatestData(data);
        }
      });

      socketInstance.on("connect_error", (error) => {
        console.warn("WebSocket connection error, falling back to polling:", error);
        setConnected(false);
        startPolling();
      });

      setSocket(socketInstance);
    } catch (error) {
      console.warn("Failed to initialize WebSocket, using polling:", error);
      startPolling();
    }

    // Polling fallback function
    function startPolling() {
      if (pollingInterval) return; // Already polling
      
      console.log("Starting polling fallback for drone:", droneId);
      
      // Poll every 100ms (10 Hz)
      pollingInterval = setInterval(async () => {
        try {
          const response = await fetch(`/api/rest/pointcloud/latest/${droneId}`);
          if (response.ok) {
            const result = await response.json();
            if (result.success && result.data) {
              setLatestData(result.data);
              setConnected(true);
            }
          } else if (response.status === 404) {
            // No data yet, keep polling
            setConnected(false);
          }
        } catch (error) {
          console.error("Polling error:", error);
          setConnected(false);
        }
      }, 100);
    }

    return () => {
      if (socketInstance) {
        socketInstance.emit("unsubscribe", droneId);
        socketInstance.disconnect();
      }
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    };
  }, [droneId]);

  // Draw point cloud on canvas
  const drawPointCloud = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !latestData) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const centerX = width / 2;
    const centerY = height / 2;

    // Clear canvas
    ctx.fillStyle = "#0a0a0a";
    ctx.fillRect(0, 0, width, height);

    // Calculate scale (pixels per mm)
    const scale = (Math.min(width, height) / 2 / maxRange) * zoom;

    // Draw reference circles
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 1;
    const circles = [2000, 4000, 6000, 8000, 10000, 12000]; // mm
    circles.forEach((radius) => {
      if (radius <= maxRange) {
        const r = radius * scale;
        ctx.beginPath();
        ctx.arc(centerX, centerY, r, 0, 2 * Math.PI);
        ctx.stroke();

        // Label
        ctx.fillStyle = "#404040";
        ctx.font = "10px monospace";
        ctx.fillText(`${radius / 1000}m`, centerX + r + 5, centerY);
      }
    });

    // Draw axes
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, height);
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();

    // Draw axis labels
    ctx.fillStyle = "#606060";
    ctx.font = "12px monospace";
    ctx.fillText("0°", centerX, 15);
    ctx.fillText("90°", width - 30, centerY - 5);
    ctx.fillText("180°", centerX - 20, height - 5);
    ctx.fillText("270°", 5, centerY - 5);

    // Draw lidar position
    ctx.fillStyle = "#3b82f6";
    ctx.beginPath();
    ctx.arc(centerX, centerY, 5, 0, 2 * Math.PI);
    ctx.fill();

    // Draw points
    latestData.points.forEach((point) => {
      if (point.distance === 0) return; // Skip invalid points

      const x = centerX + point.x * scale;
      const y = centerY - point.y * scale; // Invert Y for canvas coordinates

      // Color based on quality (0-63)
      const quality = Math.min(63, Math.max(0, point.quality));
      const hue = (quality / 63) * 120; // 0 (red) to 120 (green)
      ctx.fillStyle = `hsl(${hue}, 100%, 50%)`;

      ctx.beginPath();
      ctx.arc(x, y, 2, 0, 2 * Math.PI);
      ctx.fill();
    });
  }, [latestData, zoom, maxRange]);

  // Redraw when data or zoom changes
  useEffect(() => {
    drawPointCloud();
  }, [drawPointCloud]);

  // Handle zoom controls
  const handleZoomIn = () => setZoom((z) => Math.min(z * 1.2, 5.0));
  const handleZoomOut = () => setZoom((z) => Math.max(z / 1.2, 0.2));
  const handleResetZoom = () => setZoom(1.0);

  return (
    <div className="flex flex-col gap-4">
      {/* Stats Panel */}
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className={connected ? "text-green-500" : "text-red-500"} size={20} />
            <span className="text-sm font-medium">
              {connected ? "Connected" : "Disconnected"}
            </span>
          </div>
          {latestData && (
            <div className="flex gap-6 text-sm">
              <div>
                <span className="text-muted-foreground">Points:</span>{" "}
                <span className="font-mono">{latestData.stats.point_count}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Valid:</span>{" "}
                <span className="font-mono">{latestData.stats.valid_points}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Avg Dist:</span>{" "}
                <span className="font-mono">{latestData.stats.avg_distance.toFixed(0)}mm</span>
              </div>
              <div>
                <span className="text-muted-foreground">Avg Quality:</span>{" "}
                <span className="font-mono">{latestData.stats.avg_quality.toFixed(0)}</span>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Canvas Viewer */}
      <Card className="p-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">Live Point Cloud</h3>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleZoomOut}>
                <ZoomOut size={16} />
              </Button>
              <Button variant="outline" size="sm" onClick={handleResetZoom}>
                <Maximize2 size={16} />
              </Button>
              <Button variant="outline" size="sm" onClick={handleZoomIn}>
                <ZoomIn size={16} />
              </Button>
            </div>
          </div>
          <canvas
            ref={canvasRef}
            width={1200}
            height={800}
            className="w-full border border-border rounded-md bg-black"
          />
          <div className="text-xs text-muted-foreground text-center">
            Zoom: {zoom.toFixed(1)}x | Range: {maxRange / 1000}m
          </div>
        </div>
      </Card>
    </div>
  );
}
