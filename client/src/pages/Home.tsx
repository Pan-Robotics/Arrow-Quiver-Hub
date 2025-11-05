import { useState } from "react";
import { APP_TITLE } from "@/const";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import PointCloudViewer from "@/components/PointCloudViewer";
import { trpc } from "@/lib/trpc";
import { Loader2, Radio } from "lucide-react";

export default function Home() {
  const [selectedDrone, setSelectedDrone] = useState<string | null>(null);

  // Fetch list of drones
  const { data: drones, isLoading } = trpc.pointcloud.getDrones.useQuery();

  // Auto-select first drone if available
  if (drones && drones.length > 0 && !selectedDrone) {
    setSelectedDrone(drones[0].droneId);
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Radio className="text-primary" size={32} />
              <div>
                <h1 className="text-2xl font-bold">{APP_TITLE}</h1>
                <p className="text-sm text-muted-foreground">Real-time terrain mapping visualization</p>
              </div>
            </div>

            {/* Drone Selector */}
            {isLoading ? (
              <div className="flex items-center gap-2">
                <Loader2 className="animate-spin" size={16} />
                <span className="text-sm text-muted-foreground">Loading drones...</span>
              </div>
            ) : drones && drones.length > 0 ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Drone:</span>
                <Select value={selectedDrone || undefined} onValueChange={setSelectedDrone}>
                  <SelectTrigger className="w-[200px]">
                    <SelectValue placeholder="Select drone" />
                  </SelectTrigger>
                  <SelectContent>
                    {drones.map((drone) => (
                      <SelectItem key={drone.id} value={drone.droneId}>
                        {drone.name || drone.droneId}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No drones connected</div>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-6">
        {selectedDrone ? (
          <PointCloudViewer droneId={selectedDrone} />
        ) : (
          <Card className="p-12 text-center">
            <Radio className="mx-auto mb-4 text-muted-foreground" size={64} />
            <h2 className="text-2xl font-semibold mb-2">No Drone Selected</h2>
            <p className="text-muted-foreground mb-6">
              {drones && drones.length > 0
                ? "Please select a drone from the dropdown above"
                : "Waiting for drones to connect..."}
            </p>
            {drones && drones.length === 0 && (
              <div className="max-w-md mx-auto text-left bg-muted p-4 rounded-md">
                <p className="text-sm font-medium mb-2">To connect a drone:</p>
                <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
                  <li>Start the point cloud streamer on the Raspberry Pi</li>
                  <li>Start the forwarder on the companion computer</li>
                  <li>Configure the web server URL and API key</li>
                  <li>The drone will appear here automatically</li>
                </ol>
              </div>
            )}
          </Card>
        )}
      </main>
    </div>
  );
}
