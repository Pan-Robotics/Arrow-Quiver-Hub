import { useState, useEffect, useRef, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
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
  Activity,
  VideoOff,
  Loader2,
  Wifi,
  WifiOff,
  RefreshCw
} from "lucide-react";
import { io, Socket } from "socket.io-client";
import { useDroneSelection } from "@/hooks/useDroneSelection";

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

/**
 * Connect to a go2rtc WebRTC stream using the WHEP-like signaling API.
 * 
 * Flow:
 * 1. Create RTCPeerConnection with STUN servers
 * 2. Add a transceiver for video (recvonly)
 * 3. Create SDP offer
 * 4. POST offer to go2rtc's /api/webrtc endpoint
 * 5. Receive SDP answer
 * 6. Set remote description
 * 7. Media starts flowing peer-to-peer via UDP
 */
async function connectWebRTC(
  webrtcUrl: string,
  videoElement: HTMLVideoElement,
  onConnected: () => void,
  onDisconnected: (reason: string) => void,
): Promise<RTCPeerConnection> {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
    iceCandidatePoolSize: 4,
  });

  // Add receive-only transceivers for video and audio
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  // Handle incoming media stream
  pc.ontrack = (event) => {
    if (event.streams.length > 0) {
      videoElement.srcObject = event.streams[0];
      onConnected();
    }
  };

  // Monitor connection state
  pc.onconnectionstatechange = () => {
    switch (pc.connectionState) {
      case "connected":
        onConnected();
        break;
      case "disconnected":
        onDisconnected("Connection lost");
        break;
      case "failed":
        onDisconnected("Connection failed");
        break;
      case "closed":
        onDisconnected("Connection closed");
        break;
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === "failed") {
      onDisconnected("ICE negotiation failed — NAT traversal may be blocked");
    }
  };

  // Create and set local offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Wait for ICE gathering to complete (or timeout after 3s)
  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, 3000);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timeout);
        resolve();
      }
    };
  });

  // Send offer to go2rtc WHEP endpoint
  const response = await fetch(webrtcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: pc.localDescription?.sdp,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`WebRTC signaling failed (${response.status}): ${text}`);
  }

  // Set remote answer
  const answerSdp = await response.text();
  await pc.setRemoteDescription(new RTCSessionDescription({
    type: "answer",
    sdp: answerSdp,
  }));

  return pc;
}

export default function CameraFeedApp() {
  // Drone selection via shared hook
  const { selectedDrone, setSelectedDrone, drones, isLoading: dronesLoading } = useDroneSelection("camera");

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
  const [webrtcUrl, setWebrtcUrl] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  
  // Gimbal control state (for continuous rotation while button held)
  const rotationIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize WebSocket connection
  useEffect(() => {
    if (!selectedDrone) return;

    // Reset state when switching drones
    setStatus({
      connected: false,
      yaw: 0,
      pitch: 0,
      roll: 0,
      zoom: 1,
      recording: false,
      streamActive: false,
    });
    setWebrtcUrl(null);
    setStreamError(null);

    const socketInstance = io({
      path: "/socket.io/",
      timeout: 5000,
    });

    socketInstance.on("connect", () => {
      console.log("Camera WebSocket connected");
      socketInstance.emit("subscribe_camera", selectedDrone);
    });

    socketInstance.on("disconnect", () => {
      console.log("Camera WebSocket disconnected");
      setStatus(prev => ({ ...prev, connected: false, streamActive: false }));
    });

    // Listen for camera status updates
    socketInstance.on("camera_status", (data: any) => {
      setStatus(prev => ({
        ...prev,
        connected: data.connected ?? prev.connected,
        yaw: data.attitude?.yaw ?? prev.yaw,
        pitch: data.attitude?.pitch ?? prev.pitch,
        roll: data.attitude?.roll ?? prev.roll,
        zoom: data.zoom_level ?? prev.zoom,
        recording: data.recording ?? prev.recording,
      }));
    });

    // Listen for WebRTC stream URL updates from server
    socketInstance.on("camera_stream", (data: { url: string | null }) => {
      console.log("[Camera] WebRTC URL received:", data.url);
      if (data.url) {
        setWebrtcUrl(data.url);
        setStatus(prev => ({ ...prev, streamActive: true }));
      } else {
        setWebrtcUrl(null);
        setStatus(prev => ({ ...prev, streamActive: false }));
      }
    });

    socketInstance.on("connect_error", (error) => {
      console.warn("Camera WebSocket error:", error);
      setStatus(prev => ({ ...prev, connected: false }));
    });

    setSocket(socketInstance);

    // Also poll for stream status on initial load
    fetch(`/api/rest/camera/stream-status/${selectedDrone}`)
      .then(res => res.json())
      .then(data => {
        if (data.active && data.webrtc_url) {
          setWebrtcUrl(data.webrtc_url);
          setStatus(prev => ({ ...prev, streamActive: true }));
        }
      })
      .catch(() => { /* ignore polling errors */ });

    return () => {
      socketInstance.emit("unsubscribe_camera", selectedDrone);
      socketInstance.disconnect();
    };
  }, [selectedDrone]);

  // WebRTC connection - connect/disconnect when webrtcUrl changes
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Cleanup previous peer connection
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    video.srcObject = null;

    if (!webrtcUrl) {
      return;
    }

    setStreamError(null);
    setIsConnecting(true);

    let cancelled = false;

    connectWebRTC(
      webrtcUrl,
      video,
      () => {
        // onConnected
        if (!cancelled) {
          setIsConnecting(false);
          setStreamError(null);
          video.play().catch(() => {
            console.warn("[WebRTC] Autoplay blocked");
          });
        }
      },
      (reason) => {
        // onDisconnected
        if (!cancelled) {
          setStreamError(reason);
          setStatus(prev => ({ ...prev, streamActive: false }));
        }
      },
    )
      .then((pc) => {
        if (cancelled) {
          pc.close();
        } else {
          pcRef.current = pc;
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("[WebRTC] Connection error:", err);
          setStreamError(err.message || "Failed to connect to WebRTC stream");
          setIsConnecting(false);
        }
      });

    return () => {
      cancelled = true;
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
    };
  }, [webrtcUrl]);

  // Send command to camera via WebSocket
  const sendCommand = useCallback((command: GimbalCommand) => {
    if (socket?.connected && selectedDrone) {
      socket.emit("camera_command", { droneId: selectedDrone, command });
    }
  }, [socket, selectedDrone]);

  // Gimbal rotation handlers (continuous while held)
  const startRotation = useCallback((yawSpeed: number, pitchSpeed: number) => {
    sendCommand({ type: "rotate", yawSpeed, pitchSpeed });
    rotationIntervalRef.current = setInterval(() => {
      sendCommand({ type: "rotate", yawSpeed, pitchSpeed });
    }, 100);
  }, [sendCommand]);

  const stopRotation = useCallback(() => {
    if (rotationIntervalRef.current) {
      clearInterval(rotationIntervalRef.current);
      rotationIntervalRef.current = null;
    }
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

  // Fullscreen toggle
  const toggleFullscreen = useCallback(() => {
    if (!videoContainerRef.current) return;
    if (!document.fullscreenElement) {
      videoContainerRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  }, []);

  // Retry stream connection
  const retryStream = useCallback(() => {
    if (!selectedDrone) return;
    setStreamError(null);
    setIsConnecting(true);
    
    // Close existing connection
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    // Re-poll for stream status
    fetch(`/api/rest/camera/stream-status/${selectedDrone}`)
      .then(res => res.json())
      .then(data => {
        if (data.active && data.webrtc_url) {
          // Force re-connect by toggling URL
          setWebrtcUrl(null);
          setTimeout(() => setWebrtcUrl(data.webrtc_url), 100);
          setStatus(prev => ({ ...prev, streamActive: true }));
        } else {
          setStreamError("No active stream found for this drone");
          setIsConnecting(false);
        }
      })
      .catch(() => {
        setStreamError("Failed to check stream status");
        setIsConnecting(false);
      });
  }, [selectedDrone]);

  return (
    <div className="h-full flex flex-col bg-zinc-900">
      {/* App Header */}
      <div className="border-b border-zinc-700 bg-zinc-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div>
              <h2 className="text-xl font-semibold text-white">Camera Feed</h2>
              <p className="text-sm text-zinc-400">SIYI A8 mini Gimbal Camera</p>
            </div>
            {/* Stream status badge */}
            {selectedDrone && (
              <Badge 
                variant="outline" 
                className={`text-xs ${
                  status.streamActive 
                    ? "border-green-600 text-green-400" 
                    : "border-zinc-600 text-zinc-400"
                }`}
              >
                {status.streamActive ? (
                  <><Wifi size={12} className="mr-1" /> WebRTC Live</>
                ) : (
                  <><WifiOff size={12} className="mr-1" /> No Stream</>
                )}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3">
            {/* Drone Selector */}
            {dronesLoading ? (
              <div className="flex items-center gap-2">
                <Loader2 className="animate-spin text-zinc-400" size={16} />
                <span className="text-sm text-zinc-400">Loading drones...</span>
              </div>
            ) : drones && drones.length > 0 ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-zinc-400">Drone:</span>
                <Select value={selectedDrone || undefined} onValueChange={setSelectedDrone}>
                  <SelectTrigger className="w-[200px] bg-zinc-700 border-zinc-600 text-white">
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
              <div className="text-sm text-zinc-400">No drones registered</div>
            )}

            <Button variant="ghost" size="icon" className="text-zinc-400 hover:text-white">
              <Settings size={20} />
            </Button>
            <Button 
              variant="ghost" 
              size="icon" 
              className="text-zinc-400 hover:text-white"
              onClick={toggleFullscreen}
            >
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
            <div ref={videoContainerRef} className="relative aspect-video bg-black">
              {/* WebRTC Video Element */}
              <video
                ref={videoRef}
                className={`w-full h-full object-contain ${webrtcUrl ? 'block' : 'hidden'}`}
                autoPlay
                muted
                playsInline
              />
              
              {/* Connecting overlay */}
              {webrtcUrl && isConnecting && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 z-10">
                  <Loader2 size={48} className="animate-spin text-blue-400 mb-3" />
                  <p className="text-sm text-zinc-300">Establishing WebRTC connection...</p>
                </div>
              )}

              {/* Error overlay */}
              {webrtcUrl && streamError && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-10">
                  <WifiOff size={48} className="text-red-400 mb-3" />
                  <p className="text-sm text-red-300 mb-2">{streamError}</p>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    className="border-zinc-600 text-white hover:bg-zinc-700"
                    onClick={retryStream}
                  >
                    <RefreshCw size={14} className="mr-1" /> Retry
                  </Button>
                </div>
              )}

              {/* No stream placeholder */}
              {!webrtcUrl && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500">
                  <VideoOff size={64} className="mb-4" />
                  <p className="text-lg font-medium">No Video Stream</p>
                  <p className="text-sm text-zinc-600 mb-4">
                    {selectedDrone 
                      ? `Waiting for WebRTC stream from ${selectedDrone}...`
                      : "Select a drone to view camera feed"
                    }
                  </p>
                  {selectedDrone && (
                    <Button 
                      variant="outline" 
                      size="sm" 
                      className="border-zinc-600 text-zinc-300 hover:bg-zinc-700"
                      onClick={retryStream}
                    >
                      <RefreshCw size={14} className="mr-1" /> Check for stream
                    </Button>
                  )}
                </div>
              )}
              
              {/* Video Overlay - Crosshair (only when stream is active) */}
              {webrtcUrl && !streamError && (
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
              )}
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
                <div className="flex justify-between items-center">
                  <span className="text-zinc-400">Stream:</span>
                  <span className={`flex items-center gap-1 ${status.streamActive ? 'text-green-500' : 'text-zinc-500'}`}>
                    {status.streamActive ? <Wifi size={14} /> : <WifiOff size={14} />}
                    {status.streamActive ? 'WebRTC Active' : 'Inactive'}
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
          {selectedDrone && !status.connected && !status.streamActive && (
            <Card className="bg-zinc-800/50 border-zinc-700 p-6 text-center">
              <VideoOff className="mx-auto mb-4 text-zinc-500" size={48} />
              <h3 className="text-lg font-medium text-white mb-2">Camera Not Connected</h3>
              <p className="text-sm text-zinc-400 mb-4">
                The SIYI A8 mini camera on <strong>{selectedDrone}</strong> is not responding. Please check:
              </p>
              <ul className="text-sm text-zinc-500 text-left max-w-md mx-auto space-y-1">
                <li>• Camera is powered on and connected to the network</li>
                <li>• Camera IP is set to 192.168.144.25</li>
                <li>• Companion computer camera service is running</li>
                <li>• go2rtc is running and connected to RTSP stream</li>
                <li>• Tailscale funnel is active and accessible</li>
                <li>• WebRTC stream is registered with Quiver Hub</li>
              </ul>
            </Card>
          )}

          {!selectedDrone && !dronesLoading && (
            <Card className="bg-zinc-800/50 border-zinc-700 p-6 text-center">
              <VideoOff className="mx-auto mb-4 text-zinc-500" size={48} />
              <h3 className="text-lg font-medium text-white mb-2">No Drone Selected</h3>
              <p className="text-sm text-zinc-400">
                Please register a drone in the Drone Configuration page and select it above to view the camera feed.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
