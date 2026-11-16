function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function firstLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.trim().split(/\r?\n/, 1)[0]?.trim();
  return line === "" ? undefined : line;
}

function normalizedSummary(value: string): string {
  return value
    .replace(/^[A-Z0-9_]+:\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function buildConfigApplyErrorMessage(status: number, body: unknown): string {
  const payload = recordValue(body) ?? {};
  const doctor = recordValue(payload.doctor);
  const primaryError = firstLine(payload.error)
    ?? firstLine(doctor?.message)
    ?? "服务器未提供错误详情";
  const applied = typeof payload.applied === "boolean" ? payload.applied : undefined;
  const rolledBack = typeof payload.rolledBack === "boolean" ? payload.rolledBack : undefined;
  const rollbackAttempted = payload.rollbackAttempted === true;
  const rollbackError = firstLine(payload.rollbackError);
  const rollbackDetail = rollbackError !== undefined
    && normalizedSummary(rollbackError) !== normalizedSummary(primaryError)
    ? `：${rollbackError}`
    : "";
  const parts = [
    `HTTP ${status} 请求失败`,
    `主 apply 错误：${primaryError}`,
  ];

  if (rollbackAttempted) {
    if (applied === true) {
      parts.push("新配置已写入但未通过校验");
    }
    if (rolledBack === true) {
      parts.push("已回滚到应用前状态");
    } else if (rolledBack === false) {
      parts.push(`回滚失败${rollbackDetail}`);
      parts.push("当前配置状态未知");
    } else {
      parts.push(`回滚状态未知${rollbackDetail}`);
    }
  }

  return parts.join("；");
}
