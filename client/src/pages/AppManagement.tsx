import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
  Sparkles, 
  Trash2, 
  Edit, 
  Download, 
  Eye, 
  Settings,
  AlertCircle,
  Loader2 
} from "lucide-react";
import { toast } from "sonner";

interface AppManagementProps {
  onGoToStore?: () => void;
}

export default function AppManagement({ onGoToStore }: AppManagementProps = {}) {
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  
  // Load user's installed apps
  const { data: userApps, isLoading, refetch } = trpc.appBuilder.getUserApps.useQuery();
  
  // Uninstall app mutation
  const uninstallMutation = trpc.appBuilder.uninstallApp.useMutation({
    onSuccess: () => {
      toast.success("App uninstalled successfully");
      refetch();
    },
    onError: (error) => {
      toast.error(`Failed to uninstall app: ${error.message}`);
    },
  });

  const handleUninstall = (appId: string) => {
    if (confirm("Are you sure you want to uninstall this app?")) {
      uninstallMutation.mutate({ appId });
    }
  };

  const handleExport = (app: any) => {
    // Export app configuration as JSON
    const exportData = {
      appId: app.appId,
      name: app.name,
      description: app.description,
      version: app.version,
      parserCode: app.parserCode,
      dataSchema: app.dataSchema,
      uiSchema: app.uiSchema,
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${app.appId}_v${app.version}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    toast.success("App configuration exported");
  };

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="mx-auto mb-4 animate-spin text-muted-foreground" size={48} />
          <p className="text-muted-foreground">Loading your apps...</p>
        </div>
      </div>
    );
  }

  if (!userApps || userApps.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center max-w-md">
          <AlertCircle className="mx-auto mb-4 text-muted-foreground" size={48} />
          <h2 className="text-2xl font-bold mb-2">No Apps Installed</h2>
          <p className="text-muted-foreground mb-6">
            You haven't installed any custom apps yet. Visit the App Store to browse and install apps.
          </p>
          <Button onClick={() => onGoToStore?.()}>
            <Sparkles className="mr-2" size={16} />
            Go to App Store
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">App Management</h1>
        <p className="text-muted-foreground">
          Manage your installed custom apps, view configurations, and export for deployment
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {userApps.map((app) => (
          <Card key={app.appId} className="hover:shadow-lg transition-shadow">
            <CardHeader>
              <div className="flex items-start justify-between">
                <Sparkles className="text-primary" size={24} />
                <Badge variant="secondary">v{app.version}</Badge>
              </div>
              <CardTitle className="mt-4">{app.name}</CardTitle>
              <CardDescription className="line-clamp-2">
                {app.description || "No description provided"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 mb-4">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">App ID:</span>
                  <span className="font-mono text-xs">{app.appId}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Installed:</span>
                  <span className="text-xs">
                    {new Date(app.installedAt).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Status:</span>
                  <Badge variant={app.published === 'published' ? 'default' : 'secondary'}>
                    {app.published}
                  </Badge>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setSelectedApp(app.appId)}
                  className="flex-1"
                >
                  <Eye size={14} className="mr-1" />
                  View
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleExport(app)}
                >
                  <Download size={14} className="mr-1" />
                  Export
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleUninstall(app.appId)}
                  disabled={uninstallMutation.isPending}
                >
                  <Trash2 size={14} className="mr-1" />
                  Uninstall
                </Button>
              </div>

              <div className="mt-4 pt-4 border-t">
                <p className="text-xs text-muted-foreground mb-2">REST Endpoint:</p>
                <code className="text-xs bg-muted px-2 py-1 rounded block truncate">
                  POST /api/rest/payload/{app.appId}/ingest
                </code>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {selectedApp && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <Card className="max-w-4xl w-full max-h-[80vh] overflow-auto">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>App Details</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setSelectedApp(null)}>
                  Close
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {userApps.find(a => a.appId === selectedApp) && (
                <div className="space-y-4">
                  <div>
                    <h3 className="font-semibold mb-2">Parser Code</h3>
                    <pre className="bg-muted p-4 rounded-lg text-xs overflow-auto max-h-64">
                      {userApps.find(a => a.appId === selectedApp)?.parserCode}
                    </pre>
                  </div>
                  <div>
                    <h3 className="font-semibold mb-2">Data Schema</h3>
                    <pre className="bg-muted p-4 rounded-lg text-xs overflow-auto">
                      {JSON.stringify(
                        JSON.parse(userApps.find(a => a.appId === selectedApp)?.dataSchema || "{}"),
                        null,
                        2
                      )}
                    </pre>
                  </div>
                  <div>
                    <h3 className="font-semibold mb-2">UI Schema</h3>
                    <pre className="bg-muted p-4 rounded-lg text-xs overflow-auto">
                      {JSON.stringify(
                        JSON.parse(userApps.find(a => a.appId === selectedApp)?.uiSchema || "{}"),
                        null,
                        2
                      )}
                    </pre>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
