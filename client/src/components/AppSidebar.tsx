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
  icon: React.ElementType;
  enabled: boolean;
}

interface AppSidebarProps {
  apps: App[];
  activeAppId: string;
  onAppChange: (appId: string) => void;
  onAddApp: () => void;
}

export default function AppSidebar({ apps, activeAppId, onAppChange, onAddApp }: AppSidebarProps) {
  return (
    <TooltipProvider delayDuration={0}>
      <div className="fixed left-0 top-0 h-screen w-16 bg-card border-r border-border flex flex-col items-center py-4 gap-2 z-50">
        {/* Logo/Home */}
        <div className="mb-4">
          <Radio className="text-primary" size={28} />
        </div>

        {/* App Icons */}
        <div className="flex-1 flex flex-col gap-2 w-full px-2">
          {apps.filter(app => app.enabled).map((app) => {
            const Icon = app.icon;
            const isActive = app.id === activeAppId;
            
            return (
              <Tooltip key={app.id}>
                <TooltipTrigger asChild>
                  <Button
                    variant={isActive ? "default" : "ghost"}
                    size="icon"
                    className={cn(
                      "w-12 h-12 relative",
                      isActive && "bg-primary text-primary-foreground"
                    )}
                    onClick={() => onAppChange(app.id)}
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
          })}
        </div>

        {/* Add App Button */}
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
    </TooltipProvider>
  );
}
