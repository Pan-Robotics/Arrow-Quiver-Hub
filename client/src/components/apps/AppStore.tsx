import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Package, Download, Star, TrendingUp, Plus, Sparkles, Camera } from "lucide-react";
import AppBuilder from "./AppBuilder";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

interface StoreApp {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: React.ElementType<{ size?: number; className?: string }>;
  installed: boolean;
  popular?: boolean;
}

interface AppStoreProps {
  onInstallApp?: (appId: string) => void;
  onManageApps?: () => void;
  editingAppId?: string | null;
  onCloseEdit?: () => void;
}

export default function AppStore({ onInstallApp, onManageApps, editingAppId, onCloseEdit }: AppStoreProps) {
  const [showBuilder, setShowBuilder] = useState(false);
  
  // If editingAppId is provided, show builder in edit mode
  useEffect(() => {
    if (editingAppId) {
      setShowBuilder(true);
    }
  }, [editingAppId]);
  const { data: customApps, isLoading } = trpc.appBuilder.listApps.useQuery({ publishedOnly: true });
  const { data: installedApps } = trpc.appBuilder.getUserApps.useQuery();
  const installAppMutation = trpc.appBuilder.installApp.useMutation();
  const utils = trpc.useUtils();

  const handleInstallApp = async (appId: string, appName: string) => {
    try {
      await installAppMutation.mutateAsync({ appId });
      toast.success(`"${appName}" installed successfully!`);
      // Invalidate queries to refresh installed apps list
      utils.appBuilder.getUserApps.invalidate();
      // Call parent callback if provided
      onInstallApp?.(appId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to install: ${message}`);
    }
  };

  const isAppInstalled = (appId: string) => {
    return installedApps?.some(app => app.appId === appId) || false;
  };

  if (showBuilder) {
    return <AppBuilder 
      onBack={() => {
        setShowBuilder(false);
        onCloseEdit?.();
      }} 
      editMode={!!editingAppId}
      editingAppId={editingAppId || undefined}
    />;
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
      description: "Live video stream from SIYI A8 mini gimbal camera with gimbal control and recording",
      category: "Media",
      icon: Camera,
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
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">App Store</h2>
            <p className="text-sm text-muted-foreground">Discover and install UAV data pipeline apps</p>
          </div>
          {onManageApps && (
            <Button variant="outline" onClick={onManageApps}>
              <Package className="mr-2" size={16} />
              Manage Apps
            </Button>
          )}
        </div>
      </div>

      {/* Store Content */}
      <div className="flex-1 p-6 overflow-auto">
        {/* Custom Apps Section */}
        {customApps && customApps.length > 0 && (
          <div className="mb-8">
            <div className="flex items-center gap-2 mb-4">
              <Sparkles className="text-primary" size={20} />
              <h3 className="text-lg font-semibold">Custom Apps</h3>
              <Badge variant="secondary" className="ml-2">{customApps.length}</Badge>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {customApps.map((app) => (
                <Card key={app.id} className="p-6 hover:shadow-lg transition-shadow border-primary/30">
                  <div className="flex items-start gap-4">
                    <div className="p-3 bg-primary/10 rounded-lg">
                      <Sparkles className="text-primary" size={24} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold truncate">{app.name}</h3>
                        <Badge variant="outline" className="text-xs">
                          v{app.version}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mb-3">Custom App</p>
                      <p className="text-sm text-muted-foreground mb-4 line-clamp-2">
                        {app.description || "Custom data pipeline app"}
                      </p>
                      <Button
                        size="sm"
                        variant={isAppInstalled(app.appId) ? "outline" : "default"}
                        className="w-full"
                        onClick={() => handleInstallApp(app.appId, app.name)}
                        disabled={isAppInstalled(app.appId) || installAppMutation.isPending}
                      >
                        <Download size={14} className="mr-2" />
                        {isAppInstalled(app.appId) ? "Installed" : "Install"}
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Built-in Apps Section */}
        <div className="mb-8">
          <h3 className="text-lg font-semibold mb-4">Built-in Apps</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {storeApps.map((app) => {
            const Icon = app.icon;
            const isInstalled = isAppInstalled(app.id);
            const isInstallable = app.id === "telemetry" || app.id === "camera"; // Telemetry and Camera Feed are installable
            
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
                      variant={isInstalled ? "outline" : "default"}
                      className="w-full"
                      disabled={isInstalled || !isInstallable || installAppMutation.isPending}
                      onClick={() => isInstallable && !isInstalled && handleInstallApp(app.id, app.name)}
                    >
                      {isInstalled ? (
                        "Installed"
                      ) : isInstallable ? (
                        <>
                          <Download size={14} className="mr-2" />
                          Install
                        </>
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
