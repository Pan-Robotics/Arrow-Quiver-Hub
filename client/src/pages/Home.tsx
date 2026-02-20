import { useState } from "react";
// Quiver Hub branding
const HUB_TITLE = "Quiver Hub";
const HUB_SUBTITLE = "UAV Data Pipeline Platform";
import { Radio, Gauge, Package, Sparkles, Settings, Camera, ScrollText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import AppSidebar, { App } from "@/components/AppSidebar";
import LidarApp from "@/components/apps/LidarApp";
import TelemetryApp from "@/components/apps/TelemetryApp";
import CameraFeedApp from "@/components/apps/CameraFeedApp";
import DroneConfig from "@/pages/DroneConfig";
import AppStore from "@/components/apps/AppStore";
import AppRenderer from "@/components/apps/AppRenderer";
import AppManagement from "@/pages/AppManagement";
import { trpc } from "@/lib/trpc";

export default function Home() {
  const [activeAppId, setActiveAppId] = useState<string>("lidar");
  const [showAppStore, setShowAppStore] = useState(false);
  const [showAppManagement, setShowAppManagement] = useState(false);
  const [editingAppId, setEditingAppId] = useState<string | null>(null);
  
  // Load installed apps (both custom and built-in)
  const { data: installedApps } = trpc.appBuilder.getUserApps.useQuery();

  // Define built-in app metadata (apps that can be installed/uninstalled)
  const builtInAppMetadata: Record<string, { name: string; icon: React.ElementType<{ size?: number }> }> = {
    telemetry: { name: "Flight Telemetry", icon: Gauge },
    camera: { name: "Camera Feed", icon: Camera },
    "logs-ota": { name: "Logs & OTA Updates", icon: ScrollText },
  };

  // Get list of installed app IDs
  const installedAppIds = new Set((installedApps || []).map(app => app.appId));

  // Core apps that are always visible (not uninstallable)
  const coreApps: App[] = [
    {
      id: "lidar",
      name: "RPLidar Terrain Mapping",
      icon: Radio,
      enabled: true,
    },
  ];

  // Bottom-pinned apps (shown just above the + button)
  const bottomApps: App[] = [
    {
      id: "drone-config",
      name: "Drone Configuration",
      icon: Settings,
      enabled: true,
    },
  ];

  // Built-in apps that are installable/uninstallable (only show if installed)
  const installedBuiltInApps: App[] = Object.entries(builtInAppMetadata)
    .filter(([appId]) => installedAppIds.has(appId))
    .map(([appId, meta]) => ({
      id: appId,
      name: meta.name,
      icon: meta.icon,
      enabled: true,
    }));

  // Custom apps (filter out built-in apps)
  const installedCustomApps: App[] = (installedApps || [])
    .filter(app => !builtInAppMetadata[app.appId])
    .map(app => ({
      id: `custom-${app.appId}`,
      name: app.name,
      icon: Sparkles,
      enabled: true,
    }));

  // Combine all apps: core + installed built-in + installed custom
  const apps: App[] = [...coreApps, ...installedBuiltInApps, ...installedCustomApps];

  const handleAddApp = () => {
    setShowAppStore(true);
  };

  const renderApp = () => {
    if (showAppStore) {
      return <AppStore 
        onInstallApp={() => setShowAppStore(false)} 
        onManageApps={() => {
          setShowAppStore(false);
          setShowAppManagement(true);
        }}
        editingAppId={editingAppId}
        onCloseEdit={() => setEditingAppId(null)}
      />;
    }

    if (showAppManagement) {
      return <AppManagement 
        onGoToStore={() => {
          setShowAppManagement(false);
          setShowAppStore(true);
        }}
        onEditApp={(appId) => {
          setEditingAppId(appId);
          setShowAppManagement(false);
          setShowAppStore(true);
        }}
      />;
    }

    // Check if it's a custom app
    if (activeAppId.startsWith('custom-')) {
      const appId = activeAppId.replace('custom-', '');
      return <AppRenderer appId={appId} />;
    }

    switch (activeAppId) {
      case "lidar":
        return <LidarApp />;
      case "camera":
        return <CameraFeedApp />;
      case "telemetry":
        return <TelemetryApp />;
      case "drone-config":
        return <DroneConfig />;
      case "logs-ota":
        return (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <ScrollText className="mx-auto mb-4 text-muted-foreground" size={64} />
              <h2 className="text-2xl font-semibold mb-2">Logs & OTA Updates</h2>
              <p className="text-muted-foreground mb-1">Remote log streaming, system diagnostics, and over-the-air firmware updates.</p>
              <Badge variant="secondary" className="mt-3">Coming Soon</Badge>
            </div>
          </div>
        );
      default:
        return (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <Package className="mx-auto mb-4 text-muted-foreground" size={64} />
              <h2 className="text-2xl font-semibold mb-2">App Not Available</h2>
              <p className="text-muted-foreground">This app is coming soon.</p>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Sidebar */}
      <AppSidebar
        apps={apps}
        bottomApps={bottomApps}
        activeAppId={showAppStore ? "store" : activeAppId}
        onAppChange={(appId) => {
          setShowAppStore(false);
          setShowAppManagement(false);
          setActiveAppId(appId);
        }}
        onAddApp={handleAddApp}
      />

      {/* Main Content Area (with left margin for sidebar) */}
      <div className="ml-16 min-h-screen flex flex-col">
        {/* Global Header */}
        <header className="border-b border-border bg-card">
          <div className="px-6 py-4">
            <div className="flex items-center gap-3">
              <Radio className="text-primary" size={28} />
              <div>
                <h1 className="text-xl font-bold">{HUB_TITLE}</h1>
                <p className="text-xs text-muted-foreground">{HUB_SUBTITLE}</p>
              </div>
            </div>
          </div>
        </header>

        {/* App Content */}
        <main className="flex-1">
          {renderApp()}
        </main>
      </div>
    </div>
  );
}
