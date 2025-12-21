#!/usr/bin/env tsx

import { readFileSync } from 'fs';
import { createCustomApp } from '../server/customAppDb';

const parserCode = readFileSync('/tmp/comprehensive_widget_test_parser.py', 'utf8');

const dataSchema = {
  "temperature": {
    "type": "number",
    "unit": "°C",
    "description": "Current temperature",
    "min": -50,
    "max": 60
  },
  "humidity": {
    "type": "number",
    "unit": "%",
    "description": "Relative humidity",
    "min": 0,
    "max": 100
  },
  "pressure": {
    "type": "number",
    "unit": "hPa",
    "description": "Atmospheric pressure",
    "min": 900,
    "max": 1100
  },
  "system_status": {
    "type": "boolean",
    "description": "System operational status"
  },
  "message": {
    "type": "string",
    "description": "Status message"
  },
  "latitude": {
    "type": "number",
    "unit": "°",
    "description": "GPS latitude",
    "min": -90,
    "max": 90
  },
  "longitude": {
    "type": "number",
    "unit": "°",
    "description": "GPS longitude",
    "min": -180,
    "max": 180
  },
  "video_url": {
    "type": "string",
    "description": "Live video stream URL"
  },
  "temp_history": {
    "type": "array",
    "description": "Temperature history for chart"
  },
  "sensor_readings": {
    "type": "array",
    "description": "Sensor readings for bar chart"
  },
  "point_cloud": {
    "type": "array",
    "description": "Point cloud data [x, y, z]"
  },
  "timestamp": {
    "type": "string",
    "description": "ISO 8601 timestamp"
  }
};

const uiSchema = {
  "columns": 3,
  "widgets": [
    {
      "id": "widget-temp-text",
      "type": "text",
      "dataBinding": {"field": "temperature"},
      "position": {"row": 1, "col": 1, "rowSpan": 1, "colSpan": 1},
      "config": {"label": "Temperature", "fontSize": 24, "decimals": 1}
    },
    {
      "id": "widget-humidity-gauge",
      "type": "gauge",
      "dataBinding": {"field": "humidity"},
      "position": {"row": 1, "col": 2, "rowSpan": 1, "colSpan": 1},
      "config": {"label": "Humidity", "min": 0, "max": 100, "unit": "%"}
    },
    {
      "id": "widget-pressure-gauge",
      "type": "gauge",
      "dataBinding": {"field": "pressure"},
      "position": {"row": 1, "col": 3, "rowSpan": 1, "colSpan": 1},
      "config": {"label": "Pressure", "min": 900, "max": 1100, "unit": "hPa"}
    },
    {
      "id": "widget-status-led",
      "type": "led",
      "dataBinding": {"field": "system_status"},
      "position": {"row": 2, "col": 1, "rowSpan": 1, "colSpan": 1},
      "config": {"label": "System Status", "onColor": "green", "offColor": "red"}
    },
    {
      "id": "widget-message-text",
      "type": "text",
      "dataBinding": {"field": "message"},
      "position": {"row": 2, "col": 2, "rowSpan": 1, "colSpan": 2},
      "config": {"label": "Status Message", "fontSize": 16}
    },
    {
      "id": "widget-map",
      "type": "map",
      "dataBinding": {"field": "latitude"},
      "position": {"row": 3, "col": 1, "rowSpan": 2, "colSpan": 1},
      "config": {"label": "GPS Location", "latField": "latitude", "lonField": "longitude"}
    },
    {
      "id": "widget-video",
      "type": "video",
      "dataBinding": {"field": "video_url"},
      "position": {"row": 3, "col": 2, "rowSpan": 2, "colSpan": 2},
      "config": {"label": "Live Feed", "autoplay": false, "controls": true}
    },
    {
      "id": "widget-temp-chart",
      "type": "line_chart",
      "dataBinding": {"field": "temp_history"},
      "position": {"row": 5, "col": 1, "rowSpan": 1, "colSpan": 2},
      "config": {"label": "Temperature History", "xLabel": "Time", "yLabel": "°C"}
    },
    {
      "id": "widget-sensor-bar",
      "type": "bar_chart",
      "dataBinding": {"field": "sensor_readings"},
      "position": {"row": 5, "col": 3, "rowSpan": 1, "colSpan": 1},
      "config": {"label": "Sensor Readings", "xLabel": "Sensor", "yLabel": "Value"}
    }
  ]
};

async function main() {
  try {
    const result = await createCustomApp({
      appId: "comprehensive-widget-test",
      name: "Comprehensive Widget Test",
      description: "Tests all 8 widget types: Text, Gauge, LED, Map, Video, Line Chart, Bar Chart, Canvas",
      parserCode,
      dataSchema: JSON.stringify(dataSchema),
      uiSchema: JSON.stringify(uiSchema),
      published: "published"
    });
    
    console.log('✅ App created successfully:', result);
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to create app:', error);
    process.exit(1);
  }
}

main();
