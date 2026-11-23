import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeWhalePanel } from "./NativeWhalePanel.js";

const snapshot = {
 nodes: [], tasks: [], agentTeams: [],
 sources: {nodes: "unavailable", tasks: "live", agentTeams: "live"},
 providers: {nodes: {state: "not-configured"}, agentTeams: {state: "connected"}},
};
const response = (value: unknown) => ({ok: true, json: async () => value}) as Response;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("distinguishes the QA host source that is not configured from live empty tasks and teams", async () => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(snapshot)));
 const user = userEvent.setup();
 render(<NativeWhalePanel/>);
 expect(await screen.findByText("当前来源暂无记录。")).toBeVisible();
 expect(screen.getByRole("status")).not.toHaveTextContent("未配置");
 await user.click(screen.getByRole("button", {name: "主机"}));
 expect(screen.getByRole("status")).toHaveTextContent("主机来源未配置");
 expect(screen.getByText("主机来源未配置，暂不能确认当前记录。")).toBeVisible();
 expect(screen.queryByText("当前来源暂无记录。")).not.toBeInTheDocument();
 await user.click(screen.getByRole("button", {name: "团队"}));
 expect(screen.getByText("当前来源暂无记录。")).toBeVisible();
 expect(screen.getByRole("status")).not.toHaveTextContent("未配置");
});

it.each([
 ["unavailable", {sources: {...snapshot.sources}, providers: {nodes: {state: "offline"}}}, "主机来源不可用"],
 ["stale", {sources: {...snapshot.sources, nodes: "live"}, fleet: {stale: true}}, "主机来源已陈旧"],
 ["missing diagnostics", {sources: {tasks: "live", agentTeams: "live"}}, "主机来源状态未提供"],
] as const)("does not report an %s host source as a valid empty list", async (_case, diagnostics, notice) => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({nodes: [], tasks: [], agentTeams: [], ...diagnostics})));
 const user = userEvent.setup();
 render(<NativeWhalePanel/>);
 await screen.findByText("当前来源暂无记录。");
 await user.click(screen.getByRole("button", {name: "主机"}));
 expect(screen.getByRole("status")).toHaveTextContent(notice);
 expect(screen.getByText(notice + "，暂不能确认当前记录。")).toBeVisible();
 expect(screen.queryByText("当前来源暂无记录。")).not.toBeInTheDocument();
});

it("keeps an unavailable task source local while allowing live empty hosts", async () => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({nodes: [], tasks: [], agentTeams: [], sources: {nodes: "live", tasks: "unavailable", agentTeams: "live"}})));
 const user = userEvent.setup();
 render(<NativeWhalePanel/>);
 expect(await screen.findByText("任务来源不可用，暂不能确认当前记录。")).toBeVisible();
 await user.click(screen.getByRole("button", {name: "主机"}));
 expect(screen.getByText("当前来源暂无记录。")).toBeVisible();
 expect(screen.getByRole("status")).not.toHaveTextContent("不可用");
});

it("keeps a failed refresh of an empty snapshot distinct from a live empty source", async () => {
 let reads = 0;
 const fetcher = vi.fn(async (input: string | URL | Request) => {
  if (String(input).includes("/connectors")) return response({catalog: [], instances: []});
  if (String(input).includes("/notifications")) return response({catalog: [], adapters: [], receipts: []});
  reads += 1;
  if (reads === 1) return response({...snapshot, sources: {...snapshot.sources, nodes: "live"}});
  throw new Error("offline");
 });
 vi.stubGlobal("fetch", fetcher);
 const user = userEvent.setup();
 render(<NativeWhalePanel/>);
 await screen.findByText("当前来源暂无记录。");
 await user.click(screen.getByRole("button", {name: "刷新"}));
 await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("陈旧快照"));
 expect(screen.getByText("来源读取失败，最后快照中没有记录。")).toBeVisible();
 expect(screen.queryByText("当前来源暂无记录。")).not.toBeInTheDocument();
});

it("keeps live empty tasks valid when only the optional team collection is missing", async () => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({nodes: [], tasks: [], sources: {nodes: "live", tasks: "live"}})));
 const user = userEvent.setup();
 render(<NativeWhalePanel/>);
 expect(await screen.findByText("当前来源暂无记录。")).toBeVisible();
 expect(screen.getByRole("status")).toHaveTextContent("团队来源未提供，归属未知");
 await user.click(screen.getByRole("button", {name: "团队"}));
 expect(screen.getByText("团队来源未提供，归属未知，暂不能确认当前记录。")).toBeVisible();
 expect(screen.queryByText("当前来源暂无记录。")).not.toBeInTheDocument();
});

it("labels a demo snapshot without source metadata as synthetic and keeps its empty state valid", async () => {
 vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({nodes: [], tasks: [], agentTeams: [], demo: true})));
 const user = userEvent.setup();
 render(<NativeWhalePanel/>);
 expect(await screen.findByText("当前来源暂无记录。")).toBeVisible();
 expect(screen.getByRole("status")).toHaveTextContent("演示数据");
 expect(screen.getByRole("status")).not.toHaveTextContent("未提供");
 await user.click(screen.getByRole("button", {name: "主机"}));
 expect(screen.getByText("当前来源暂无记录。")).toBeVisible();
});
