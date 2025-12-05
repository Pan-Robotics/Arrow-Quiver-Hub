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

export function getWebSocketServer() {
  return io;
}
