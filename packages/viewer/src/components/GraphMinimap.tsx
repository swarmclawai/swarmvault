import type { Core } from "cytoscape";
import { useEffect, useRef, useState } from "react";

type GraphMinimapProps = {
  cyRef: React.MutableRefObject<Core | null>;
};

type Bounds = { x: number; y: number; w: number; h: number };

const MINIMAP_W = 180;
const MINIMAP_H = 120;

export function GraphMinimap({ cyRef }: GraphMinimapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [viewport, setViewport] = useState<Bounds | null>(null);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const draw = () => {
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);
      const nodes = cy.nodes();
      if (nodes.empty()) return;
      const bb = nodes.boundingBox({ includeNodes: true, includeEdges: false });
      const dx = bb.w === 0 ? 1 : bb.w;
      const dy = bb.h === 0 ? 1 : bb.h;
      const scale = Math.min((MINIMAP_W - 8) / dx, (MINIMAP_H - 8) / dy);
      const offsetX = (MINIMAP_W - dx * scale) / 2;
      const offsetY = (MINIMAP_H - dy * scale) / 2;
      ctx.fillStyle = "rgba(125, 211, 252, 0.7)";
      nodes.forEach((node) => {
        const pos = node.position();
        const nx = (pos.x - bb.x1) * scale + offsetX;
        const ny = (pos.y - bb.y1) * scale + offsetY;
        ctx.beginPath();
        ctx.arc(nx, ny, 1.4, 0, Math.PI * 2);
        ctx.fill();
      });
      const extent = cy.extent();
      const vx = (extent.x1 - bb.x1) * scale + offsetX;
      const vy = (extent.y1 - bb.y1) * scale + offsetY;
      const vw = (extent.x2 - extent.x1) * scale;
      const vh = (extent.y2 - extent.y1) * scale;
      setViewport({
        x: Math.max(0, Math.min(MINIMAP_W, vx)),
        y: Math.max(0, Math.min(MINIMAP_H, vy)),
        w: Math.max(2, Math.min(MINIMAP_W, vw)),
        h: Math.max(2, Math.min(MINIMAP_H, vh))
      });
    };

    draw();
    const handler = () => requestAnimationFrame(draw);
    cy.on("pan zoom add remove position layoutstop", handler);
    return () => {
      cy.off("pan zoom add remove position layoutstop", handler);
    };
  }, [cyRef]);

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const cy = cyRef.current;
    if (!cy || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const nodes = cy.nodes();
    if (nodes.empty()) return;
    const bb = nodes.boundingBox({ includeNodes: true, includeEdges: false });
    const scale = Math.min((MINIMAP_W - 8) / Math.max(1, bb.w), (MINIMAP_H - 8) / Math.max(1, bb.h));
    const offsetX = (MINIMAP_W - bb.w * scale) / 2;
    const offsetY = (MINIMAP_H - bb.h * scale) / 2;
    const targetX = (localX - offsetX) / scale + bb.x1;
    const targetY = (localY - offsetY) / scale + bb.y1;
    cy.center({ position: () => ({ x: targetX, y: targetY }) } as never);
  };

  return (
    <div ref={containerRef} className="canvas-minimap" role="presentation" onClick={handleClick} aria-hidden="true">
      <canvas ref={canvasRef} width={MINIMAP_W} height={MINIMAP_H} style={{ width: "100%", height: "100%" }} />
      {viewport ? (
        <div className="canvas-minimap-viewport" style={{ left: viewport.x, top: viewport.y, width: viewport.w, height: viewport.h }} />
      ) : null}
    </div>
  );
}
