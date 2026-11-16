export type RunNodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface DagRunViewInput {
  id: string;
  specId: string;
  status: "pending" | "running" | "completed" | "failed";
  // Referenced tasks the snapshot did not contain. The status
  // above summarizes only the OBSERVED tasks; a non-empty list
  // here means the run's final result is not fully confirmed.
  missingTaskIds?: string[];
  order: string[][];
  nodes: Record<string, {
    nodeId: string;
    status: RunNodeStatus;
    dependsOn?: string[];
    startedAt?: string;
    finishedAt?: string;
    error?: string;
  }>;
  startedAt: string;
  finishedAt?: string;
}

export interface RunNodeView {
  id: string;
  status: RunNodeStatus;
  dependsOn: string[];
  wave: number;
  x: number;
  y: number;
  durationMs?: number;
  error?: string;
}

function durationMs(startedAt?: string, finishedAt?: string): number | undefined {
  if (startedAt === undefined || finishedAt === undefined) return undefined;
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
}

export function buildRunView(run: DagRunViewInput): RunNodeView[] {
  return run.order.flatMap((wave, waveIndex) =>
    wave.map((nodeId, rowIndex) => {
      const node = run.nodes[nodeId] ?? { nodeId, status: "pending" as const };
      const duration = durationMs(node.startedAt, node.finishedAt);
      return {
        id: nodeId,
        status: node.status,
        dependsOn: node.dependsOn ?? [],
        wave: waveIndex,
        x: 26 + waveIndex * 230,
        y: 28 + rowIndex * 96,
        ...(duration === undefined ? {} : { durationMs: duration }),
        ...(node.error === undefined ? {} : { error: node.error }),
      };
    }),
  );
}

export function buildDependencyWaves(
  tasks: ReadonlyArray<{ id: string; dependsOnTaskIds?: readonly string[] }>,
): string[][] {
  const taskIds = new Set(tasks.map((task) => task.id));
  const remaining = new Map(tasks.map((task) => [
    task.id,
    (task.dependsOnTaskIds ?? []).filter((dependency) =>
      dependency !== task.id && taskIds.has(dependency)
    ),
  ]));
  const placed = new Set<string>();
  const waves: string[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.every((dependency) => placed.has(dependency)))
      .map(([taskId]) => taskId)
      .sort();
    if (ready.length === 0) {
      waves.push([...remaining.keys()].sort());
      break;
    }
    waves.push(ready);
    for (const taskId of ready) {
      remaining.delete(taskId);
      placed.add(taskId);
    }
  }

  return waves;
}
