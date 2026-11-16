import type {
  TaskEvidence,
  TaskEvidenceKind,
  TaskRecord,
  TaskStatus,
} from "@dsh-fusion/core";

export type EvidenceFailureReason =
  | "MISSING_EXPECTED_EVIDENCE"
  | "EMPTY_EVIDENCE"
  | "MISSING_SUMMARY";

export interface EvidenceSubmission {
  summary?: string;
  evidence?: TaskEvidence[];
}

export interface EvidenceVerdict {
  ok: boolean;
  reason?: EvidenceFailureReason;
  missingKinds: TaskEvidenceKind[];
  accepted: TaskEvidence[];
}

export interface WorkerTaskEvent {
  type: "status";
  status: TaskStatus;
  progress: number;
}

function hasValue(evidence: TaskEvidence): boolean {
  return evidence.value.trim() !== "";
}

function currentEvidence(items: TaskEvidence[]): TaskEvidence[] {
  // A fresh observation replaces the same evidence slot, even when it is empty.
  const current = new Map<string, TaskEvidence>();
  for (const item of items) current.set(JSON.stringify([item.kind, item.label]), item);
  return [...current.values()];
}

function receiptTaskId(task: TaskRecord, label: string): string | undefined {
  if (label === `${task.id}:summary`) return task.id;
  for (const child of task.childTaskRefs ?? []) {
    for (const nodeId of child.targetNodeIds) {
      if (label === `[${nodeId}] ${child.id}:summary`) return child.id;
    }
  }
  return undefined;
}

function successfulReceipt(task: TaskRecord, item: TaskEvidence): boolean {
  if (item.kind !== "summary") return false;
  const taskId = receiptTaskId(task, item.label);
  if (taskId === undefined) return false;
  const fields = new Map<string, string>();
  for (const line of item.value.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    if (!["status", "exit", "taskId"].includes(key)) continue;
    if (fields.has(key)) return false;
    fields.set(key, line.slice(separator + 1));
  }
  return fields.get("status") === "completed"
    && fields.get("exit") === "0"
    && (!fields.has("taskId") || fields.get("taskId") === taskId);
}

function usableEvidence(
  task: TaskRecord,
  available: TaskEvidence[],
  item: TaskEvidence,
  requiresReceipt: boolean,
): boolean {
  if (!hasValue(item)) return false;
  if (item.kind === "summary" && requiresReceipt) return successfulReceipt(task, item);
  const stream = item.kind === "command" ? ":stdout" : item.kind === "log" ? ":stderr" : undefined;
  if (stream !== undefined && item.label.endsWith(stream)) {
    const receiptLabel = item.label.slice(0, -stream.length) + ":summary";
    const hasReceipt = available.some(candidate =>
      candidate.label === receiptLabel && successfulReceipt(task, candidate)
    );
    if (requiresReceipt || item.value.trim() === "(empty)") return hasReceipt;
  } else if (requiresReceipt && (item.kind === "command" || item.kind === "log")) {
    return false;
  }
  // The provider's display sentinel is not itself proof that a command ran.
  return item.value.trim() !== "(empty)";
}

function missingChildEvidence(
  task: TaskRecord,
  available: TaskEvidence[],
): TaskEvidenceKind[] {
  const children = task.childTaskRefs ?? [];
  if (children.length <= 1) return [];
  const required = [
    ["summary", ":summary"],
    ["command", ":stdout"],
    ["log", ":stderr"],
  ] as const;
  const missing = new Set<TaskEvidenceKind>();
  for (const child of children) {
    if (child.status !== undefined && child.status !== "completed") missing.add("summary");
    if (child.targetNodeIds.length === 0) {
      for (const [kind] of required) missing.add(kind);
    }
    for (const nodeId of child.targetNodeIds) {
      const prefix = `[${nodeId}] ${child.id}`;
      for (const [kind, suffix] of required) {
        if (!available.some(item =>
          item.kind === kind
          && item.label === prefix + suffix
          && usableEvidence(task, available, item, true)
        )) missing.add(kind);
      }
    }
  }
  return [...missing];
}

export function normalizeEvidenceValue(value: string): string {
  return value.trim() === "" ? "(empty)" : value;
}

export function verifyEvidence(
  task: TaskRecord,
  submission: EvidenceSubmission,
): EvidenceVerdict {
  const submitted = submission.evidence ?? [];
  const available = currentEvidence([...task.evidence, ...submitted]);
  const expected = task.expectedEvidence ?? [];
  const requiresReceipt = ["summary", "command", "log"].every(kind =>
    expected.some(expectedKind => expectedKind === kind)
  ) || available.some(item => item.kind === "summary" && item.label.endsWith(":summary"));
  const usable = (item: TaskEvidence) => usableEvidence(task, available, item, requiresReceipt);
  const missingKinds = [...new Set([
    ...expected.filter(
      (kind) => !available.some((evidence) => evidence.kind === kind && usable(evidence)),
    ),
    ...missingChildEvidence(task, available),
  ])];

  if (missingKinds.length > 0) {
    return {
      ok: false,
      reason: "MISSING_EXPECTED_EVIDENCE",
      missingKinds,
      accepted: [],
    };
  }

  const accepted = currentEvidence(submitted).filter(usable);
  if (accepted.length === 0 && (submission.summary ?? "").trim() === "") {
    return {
      ok: false,
      reason: "MISSING_SUMMARY",
      missingKinds: [],
      accepted: [],
    };
  }

  return {
    ok: true,
    missingKinds: [],
    accepted,
  };
}

export function gateCompletedTask(task: TaskRecord): TaskRecord {
  if (task.status !== "completed") return task;
  const verdict = verifyEvidence(task, { evidence: task.evidence });
  if (verdict.ok) return task;
  return {
    ...task,
    status: "verifying",
    updatedAt: new Date().toISOString(),
  };
}

export function applyWorkerEvent(task: TaskRecord, event: WorkerTaskEvent): TaskRecord {
  const status = event.status === "completed" ? "verifying" : event.status;
  return {
    ...structuredClone(task),
    status,
    progress: Math.max(0, Math.min(100, event.progress)),
    updatedAt: new Date().toISOString(),
  };
}
