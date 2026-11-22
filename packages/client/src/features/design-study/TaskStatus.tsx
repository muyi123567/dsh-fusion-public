import { Ban, Check, CircleAlert, CircleDashed, CircleDot, CirclePause, Clock3, LoaderCircle } from "lucide-react";
import type { TaskRecord } from "@dsh-fusion/core";
import { taskState } from "./design-fixture.js";

const STATE_ICONS = {
  failed: CircleAlert, blocked: CirclePause, verifying: CircleDashed,
  running: LoaderCircle, claimed: CircleDot, queued: Clock3, completed: Check, cancelled: Ban,
};

const SOURCE_LABELS = { queued: "排队", claimed: "已认领", running: "进行中", verifying: "待验收", completed: "已回报完成", failed: "失败", cancelled: "已取消" };

export function TaskStatus({ task, sourceOnly = false }: { task: TaskRecord; sourceOnly?: boolean }) {
  const { key, label } = sourceOnly ? { key: task.status, label: SOURCE_LABELS[task.status] } : taskState(task);
  const Icon = STATE_ICONS[key as keyof typeof STATE_ICONS];
  return <span className={`study-status study-status--${key}`}>
    <Icon aria-hidden="true" size={13} strokeWidth={1.7} />{label}
  </span>;
}
