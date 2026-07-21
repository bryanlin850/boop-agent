import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import {
  buildMemoryGraph,
  type GraphLink,
  type GraphNode,
  type MemoryNode,
  type MemoryRecord,
  type RootNode,
  type TopicNode,
} from "./memoryGraphModel.js";

const SEGMENT_COLORS: Record<string, string> = {
  identity: "#f43f5e",
  preference: "#14b8a6",
  correction: "#eab308",
  relationship: "#ec4899",
  project: "#f97316",
  knowledge: "#3b82f6",
  context: "#64748b",
};
const DEFAULT_COLOR = "#94a3b8";

function segmentColor(segment: string): string {
  return SEGMENT_COLORS[segment] ?? DEFAULT_COLOR;
}

function colorWithAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  if (value.length !== 6) return hex;
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red},${green},${blue},${alpha})`;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawRootNode(ctx: CanvasRenderingContext2D, node: RootNode, isDark: boolean) {
  const width = 104;
  const height = 43;
  const x = node.fx - width / 2;
  const y = node.fy - height / 2;

  ctx.save();
  ctx.shadowColor = isDark ? "rgba(0,0,0,0.35)" : "rgba(15,23,42,0.14)";
  ctx.shadowBlur = 9;
  roundedRect(ctx, x, y, width, height, 13);
  ctx.fillStyle = isDark ? "#27272a" : "#ffffff";
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = isDark ? "rgba(255,255,255,0.16)" : "rgba(15,23,42,0.13)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "#f59e0b";
  ctx.beginPath();
  ctx.arc(x + 17, node.fy, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = isDark ? "#18181b" : "#ffffff";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = isDark ? "#fafafa" : "#18181b";
  ctx.font = "600 10.5px Geist, ui-sans-serif, system-ui";
  ctx.fillText("Boop memory", x + 29, node.fy - 6);
  ctx.fillStyle = isDark ? "#a1a1aa" : "#71717a";
  ctx.font = "7.5px Geist, ui-sans-serif, system-ui";
  ctx.fillText(`${node.memoryCount} memories`, x + 29, node.fy + 8);
  ctx.restore();
}

function drawTopicNode(ctx: CanvasRenderingContext2D, node: TopicNode, isDark: boolean) {
  ctx.save();
  ctx.font = "600 9.5px Geist, ui-sans-serif, system-ui";
  const labelWidth = ctx.measureText(node.label).width;
  const countText = String(node.memoryCount);
  ctx.font = "600 8px Geist, ui-sans-serif, system-ui";
  const countWidth = ctx.measureText(countText).width;
  const width = Math.max(94, labelWidth + countWidth + 38);
  const height = 30;
  const x = node.fx - width / 2;
  const y = node.fy - height / 2;

  ctx.shadowColor = isDark ? "rgba(0,0,0,0.28)" : "rgba(15,23,42,0.1)";
  ctx.shadowBlur = 6;
  roundedRect(ctx, x, y, width, height, 9);
  ctx.fillStyle = isDark ? "#27272a" : "rgba(255,255,255,0.96)";
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = colorWithAlpha(node.color, isDark ? 0.65 : 0.45);
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.fillStyle = node.color;
  roundedRect(ctx, x + 7, y + 7, 4, 16, 2);
  ctx.fill();

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = isDark ? "#f4f4f5" : "#27272a";
  ctx.font = "600 9.5px Geist, ui-sans-serif, system-ui";
  ctx.fillText(node.label, x + 18, node.fy);

  const countX = x + width - countWidth - 10;
  ctx.fillStyle = isDark ? "#a1a1aa" : "#71717a";
  ctx.font = "600 8px Geist, ui-sans-serif, system-ui";
  ctx.fillText(countText, countX, node.fy);
  ctx.restore();
}

function drawMemoryNode(
  ctx: CanvasRenderingContext2D,
  node: MemoryNode,
  isDark: boolean,
  globalScale: number,
) {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const radius = 3.2 + node.importance * 2.2;
  const color = segmentColor(node.segment);

  ctx.save();
  ctx.fillStyle = colorWithAlpha(node.topicColor, isDark ? 0.2 : 0.14);
  ctx.beginPath();
  ctx.arc(x, y, radius + 3.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = isDark ? "#202024" : "#ffffff";
  ctx.lineWidth = 1.2;
  ctx.stroke();

  if (node.tier === "permanent") {
    ctx.strokeStyle = colorWithAlpha(color, 0.75);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (node.showLabel && globalScale >= 0.72) {
    ctx.font = "500 7.5px Geist, ui-sans-serif, system-ui";
    const labelWidth = Math.min(104, ctx.measureText(node.label).width + 12);
    const labelX =
      node.labelSide === "left"
        ? x - radius - 4 - labelWidth
        : x + radius + 4;
    const labelY = y - 8;
    roundedRect(ctx, labelX, labelY, labelWidth, 16, 5);
    ctx.fillStyle = isDark ? "rgba(39,39,42,0.94)" : "rgba(255,255,255,0.94)";
    ctx.fill();
    ctx.strokeStyle = isDark ? "rgba(255,255,255,0.11)" : "rgba(15,23,42,0.1)";
    ctx.lineWidth = 0.7;
    ctx.stroke();
    ctx.fillStyle = isDark ? "#e4e4e7" : "#3f3f46";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(node.label, labelX + 6, y, labelWidth - 10);
  }
  ctx.restore();
}

export default function MemoryGraphView({
  records,
  isDark,
}: {
  records: unknown[];
  isDark: boolean;
}) {
  const graph = useMemo(() => buildMemoryGraph(records as MemoryRecord[]), [records]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const [size, setSize] = useState({ width: 1, height: 1 });

  const fitGraph = useCallback(() => {
    window.setTimeout(() => fgRef.current?.zoomToFit(450, 42), 60);
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    let settleTimer: number | undefined;
    const updateSize = () => {
      const bounds = element.getBoundingClientRect();
      const nextSize = {
        width: Math.max(1, Math.floor(bounds.width)),
        height: Math.max(1, Math.floor(bounds.height)),
      };
      setSize((current) =>
        current.width === nextSize.width && current.height === nextSize.height
          ? current
          : nextSize,
      );

      // The desktop app reveals the dashboard iframe after startup. Chromium
      // can miss that transition in ResizeObserver, so keep checking until the
      // graph has measured a real viewport instead of its 1px fallback.
      if (nextSize.width > 1 && nextSize.height > 1 && settleTimer !== undefined) {
        window.clearInterval(settleTimer);
        settleTimer = undefined;
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    const frame = window.requestAnimationFrame(updateSize);
    settleTimer = window.setInterval(updateSize, 200);
    window.addEventListener("resize", updateSize);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      if (settleTimer !== undefined) window.clearInterval(settleTimer);
      window.removeEventListener("resize", updateSize);
    };
  }, []);

  useEffect(() => {
    const graphInstance = fgRef.current;
    if (!graphInstance) return;
    const linkForce = graphInstance.d3Force("link") as
      | {
          distance: (value: (link: GraphLink) => number) => unknown;
          strength: (value: (link: GraphLink) => number) => unknown;
        }
      | undefined;
    linkForce?.distance((link) => {
      if (link.kind === "root") return 105;
      if (link.kind === "membership") return 52;
      if (link.kind === "history") return 36;
      return 42;
    });
    linkForce?.strength((link) => (link.kind === "root" ? 0.45 : 0.2));

    const chargeForce = graphInstance.d3Force("charge") as
      | {
          strength: (value: (node: GraphNode) => number) => unknown;
          distanceMax: (value: number) => unknown;
        }
      | undefined;
    chargeForce?.strength((node) => {
      if (node.kind === "root") return -180;
      if (node.kind === "topic") return -260;
      return -24;
    });
    chargeForce?.distanceMax(180);
    graphInstance.d3ReheatSimulation();
    fitGraph();
  }, [fitGraph, graph, size.height, size.width]);

  if (records.length === 0) {
    return (
      <div
        className={`flex h-full items-center justify-center text-sm ${
          isDark ? "text-zinc-600" : "text-zinc-400"
        }`}
      >
        No memories yet. Chat with the agent to build your graph.
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <ForceGraph2D<GraphNode, GraphLink>
        ref={fgRef}
        graphData={graph}
        width={size.width}
        height={size.height}
        backgroundColor={isDark ? "#202024" : "#ffffff"}
        nodeRelSize={4}
        nodeLabel={(node) => {
          if (node.kind === "root") {
            return `${node.memoryCount} memories across ${node.topicCount} connected themes`;
          }
          if (node.kind === "topic") return `${node.label} - ${node.memoryCount} memories`;
          return node.content;
        }}
        nodeCanvasObject={(node, ctx, globalScale) => {
          if (node.kind === "root") drawRootNode(ctx, node, isDark);
          else if (node.kind === "topic") drawTopicNode(ctx, node, isDark);
          else drawMemoryNode(ctx, node, isDark, globalScale);
        }}
        nodePointerAreaPaint={(node, color, ctx) => {
          ctx.fillStyle = color;
          if (node.kind === "root") {
            roundedRect(ctx, node.fx - 52, node.fy - 22, 104, 44, 13);
            ctx.fill();
          } else if (node.kind === "topic") {
            roundedRect(ctx, node.fx - 58, node.fy - 16, 116, 32, 9);
            ctx.fill();
          } else {
            ctx.beginPath();
            ctx.arc(node.x ?? 0, node.y ?? 0, 9, 0, Math.PI * 2);
            ctx.fill();
          }
        }}
        linkColor={(link) => {
          if (link.kind === "root") return colorWithAlpha(link.color ?? DEFAULT_COLOR, 0.34);
          if (link.kind === "membership") {
            return colorWithAlpha(link.color ?? DEFAULT_COLOR, isDark ? 0.26 : 0.21);
          }
          if (link.kind === "history") {
            return isDark ? "rgba(250,204,21,0.34)" : "rgba(161,98,7,0.28)";
          }
          return isDark ? "rgba(161,161,170,0.19)" : "rgba(71,85,105,0.14)";
        }}
        linkWidth={(link) => (link.kind === "root" ? 1.5 : link.kind === "history" ? 1.1 : 0.75)}
        linkLineDash={(link) => (link.kind === "history" ? [3, 3] : null)}
        linkCurvature={(link) => (link.kind === "affinity" ? 0.08 : 0)}
        d3AlphaDecay={0.035}
        d3VelocityDecay={0.38}
        warmupTicks={80}
        cooldownTicks={180}
        minZoom={0.65}
        maxZoom={6}
        onEngineStop={fitGraph}
      />
    </div>
  );
}
