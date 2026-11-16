import type { RunNodeView } from "./run-view-model.js";

export function RunDag({ nodes }: { nodes: RunNodeView[] }) {
  const maxWave = Math.max(0, ...nodes.map((node) => node.wave));
  const width = Math.max(680, 280 + maxWave * 230);
  const height = Math.max(220, 72 + Math.max(0, ...nodes.map((node) => node.y)));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  return (
    <div className="fusion-run-dag" aria-label="DAG 运行图">
      <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`}>
        {nodes.flatMap((node) => node.dependsOn.flatMap((dependencyId) => {
          const dependency = nodesById.get(dependencyId);
          if (dependency === undefined) return [];
          return (
            <path
              key={`${dependency.id}-${node.id}`}
              d={`M ${dependency.x + 156} ${dependency.y + 31} C ${dependency.x + 192} ${dependency.y + 31}, ${node.x - 36} ${node.y + 31}, ${node.x} ${node.y + 31}`}
            />
          );
        }))}
      </svg>
      {nodes.map((node) => (
        <article
          className={`fusion-run-node ${node.status}`}
          key={node.id}
          style={{ left: node.x, top: node.y }}
        >
          <span>{node.status}</span>
          <strong>{node.id}</strong>
          <small>
            {node.durationMs === undefined ? "等待耗时" : `${(node.durationMs / 1000).toFixed(1)}s`}
          </small>
          {node.error === undefined ? null : <em>{node.error}</em>}
        </article>
      ))}
    </div>
  );
}
