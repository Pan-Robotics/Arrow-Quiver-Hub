import { useState, useEffect, useRef, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import PointCloudCanvas from "@/components/widgets/PointCloudCanvas";
import PointCloudCanvas2D from "@/components/widgets/PointCloudCanvas2D";
import { trpc } from "@/lib/trpc";
import { Loader2, Radio, Activity, Play, Square, Box, Grid2x2 } from "lucide-react";
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

/**
 * Generate a realistic mock RPLidar scan for demo/testing purposes.
 * Simulates a room-like environment with walls and objects.
 */
function generateMockScan(scanNumber: number): PointCloudData {
  const points: Point[] = [];
  const numPoints = 360;

  for (let i = 0; i < numPoints; i++) {
    const angle = (i * 360.0) / numPoints;
    const angleRad = (angle * Math.PI) / 180;

    // Simulate a room with walls at different distances
    let baseDist: number;
    if (angle >= 0 && angle < 90) {
      // Front wall at ~3000mm
      baseDist = 3000 + 200 * Math.sin(angleRad * 3);
    } else if (angle >= 90 && angle < 180) {
      // Right wall at ~2500mm
      baseDist = 2500 + 150 * Math.cos(angleRad * 2);
    } else if (angle >= 180 && angle < 270) {
      // Back wall at ~4000mm
      baseDist = 4000 + 300 * Math.sin(angleRad * 4);
    } else {
      // Left wall at ~2000mm
      baseDist = 2000 + 100 * Math.cos(angleRad * 5);
    }

    // Simulated objects (furniture-like obstacles)
    if (angle >= 40 && angle <= 55) {
      baseDist = Math.min(baseDist, 1500 + (Math.random() - 0.5) * 100);
    }
    if (angle >= 145 && angle <= 165) {
      baseDist = Math.min(baseDist, 1800 + (Math.random() - 0.5) * 60);
    }
    if (angle >= 245 && angle <= 260) {
      baseDist = Math.min(baseDist, 1200 + (Math.random() - 0.5) * 80);
    }

    // Add noise and slight movement per scan
    let distance = Math.max(100, baseDist + (Math.random() - 0.5) * 40);
    distance += 50 * Math.sin(scanNumber * 0.1 + angleRad);

    // Quality (0-47 for RPLidar)
    let quality = Math.floor(Math.random() * 37) + 10;

    // 2% invalid points
    if (Math.random() < 0.02) {
      distance = 0;
      quality = 0;
    }

    // Calculate x, y (same as the real forwarder)
    const x = distance * Math.cos(angleRad);
    const y = distance * Math.sin(angleRad);

    points.push({
      angle: Math.round(angle * 100) / 100,
      distance: Math.round(distance * 10) / 10,
      quality,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
    });
  }

  const validPoints = points.filter((p) => p.distance > 0);
  const distances = validPoints.map((p) => p.distance);
  const qualities = validPoints.map((p) => p.quality);

  return {
    drone_id: "demo_drone",
    timestamp: new Date().toISOString(),
    points,
    stats: {
      point_count: points.length,
      valid_points: validPoints.length,
      min_distance: distances.length > 0 ? Math.min(...distances) : 0,
      max_distance: distances.length > 0 ? Math.max(...distances) : 0,
      avg_distance: distances.length > 0 ? distances.reduce((a, b) => a + b, 0) / distances.length : 0,
      avg_quality: qualities.length > 0 ? qualities.reduce((a, b) => a + b, 0) / qualities.length : 0,
    },
  };
}

/**
 * Convert raw RPLidar 2D points to 3D format for PointCloudCanvas.
 */
function convertTo3D(points: Point[]): Point3D[] {
  return points
    .filter((p) => p.distance > 0)
    .map((p) => ({
      x: p.x,
      y: p.y,
      z: 0, // RPLidar is 2D, so z is always 0
      distance: p.distance,
      intensity: p.quality, // Map quality to intensity
    }));
}

export default function LidarApp() {
  const [selectedDrone, setSelectedDrone] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [latestData, setLatestData] = useState<PointCloudData | null>(null);
  const [points3D, setPoints3D] = useState<Point3D[]>([]);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);

  // Demo mode state
  const [demoMode, setDemoMode] = useState(false);
  const demoIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const demoScanCountRef = useRef(0);

  // Render mode: '2d' for reliable Canvas2D, '3d' for Three.js WebGL
  const [renderMode, setRenderMode] = useState<'2d' | '3d'>('2d');

  // Fetch list of drones
  const { data: drones, isLoading } = trpc.pointcloud.getDrones.useQuery();

  // Auto-select first drone if available
  useEffect(() => {
    if (drones && drones.length > 0 && !selectedDrone) {
      setSelectedDrone(drones[0].droneId);
    }
  }, [drones, selectedDrone]);

  // Demo mode handler
  const toggleDemoMode = useCallback(() => {
    if (demoMode) {
      // Stop demo
      if (demoIntervalRef.current) {
        clearInterval(demoIntervalRef.current);
        demoIntervalRef.current = null;
      }
      setDemoMode(false);
      setConnected(false);
      setLatestData(null);
      setPoints3D([]);
      demoScanCountRef.current = 0;
    } else {
      // Start demo - disconnect real socket first
      if (socket) {
        socket.disconnect();
        setSocket(null);
      }
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }

      setDemoMode(true);
      setConnected(true);
      setSelectedDrone("demo_drone");

      // Generate scans at 10Hz (every 100ms)
      demoIntervalRef.current = setInterval(() => {
        const mockData = generateMockScan(demoScanCountRef.current);
        demoScanCountRef.current += 1;
        setLatestData(mockData);
        setPoints3D(convertTo3D(mockData.points));
      }, 100);
    }
  }, [demoMode, socket]);

  // Cleanup demo mode on unmount
  useEffect(() => {
    return () => {
      if (demoIntervalRef.current) {
        clearInterval(demoIntervalRef.current);
        demoIntervalRef.current = null;
      }
    };
  }, []);

  // Initialize WebSocket connection with polling fallback (skip if demo mode)
  useEffect(() => {
    if (!selectedDrone || demoMode) return;

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
        startPolling();
      });

      socketInstance.on("pointcloud", (data: PointCloudData) => {
        if (data.drone_id === selectedDrone) {
          setLatestData(data);
          setPoints3D(convertTo3D(data.points));
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

    // Polling fallback function with debounce to avoid race with WebSocket reconnect
    let pollingDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    function startPolling() {
      if (pollingIntervalRef.current) return;

      // Debounce: wait 2s before starting polling in case WebSocket reconnects quickly
      if (pollingDebounceTimer) clearTimeout(pollingDebounceTimer);
      pollingDebounceTimer = setTimeout(() => {
        if (pollingIntervalRef.current) return; // Already started or WebSocket reconnected
        console.log("Starting polling fallback for drone:", selectedDrone);

        pollingIntervalRef.current = setInterval(async () => {
          try {
            const response = await fetch(`/api/rest/pointcloud/latest/${selectedDrone}`);
            if (response.ok) {
              const result = await response.json();
              if (result.success && result.data) {
                setLatestData(result.data);
                setPoints3D(convertTo3D(result.data.points));
                setConnected(true);
              }
            } else if (response.status === 404) {
              // No data yet — don't mark as disconnected, just waiting
            }
          } catch {
            // Silently ignore transient fetch failures (network blips)
            // WebSocket will reconnect and clear polling when ready
          }
        }, 1000); // Poll every 1s (not 100ms) — HTTP polling doesn't need 10Hz
      }, 2000);
    }

    return () => {
      if (pollingDebounceTimer) clearTimeout(pollingDebounceTimer);
      if (socketInstance) {
        socketInstance.emit("unsubscribe", selectedDrone);
        socketInstance.disconnect();
      }
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, [selectedDrone, demoMode]);

  return (
    <div className="h-full flex flex-col">
      {/* App Header */}
      <div className="border-b border-border bg-card px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">RPLidar Terrain Mapping</h2>
            <p className="text-sm text-muted-foreground">Real-time LiDAR point cloud visualization</p>
          </div>

          <div className="flex items-center gap-4">
            {/* Render Mode Toggle */}
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

            {/* Demo Mode Toggle */}
            <Button
              variant={demoMode ? "destructive" : "outline"}
              size="sm"
              onClick={toggleDemoMode}
              className="flex items-center gap-2"
            >
              {demoMode ? (
                <>
                  <Square size={14} />
                  Stop Demo
                </>
              ) : (
                <>
                  <Play size={14} />
                  Demo Mode
                </>
              )}
            </Button>

            {/* Drone Selector */}
            {!demoMode && (
              <>
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
              </>
            )}
          </div>
        </div>
      </div>

      {/* App Content */}
      <div className="flex-1 p-6 overflow-auto">
        {selectedDrone || demoMode ? (
          <div className="flex flex-col gap-4">
            {/* Connection Status & Stats Panel */}
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Activity className={connected ? "text-green-500" : "text-red-500"} size={20} />
                  <span className="text-sm font-medium">
                    {demoMode ? "Demo Mode" : connected ? "Connected" : "Disconnected"}
                  </span>
                  {demoMode && (
                    <span className="text-xs bg-yellow-500/20 text-yellow-600 px-2 py-0.5 rounded-full">
                      Simulated Data
                    </span>
                  )}
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
                  {renderMode === '2d' ? (
                    <PointCloudCanvas2D
                      points={points3D}
                      colorMode="distance"
                      minDistance={0}
                      maxDistance={5000}
                      pointSize={3}
                      showGrid={true}
                      showAxes={true}
                    />
                  ) : (
                    <PointCloudCanvas
                      points={points3D}
                      colorMode="distance"
                      minDistance={0}
                      maxDistance={5000}
                      pointSize={4}
                      showGrid={true}
                      showAxes={true}
                    />
                  )}
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
            <div className="flex flex-col items-center gap-4">
              <Button variant="outline" onClick={toggleDemoMode} className="flex items-center gap-2">
                <Play size={16} />
                Try Demo Mode
              </Button>
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
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
