import { useState, useEffect, useRef, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { 
  Camera, 
  Video, 
  Home, 
  ArrowDown,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Minus,
  Plus,
  Settings,
  Maximize2,
  X,
  Activity,
  VideoOff
} from "lucide-react";
import { io, Socket } from "socket.io-client";

// Camera status interface
interface CameraStatus {
  connected: boolean;
  yaw: number;
  pitch: number;
  roll: number;
  zoom: number;
  recording: boolean;
  streamActive: boolean;
}

// Command types for gimbal control
type GimbalCommand = 
  | { type: "rotate"; yawSpeed: number; pitchSpeed: number }
  | { type: "setAngles"; yaw: number; pitch: number }
  | { type: "center" }
  | { type: "nadir" }
  | { type: "zoom"; level: number }
  | { type: "photo" }
  | { type: "recordToggle" };

export default function CameraFeedApp() {
  // Camera state
  const [status, setStatus] = useState<CameraStatus>({
    connected: false,
    yaw: 0,
    pitch: 0,
    roll: 0,
    zoom: 1,
    recording: false,
    streamActive: false,
  });
  
  const [socket, setSocket] = useState<Socket | null>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  
  // Gimbal control state (for continuous rotation while button held)
  const rotationIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize WebSocket connection
  useEffect(() => {
    const socketInstance = io({
      path: "/socket.io/",
      timeout: 5000,
    });

    socketInstance.on("connect", () => {
      console.log("Camera WebSocket connected");
      socketInstance.emit("subscribe_camera", "quiver_001");
    });

    socketInstance.on("disconnect", () => {
      console.log("Camera WebSocket disconnected");
      setStatus(prev => ({ ...prev, connected: false, streamActive: false }));
    });

    // Listen for camera status updates
    socketInstance.on("camera_status", (data: CameraStatus) => {
      setStatus(data);
    });

    // Listen for stream URL updates
    socketInstance.on("camera_stream", (data: { url: string }) => {
      setStreamUrl(data.url);
    });

    socketInstance.on("connect_error", (error) => {
      console.warn("Camera WebSocket error:", error);
      setStatus(prev => ({ ...prev, connected: false }));
    });

    setSocket(socketInstance);

    return () => {
      socketInstance.emit("unsubscribe_camera", "quiver_001");
      socketInstance.disconnect();
    };
  }, []);

  // Send command to camera via WebSocket
  const sendCommand = useCallback((command: GimbalCommand) => {
    if (socket?.connected) {
      socket.emit("camera_command", { droneId: "quiver_001", command });
    }
  }, [socket]);

  // Gimbal rotation handlers (continuous while held)
  const startRotation = useCallback((yawSpeed: number, pitchSpeed: number) => {
    // Send initial command
    sendCommand({ type: "rotate", yawSpeed, pitchSpeed });
    
    // Continue sending while held
    rotationIntervalRef.current = setInterval(() => {
      sendCommand({ type: "rotate", yawSpeed, pitchSpeed });
    }, 100); // 10Hz update rate
  }, [sendCommand]);

  const stopRotation = useCallback(() => {
    if (rotationIntervalRef.current) {
      clearInterval(rotationIntervalRef.current);
      rotationIntervalRef.current = null;
    }
    // Send stop command
    sendCommand({ type: "rotate", yawSpeed: 0, pitchSpeed: 0 });
  }, [sendCommand]);

  // Zoom handler
  const handleZoomChange = useCallback((value: number[]) => {
    const zoomLevel = value[0];
    setStatus(prev => ({ ...prev, zoom: zoomLevel }));
    sendCommand({ type: "zoom", level: zoomLevel });
  }, [sendCommand]);

  // Action handlers
  const handlePhoto = useCallback(() => {
    sendCommand({ type: "photo" });
  }, [sendCommand]);

  const handleRecordToggle = useCallback(() => {
    sendCommand({ type: "recordToggle" });
    setStatus(prev => ({ ...prev, recording: !prev.recording }));
  }, [sendCommand]);

  const handleCenter = useCallback(() => {
    sendCommand({ type: "center" });
    setStatus(prev => ({ ...prev, yaw: 0, pitch: 0 }));
  }, [sendCommand]);

  const handleNadir = useCallback(() => {
    sendCommand({ type: "nadir" });
    setStatus(prev => ({ ...prev, yaw: 0, pitch: -90 }));
  }, [sendCommand]);

  return (
    <div className="h-full flex flex-col bg-zinc-900">
      {/* App Header */}
      <div className="border-b border-zinc-700 bg-zinc-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-white">Camera Feed</h2>
            <p className="text-sm text-zinc-400">SIYI A8 mini Gimbal Camera</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="text-zinc-400 hover:text-white">
              <Settings size={20} />
            </Button>
            <Button variant="ghost" size="icon" className="text-zinc-400 hover:text-white">
              <Maximize2 size={20} />
            </Button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-6 overflow-auto">
        <div className="flex flex-col gap-4 max-w-6xl mx-auto">
          
          {/* Video Player */}
          <Card className="bg-zinc-800 border-zinc-700 overflow-hidden">
            <div className="relative aspect-video bg-black">
              {streamUrl ? (
                <video
                  ref={videoRef}
                  className="w-full h-full object-contain"
                  autoPlay
                  muted
                  playsInline
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500">
                  <VideoOff size={64} className="mb-4" />
                  <p className="text-lg font-medium">No Video Stream</p>
                  <p className="text-sm text-zinc-600">Waiting for camera connection...</p>
                </div>
              )}
              
              {/* Video Overlay - Crosshair */}
              <div className="absolute inset-0 pointer-events-none">
                {/* Center crosshair */}
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                  <div className="w-8 h-[1px] bg-white/50" />
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[1px] h-8 bg-white/50" />
                </div>
                
                {/* Altitude indicator (top-left) */}
                <div className="absolute top-4 left-4 bg-black/50 px-3 py-1 rounded text-white text-sm font-mono">
                  ALT: --m
                </div>
                
                {/* Recording indicator */}
                {status.recording && (
                  <div className="absolute top-4 right-4 flex items-center gap-2 bg-red-600/80 px-3 py-1 rounded">
                    <Circle className="w-3 h-3 fill-white text-white animate-pulse" />
                    <span className="text-white text-sm font-medium">REC</span>
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Control Panels */}
          <div className="grid grid-cols-3 gap-4">
            
            {/* Gimbal Control Panel */}
            <Card className="bg-zinc-800 border-zinc-700 p-4">
              <h3 className="text-sm font-medium text-zinc-400 mb-4 text-center">GIMBAL</h3>
              <div className="flex flex-col items-center gap-2">
                {/* Up button */}
                <Button
                  variant="outline"
                  size="icon"
                  className="w-12 h-12 rounded-full bg-zinc-700 border-zinc-600 hover:bg-zinc-600 text-white"
                  onMouseDown={() => startRotation(0, 50)}
                  onMouseUp={stopRotation}
                  onMouseLeave={stopRotation}
                  onTouchStart={() => startRotation(0, 50)}
                  onTouchEnd={stopRotation}
                >
                  <ChevronUp size={24} />
                </Button>
                
                {/* Middle row: Left, Center, Right */}
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    className="w-12 h-12 rounded-full bg-zinc-700 border-zinc-600 hover:bg-zinc-600 text-white"
                    onMouseDown={() => startRotation(-50, 0)}
                    onMouseUp={stopRotation}
                    onMouseLeave={stopRotation}
                    onTouchStart={() => startRotation(-50, 0)}
                    onTouchEnd={stopRotation}
                  >
                    <ChevronLeft size={24} />
                  </Button>
                  
                  <Button
                    variant="outline"
                    size="icon"
                    className="w-12 h-12 rounded-full bg-zinc-600 border-zinc-500 hover:bg-zinc-500 text-white"
                    onClick={handleCenter}
                  >
                    <Circle size={16} className="fill-current" />
                  </Button>
                  
                  <Button
                    variant="outline"
                    size="icon"
                    className="w-12 h-12 rounded-full bg-zinc-700 border-zinc-600 hover:bg-zinc-600 text-white"
                    onMouseDown={() => startRotation(50, 0)}
                    onMouseUp={stopRotation}
                    onMouseLeave={stopRotation}
                    onTouchStart={() => startRotation(50, 0)}
                    onTouchEnd={stopRotation}
                  >
                    <ChevronRight size={24} />
                  </Button>
                </div>
                
                {/* Down button */}
                <Button
                  variant="outline"
                  size="icon"
                  className="w-12 h-12 rounded-full bg-zinc-700 border-zinc-600 hover:bg-zinc-600 text-white"
                  onMouseDown={() => startRotation(0, -50)}
                  onMouseUp={stopRotation}
                  onMouseLeave={stopRotation}
                  onTouchStart={() => startRotation(0, -50)}
                  onTouchEnd={stopRotation}
                >
                  <ChevronDown size={24} />
                </Button>
              </div>
            </Card>

            {/* Zoom Control Panel */}
            <Card className="bg-zinc-800 border-zinc-700 p-4">
              <h3 className="text-sm font-medium text-zinc-400 mb-4 text-center">ZOOM</h3>
              <div className="flex flex-col items-center gap-4">
                <span className="text-2xl font-mono text-white">{status.zoom.toFixed(1)}x</span>
                <div className="flex items-center gap-3 w-full">
                  <Button
                    variant="outline"
                    size="icon"
                    className="w-10 h-10 rounded-full bg-zinc-700 border-zinc-600 hover:bg-zinc-600 text-white"
                    onClick={() => handleZoomChange([Math.max(1, status.zoom - 0.5)])}
                  >
                    <Minus size={18} />
                  </Button>
                  
                  <Slider
                    value={[status.zoom]}
                    min={1}
                    max={6}
                    step={0.1}
                    onValueChange={handleZoomChange}
                    className="flex-1"
                  />
                  
                  <Button
                    variant="outline"
                    size="icon"
                    className="w-10 h-10 rounded-full bg-zinc-700 border-zinc-600 hover:bg-zinc-600 text-white"
                    onClick={() => handleZoomChange([Math.min(6, status.zoom + 0.5)])}
                  >
                    <Plus size={18} />
                  </Button>
                </div>
              </div>
            </Card>

            {/* Status Panel */}
            <Card className="bg-zinc-800 border-zinc-700 p-4">
              <h3 className="text-sm font-medium text-zinc-400 mb-4 text-center">STATUS</h3>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between items-center">
                  <span className="text-zinc-400">Yaw:</span>
                  <span className="font-mono text-white">{status.yaw.toFixed(1)}°</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-zinc-400">Pitch:</span>
                  <span className="font-mono text-white">{status.pitch.toFixed(1)}°</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-zinc-400">Recording:</span>
                  <span className={`flex items-center gap-1 ${status.recording ? 'text-red-500' : 'text-zinc-500'}`}>
                    <Circle className={`w-2 h-2 ${status.recording ? 'fill-red-500' : 'fill-zinc-500'}`} />
                    {status.recording ? 'ON' : 'OFF'}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-zinc-400">Connected:</span>
                  <span className={`flex items-center gap-1 ${status.connected ? 'text-green-500' : 'text-red-500'}`}>
                    <Activity size={14} />
                    {status.connected ? 'Yes' : 'No'}
                  </span>
                </div>
              </div>
            </Card>
          </div>

          {/* Action Buttons */}
          <div className="grid grid-cols-4 gap-4">
            <Button
              variant="outline"
              className="bg-zinc-800 border-zinc-700 hover:bg-zinc-700 text-white py-6"
              onClick={handlePhoto}
            >
              <Camera size={20} className="mr-2" />
              Photo
            </Button>
            
            <Button
              variant="outline"
              className={`py-6 ${
                status.recording 
                  ? 'bg-red-600 border-red-500 hover:bg-red-700 text-white' 
                  : 'bg-zinc-800 border-zinc-700 hover:bg-zinc-700 text-white'
              }`}
              onClick={handleRecordToggle}
            >
              <Video size={20} className="mr-2" />
              {status.recording ? 'Stop' : 'Record'}
            </Button>
            
            <Button
              variant="outline"
              className="bg-zinc-800 border-zinc-700 hover:bg-zinc-700 text-white py-6"
              onClick={handleCenter}
            >
              <Home size={20} className="mr-2" />
              Center
            </Button>
            
            <Button
              variant="outline"
              className="bg-zinc-800 border-zinc-700 hover:bg-zinc-700 text-white py-6"
              onClick={handleNadir}
            >
              <ArrowDown size={20} className="mr-2" />
              Nadir
            </Button>
          </div>

          {/* Connection Info */}
          {!status.connected && (
            <Card className="bg-zinc-800/50 border-zinc-700 p-6 text-center">
              <VideoOff className="mx-auto mb-4 text-zinc-500" size={48} />
              <h3 className="text-lg font-medium text-white mb-2">Camera Not Connected</h3>
              <p className="text-sm text-zinc-400 mb-4">
                The SIYI A8 mini camera is not responding. Please check:
              </p>
              <ul className="text-sm text-zinc-500 text-left max-w-md mx-auto space-y-1">
                <li>• Camera is powered on and connected to the network</li>
                <li>• Camera IP is set to 192.168.144.25</li>
                <li>• Companion computer camera service is running</li>
                <li>• Network connectivity between components</li>
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
