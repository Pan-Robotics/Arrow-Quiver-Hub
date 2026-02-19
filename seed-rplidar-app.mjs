/**
 * Seed script: Create an RPLidar Point Cloud Viewer custom app
 * that taps into the existing RPLidar data stream via broadcastAppData.
 */
import mysql from 'mysql2/promise';

const APP_ID = 'rplidar-pointcloud-viewer';
const CREATOR_ID = 1; // Admin user

// Parser code - a simple passthrough since data is already formatted server-side
const parserCode = `
import json

SCHEMA = {
    "point_cloud": {"type": "array", "description": "3D point cloud data"},
    "point_count": {"type": "number", "description": "Total point count"},
    "valid_points": {"type": "number", "description": "Valid point count"},
    "avg_distance": {"type": "number", "description": "Average distance in mm"},
    "avg_quality": {"type": "number", "description": "Average quality"},
    "min_distance": {"type": "number", "description": "Min distance in mm"},
    "max_distance": {"type": "number", "description": "Max distance in mm"},
    "drone_id": {"type": "string", "description": "Drone identifier"}
}

def parse(payload):
    return payload
`;

// Data schema matching the parser output
const dataSchema = {
  point_cloud: { type: "array", description: "3D point cloud data" },
  point_count: { type: "number", description: "Total point count" },
  valid_points: { type: "number", description: "Valid point count" },
  avg_distance: { type: "number", description: "Average distance in mm" },
  avg_quality: { type: "number", description: "Average quality" },
  min_distance: { type: "number", description: "Min distance in mm" },
  max_distance: { type: "number", description: "Max distance in mm" },
  drone_id: { type: "string", description: "Drone identifier" },
};

// UI schema with canvas widget + stat text widgets
const uiSchema = {
  columns: 4,
  widgets: [
    // Point Cloud Canvas - full width, tall
    {
      id: "w-canvas",
      type: "canvas",
      position: { row: 1, col: 1, colSpan: 4, rowSpan: 3 },
      config: {
        label: "RPLidar Point Cloud (UI Builder)",
        height: 500,
        colorMode: "distance",
        minDistance: 0,
        maxDistance: 5000,
        pointSize: 3,
        showGrid: true,
        showAxes: true,
      },
      dataBinding: { field: "point_cloud" },
    },
    // Stat widgets - bottom row
    {
      id: "w-points",
      type: "text",
      position: { row: 4, col: 1 },
      config: {
        label: "Point Count",
        decimalPlaces: 0,
      },
      dataBinding: { field: "point_count" },
    },
    {
      id: "w-valid",
      type: "text",
      position: { row: 4, col: 2 },
      config: {
        label: "Valid Points",
        decimalPlaces: 0,
      },
      dataBinding: { field: "valid_points" },
    },
    {
      id: "w-avgdist",
      type: "text",
      position: { row: 4, col: 3 },
      config: {
        label: "Avg Distance",
        unit: "mm",
        decimalPlaces: 0,
      },
      dataBinding: { field: "avg_distance" },
    },
    {
      id: "w-quality",
      type: "text",
      position: { row: 4, col: 4 },
      config: {
        label: "Avg Quality",
        decimalPlaces: 1,
      },
      dataBinding: { field: "avg_quality" },
    },
    // Second row of stats
    {
      id: "w-mindist",
      type: "gauge",
      position: { row: 5, col: 1 },
      config: {
        label: "Min Distance",
        unit: "mm",
        min: 0,
        max: 5000,
        decimalPlaces: 0,
      },
      dataBinding: { field: "min_distance" },
    },
    {
      id: "w-maxdist",
      type: "gauge",
      position: { row: 5, col: 2 },
      config: {
        label: "Max Distance",
        unit: "mm",
        min: 0,
        max: 12000,
        decimalPlaces: 0,
      },
      dataBinding: { field: "max_distance" },
    },
    {
      id: "w-drone",
      type: "text",
      position: { row: 5, col: 3, colSpan: 2 },
      config: {
        label: "Drone ID",
      },
      dataBinding: { field: "drone_id" },
    },
  ],
};

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);

  try {
    // Check if app already exists
    const [existing] = await conn.execute(
      'SELECT id FROM customApps WHERE appId = ?',
      [APP_ID]
    );

    if (existing.length > 0) {
      console.log(`App "${APP_ID}" already exists (id: ${existing[0].id}). Updating...`);
      await conn.execute(
        'UPDATE customApps SET uiSchema = ?, dataSchema = ?, parserCode = ?, name = ?, description = ? WHERE appId = ?',
        [
          JSON.stringify(uiSchema),
          JSON.stringify(dataSchema),
          parserCode,
          'RPLidar Point Cloud Viewer',
          'Live RPLidar point cloud visualization via UI Builder canvas widget. Taps into the existing RPLidar data stream.',
          APP_ID,
        ]
      );
      console.log('App updated successfully.');
    } else {
      // Insert the app
      await conn.execute(
        'INSERT INTO customApps (appId, name, description, parserCode, dataSchema, uiSchema, version, published, creatorId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          APP_ID,
          'RPLidar Point Cloud Viewer',
          'Live RPLidar point cloud visualization via UI Builder canvas widget. Taps into the existing RPLidar data stream.',
          parserCode,
          JSON.stringify(dataSchema),
          JSON.stringify(uiSchema),
          '1.0.0',
          'published',
          CREATOR_ID,
        ]
      );
      console.log(`App "${APP_ID}" created successfully.`);
    }

    // Auto-install for admin user
    const [installed] = await conn.execute(
      'SELECT id FROM userApps WHERE userId = ? AND appId = ?',
      [CREATOR_ID, APP_ID]
    );

    if (installed.length === 0) {
      await conn.execute(
        'INSERT INTO userApps (userId, appId) VALUES (?, ?)',
        [CREATOR_ID, APP_ID]
      );
      console.log(`App installed for user ${CREATOR_ID}.`);
    } else {
      console.log(`App already installed for user ${CREATOR_ID}.`);
    }

    console.log('Done!');
  } finally {
    await conn.end();
  }
}

main().catch(console.error);
