import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { 
  Plus, 
  Trash2, 
  Eye, 
  Settings, 
  Type, 
  Gauge, 
  LineChart, 
  BarChart3, 
  Circle, 
  Map, 
  Video, 
  Square,
  MousePointer2
} from "lucide-react";

interface Widget {
  id: string;
  type: string;
  position: { row: number; col: number; rowSpan?: number; colSpan?: number };
  size: { width?: number | "auto"; height?: number | "auto" };
  config: Record<string, any>;
  dataBinding?: { field: string };
}

interface UIBuilderProps {
  dataSchema: Record<string, any>;
  initialUiSchema?: any; // Optional: existing UI schema for edit mode
  onSave: (uiSchema: any) => void;
  onCancel: () => void;
}

const WIDGET_TYPES = [
  { value: "text", label: "Text Display", icon: Type, description: "Display text or numbers" },
  { value: "gauge", label: "Gauge", icon: Gauge, description: "Circular gauge for numbers" },
  { value: "line-chart", label: "Line Chart", icon: LineChart, description: "Time-series chart" },
  { value: "bar-chart", label: "Bar Chart", icon: BarChart3, description: "Bar chart" },
  { value: "led", label: "LED Indicator", icon: Circle, description: "Boolean status light" },
  { value: "map", label: "Map", icon: Map, description: "Geographic map" },
  { value: "video", label: "Video", icon: Video, description: "Video stream" },
  { value: "canvas", label: "Canvas", icon: Square, description: "Custom canvas" },
];

export default function UIBuilder({ dataSchema, initialUiSchema, onSave, onCancel }: UIBuilderProps) {
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [selectedWidget, setSelectedWidget] = useState<string | null>(null);
  const [layoutColumns, setLayoutColumns] = useState(3);
  const [previewMode, setPreviewMode] = useState(false);

  // Load existing UI schema when editing
  useEffect(() => {
    if (initialUiSchema) {
      console.log('[UIBuilder] Loading existing UI schema:', initialUiSchema);
      try {
        const parsed = typeof initialUiSchema === 'string' 
          ? JSON.parse(initialUiSchema) 
          : initialUiSchema;
        
        if (parsed.widgets && Array.isArray(parsed.widgets)) {
          setWidgets(parsed.widgets);
          console.log(`[UIBuilder] Loaded ${parsed.widgets.length} existing widgets`);
        }
        
        if (parsed.layoutColumns) {
          setLayoutColumns(parsed.layoutColumns);
        }
      } catch (error) {
        console.error('[UIBuilder] Failed to parse initialUiSchema:', error);
        toast.error('Failed to load existing UI layout');
      }
    }
  }, [initialUiSchema]);

  // Get available fields from data schema
  const availableFields = Object.keys(dataSchema);

  const addWidget = (type: string) => {
    const newWidget: Widget = {
      id: `widget-${Date.now()}`,
      type,
      position: { row: widgets.length + 1, col: 1 },
      size: { width: "auto", height: "auto" },
      config: getDefaultConfig(type),
      dataBinding: availableFields.length > 0 ? { field: availableFields[0] } : undefined,
    };
    setWidgets([...widgets, newWidget]);
    setSelectedWidget(newWidget.id);
    toast.success(`Added ${type} widget`);
  };

  const removeWidget = (id: string) => {
    setWidgets(widgets.filter(w => w.id !== id));
    if (selectedWidget === id) {
      setSelectedWidget(null);
    }
    toast.success("Widget removed");
  };

  const updateWidget = (id: string, updates: Partial<Widget>) => {
    setWidgets(widgets.map(w => w.id === id ? { ...w, ...updates } : w));
  };

  const handleSave = () => {
    const uiSchema = {
      version: "1.0",
      layout: {
        type: "grid",
        columns: layoutColumns,
        gap: 16,
        padding: 24,
      },
      widgets,
    };
    onSave(uiSchema);
  };

  const selected = widgets.find(w => w.id === selectedWidget);

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">UI Builder</h1>
            <p className="text-muted-foreground">Design your app's visual layout</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setPreviewMode(!previewMode)}
            >
              <Eye className="h-4 w-4 mr-2" />
              {previewMode ? "Edit" : "Preview"}
            </Button>
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={handleSave}>
              Save UI
            </Button>
          </div>
        </div>

        {previewMode ? (
          <Card>
            <CardHeader>
              <CardTitle>Preview Mode</CardTitle>
              <p className="text-sm text-muted-foreground">This is how your app will look with live data</p>
            </CardHeader>
            <CardContent>
              <div
                className="grid gap-4"
                style={{
                  gridTemplateColumns: `repeat(${layoutColumns}, 1fr)`,
                }}
              >
                {widgets.map((widget) => (
                  <div
                    key={widget.id}
                    className="p-4 border rounded-lg bg-card"
                    style={{
                      gridColumn: `${widget.position.col} / span ${widget.position.colSpan || 1}`,
                      gridRow: `${widget.position.row} / span ${widget.position.rowSpan || 1}`,
                    }}
                  >
                    <div className="text-sm font-medium mb-2">{widget.config.label || widget.type}</div>
                    <div className="text-muted-foreground">{getWidgetPreview(widget)}</div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-[250px_1fr_300px] gap-6">
            {/* Widget Palette */}
            <Card className="h-fit">
            <CardHeader>
              <CardTitle className="text-lg">Widget Palette</CardTitle>
              <CardDescription>Drag or click to add</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {WIDGET_TYPES.map((widget) => {
                const Icon = widget.icon;
                return (
                  <Button
                    key={widget.value}
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => addWidget(widget.value)}
                  >
                    <Icon className="h-4 w-4 mr-2" />
                    {widget.label}
                  </Button>
                );
              })}
            </CardContent>
          </Card>

          {/* Canvas */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Canvas</CardTitle>
                <div className="flex items-center gap-2">
                  <Label className="text-sm">Columns:</Label>
                  <Input
                    type="number"
                    min={1}
                    max={12}
                    value={layoutColumns}
                    onChange={(e) => setLayoutColumns(parseInt(e.target.value) || 3)}
                    className="w-16 h-8"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {widgets.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-96 border-2 border-dashed border-muted-foreground/25 rounded-lg">
                  <MousePointer2 className="h-12 w-12 text-muted-foreground/50 mb-4" />
                  <p className="text-muted-foreground">Add widgets from the palette</p>
                </div>
              ) : (
                <div
                  className="grid gap-4 p-4 border-2 border-dashed border-muted-foreground/25 rounded-lg"
                  style={{ gridTemplateColumns: `repeat(${layoutColumns}, 1fr)` }}
                >
                  {widgets.map((widget) => (
                    <div
                      key={widget.id}
                      className={`
                        relative p-4 border-2 rounded-lg cursor-pointer transition-all
                        ${selectedWidget === widget.id 
                          ? 'border-primary bg-primary/5' 
                          : 'border-border bg-card hover:border-primary/50'
                        }
                      `}
                      style={{
                        gridColumn: `${widget.position.col} / span ${widget.position.colSpan || 1}`,
                        gridRow: `${widget.position.row} / span ${widget.position.rowSpan || 1}`,
                      }}
                      onClick={() => setSelectedWidget(widget.id)}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium capitalize">{widget.type}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeWidget(widget.id);
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {widget.dataBinding?.field || "No data binding"}
                      </div>
                      <div className="mt-2 p-2 bg-muted/50 rounded text-xs">
                        {getWidgetPreview(widget)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Properties Panel */}
          <Card className="h-fit">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Settings className="h-4 w-4" />
                Properties
              </CardTitle>
            </CardHeader>
            <CardContent>
              {selected ? (
                <div className="space-y-4">
                  {/* Widget Type */}
                  <div className="space-y-2">
                    <Label>Widget Type</Label>
                    <Input value={selected.type} disabled className="capitalize" />
                  </div>

                  {/* Data Binding */}
                  <div className="space-y-2">
                    <Label>Data Field</Label>
                    <Select
                      value={selected.dataBinding?.field || ""}
                      onValueChange={(value) =>
                        updateWidget(selected.id, {
                          dataBinding: { field: value },
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select field" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableFields.map((field) => (
                          <SelectItem key={field} value={field}>
                            {field} ({dataSchema[field].type})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Position */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-2">
                      <Label>Row</Label>
                      <Input
                        type="number"
                        min={1}
                        value={selected.position.row}
                        onChange={(e) =>
                          updateWidget(selected.id, {
                            position: { ...selected.position, row: parseInt(e.target.value) || 1 },
                          })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Column</Label>
                      <Input
                        type="number"
                        min={1}
                        max={layoutColumns}
                        value={selected.position.col}
                        onChange={(e) =>
                          updateWidget(selected.id, {
                            position: { ...selected.position, col: parseInt(e.target.value) || 1 },
                          })
                        }
                      />
                    </div>
                  </div>

                  {/* Span */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-2">
                      <Label>Row Span</Label>
                      <Input
                        type="number"
                        min={1}
                        value={selected.position.rowSpan || 1}
                        onChange={(e) =>
                          updateWidget(selected.id, {
                            position: { ...selected.position, rowSpan: parseInt(e.target.value) || 1 },
                          })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Col Span</Label>
                      <Input
                        type="number"
                        min={1}
                        max={layoutColumns}
                        value={selected.position.colSpan || 1}
                        onChange={(e) =>
                          updateWidget(selected.id, {
                            position: { ...selected.position, colSpan: parseInt(e.target.value) || 1 },
                          })
                        }
                      />
                    </div>
                  </div>

                  {/* Widget-specific config */}
                  {renderWidgetConfig(selected, (config) =>
                    updateWidget(selected.id, { config })
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Select a widget to edit its properties
                </p>
              )}
            </CardContent>
          </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function getDefaultConfig(type: string): Record<string, any> {
  switch (type) {
    case "text":
      return { label: "Value", fontSize: 24, showUnit: true, decimalPlaces: 1 };
    case "gauge":
      return { label: "Gauge", min: 0, max: 100, showValue: true };
    case "line-chart":
      return { title: "Chart", maxDataPoints: 100, lineColor: "#3b82f6" };
    case "bar-chart":
      return { title: "Chart", orientation: "vertical", barColor: "#8b5cf6" };
    case "led":
      return { label: "Status", onColor: "#22c55e", offColor: "#ef4444", size: 40 };
    case "map":
      return { zoom: 10, markerColor: "#ef4444" };
    case "video":
      return { autoplay: true, controls: true };
    case "canvas":
      return { backgroundColor: "#000000", renderMode: "2d" };
    default:
      return {};
  }
}

function getWidgetPreview(widget: Widget): string {
  switch (widget.type) {
    case "text":
      return `${widget.config.label || "Value"}: 0`;
    case "gauge":
      return `${widget.config.label || "Gauge"}: 0/${widget.config.max || 100}`;
    case "line-chart":
    case "bar-chart":
      return widget.config.title || "Chart";
    case "led":
      return `${widget.config.label || "Status"}: OFF`;
    case "map":
      return "Map View";
    case "video":
      return "Video Feed";
    case "canvas":
      return "Custom Canvas";
    default:
      return widget.type;
  }
}

function renderWidgetConfig(
  widget: Widget,
  onChange: (config: Record<string, any>) => void
): React.ReactNode {
  const { config, type } = widget;

  const updateConfig = (key: string, value: any) => {
    onChange({ ...config, [key]: value });
  };

  switch (type) {
    case "text":
      return (
        <>
          <div className="space-y-2">
            <Label>Label</Label>
            <Input
              value={config.label || ""}
              onChange={(e) => updateConfig("label", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Font Size</Label>
            <Input
              type="number"
              value={config.fontSize || 24}
              onChange={(e) => updateConfig("fontSize", parseInt(e.target.value) || 24)}
            />
          </div>
          <div className="space-y-2">
            <Label>Decimal Places</Label>
            <Input
              type="number"
              min={0}
              max={10}
              value={config.decimalPlaces || 1}
              onChange={(e) => updateConfig("decimalPlaces", parseInt(e.target.value) || 1)}
            />
          </div>
        </>
      );

    case "gauge":
      return (
        <>
          <div className="space-y-2">
            <Label>Label</Label>
            <Input
              value={config.label || ""}
              onChange={(e) => updateConfig("label", e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-2">
              <Label>Min</Label>
              <Input
                type="number"
                value={config.min || 0}
                onChange={(e) => updateConfig("min", parseFloat(e.target.value) || 0)}
              />
            </div>
            <div className="space-y-2">
              <Label>Max</Label>
              <Input
                type="number"
                value={config.max || 100}
                onChange={(e) => updateConfig("max", parseFloat(e.target.value) || 100)}
              />
            </div>
          </div>
        </>
      );

    case "line-chart":
    case "bar-chart":
      return (
        <>
          <div className="space-y-2">
            <Label>Title</Label>
            <Input
              value={config.title || ""}
              onChange={(e) => updateConfig("title", e.target.value)}
            />
          </div>
          {type === "line-chart" && (
            <div className="space-y-2">
              <Label>Max Data Points</Label>
              <Input
                type="number"
                value={config.maxDataPoints || 100}
                onChange={(e) => updateConfig("maxDataPoints", parseInt(e.target.value) || 100)}
              />
            </div>
          )}
        </>
      );

    case "led":
      return (
        <>
          <div className="space-y-2">
            <Label>Label</Label>
            <Input
              value={config.label || ""}
              onChange={(e) => updateConfig("label", e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-2">
              <Label>On Color</Label>
              <Input
                type="color"
                value={config.onColor || "#22c55e"}
                onChange={(e) => updateConfig("onColor", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Off Color</Label>
              <Input
                type="color"
                value={config.offColor || "#ef4444"}
                onChange={(e) => updateConfig("offColor", e.target.value)}
              />
            </div>
          </div>
        </>
      );

    default:
      return null;
  }
}
