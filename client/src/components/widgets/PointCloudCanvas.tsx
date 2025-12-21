import { useRef, useEffect, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
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
  pointSize = 2
}: { 
  points: Point[];
  colorMode: 'distance' | 'intensity' | 'height';
  minDistance: number;
  maxDistance: number;
  pointSize: number;
}) {
  const pointsRef = useRef<THREE.Points>(null);

  // Create geometry and material
  const { geometry, material } = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(points.length * 3);
    const colors = new Float32Array(points.length * 3);

    points.forEach((point, i) => {
      positions[i * 3] = point.x;
      positions[i * 3 + 1] = point.y;
      positions[i * 3 + 2] = point.z;

      // Calculate color based on mode
      let value = 0;
      if (colorMode === 'distance') {
        value = point.distance || Math.sqrt(point.x ** 2 + point.y ** 2 + point.z ** 2);
      } else if (colorMode === 'intensity') {
        value = point.intensity || 0;
      } else if (colorMode === 'height') {
        value = point.z;
      }

      // Normalize value to 0-1 range
      const normalized = Math.max(0, Math.min(1, (value - minDistance) / (maxDistance - minDistance)));

      // Color gradient: blue (close) -> green -> yellow -> red (far)
      const color = new THREE.Color();
      if (normalized < 0.33) {
        // Blue to green
        color.setRGB(0, normalized * 3, 1 - normalized * 3);
      } else if (normalized < 0.66) {
        // Green to yellow
        const t = (normalized - 0.33) * 3;
        color.setRGB(t, 1, 0);
      } else {
        // Yellow to red
        const t = (normalized - 0.66) * 3;
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
      sizeAttenuation: true,
    });

    return { geometry: geo, material: mat };
  }, [points, colorMode, minDistance, maxDistance, pointSize]);

  // Optional: Add rotation animation
  useFrame(() => {
    if (pointsRef.current) {
      // Slowly rotate the point cloud for better visualization
      // pointsRef.current.rotation.z += 0.001;
    }
  });

  return <points ref={pointsRef} geometry={geometry} material={material} />;
}

export default function PointCloudCanvas({
  points,
  colorMode = 'distance',
  minDistance = 0,
  maxDistance = 5000,
  pointSize = 2,
  showGrid = true,
  showAxes = true,
}: PointCloudCanvasProps) {
  // Parse points if they're in string format
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
    <div className="w-full h-full relative">
      <Canvas>
        <PerspectiveCamera makeDefault position={[0, -2000, 1000]} />
        <OrbitControls 
          enableDamping
          dampingFactor={0.05}
          rotateSpeed={0.5}
          zoomSpeed={0.8}
          panSpeed={0.5}
        />
        
        {/* Lighting */}
        <ambientLight intensity={0.5} />
        <pointLight position={[10, 10, 10]} intensity={1} />
        
        {/* Grid helper */}
        {showGrid && (
          <gridHelper args={[10000, 50, 0x444444, 0x222222]} rotation={[0, 0, 0]} />
        )}
        
        {/* Axes helper */}
        {showAxes && <axesHelper args={[1000]} />}
        
        {/* Point cloud */}
        <PointCloud 
          points={parsedPoints}
          colorMode={colorMode}
          minDistance={minDistance}
          maxDistance={maxDistance}
          pointSize={pointSize}
        />
      </Canvas>
      
      {/* Info overlay */}
      <div className="absolute bottom-2 left-2 bg-background/80 backdrop-blur-sm rounded px-2 py-1 text-xs">
        <div className="text-muted-foreground">
          Points: {parsedPoints.length.toLocaleString()}
        </div>
        <div className="text-muted-foreground">
          Color: {colorMode}
        </div>
      </div>
      
      {/* Controls hint */}
      <div className="absolute top-2 right-2 bg-background/80 backdrop-blur-sm rounded px-2 py-1 text-xs text-muted-foreground">
        <div>Left click: Rotate</div>
        <div>Right click: Pan</div>
        <div>Scroll: Zoom</div>
      </div>
    </div>
  );
}
