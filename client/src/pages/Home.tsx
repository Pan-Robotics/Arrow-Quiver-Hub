import { useState } from "react";
// Quiver Hub branding
const HUB_TITLE = "Quiver Hub";
const HUB_SUBTITLE = "UAV Data Pipeline Platform";
import { Radio, Gauge, Package, Sparkles } from "lucide-react";
import AppSidebar, { App } from "@/components/AppSidebar";
import LidarApp from "@/components/apps/LidarApp";
import TelemetryApp from "@/components/apps/TelemetryApp";
import AppStore from "@/components/apps/AppStore";
import AppRenderer from "@/components/apps/AppRenderer";
import { trpc } from "@/lib/trpc";

export default function Home() {
  const [activeAppId, setActiveAppId] = useState<string>("lidar");
  const [showAppStore, setShowAppStore] = useState(false);
  
  // Load installed custom apps
  const { data: installedApps } = trpc.appBuilder.getUserApps.useQuery();

  // Built-in apps
  const builtInApps: App[] = [
    {
      id: "lidar",
      name: "RPLidar Terrain Mapping",
      icon: Radio,
      enabled: true,
    },
    {
      id: "telemetry",
      name: "Flight Telemetry",
      icon: Gauge,
      enabled: true,
    },
  ];

  // Convert installed custom apps to App format
  const customAppsList: App[] = (installedApps || []).map(app => ({
    id: `custom-${app.appId}`,
    name: app.name,
    icon: Sparkles, // Use sparkles icon for custom apps
    enabled: true,
  }));

  // Combine built-in and custom apps
  const apps: App[] = [...builtInApps, ...customAppsList];

  const handleAddApp = () => {
    setShowAppStore(true);
  };

  const renderApp = () => {
    if (showAppStore) {
      return <AppStore onInstallApp={() => setShowAppStore(false)} />;
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
