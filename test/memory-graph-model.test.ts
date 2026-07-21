import { describe, expect, it } from "vitest";
import {
  buildMemoryGraph,
  type GraphLink,
  type MemoryRecord,
} from "../debug/src/components/memoryGraphModel.js";

function memory(
  memoryId: string,
  topic: string,
  content: string,
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  return {
    memoryId,
    content,
    tier: "long",
    segment: "preference",
    importance: 0.8,
    accessCount: 4,
    metadata: JSON.stringify({ graph: { topic, label: content, relatedMemoryIds: [] } }),
    ...overrides,
  };
}

function endpoints(link: GraphLink): [string, string] {
  return [String(link.source), String(link.target)];
}

describe("memory graph model", () => {
  it("builds a connected topic map with affinity and history edges", () => {
    const graph = buildMemoryGraph([
      memory("memory:1", "launch", "Launch checklist", {
        metadata: JSON.stringify({
          graph: {
            topic: "launch",
            label: "Launch checklist",
            relatedMemoryIds: ["memory:3"],
          },
        }),
      }),
      memory("memory:2", "launch", "Beta feedback"),
      memory("memory:3", "daily-rhythm", "Protect focus time", {
        supersedes: ["memory:4"],
      }),
      memory("memory:4", "daily-rhythm", "Old focus-time rule"),
    ]);

    expect(graph.nodes.filter((node) => node.kind === "root")).toHaveLength(1);
    expect(graph.nodes.filter((node) => node.kind === "topic")).toHaveLength(2);
    expect(graph.nodes.filter((node) => node.kind === "memory")).toHaveLength(4);
    expect(graph.links.filter((link) => link.kind === "membership")).toHaveLength(4);
    expect(graph.links.some((link) => link.kind === "affinity")).toBe(true);
    expect(graph.links.some((link) => link.kind === "history")).toBe(true);

    const adjacency = new Map<string, Set<string>>();
    for (const link of graph.links) {
      const [source, target] = endpoints(link);
      if (!adjacency.has(source)) adjacency.set(source, new Set());
      if (!adjacency.has(target)) adjacency.set(target, new Set());
      adjacency.get(source)!.add(target);
      adjacency.get(target)!.add(source);
    }
    const visited = new Set<string>(["root:memory"]);
    const queue = ["root:memory"];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }

    expect(visited.size).toBe(graph.nodes.length);
  });

  it("infers a useful topic when real memory metadata has no graph hints", () => {
    const graph = buildMemoryGraph([
      memory("memory:travel", "unknown", "Prefer nonstop flights and an aisle seat", {
        metadata: undefined,
      }),
    ]);

    expect(graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "topic", id: "topic:travel", label: "Travel" }),
      ]),
    );
  });
});
