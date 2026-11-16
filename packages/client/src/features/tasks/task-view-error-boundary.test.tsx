import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskViewErrorBoundary } from "./TaskViewErrorBoundary.js";

function BrokenView(): JSX.Element {
  throw new Error("extension exploded");
}

describe("TaskViewErrorBoundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("contains an extension render failure and offers a safe reset", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onReset = vi.fn();

    render(
      <TaskViewErrorBoundary extensionId="broken-view" onReset={onReset}>
        <BrokenView />
      </TaskViewErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("扩展视图不可用");
    expect(screen.getByRole("alert")).toHaveTextContent("broken-view");
    fireEvent.click(screen.getByRole("button", { name: "返回任务列表" }));
    expect(onReset).toHaveBeenCalledOnce();
  });
});
