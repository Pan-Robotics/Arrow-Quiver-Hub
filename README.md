# Quiver Hub

**UAV Data Pipeline Platform**

Quiver Hub is a modular web platform for managing and visualizing multiple UAV (drone) data pipelines in a unified interface. Built with a modern tech stack, it provides a flexible app-based architecture where different data sources and visualization tools can be added as independent modules.

---

## Overview

Quiver Hub transforms traditional single-purpose drone data viewers into a comprehensive platform where multiple data pipelines coexist. The platform features:

- **Modular App Architecture** - Each data pipeline is an independent app module
- **Unified Interface** - Single hub for all UAV data sources
- **Real-time Updates** - WebSocket-based live data streaming
- **Multi-drone Support** - Handle data from multiple drones simultaneously
- **Extensible Design** - Easy to add new apps and data pipelines

---

## Current Apps

### 1. RPLidar Terrain Mapping
Real-time LiDAR point cloud visualization with:
- Live 2D point cloud rendering on HTML5 canvas
- Heatmap accumulation mode for persistent mapping
- Distance and quality-based point filtering
- Zoom, pan, and reset controls
- Connection status and statistics display

**Data Flow:**
```
Raspberry Pi (RPLidar C1) 
  → TCP Stream → 
Companion Computer (Forwarder) 
  → HTTP POST → 
Quiver Hub (Web Server) 
  → WebSocket → 
Browser (Visualization)
```

---

## Architecture

### Frontend
- **Framework**: React 19 + TypeScript
- **Styling**: Tailwind CSS 4
- **UI Components**: shadcn/ui
- **State Management**: tRPC React Query
- **Real-time**: Socket.IO client

### Backend
- **Runtime**: Node.js + Express
- **API**: tRPC 11 (type-safe RPC)
- **Database**: MySQL/TiDB (via Drizzle ORM)
- **Real-time**: Socket.IO server
- **Auth**: Manus OAuth

### Key Directories

```
client/
  src/
    components/
      AppSidebar.tsx          ← Sidebar navigation with app icons
      apps/
        LidarApp.tsx          ← RPLidar visualization app
        AppStore.tsx          ← App marketplace UI
      PointCloudViewer.tsx    ← Canvas-based point cloud renderer
    pages/
      Home.tsx                ← Main hub layout
server/
  routers.ts                  ← tRPC API endpoints
  db.ts                       ← Database queries
  _core/
    websocket.ts              ← Socket.IO server
drizzle/
  schema.ts                   ← Database schema (drones, API keys, etc.)
```

---

## Getting Started

### Prerequisites
- Node.js 22+
- MySQL/TiDB database
- pnpm package manager

### Installation

```bash
# Install dependencies
pnpm install

# Push database schema
pnpm db:push

# Start development server
pnpm dev
```

### Configuration

Environment variables are managed through the Manus platform. Key variables:

- `DATABASE_URL` - MySQL connection string
- `JWT_SECRET` - Session signing secret
- `VITE_APP_TITLE` - Browser tab title (set to "Quiver Hub")
- `VITE_APP_LOGO` - Platform logo URL

Update `VITE_APP_TITLE` via Management Dashboard → Settings → General.

---

## Adding New Apps

Quiver Hub is designed for easy extensibility. To add a new data pipeline app:

### 1. Create App Component

```tsx
// client/src/components/apps/YourApp.tsx
export default function YourApp() {
  return (
    <div className="h-full flex flex-col">
      {/* App Header */}
      <div className="border-b border-border bg-card px-6 py-4">
        <h2 className="text-xl font-semibold">Your App Name</h2>
        <p className="text-sm text-muted-foreground">App description</p>
      </div>
      
      {/* App Content */}
      <div className="flex-1 p-6 overflow-auto">
        {/* Your visualization/UI here */}
      </div>
    </div>
  );
}
```

### 2. Register in Home.tsx

```tsx
import YourApp from "@/components/apps/YourApp";

const apps: App[] = [
  // ... existing apps
  {
    id: "your-app",
    name: "Your App Name",
    icon: YourIcon,
    enabled: true,
  },
];

// Add to renderApp() switch
case "your-app":
  return <YourApp />;
```

### 3. Add Backend Endpoints (if needed)

```tsx
// server/routers.ts
yourApp: router({
  getData: publicProcedure.query(async () => {
    // Your data fetching logic
  }),
}),
```

---

## Future Development Direction

### Phase 1: Core Platform Enhancement
- **App Registry System** - Database-backed app installation/removal
- **User Preferences** - Per-user app configuration and layout
- **App Permissions** - Role-based access control for apps
- **App Marketplace** - Browse and install apps from catalog

### Phase 2: Additional Data Pipelines
- **Flight Telemetry** - Real-time altitude, speed, battery, GPS tracking
- **Camera Feeds** - Live video streaming with recording
- **Mission Planner** - Waypoint-based autonomous flight planning
- **Flight Analytics** - Historical data analysis and performance metrics

### Phase 3: Advanced Features
- **Multi-drone Dashboard** - Side-by-side comparison view
- **Data Export** - CSV, JSON, KML export for all apps
- **Alert System** - Configurable alerts for critical events
- **API Gateway** - Unified REST API for external integrations

### Phase 4: Collaboration & Sharing
- **Team Workspaces** - Shared drone access for teams
- **Live Sharing** - Share real-time views with stakeholders
- **Report Generation** - Automated flight reports and summaries

---

## RPLidar Integration

### Hardware Setup

**Components:**
- RPLidar C1 (360° laser scanner)
- Raspberry Pi (data collection)
- Companion Computer (data forwarding)

**Software Stack:**
- `rplidar_c1.py` - Python library for RPLidar C1
- `pointcloud_streamer.py` - TCP streamer on Raspberry Pi
- `pointcloud_forwarder_heatmap.py` - HTTP forwarder on companion computer

### Data Pipeline

1. **Raspberry Pi** reads scan data from RPLidar C1 via serial
2. **Streamer** converts to JSON and sends via TCP to companion computer
3. **Forwarder** accumulates scans into heatmap and POSTs to Quiver Hub
4. **Quiver Hub** broadcasts to connected browsers via WebSocket
5. **Browser** renders point cloud on canvas in real-time

### Configuration

**Forwarder Environment:**
```bash
WEB_SERVER_URL=https://your-hub.manus.space/api/rest/pointcloud/ingest
API_KEY=your_api_key
DRONE_ID=quiver_001
UPDATE_INTERVAL=10  # Send every N scans
```

**Key Features:**
- Angle normalization (wraps 360°+)
- Distance filtering (rejects spurious readings > 8m)
- Heatmap accumulation (reduces HTTP overhead)
- Full 360° scan validation

---

## API Reference

### REST Endpoints

#### POST /api/rest/pointcloud/ingest
Ingest point cloud data from external sources.

**Request Body:**
```json
{
  "api_key": "string",
  "drone_id": "string",
  "timestamp": "ISO8601",
  "points": [
    {
      "angle": 0.0,
      "distance": 1000.0,
      "quality": 63,
      "x": 1000.0,
      "y": 0.0
    }
  ],
  "stats": {
    "point_count": 800,
    "valid_points": 750,
    "min_distance": 100.0,
    "max_distance": 8000.0,
    "avg_distance": 2500.0,
    "avg_quality": 45.0
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Point cloud data received"
}
```

### WebSocket Events

#### Client → Server
- `subscribe` - Subscribe to drone updates
  ```json
  { "droneId": "quiver_001" }
  ```

#### Server → Client
- `pointcloud` - New point cloud data
  ```json
  {
    "droneId": "quiver_001",
    "timestamp": "2025-11-18T12:00:00Z",
    "points": [...],
    "stats": {...}
  }
  ```

### tRPC Procedures

#### `pointcloud.getDrones`
Get list of connected drones.

**Returns:**
```typescript
Array<{
  id: number;
  droneId: string;
  name: string | null;
  lastSeen: Date;
}>
```

---

## Deployment

### Via Manus Platform

1. Create checkpoint via Management UI
2. Click "Publish" in dashboard header
3. Site is live at `https://your-project.manus.space`

### Custom Deployment

```bash
# Build frontend
cd client && pnpm build

# Start production server
NODE_ENV=production pnpm start
```

**Environment Requirements:**
- Node.js 22+
- MySQL/TiDB database
- SSL certificate (for WebSocket)

---

## Contributing

Quiver Hub is designed for extensibility. Contributions welcome for:

- New app modules (telemetry, cameras, sensors)
- UI/UX improvements
- Performance optimizations
- Documentation enhancements

---

## License

MIT License - See LICENSE file for details

---

## Support

For issues, questions, or feature requests:
- GitHub Issues: [your-repo]/issues
- Documentation: [your-docs-url]
- Community: [your-community-url]

---

## Acknowledgments

- **RPLidar C1** by SLAMTEC
- **shadcn/ui** for UI components
- **tRPC** for type-safe APIs
- **Manus Platform** for hosting and deployment
