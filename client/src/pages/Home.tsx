import { useState } from "react";
// Quiver Hub branding
const HUB_TITLE = "Quiver Hub";
const HUB_SUBTITLE = "UAV Data Pipeline Platform";
import { Radio, Map, Package } from "lucide-react";
import AppSidebar, { App } from "@/components/AppSidebar";
import LidarApp from "@/components/apps/LidarApp";
import AppStore from "@/components/apps/AppStore";

export default function Home() {
  // Available apps
  const apps: App[] = [
    {
      id: "lidar",
      name: "RPLidar Terrain Mapping",
      icon: Radio,
      enabled: true,
    },
    {
      id: "telemetry",
      name: "Telemetry",
      icon: Map,
      enabled: false, // Placeholder for future app
    },
  ];

  const [activeAppId, setActiveAppId] = useState<string>("lidar");
  const [showAppStore, setShowAppStore] = useState(false);

  const handleAddApp = () => {
    setShowAppStore(true);
  };

  const renderApp = () => {
    if (showAppStore) {
      return <AppStore />;
    }

    switch (activeAppId) {
      case "lidar":
        return <LidarApp />;
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
