import { describe, expect, it } from "vitest";
import { buildConfigApplyErrorMessage } from "./config-apply-error.js";

describe("buildConfigApplyErrorMessage", () => {
  it("reports the primary apply error and a successful rollback without duplicating text", () => {
    const message = buildConfigApplyErrorMessage(409, {
      error: "doctor rejected config\n    at internal-apply.ts:42",
      doctor: { message: "doctor rejected config" },
      applied: false,
      rolledBack: true,
      rollbackAttempted: true,
    });

    expect(message).toBe(
      "HTTP 409 请求失败；主 apply 错误：doctor rejected config；已回滚到应用前状态",
    );
  });

  it("reports rollback failure with a non-stack diagnostic", () => {
    const message = buildConfigApplyErrorMessage(409, {
      doctor: { message: "doctor rejected config" },
      applied: false,
      rolledBack: false,
      rollbackAttempted: true,
      rollbackError: "restore denied\n    at rollback.ts:12",
    });

    expect(message).toBe(
      "HTTP 409 请求失败；主 apply 错误：doctor rejected config；"
        + "回滚失败：restore denied；当前配置状态未知",
    );
  });

  it("does not treat an applied body with a non-2xx status as success", () => {
    const message = buildConfigApplyErrorMessage(409, {
      applied: true,
    });

    expect(message).toBe(
      "HTTP 409 请求失败；主 apply 错误：服务器未提供错误详情",
    );
    expect(message).not.toContain("成功");
    expect(message).not.toContain("回滚");
  });

  it("reports an unknown rollback state when rollback evidence is absent", () => {
    const message = buildConfigApplyErrorMessage(503, {
      error: "apply interrupted",
      rollbackAttempted: true,
    });

    expect(message).toBe(
      "HTTP 503 请求失败；主 apply 错误：apply interrupted；回滚状态未知",
    );
  });

  it("does not report a rollback conclusion for a rollbackAttempted=false preflight 409", () => {
    const message = buildConfigApplyErrorMessage(409, {
      error: "preflight failed",
      applied: false,
      rolledBack: false,
      rollbackAttempted: false,
      rollbackError: "REMOTE_CONFIG_ROLLBACK_FAILED:stale diagnostic",
    });

    expect(message).toBe(
      "HTTP 409 请求失败；主 apply 错误：preflight failed",
    );
    expect(message).not.toContain("回滚");
  });

  it("deduplicates the rollback cause after stripping its error-code prefix", () => {
    const message = buildConfigApplyErrorMessage(409, {
      error: "No space left on device",
      applied: false,
      rolledBack: false,
      rollbackAttempted: true,
      rollbackError: "REMOTE_CONFIG_ROLLBACK_FAILED:No space left on device",
    });

    expect(message).toBe(
      "HTTP 409 请求失败；主 apply 错误：No space left on device；"
        + "回滚失败；当前配置状态未知",
    );
    expect(message.match(/No space left on device/g)).toHaveLength(1);
  });

  it.each([400, 403, 415])(
    "shows only the request error and status for HTTP %i",
    (status) => {
      const message = buildConfigApplyErrorMessage(status, {
        error: "request rejected",
      });

      expect(message).toBe(
        `HTTP ${status} 请求失败；主 apply 错误：request rejected`,
      );
      expect(message).not.toContain("回滚");
    },
  );
});
