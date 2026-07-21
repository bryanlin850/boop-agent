export type MemoryRecord = {
  memoryId: string;
  content: string;
  tier: string;
  segment: string;
  importance: number;
  accessCount?: number;
  supersedes?: string[];
  metadata?: string;
};

type TopicDefinition = {
  id: string;
  label: string;
  color: string;
  patterns: RegExp[];
};

type GraphMetadata = {
  topic?: string;
  label?: string;
  relatedMemoryIds?: string[];
};

export type RootNode = {
  id: "root:memory";
  kind: "root";
  label: string;
  memoryCount: number;
  topicCount: number;
  fx: number;
  fy: number;
};

export type TopicNode = {
  id: string;
  kind: "topic";
  label: string;
  color: string;
  memoryCount: number;
  fx: number;
  fy: number;
};

export type MemoryNode = {
  id: string;
  kind: "memory";
  label: string;
  content: string;
  segment: string;
  tier: string;
  importance: number;
  topicId: string;
  topicColor: string;
  showLabel: boolean;
  labelSide: "left" | "right";
  x: number;
  y: number;
  fx?: number;
  fy?: number;
};

export type GraphNode = RootNode | TopicNode | MemoryNode;
export type GraphLink = {
  source: string;
  target: string;
  kind: "root" | "membership" | "affinity" | "history";
  color?: string;
};

const TOPICS: TopicDefinition[] = [
  {
    id: "launch",
    label: "Launch & product",
    color: "#f97316",
    patterns: [
      /launch|beta|dashboard|onboarding|release|pricing|webhook|bug bash|screenshots?/i,
      /product|billing|implementation|software team|code review/i,
    ],
  },
  {
    id: "customer-care",
    label: "Customer care",
    color: "#ec4899",
    patterns: [/customer|support|escalation|reply|draft|public post|copy|editor/i],
  },
  {
    id: "daily-rhythm",
    label: "Daily rhythm",
    color: "#6366f1",
    patterns: [
      /calendar|meeting|schedule|timezone|friday|focus block|deep work/i,
      /morning brief|status update|weekly digest|automation|evenings? after/i,
    ],
  },
  {
    id: "people",
    label: "People",
    color: "#a855f7",
    patterns: [
      /partner|family|design lead|support lead|operations contact/i,
      /contractor|finance contact|customer success lead|stakeholder/i,
    ],
  },
  {
    id: "travel",
    label: "Travel",
    color: "#3b82f6",
    patterns: [/travel|flight|hotel|airport|itinerary|aisle|nonstop|cancellation/i],
  },
  {
    id: "home-life",
    label: "Home & life",
    color: "#14b8a6",
    patterns: [/grocery|errand|package|dinner|restaurant|weekend|meal|neighborhood/i],
  },
  {
    id: "wellbeing",
    label: "Wellbeing",
    color: "#22c55e",
    patterns: [/workout|knee|shoulder|warmup|run|lower impact|health/i],
  },
  {
    id: "principles",
    label: "Principles",
    color: "#64748b",
    patterns: [/uncertainty|sensitive|private|remembered fact|confirmation|tradeoffs?/i],
  },
];

const TOPIC_BY_ID = new Map(TOPICS.map((topic) => [topic.id, topic]));

function parseGraphMetadata(metadata?: string): GraphMetadata {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata) as { graph?: GraphMetadata };
    return parsed.graph ?? {};
  } catch {
    return {};
  }
}

function topicForRecord(record: MemoryRecord, graphMetadata: GraphMetadata): TopicDefinition {
  const explicit = graphMetadata.topic ? TOPIC_BY_ID.get(graphMetadata.topic) : undefined;
  if (explicit) return explicit;

  const inferred = TOPICS.find((topic) =>
    topic.patterns.some((pattern) => pattern.test(record.content)),
  );
  return inferred ?? TOPIC_BY_ID.get("principles")!;
}

function compactLabel(content: string): string {
  const cleaned = content
    .replace(/^(the user|user|current|latest|next)\s+/i, "")
    .replace(/^(for|when|if)\s+/i, "")
    .replace(/[.:;,]+$/g, "")
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  const label = words.slice(0, 5).join(" ");
  return words.length > 5 ? `${label}...` : label;
}

function hashNumber(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0;
  }
  return hash;
}

function topicPosition(index: number, count: number) {
  const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
  return {
    angle,
    x: Math.cos(angle) * 330,
    y: Math.sin(angle) * 145,
  };
}

function memoryPosition(
  topicX: number,
  topicY: number,
  topicAngle: number,
  memoryId: string,
  index: number,
) {
  const hash = hashNumber(memoryId);
  const ring = Math.floor(index / 7);
  const radius = 42 + ring * 15 + (hash % 7);
  const angle = index === 0 ? topicAngle : ((hash % 360) * Math.PI) / 180 + index * 0.73;
  return {
    x: topicX + Math.cos(angle) * radius,
    y: topicY + Math.sin(angle) * radius,
  };
}

export function buildMemoryGraph(records: MemoryRecord[]): {
  nodes: GraphNode[];
  links: GraphLink[];
} {
  const prepared = records.map((record) => {
    const graphMetadata = parseGraphMetadata(record.metadata);
    return {
      record,
      graphMetadata,
      topic: topicForRecord(record, graphMetadata),
    };
  });

  const populatedTopics = TOPICS.filter((topic) =>
    prepared.some((item) => item.topic.id === topic.id),
  );
  const nodes: GraphNode[] = [
    {
      id: "root:memory",
      kind: "root",
      label: "Boop memory",
      memoryCount: records.length,
      topicCount: populatedTopics.length,
      fx: 0,
      fy: 0,
    },
  ];
  const links: GraphLink[] = [];
  const linkKeys = new Set<string>();

  const addLink = (link: GraphLink) => {
    const endpoints = [String(link.source), String(link.target)].sort().join("::");
    const key = `${link.kind}:${endpoints}`;
    if (linkKeys.has(key) || link.source === link.target) return;
    linkKeys.add(key);
    links.push(link);
  };

  const recordsByTopic = new Map<string, typeof prepared>();
  for (const item of prepared) {
    const members = recordsByTopic.get(item.topic.id) ?? [];
    members.push(item);
    recordsByTopic.set(item.topic.id, members);
  }

  populatedTopics.forEach((topic, topicIndex) => {
    const members = [...(recordsByTopic.get(topic.id) ?? [])].sort(
      (left, right) =>
        right.record.importance - left.record.importance ||
        (right.record.accessCount ?? 0) - (left.record.accessCount ?? 0),
    );
    const position = topicPosition(topicIndex, populatedTopics.length);
    const topicId = `topic:${topic.id}`;
    nodes.push({
      id: topicId,
      kind: "topic",
      label: topic.label,
      color: topic.color,
      memoryCount: members.length,
      fx: position.x,
      fy: position.y,
    });
    addLink({
      source: "root:memory",
      target: topicId,
      kind: "root",
      color: topic.color,
    });

    members.forEach((item, memberIndex) => {
      const memoryPositionValue = memoryPosition(
        position.x,
        position.y,
        position.angle,
        item.record.memoryId,
        memberIndex,
      );
      nodes.push({
        id: item.record.memoryId,
        kind: "memory",
        label: item.graphMetadata.label ?? compactLabel(item.record.content),
        content: item.record.content,
        segment: item.record.segment,
        tier: item.record.tier,
        importance: item.record.importance,
        topicId: topic.id,
        topicColor: topic.color,
        showLabel: memberIndex === 0,
        labelSide: Math.cos(position.angle) < -0.05 ? "left" : "right",
        x: memoryPositionValue.x,
        y: memoryPositionValue.y,
        fx: memberIndex === 0 ? memoryPositionValue.x : undefined,
        fy: memberIndex === 0 ? memoryPositionValue.y : undefined,
      });
      addLink({
        source: topicId,
        target: item.record.memoryId,
        kind: "membership",
        color: topic.color,
      });

      const next = members[(memberIndex + 1) % members.length];
      if (members.length > 2 && next) {
        addLink({
          source: item.record.memoryId,
          target: next.record.memoryId,
          kind: "affinity",
          color: topic.color,
        });
      }

      for (const relatedMemoryId of item.graphMetadata.relatedMemoryIds ?? []) {
        if (prepared.some((candidate) => candidate.record.memoryId === relatedMemoryId)) {
          addLink({
            source: item.record.memoryId,
            target: relatedMemoryId,
            kind: "affinity",
          });
        }
      }

      for (const supersededId of item.record.supersedes ?? []) {
        if (prepared.some((candidate) => candidate.record.memoryId === supersededId)) {
          addLink({
            source: item.record.memoryId,
            target: supersededId,
            kind: "history",
          });
        }
      }
    });
  });

  const recordsBySegment = new Map<string, typeof prepared>();
  for (const item of prepared) {
    const members = recordsBySegment.get(item.record.segment) ?? [];
    members.push(item);
    recordsBySegment.set(item.record.segment, members);
  }
  for (const members of recordsBySegment.values()) {
    for (let index = 0; index + 3 < members.length; index += 4) {
      const source = members[index];
      const target = members[index + 3];
      if (source && target && source.topic.id !== target.topic.id) {
        addLink({
          source: source.record.memoryId,
          target: target.record.memoryId,
          kind: "affinity",
        });
      }
    }
  }

  const paintOrder: Record<GraphNode["kind"], number> = {
    memory: 0,
    topic: 1,
    root: 2,
  };
  nodes.sort((left, right) => paintOrder[left.kind] - paintOrder[right.kind]);

  return { nodes, links };
}

export const MEMORY_GRAPH_TOPICS = TOPICS.map(({ id, label, color }) => ({ id, label, color }));
