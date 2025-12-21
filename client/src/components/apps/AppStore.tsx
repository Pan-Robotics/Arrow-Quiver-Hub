import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Package, Download, Star, TrendingUp, Plus } from "lucide-react";
import AppBuilder from "./AppBuilder";

interface StoreApp {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: React.ElementType;
  installed: boolean;
  popular?: boolean;
}

interface AppStoreProps {
  onInstallApp?: (appId: string) => void;
}

export default function AppStore({ onInstallApp }: AppStoreProps) {
  const [showBuilder, setShowBuilder] = useState(false);

  if (showBuilder) {
    return <AppBuilder onBack={() => setShowBuilder(false)} />;
  }
  // Placeholder apps for the store
  const storeApps: StoreApp[] = [
    {
      id: "telemetry",
      name: "Flight Telemetry",
      description: "Real-time flight data, altitude, speed, and battery monitoring",
      category: "Monitoring",
      icon: TrendingUp,
      installed: false,
      popular: true,
    },
    {
      id: "camera",
      name: "Camera Feed",
      description: "Live video stream from drone cameras with recording capabilities",
      category: "Media",
      icon: Package,
      installed: false,
      popular: true,
    },
    {
      id: "mission",
      name: "Mission Planner",
      description: "Plan and execute autonomous flight missions with waypoints",
      category: "Planning",
      icon: Package,
      installed: false,
    },
    {
      id: "analytics",
      name: "Flight Analytics",
      description: "Historical flight data analysis and performance metrics",
      category: "Analytics",
      icon: Package,
      installed: false,
    },
  ];

  return (
    <div className="h-full flex flex-col">
      {/* Store Header */}
      <div className="border-b border-border bg-card px-6 py-4">
        <div>
          <h2 className="text-xl font-semibold">App Store</h2>
          <p className="text-sm text-muted-foreground">Discover and install UAV data pipeline apps</p>
        </div>
      </div>

      {/* Store Content */}
      <div className="flex-1 p-6 overflow-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {storeApps.map((app) => {
            const Icon = app.icon;
            
            return (
              <Card key={app.id} className="p-6 hover:shadow-lg transition-shadow">
                <div className="flex items-start gap-4">
                  <div className="p-3 bg-primary/10 rounded-lg">
                    <Icon className="text-primary" size={24} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-semibold truncate">{app.name}</h3>
                      {app.popular && (
                        <Badge variant="secondary" className="text-xs">
                          <Star size={10} className="mr-1" />
                          Popular
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">{app.category}</p>
                    <p className="text-sm text-muted-foreground mb-4 line-clamp-2">
                      {app.description}
                    </p>
                    <Button
                      size="sm"
                      variant={app.installed ? "outline" : "default"}
                      className="w-full"
                      disabled={!app.installed}
                    >
                      {app.installed ? (
                        "Installed"
                      ) : (
                        <>
                          <Download size={14} className="mr-2" />
                          Coming Soon
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>

        {/* Create Your Own App */}
        <Card className="mt-6 p-12 text-center bg-primary/5 border-primary/20">
          <Plus className="mx-auto mb-4 text-primary" size={48} />
          <h3 className="text-lg font-semibold mb-2">Create Your Own App</h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto mb-6">
            Build custom data pipeline apps for your UAV. Upload payload parsers and design your UI.
          </p>
          <Button onClick={() => setShowBuilder(true)}>
            <Plus size={16} className="mr-2" />
            Start Building
          </Button>
        </Card>
      </div>
    </div>
  );
}
