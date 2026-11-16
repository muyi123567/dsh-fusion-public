import type { TaskRecord } from "@dsh-fusion/core";
import type {
  EvidenceSubmission,
  EvidenceVerdict,
  WorkerTaskEvent,
} from "./evidence.js";
import { applyWorkerEvent, verifyEvidence } from "./evidence.js";

export interface TaskCompletionResult {
  task: TaskRecord;
  verdict: EvidenceVerdict;
}

export class TaskService {
  constructor(private task: TaskRecord) {}

  snapshot(): TaskRecord {
    return structuredClone(this.task);
  }

  applyWorkerEvent(event: WorkerTaskEvent): TaskRecord {
    this.task = applyWorkerEvent(this.task, event);
    return this.snapshot();
  }

  completeWithEvidence(submission: EvidenceSubmission): TaskCompletionResult {
    const verdict = verifyEvidence(this.task, submission);
    if (verdict.ok) {
      this.task = {
        ...this.task,
        status: "completed",
        progress: 100,
        evidence: [...this.task.evidence, ...verdict.accepted],
        updatedAt: new Date().toISOString(),
      };
    } else {
      this.task = {
        ...this.task,
        status: "verifying",
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      task: this.snapshot(),
      verdict,
    };
  }
}
