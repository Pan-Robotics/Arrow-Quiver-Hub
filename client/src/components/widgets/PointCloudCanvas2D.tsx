import { useRef, useEffect, useCallback, useState } from 'react';

interface Point {
  x: number;
  y: number;
  z: number;
  distance?: number;
  intensity?: number;
}

interface PointCloudCanvas2DProps {
  points: Point[];
  colorMode?: 'distance' | 'intensity' | 'height';
  minDistance?: number;
  maxDistance?: number;
  pointSize?: number;
  showGrid?: boolean;
  showAxes?: boolean;
}

/**
 * Get color for a normalized value (0-1) using a blue->cyan->green->yellow->red gradient.
 */
function getColor(normalized: number): string {
  const n = Math.max(0, Math.min(1, normalized));
  let r: number, g: number, b: number;

  if (n < 0.25) {
    // Blue to Cyan
    r = 0;
    g = Math.floor(n * 4 * 255);
    b = 255;
  } else if (n < 0.5) {
    // Cyan to Green
    const t = (n - 0.25) * 4;
    r = 0;
    g = 255;
    b = Math.floor((1 - t) * 255);
  } else if (n < 0.75) {
    // Green to Yellow
    const t = (n - 0.5) * 4;
    r = Math.floor(t * 255);
    g = 255;
    b = 0;
  } else {
    // Yellow to Red
    const t = (n - 0.75) * 4;
    r = 255;
    g = Math.floor((1 - t) * 255);
    b = 0;
  }

  return `rgb(${r},${g},${b})`;
}

export default function PointCloudCanvas2D({
  points,
  colorMode = 'distance',
  minDistance = 0,
  maxDistance = 5000,
  pointSize = 3,
  showGrid = true,
  showAxes = true,
}: PointCloudCanvas2DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  // Pan and zoom state
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const autoFitted = useRef(false);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width: Math.floor(width), height: Math.floor(height) });
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Auto-fit to data on first render
  useEffect(() => {
    if (points.length === 0 || autoFitted.current) return;
    autoFitted.current = true;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    // Fit with 10% padding
    const scaleX = dimensions.width / (rangeX * 1.2);
    const scaleY = dimensions.height / (rangeY * 1.2);
    const scale = Math.min(scaleX, scaleY);

    zoomRef.current = scale;
    panRef.current = {
      x: dimensions.width / 2 - centerX * scale,
      y: dimensions.height / 2 + centerY * scale, // Flip Y
    };
  }, [points, dimensions]);

  // Mouse handlers for pan and zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const oldZoom = zoomRef.current;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = oldZoom * factor;

    // Zoom toward mouse position
    panRef.current.x = mouseX - (mouseX - panRef.current.x) * (newZoom / oldZoom);
    panRef.current.y = mouseY - (mouseY - panRef.current.y) * (newZoom / oldZoom);
    zoomRef.current = newZoom;
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    lastMouse.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    panRef.current.x += dx;
    panRef.current.y += dy;
    lastMouse.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;

    function draw() {
      if (!ctx || !canvas) return;

      const { width, height } = dimensions;
      canvas.width = width;
      canvas.height = height;

      // Clear
      ctx.fillStyle = '#111111';
      ctx.fillRect(0, 0, width, height);

      const zoom = zoomRef.current;
      const pan = panRef.current;

      // Transform: world coords -> screen coords
      // screenX = worldX * zoom + panX
      // screenY = -worldY * zoom + panY (flip Y axis)
      const toScreenX = (wx: number) => wx * zoom + pan.x;
      const toScreenY = (wy: number) => -wy * zoom + pan.y;

      // Draw grid
      if (showGrid) {
        ctx.strokeStyle = '#333333';
        ctx.lineWidth = 0.5;

        // Determine grid spacing based on zoom
        let gridStep = 1000; // 1 meter in mm
        if (zoom > 0.5) gridStep = 500;
        if (zoom > 1) gridStep = 200;
        if (zoom < 0.05) gridStep = 5000;
        if (zoom < 0.01) gridStep = 10000;

        // Determine visible range
        const worldMinX = (0 - pan.x) / zoom;
        const worldMaxX = (width - pan.x) / zoom;
        const worldMinY = -(height - pan.y) / zoom;
        const worldMaxY = -(0 - pan.y) / zoom;

        const startX = Math.floor(worldMinX / gridStep) * gridStep;
        const endX = Math.ceil(worldMaxX / gridStep) * gridStep;
        const startY = Math.floor(worldMinY / gridStep) * gridStep;
        const endY = Math.ceil(worldMaxY / gridStep) * gridStep;

        ctx.beginPath();
        for (let x = startX; x <= endX; x += gridStep) {
          const sx = toScreenX(x);
          ctx.moveTo(sx, 0);
          ctx.lineTo(sx, height);
        }
        for (let y = startY; y <= endY; y += gridStep) {
          const sy = toScreenY(y);
          ctx.moveTo(0, sy);
          ctx.lineTo(width, sy);
        }
        ctx.stroke();
      }

      // Draw axes
      if (showAxes) {
        const originX = toScreenX(0);
        const originY = toScreenY(0);

        // X axis (red)
        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(originX, originY);
        ctx.lineTo(originX + 100, originY);
        ctx.stroke();

        // Y axis (green)
        ctx.strokeStyle = '#44ff44';
        ctx.beginPath();
        ctx.moveTo(originX, originY);
        ctx.lineTo(originX, originY - 100);
        ctx.stroke();

        // Origin dot
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(originX, originY, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Draw points
      if (points.length > 0) {
        const range = maxDistance - minDistance || 1;

        for (const p of points) {
          let value = 0;
          if (colorMode === 'distance') {
            value = p.distance || Math.sqrt(p.x ** 2 + p.y ** 2 + p.z ** 2);
          } else if (colorMode === 'intensity') {
            value = p.intensity || 0;
          } else if (colorMode === 'height') {
            value = p.z;
          }

          const normalized = (value - minDistance) / range;
          const color = getColor(normalized);

          const sx = toScreenX(p.x);
          const sy = toScreenY(p.y);

          // Skip points outside viewport
          if (sx < -10 || sx > width + 10 || sy < -10 || sy > height + 10) continue;

          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(sx, sy, pointSize, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Draw scale bar
      const scaleBarWorldLength = Math.pow(10, Math.floor(Math.log10(width / zoom / 3)));
      const scaleBarScreenLength = scaleBarWorldLength * zoom;
      
      ctx.fillStyle = '#666666';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      
      const barX = width - 20 - scaleBarScreenLength;
      const barY = height - 20;
      
      ctx.strokeStyle = '#888888';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(barX, barY);
      ctx.lineTo(barX + scaleBarScreenLength, barY);
      ctx.stroke();
      
      // Tick marks
      ctx.beginPath();
      ctx.moveTo(barX, barY - 4);
      ctx.lineTo(barX, barY + 4);
      ctx.moveTo(barX + scaleBarScreenLength, barY - 4);
      ctx.lineTo(barX + scaleBarScreenLength, barY + 4);
      ctx.stroke();
      
      const label = scaleBarWorldLength >= 1000 
        ? `${(scaleBarWorldLength / 1000).toFixed(0)}m` 
        : `${scaleBarWorldLength.toFixed(0)}mm`;
      ctx.fillText(label, barX + scaleBarScreenLength / 2, barY - 8);

      animId = requestAnimationFrame(draw);
    }

    draw();

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [points, dimensions, colorMode, minDistance, maxDistance, pointSize, showGrid, showAxes]);

  if (!points || points.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-muted rounded-lg">
        <div className="text-center">
          <p className="text-sm text-muted-foreground">No point cloud data</p>
          <p className="text-xs text-muted-foreground mt-1">Waiting for data...</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-full relative bg-black rounded-lg overflow-hidden">
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
        className="w-full h-full"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: isDragging.current ? 'grabbing' : 'grab' }}
      />
      
      {/* Info overlay */}
      <div className="absolute bottom-2 left-2 bg-black/70 backdrop-blur-sm rounded px-2 py-1 text-xs">
        <div className="text-gray-400">
          Points: {points.length.toLocaleString()}
        </div>
        <div className="text-gray-400">
          Color: {colorMode}
        </div>
      </div>
      
      {/* Controls hint */}
      <div className="absolute top-2 right-2 bg-black/70 backdrop-blur-sm rounded px-2 py-1 text-xs text-gray-400">
        <div>Drag: Pan</div>
        <div>Scroll: Zoom</div>
      </div>
    </div>
  );
}
