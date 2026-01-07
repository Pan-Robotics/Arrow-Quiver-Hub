import { useState, useEffect, useRef } from "react";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import PointCloudCanvas from "@/components/widgets/PointCloudCanvas";
import { trpc } from "@/lib/trpc";
import { Loader2, Radio, Activity } from "lucide-react";
import { io, Socket } from "socket.io-client";

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

interface Point3D {
  x: number;
  y: number;
  z: number;
  distance: number;
  intensity: number;
}

export default function LidarApp() {
  const [selectedDrone, setSelectedDrone] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [latestData, setLatestData] = useState<PointCloudData | null>(null);
  const [points3D, setPoints3D] = useState<Point3D[]>([]);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);

  // Fetch list of drones
  const { data: drones, isLoading } = trpc.pointcloud.getDrones.useQuery();

  // Auto-select first drone if available
  useEffect(() => {
    if (drones && drones.length > 0 && !selectedDrone) {
      setSelectedDrone(drones[0].droneId);
    }
  }, [drones, selectedDrone]);

  // Initialize WebSocket connection with polling fallback
  useEffect(() => {
    if (!selectedDrone) return;

    let socketInstance: Socket | null = null;

    // Try WebSocket first
    try {
      socketInstance = io({
        path: "/socket.io/",
        timeout: 5000,
      });

      socketInstance.on("connect", () => {
        console.log("WebSocket connected");
        setConnected(true);
        socketInstance!.emit("subscribe", selectedDrone);
        // Clear polling if WebSocket connects
        if (pollingIntervalRef.current) {
          console.log("Stopping polling fallback (WebSocket connected)");
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
      });

      socketInstance.on("disconnect", () => {
        console.log("WebSocket disconnected");
        setConnected(false);
        // Start polling fallback
        startPolling();
      });

      socketInstance.on("pointcloud", (data: PointCloudData) => {
        if (data.drone_id === selectedDrone) {
          setLatestData(data);
          // Convert 2D points to 3D format for PointCloudCanvas
          const points3d: Point3D[] = data.points
            .filter(p => p.distance > 0) // Filter invalid points
            .map(p => ({
              x: p.x,
              y: p.y,
              z: 0, // RPLidar is 2D, so z is always 0
              distance: p.distance,
              intensity: p.quality, // Map quality to intensity
            }));
          setPoints3D(points3d);
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
      if (pollingIntervalRef.current) return; // Already polling
      
      console.log("Starting polling fallback for drone:", selectedDrone);
      
      // Poll every 100ms (10 Hz)
      pollingIntervalRef.current = setInterval(async () => {
        try {
          const response = await fetch(`/api/rest/pointcloud/latest/${selectedDrone}`);
          if (response.ok) {
            const result = await response.json();
            if (result.success && result.data) {
              setLatestData(result.data);
              // Convert 2D points to 3D format
              const points3d: Point3D[] = result.data.points
                .filter((p: Point) => p.distance > 0)
                .map((p: Point) => ({
                  x: p.x,
                  y: p.y,
                  z: 0,
                  distance: p.distance,
                  intensity: p.quality,
                }));
              setPoints3D(points3d);
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
        socketInstance.emit("unsubscribe", selectedDrone);
        socketInstance.disconnect();
      }
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, [selectedDrone]);

  return (
    <div className="h-full flex flex-col">
      {/* App Header */}
      <div className="border-b border-border bg-card px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">RPLidar Terrain Mapping</h2>
            <p className="text-sm text-muted-foreground">Real-time LiDAR point cloud visualization</p>
          </div>

          {/* Drone Selector */}
          {isLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="animate-spin" size={16} />
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
            <div className="text-sm text-muted-foreground">No drones connected</div>
          )}
        </div>
      </div>

      {/* App Content */}
      <div className="flex-1 p-6 overflow-auto">
        {selectedDrone ? (
          <div className="flex flex-col gap-4">
            {/* Connection Status & Stats Panel */}
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

            {/* Point Cloud Visualization */}
            <Card className="p-4">
              <div className="flex flex-col gap-2">
                <h3 className="text-lg font-semibold">Live Point Cloud</h3>
                <div className="w-full" style={{ height: 600 }}>
                  <PointCloudCanvas
                    points={points3D}
                    colorMode="distance"
                    minDistance={0}
                    maxDistance={12000}
                    pointSize={3}
                    showGrid={true}
                    showAxes={true}
                  />
                </div>
              </div>
            </Card>
          </div>
        ) : (
          <Card className="p-12 text-center">
            <Radio className="mx-auto mb-4 text-muted-foreground" size={64} />
            <h2 className="text-2xl font-semibold mb-2">No Drone Selected</h2>
            <p className="text-muted-foreground mb-6">
              {drones && drones.length > 0
                ? "Please select a drone from the dropdown above"
                : "Waiting for drones to connect..."}
            </p>
            {drones && drones.length === 0 && (
              <div className="max-w-md mx-auto text-left bg-muted p-4 rounded-md">
                <p className="text-sm font-medium mb-2">To connect a drone:</p>
                <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
                  <li>Start the point cloud streamer on the Raspberry Pi</li>
                  <li>Start the forwarder on the companion computer</li>
                  <li>Configure the web server URL and API key</li>
                  <li>The drone will appear here automatically</li>
                </ol>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
