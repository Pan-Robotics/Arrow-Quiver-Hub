import { useState } from "react";
// Quiver Hub branding
const HUB_TITLE = "Quiver Hub";
const HUB_SUBTITLE = "UAV Data Pipeline Platform";
import { Radio, Gauge, Package, Sparkles, Settings } from "lucide-react";
import AppSidebar, { App } from "@/components/AppSidebar";
import LidarApp from "@/components/apps/LidarApp";
import TelemetryApp from "@/components/apps/TelemetryApp";
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

  // Define built-in app metadata
  const builtInAppMetadata: Record<string, { name: string; icon: React.ElementType<{ size?: number }> }> = {
    telemetry: { name: "Flight Telemetry", icon: Gauge },
  };

  // Always show RPLidar app and Drone Config
  const builtInApps: App[] = [
    {
      id: "lidar",
      name: "RPLidar Terrain Mapping",
      icon: Radio,
      enabled: true,
    },
    {
      id: "drone-config",
      name: "Drone Configuration",
      icon: Settings,
      enabled: true,
    },
  ];

  // Convert installed apps to App format
  const installedAppsList: App[] = (installedApps || []).map(app => {
    // Check if it's a built-in app
    const builtInMeta = builtInAppMetadata[app.appId];
    if (builtInMeta) {
      return {
        id: app.appId,
        name: builtInMeta.name,
        icon: builtInMeta.icon,
        enabled: true,
      };
    }
    
    // It's a custom app
    return {
      id: `custom-${app.appId}`,
      name: app.name,
      icon: Sparkles,
      enabled: true,
    };
  });

  // Combine built-in and installed apps
  const apps: App[] = [...builtInApps, ...installedAppsList];

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
      case "telemetry":
        return <TelemetryApp droneId="quiver_001" />;
      case "drone-config":
        return <DroneConfig />;
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
