import { useRef, useMemo, useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

interface Point {
  x: number;
  y: number;
  z: number;
  distance?: number;
  intensity?: number;
}

interface PointCloudCanvasProps {
  points: Point[] | string;
  colorMode?: 'distance' | 'intensity' | 'height';
  minDistance?: number;
  maxDistance?: number;
  pointSize?: number;
  showGrid?: boolean;
  showAxes?: boolean;
}

function PointCloud({ 
  points, 
  colorMode = 'distance',
  minDistance = 0,
  maxDistance = 5000,
  pointSize = 4
}: { 
  points: Point[];
  colorMode: 'distance' | 'intensity' | 'height';
  minDistance: number;
  maxDistance: number;
  pointSize: number;
}) {
  const pointsRef = useRef<THREE.Points>(null);

  const { geometry, material } = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(points.length * 3);
    const colors = new Float32Array(points.length * 3);

    points.forEach((point, i) => {
      positions[i * 3] = point.x;
      positions[i * 3 + 1] = point.y;
      positions[i * 3 + 2] = point.z;

      let value = 0;
      if (colorMode === 'distance') {
        value = point.distance || Math.sqrt(point.x ** 2 + point.y ** 2 + point.z ** 2);
      } else if (colorMode === 'intensity') {
        value = point.intensity || 0;
      } else if (colorMode === 'height') {
        value = point.z;
      }

      const normalized = Math.max(0, Math.min(1, (value - minDistance) / (maxDistance - minDistance)));

      const color = new THREE.Color();
      if (normalized < 0.25) {
        color.setRGB(0, normalized * 4, 1);
      } else if (normalized < 0.5) {
        const t = (normalized - 0.25) * 4;
        color.setRGB(0, 1, 1 - t);
      } else if (normalized < 0.75) {
        const t = (normalized - 0.5) * 4;
        color.setRGB(t, 1, 0);
      } else {
        const t = (normalized - 0.75) * 4;
        color.setRGB(1, 1 - t, 0);
      }

      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    });

    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.PointsMaterial({
      size: pointSize,
      vertexColors: true,
      sizeAttenuation: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.9,
    });

    return { geometry: geo, material: mat };
  }, [points, colorMode, minDistance, maxDistance, pointSize]);

  // Dispose previous geometry/material on update
  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  return <points ref={pointsRef} geometry={geometry} material={material} />;
}

/**
 * Camera controller that auto-fits to view all points.
 * Uses orthographic-like perspective for 2D lidar data (top-down view).
 */
function AutoFitCamera({ points }: { points: Point[] }) {
  const { camera } = useThree();
  const initialized = useRef(false);

  useEffect(() => {
    if (points.length === 0) return;
    if (initialized.current) return;
    initialized.current = true;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const rangeX = maxX - minX;
    const rangeY = maxY - minY;
    const maxRange = Math.max(rangeX, rangeY, 100);

    // Position camera directly above, looking down at the XY plane
    camera.position.set(centerX, centerY, maxRange * 1.5);
    camera.up.set(0, 1, 0);
    camera.lookAt(centerX, centerY, 0);
    camera.updateProjectionMatrix();
  }, [points, camera]);

  return null;
}

/**
 * Grid lines drawn in the XY plane (z=0) for 2D lidar data.
 */
function XYGrid({ size = 10000, divisions = 20 }: { size?: number; divisions?: number }) {
  const gridRef = useRef<THREE.GridHelper>(null);

  useEffect(() => {
    // Rotate grid to lie in XY plane (default is XZ)
    if (gridRef.current) {
      gridRef.current.rotation.x = Math.PI / 2;
    }
  }, []);

  return (
    <gridHelper 
      ref={gridRef}
      args={[size, divisions, 0x444444, 0x333333]} 
    />
  );
}

export default function PointCloudCanvas({
  points,
  colorMode = 'distance',
  minDistance = 0,
  maxDistance = 5000,
  pointSize = 4,
  showGrid = true,
  showAxes = true,
}: PointCloudCanvasProps) {
  const parsedPoints = useMemo(() => {
    if (typeof points === 'string') {
      try {
        return JSON.parse(points) as Point[];
      } catch (e) {
        console.error('Failed to parse point cloud data:', e);
        return [];
      }
    }
    return points || [];
  }, [points]);

  if (!parsedPoints || parsedPoints.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-muted rounded-lg">
        <div className="text-center">
          <p className="text-sm text-muted-foreground">No point cloud data</p>
          <p className="text-xs text-muted-foreground mt-1">
            Waiting for data...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative bg-black rounded-lg overflow-hidden">
      <Canvas
        gl={{ 
          antialias: true,
          alpha: false,
          powerPreference: 'default',
        }}
        camera={{
          fov: 50,
          near: 1,
          far: 100000,
          position: [0, 0, 8000],
        }}
        style={{ background: '#111111' }}
      >
        <color attach="background" args={['#111111']} />
        
        <OrbitControls 
          enableDamping
          dampingFactor={0.1}
          rotateSpeed={0.5}
          zoomSpeed={1.2}
          panSpeed={0.8}
          minDistance={100}
          maxDistance={50000}
          enableRotate={true}
        />
        
        <AutoFitCamera points={parsedPoints} />
        
        <ambientLight intensity={1.0} />
        
        {showGrid && <XYGrid size={10000} divisions={20} />}
        
        {showAxes && <axesHelper args={[2000]} />}
        
        <PointCloud 
          points={parsedPoints}
          colorMode={colorMode}
          minDistance={minDistance}
          maxDistance={maxDistance}
          pointSize={pointSize}
        />
      </Canvas>
      
      {/* Info overlay */}
      <div className="absolute bottom-2 left-2 bg-black/70 backdrop-blur-sm rounded px-2 py-1 text-xs">
        <div className="text-gray-400">
          Points: {(parsedPoints?.length || 0).toLocaleString()}
        </div>
        <div className="text-gray-400">
          Color: {colorMode}
        </div>
      </div>
      
      {/* Controls hint */}
      <div className="absolute top-2 right-2 bg-black/70 backdrop-blur-sm rounded px-2 py-1 text-xs text-gray-400">
        <div>Left click: Rotate</div>
        <div>Right click: Pan</div>
        <div>Scroll: Zoom</div>
      </div>
    </div>
  );
}
