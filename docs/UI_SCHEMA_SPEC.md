# UI Schema Specification

## Overview

The UI Schema defines the visual layout and data bindings for custom apps. It's stored as JSON in the `customApps.uiSchema` field and rendered dynamically by the UI Builder.

## Schema Structure

```typescript
interface UISchema {
  version: string;           // Schema version (e.g., "1.0")
  layout: LayoutConfig;      // Root layout configuration
  widgets: Widget[];         // Array of widget definitions
}

interface LayoutConfig {
  type: "grid" | "flex";
  columns?: number;          // For grid layout
  gap?: number;              // Gap between widgets (in pixels)
  padding?: number;          // Container padding
}

interface Widget {
  id: string;                // Unique widget ID
  type: WidgetType;          // Widget type
  position: Position;        // Grid/flex position
  size: Size;                // Widget dimensions
  config: WidgetConfig;      // Widget-specific configuration
  dataBinding?: DataBinding; // Data source binding
}

type WidgetType = 
  | "text"                   // Text display
  | "gauge"                  // Circular gauge
  | "line-chart"             // Line chart
  | "bar-chart"              // Bar chart
  | "led"                    // LED indicator
  | "map"                    // Map widget
  | "video"                  // Video feed
  | "canvas"                 // Custom canvas
  | "button";                // Action button

interface Position {
  row: number;               // Grid row (1-indexed)
  col: number;               // Grid column (1-indexed)
  rowSpan?: number;          // Rows to span
  colSpan?: number;          // Columns to span
}

interface Size {
  width?: number | "auto";   // Width in pixels or auto
  height?: number | "auto";  // Height in pixels or auto
  minWidth?: number;
  minHeight?: number;
}

interface DataBinding {
  field: string;             // Field name from parser output
  transform?: string;        // Optional transform function
  updateRate?: number;       // Update rate in ms (default: realtime)
}
```

## Widget Types

### 1. Text Display

Displays text or numeric values.

```json
{
  "id": "temp-display",
  "type": "text",
  "position": { "row": 1, "col": 1 },
  "size": { "width": 200, "height": 80 },
  "config": {
    "label": "Temperature",
    "fontSize": 24,
    "fontWeight": "bold",
    "color": "#ffffff",
    "backgroundColor": "#1e293b",
    "alignment": "center",
    "showUnit": true,
    "decimalPlaces": 1
  },
  "dataBinding": {
    "field": "temperature"
  }
}
```

### 2. Gauge

Circular gauge for numeric values with min/max range.

```json
{
  "id": "humidity-gauge",
  "type": "gauge",
  "position": { "row": 1, "col": 2 },
  "size": { "width": 200, "height": 200 },
  "config": {
    "label": "Humidity",
    "min": 0,
    "max": 100,
    "unit": "%",
    "thresholds": [
      { "value": 30, "color": "#ef4444" },
      { "value": 70, "color": "#22c55e" },
      { "value": 90, "color": "#eab308" }
    ],
    "showValue": true,
    "showMinMax": true
  },
  "dataBinding": {
    "field": "humidity"
  }
}
```

### 3. Line Chart

Time-series line chart.

```json
{
  "id": "temp-chart",
  "type": "line-chart",
  "position": { "row": 2, "col": 1, "colSpan": 2 },
  "size": { "width": "auto", "height": 300 },
  "config": {
    "title": "Temperature Over Time",
    "xAxisLabel": "Time",
    "yAxisLabel": "Temperature (°C)",
    "maxDataPoints": 100,
    "lineColor": "#3b82f6",
    "lineWidth": 2,
    "showGrid": true,
    "showLegend": true
  },
  "dataBinding": {
    "field": "temperature",
    "updateRate": 1000
  }
}
```

### 4. Bar Chart

Bar chart for categorical or comparative data.

```json
{
  "id": "sensor-comparison",
  "type": "bar-chart",
  "position": { "row": 3, "col": 1 },
  "size": { "width": 400, "height": 300 },
  "config": {
    "title": "Sensor Readings",
    "orientation": "vertical",
    "barColor": "#8b5cf6",
    "showValues": true,
    "showGrid": true
  },
  "dataBinding": {
    "field": "sensor_array"
  }
}
```

### 5. LED Indicator

Boolean status indicator.

```json
{
  "id": "status-led",
  "type": "led",
  "position": { "row": 1, "col": 3 },
  "size": { "width": 100, "height": 100 },
  "config": {
    "label": "Active",
    "onColor": "#22c55e",
    "offColor": "#ef4444",
    "size": 40,
    "blinkWhenOn": false
  },
  "dataBinding": {
    "field": "is_active"
  }
}
```

### 6. Map

Geographic map display.

```json
{
  "id": "location-map",
  "type": "map",
  "position": { "row": 4, "col": 1, "colSpan": 2 },
  "size": { "width": "auto", "height": 400 },
  "config": {
    "center": { "lat": 0, "lng": 0 },
    "zoom": 10,
    "markerColor": "#ef4444",
    "showPath": true,
    "pathColor": "#3b82f6"
  },
  "dataBinding": {
    "field": "location"
  }
}
```

### 7. Video Feed

Video stream display.

```json
{
  "id": "camera-feed",
  "type": "video",
  "position": { "row": 5, "col": 1 },
  "size": { "width": 640, "height": 480 },
  "config": {
    "autoplay": true,
    "controls": true,
    "muted": false
  },
  "dataBinding": {
    "field": "video_url"
  }
}
```

### 8. Custom Canvas

Custom drawing canvas for specialized visualizations.

```json
{
  "id": "point-cloud",
  "type": "canvas",
  "position": { "row": 6, "col": 1, "colSpan": 2 },
  "size": { "width": "auto", "height": 600 },
  "config": {
    "backgroundColor": "#000000",
    "renderMode": "2d"
  },
  "dataBinding": {
    "field": "point_cloud_data"
  }
}
```

### 9. Button

Action button for triggering commands.

```json
{
  "id": "reset-button",
  "type": "button",
  "position": { "row": 7, "col": 1 },
  "size": { "width": 150, "height": 40 },
  "config": {
    "label": "Reset",
    "variant": "primary",
    "action": "reset_device"
  }
}
```

## Complete Example

Weather Station App UI Schema:

```json
{
  "version": "1.0",
  "layout": {
    "type": "grid",
    "columns": 3,
    "gap": 16,
    "padding": 24
  },
  "widgets": [
    {
      "id": "temp-display",
      "type": "text",
      "position": { "row": 1, "col": 1 },
      "size": { "width": 200, "height": 100 },
      "config": {
        "label": "Temperature",
        "fontSize": 32,
        "fontWeight": "bold",
        "showUnit": true,
        "decimalPlaces": 1
      },
      "dataBinding": {
        "field": "temperature"
      }
    },
    {
      "id": "humidity-gauge",
      "type": "gauge",
      "position": { "row": 1, "col": 2 },
      "size": { "width": 200, "height": 200 },
      "config": {
        "label": "Humidity",
        "min": 0,
        "max": 100,
        "unit": "%",
        "thresholds": [
          { "value": 30, "color": "#ef4444" },
          { "value": 70, "color": "#22c55e" }
        ]
      },
      "dataBinding": {
        "field": "humidity"
      }
    },
    {
      "id": "pressure-display",
      "type": "text",
      "position": { "row": 1, "col": 3 },
      "size": { "width": 200, "height": 100 },
      "config": {
        "label": "Pressure",
        "fontSize": 24,
        "showUnit": true,
        "decimalPlaces": 1
      },
      "dataBinding": {
        "field": "pressure"
      }
    },
    {
      "id": "temp-chart",
      "type": "line-chart",
      "position": { "row": 2, "col": 1, "colSpan": 3 },
      "size": { "width": "auto", "height": 300 },
      "config": {
        "title": "Temperature Trend",
        "maxDataPoints": 100,
        "lineColor": "#3b82f6"
      },
      "dataBinding": {
        "field": "temperature",
        "updateRate": 1000
      }
    },
    {
      "id": "rain-indicator",
      "type": "led",
      "position": { "row": 3, "col": 1 },
      "size": { "width": 100, "height": 100 },
      "config": {
        "label": "Raining",
        "onColor": "#3b82f6",
        "offColor": "#64748b"
      },
      "dataBinding": {
        "field": "is_raining"
      }
    }
  ]
}
```

## Validation Rules

1. **Unique widget IDs** - No duplicate IDs
2. **Valid positions** - Row/col must be positive integers
3. **Valid data bindings** - Field must exist in parser SCHEMA
4. **Type compatibility** - Widget type must match field type
5. **Required config** - Each widget type has required config fields
6. **Grid constraints** - Widgets must fit within layout columns

## Default Values

If not specified, these defaults apply:

- `layout.type`: "grid"
- `layout.columns`: 3
- `layout.gap`: 16
- `layout.padding`: 24
- `widget.size.width`: "auto"
- `widget.size.height`: "auto"
- `widget.position.rowSpan`: 1
- `widget.position.colSpan`: 1
- `dataBinding.updateRate`: realtime (every update)

## Future Extensions

- **Conditional visibility** - Show/hide widgets based on data
- **Widget interactions** - Click handlers, hover effects
- **Custom themes** - Color schemes and styling
- **Responsive layouts** - Breakpoints for different screen sizes
- **Widget groups** - Collapsible sections
- **Data transformations** - Advanced data processing
