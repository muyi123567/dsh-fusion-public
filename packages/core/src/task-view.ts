export type FusionTaskTopologyEntityKind = "owner" | "task" | "node" | "evidence";

export type FusionTaskTopologyEntityStatus = import("./types.js").NodeRecord["status"]
  | import("./types.js").TaskRecord["status"]
  | "unknown";

export interface FusionTaskTopologyEntity {
  id: string;
  kind: FusionTaskTopologyEntityKind;
  label: string;
  detail: string;
  status: FusionTaskTopologyEntityStatus;
  taskIds: string[];
  nodeIds: string[];
  progress?: number;
  evidenceCount?: number;
}

export type FusionTaskTopologyRelation = "owns" | "executes_on" | "produces";

export interface FusionTaskTopologyEdge {
  id: string;
  source: string;
  target: string;
  relation: FusionTaskTopologyRelation;
}

export interface FusionTaskTopology {
  version: 1;
  entities: FusionTaskTopologyEntity[];
  edges: FusionTaskTopologyEdge[];
  ownerIds: string[];
  taskIds: string[];
  nodeIds: string[];
  evidenceGroupIds: string[];
}
