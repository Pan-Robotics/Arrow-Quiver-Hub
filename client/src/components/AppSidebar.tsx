import { useState } from "react";
import { Radio, Plus, Home, Map, Camera, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface App {
  id: string;
  name: string;
  icon: React.ElementType<{ size?: number }>;
  enabled: boolean;
}

interface AppSidebarProps {
  apps: App[];
  bottomApps?: App[];
  activeAppId: string;
  onAppChange: (appId: string) => void;
  onAddApp: () => void;
}

function SidebarAppButton({ app, isActive, onClick }: { app: App; isActive: boolean; onClick: () => void }) {
  const Icon = app.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={isActive ? "default" : "ghost"}
          size="icon"
          className={cn(
            "w-12 h-12 relative shrink-0",
            isActive && "bg-primary text-primary-foreground"
          )}
          onClick={onClick}
        >
          <Icon size={20} />
          {isActive && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r-full" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        <p>{app.name}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export default function AppSidebar({ apps, bottomApps = [], activeAppId, onAppChange, onAddApp }: AppSidebarProps) {
  return (
    <TooltipProvider delayDuration={0}>
      <div className="fixed left-0 top-0 h-screen w-16 bg-card border-r border-border flex flex-col items-center py-4 gap-2 z-50">
        {/* Logo/Home */}
        <div className="mb-4">
          <Radio className="text-primary" size={28} />
        </div>

        {/* Main App Icons */}
        <div className="flex-1 flex flex-col gap-2 w-full px-2 overflow-y-auto scrollbar-none min-h-0">
          {apps.filter(app => app.enabled).map((app) => (
            <SidebarAppButton
              key={app.id}
              app={app}
              isActive={app.id === activeAppId}
              onClick={() => onAppChange(app.id)}
            />
          ))}
        </div>

        {/* Bottom-pinned apps (just above the + button) */}
        {bottomApps.length > 0 && (
          <div className="flex flex-col gap-2 w-full px-2 mb-2">
            {bottomApps.filter(app => app.enabled).map((app) => (
              <SidebarAppButton
                key={app.id}
                app={app}
                isActive={app.id === activeAppId}
                onClick={() => onAppChange(app.id)}
              />
            ))}
          </div>
        )}

        {/* Add App Button */}
        <div className="mb-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="w-12 h-12 border-dashed"
                onClick={onAddApp}
              >
                <Plus size={20} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Add App</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}
