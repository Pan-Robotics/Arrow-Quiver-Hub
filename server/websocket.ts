import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';

export interface TelemetryMessage {
  drone_id: string;
  timestamp: string;
  telemetry: {
    attitude: {
      roll_deg: number;
      pitch_deg: number;
      yaw_deg: number;
      timestamp: string;
    } | null;
    position: {
      latitude_deg: number;
      longitude_deg: number;
      absolute_altitude_m: number;
      relative_altitude_m: number;
      timestamp: string;
    } | null;
    gps: {
      num_satellites: number;
      fix_type: number;
      timestamp: string;
    } | null;
    battery_fc: {
      voltage_v: number;
      remaining_percent: number;
      timestamp: string;
    } | null;
    battery_uavcan: {
      battery_id: number;
      voltage_v: number;
      current_a: number;
      temperature_k: number;
      state_of_charge_pct: number;
      timestamp: string;
    } | null;
    in_air: boolean;
  };
}

export interface CameraStatusMessage {
  drone_id: string;
  timestamp: number;
  connected: boolean;
  attitude?: {
    yaw: number;
    pitch: number;
    roll: number;
  };
  recording?: boolean;
  hdr_enabled?: boolean;
  tf_card_present?: boolean;
  zoom_level?: number;
}

export interface CameraCommandMessage {
  type: 'camera_command';
  droneId: string;
  action: string;
  params?: Record<string, any>;
}

export interface PointCloudMessage {
  drone_id: string;
  timestamp: string;
  points: Array<{
    angle: number;
    distance: number;
    quality: number;
    x: number;
    y: number;
  }>;
  stats: {
    point_count: number;
    valid_points: number;
    min_distance: number;
    max_distance: number;
    avg_distance: number;
    avg_quality: number;
  };
}

let io: SocketIOServer | null = null;

export function initializeWebSocket(httpServer: HTTPServer) {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    },
    path: "/socket.io/"
  });

  io.on('connection', (socket: Socket) => {
    console.log(`[WebSocket] Client connected: ${socket.id}`);

    socket.on('subscribe', (droneId: string) => {
      console.log(`[WebSocket] Client ${socket.id} subscribed to drone: ${droneId}`);
      socket.join(`drone:${droneId}`);
    });

    socket.on('unsubscribe', (droneId: string) => {
      console.log(`[WebSocket] Client ${socket.id} unsubscribed from drone: ${droneId}`);
      socket.leave(`drone:${droneId}`);
    });

    // Subscribe to custom app data
    socket.on('subscribe_app', (appId: string) => {
      console.log(`[WebSocket] Client ${socket.id} subscribed to app: ${appId}`);
      socket.join(`app:${appId}`);
    });

    socket.on('unsubscribe_app', (appId: string) => {
      console.log(`[WebSocket] Client ${socket.id} unsubscribed from app: ${appId}`);
      socket.leave(`app:${appId}`);
    });

    // Subscribe to camera feed
    socket.on('subscribe_camera', (droneId: string) => {
      console.log(`[WebSocket] Client ${socket.id} subscribed to camera: ${droneId}`);
      socket.join(`camera:${droneId}`);
    });

    socket.on('unsubscribe_camera', (droneId: string) => {
      console.log(`[WebSocket] Client ${socket.id} unsubscribed from camera: ${droneId}`);
      socket.leave(`camera:${droneId}`);
    });

    // Handle camera commands from frontend
    socket.on('camera_command', (message: CameraCommandMessage) => {
      console.log(`[WebSocket] Camera command from ${socket.id}:`, message.action);
      // Forward command to companion computer clients
      io?.to(`companion:${message.droneId}`).emit('camera_command', message);
    });

    // Companion computer registration
    socket.on('register_companion', (data: { droneId: string; type: string }) => {
      console.log(`[WebSocket] Companion registered: ${data.droneId} (${data.type})`);
      socket.join(`companion:${data.droneId}`);
      socket.data.companionDroneId = data.droneId;
      socket.data.companionType = data.type;
    });

    socket.on('disconnect', () => {
      console.log(`[WebSocket] Client disconnected: ${socket.id}`);
    });
  });

  console.log('[WebSocket] Server initialized');
  return io;
}

export function broadcastPointCloud(message: PointCloudMessage) {
  if (!io) {
    console.warn('[WebSocket] Cannot broadcast: server not initialized');
    return;
  }

  // Broadcast to all clients subscribed to this drone
  io.to(`drone:${message.drone_id}`).emit('pointcloud', message);
  
  // Also broadcast to general channel for dashboard
  io.emit('pointcloud_update', {
    drone_id: message.drone_id,
    timestamp: message.timestamp,
    point_count: message.stats.point_count,
  });
}

export function broadcastTelemetry(message: TelemetryMessage) {
  if (!io) {
    console.warn('[WebSocket] Cannot broadcast: server not initialized');
    return;
  }

  // Broadcast to all clients subscribed to this drone
  io.to(`drone:${message.drone_id}`).emit('telemetry', message);
  
  // Also broadcast to general channel for dashboard
  io.emit('telemetry_update', {
    drone_id: message.drone_id,
    timestamp: message.timestamp,
  });
}

/**
 * Broadcast custom app data to subscribed clients
 */
export function broadcastAppData(appId: string, data: any) {
  if (!io) {
    console.warn('[WebSocket] Cannot broadcast app data: server not initialized');
    return;
  }

  // Broadcast to all clients subscribed to this app
  io.to(`app:${appId}`).emit('app_data', {
    appId,
    data,
    timestamp: new Date().toISOString(),
  });
  
  console.log(`[WebSocket] Broadcasted data to app:${appId}`);
}

/**
 * Broadcast camera status to subscribed clients
 */
export function broadcastCameraStatus(message: CameraStatusMessage) {
  if (!io) {
    console.warn('[WebSocket] Cannot broadcast camera status: server not initialized');
    return;
  }

  // Broadcast to all clients subscribed to this drone's camera
  io.to(`camera:${message.drone_id}`).emit('camera_status', message);
}

/**
 * Broadcast camera command response to frontend
 */
export function broadcastCameraResponse(droneId: string, response: any) {
  if (!io) {
    console.warn('[WebSocket] Cannot broadcast camera response: server not initialized');
    return;
  }

  io.to(`camera:${droneId}`).emit('camera_response', response);
}

export function getWebSocketServer() {
  return io;
}
