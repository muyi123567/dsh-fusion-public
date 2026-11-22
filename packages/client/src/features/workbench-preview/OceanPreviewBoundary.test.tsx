import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { OceanPreviewBoundary } from "./OceanPreviewBoundary.js";

const ignoreSyntheticChunkError = (event: ErrorEvent) => {
  if (event.error instanceof Error && event.error.message === "Synthetic chunk unavailable") event.preventDefault();
};
afterEach(() => { window.removeEventListener("error", ignoreSyntheticChunkError); vi.restoreAllMocks(); });

it("contains a rejected optional chunk and retries without remounting the surrounding draft", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  window.addEventListener("error", ignoreSyntheticChunkError);
  const user = userEvent.setup();
  const loader = vi.fn()
    .mockRejectedValueOnce(new Error("Synthetic chunk unavailable"))
    .mockResolvedValueOnce({ default: () => <p>合成海域已恢复</p> });
  render(<><textarea aria-label="保留的本地草稿" defaultValue="未发送内容" /><OceanPreviewBoundary loader={loader} activity={{ active: 1, blocked: 0, completed: 0, observed: true }} quality="eco" playing /></>);
  expect(await screen.findByRole("alert")).toHaveTextContent("海域加载失败");
  const draft = screen.getByRole("textbox", { name: "保留的本地草稿" });
  await user.type(draft, "，继续编辑");
  await user.click(screen.getByRole("button", { name: "重试海域" }));
  expect(await screen.findByText("合成海域已恢复")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(draft).toHaveValue("未发送内容，继续编辑");
});
