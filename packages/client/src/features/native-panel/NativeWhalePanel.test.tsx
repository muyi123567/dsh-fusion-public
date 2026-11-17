import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeWhalePanel } from "./NativeWhalePanel.js";
import { buildWhalePanelModel } from "../whale/model.js";
import type { NodeRecord, TaskRecord } from "@dsh-fusion/core";

vi.mock("./use-native-data.js",()=>({useNativeData:()=>({data,refresh:vi.fn(),refreshing:false})}));
vi.mock("./NativeOceanBoundary.js",async()=>{
 const {useState}=await import("react");
 return {NativeOceanBoundary:({visible,onSelectTeam}:{visible:boolean;onSelectTeam:(id:string)=>void})=>{
  const [paused,setPaused]=useState(false);
  const [page,setPage]=useState(1);
  return <section aria-label="测试海域">
   <button onClick={()=>setPaused(value=>!value)}>{paused ? "继续海域" : "暂停海域"}</button>
   <button onClick={()=>setPage(value=>value+1)}>下一页</button>
   <span>海域页码 {page}</span><span>{visible ? "海域运行" : "海域已停止"}</span>
   <button onClick={()=>onSelectTeam("team-1")}>查看海域团队</button>
  </section>;
 }};
});
const task:TaskRecord={id:"task-1",goal:"验证任务",targetNodeIds:["host-1"],transport:"ssh",status:"running",evidence:[],createdAt:"",updatedAt:""};
const host:NodeRecord={id:"host-1",externalId:"host-1",providerId:"test",name:"测试主机",platform:"linux",roles:["worker"],status:"online",transports:["ssh"],capabilities:[],configState:"unknown"};
const initialData={tasks:[task],nodes:[host],teams:[],loaded:true,model:buildWhalePanelModel({nodes:[host],tasks:[task],demo:false,loaded:true,stale:false})};
let data=initialData;
const setTasks=(tasks:TaskRecord[])=>{data={...data,tasks,model:buildWhalePanelModel({nodes:data.nodes,tasks,agentTeams:data.teams,demo:false,loaded:true,stale:false})};};
afterEach(()=>{cleanup();data=initialData;});

it("click then Escape returns to the list row with focus",async()=>{
 const user=userEvent.setup();
 render(<NativeWhalePanel/>);
 await user.click(screen.getByRole("button",{name:/验证任务/}));
 expect(screen.getByLabelText("详情导航")).toHaveFocus();
 await user.keyboard("{Escape}");
 expect(screen.queryByRole("region",{name:"任务详情"})).not.toBeInTheDocument();
 expect(screen.getByRole("button",{name:/验证任务/})).toHaveFocus();
});

it("task to host then back restores task detail, then the originating list",async()=>{
 const user=userEvent.setup();
 render(<NativeWhalePanel/>);
 await user.click(screen.getByRole("button",{name:/验证任务/}));
 await user.click(within(screen.getByRole("region",{name:"任务详情"})).getByRole("button",{name:"测试主机"}));
 expect(screen.getByRole("region",{name:"主机详情"})).toBeInTheDocument();
 await user.click(screen.getByRole("button",{name:"返回任务详情"}));
 expect(screen.getByRole("region",{name:"任务详情"})).toBeInTheDocument();
 expect(screen.getByLabelText("详情导航")).toHaveFocus();
 await user.click(screen.getByRole("button",{name:"返回任务列表"}));
 expect(screen.getByRole("button",{name:/验证任务/})).toHaveFocus();
});

it("does not handle Escape or move focus from the adjacent DSH session",async()=>{
 const user=userEvent.setup();
 render(<><input aria-label="DSH 会话"/><NativeWhalePanel/></>);
 await user.click(screen.getByRole("button",{name:/验证任务/}));
 await user.click(screen.getByRole("textbox",{name:"DSH 会话"}));
 await user.keyboard("{Escape}");
 expect(screen.getByRole("textbox",{name:"DSH 会话"})).toHaveFocus();
 expect(screen.getByRole("region",{name:"任务详情"})).toBeInTheDocument();
});


it("mounts ocean on demand, retains preferences through details and stops while hidden",async()=>{
 const user=userEvent.setup();
 const {rerender}=render(<NativeWhalePanel/>);
 expect(screen.queryByLabelText("测试海域")).not.toBeInTheDocument();
 await user.click(screen.getByRole("button",{name:"海域"}));
 await user.click(screen.getByRole("button",{name:"暂停海域"}));
 await user.click(screen.getByRole("button",{name:"下一页"}));
 await user.click(screen.getByRole("button",{name:"查看海域团队"}));
 expect(screen.getByText("海域已停止")).toBeInTheDocument();
 expect(screen.getByLabelText("测试海域")).not.toBeVisible();
 await user.click(screen.getByRole("button",{name:"返回海域"}));
 expect(screen.getByRole("button",{name:"继续海域"})).toBeVisible();
 expect(screen.getByText("海域页码 2")).toBeVisible();
 expect(screen.getByText("海域运行")).toBeVisible();
 expect(screen.getByRole("button",{name:"海域"})).toHaveFocus();
 await user.click(screen.getByRole("button",{name:"任务"}));
 expect(screen.getByText("海域已停止")).toBeInTheDocument();
 await user.click(screen.getByRole("button",{name:"海域"}));
 expect(screen.getByText("海域页码 2")).toBeVisible();
 rerender(<NativeWhalePanel visible={false}/>);
 expect(screen.getByText("海域已停止")).toBeInTheDocument();
 expect(screen.getByLabelText("测试海域")).not.toBeVisible();
 rerender(<NativeWhalePanel visible/>);
 expect(screen.getByRole("button",{name:"继续海域"})).toBeVisible();
 expect(screen.getByText("海域页码 2")).toBeVisible();
});

it("keeps the visible search across tabs and lets clearing it recover the new list",async()=>{
 const user=userEvent.setup();
 render(<NativeWhalePanel/>);
 await user.type(screen.getByRole("textbox",{name:"搜索名称或归属"}),"验证任务");
 await user.click(screen.getByRole("button",{name:"主机"}));
 expect(screen.getByRole("textbox",{name:"搜索名称或归属"})).toHaveValue("验证任务");
 expect(screen.getByText("没有符合筛选条件的记录。")).toBeVisible();
 await user.clear(screen.getByRole("textbox",{name:"搜索名称或归属"}));
 expect(screen.getByRole("button",{name:/测试主机/})).toBeVisible();
});

it("does not silently restore an invalidated status filter when matching records return",async()=>{
 const user=userEvent.setup();
 const failed:TaskRecord={...task,id:"failed-1",goal:"失败任务",status:"failed"};
 setTasks([task,failed]);
 const {rerender}=render(<NativeWhalePanel/>);
 await user.selectOptions(screen.getByRole("combobox",{name:"状态筛选"}),"failed");
 expect(screen.queryByRole("button",{name:/验证任务/})).not.toBeInTheDocument();
 setTasks([task]);
 rerender(<NativeWhalePanel/>);
 expect(screen.getByRole("combobox",{name:"状态筛选"})).toHaveValue("");
 expect(screen.getByRole("button",{name:/验证任务/})).toBeVisible();
 setTasks([task,failed]);
 rerender(<NativeWhalePanel/>);
 expect(screen.getByRole("combobox",{name:"状态筛选"})).toHaveValue("");
 expect(screen.getByRole("button",{name:/验证任务/})).toBeVisible();
 expect(screen.getByRole("button",{name:/失败任务/})).toBeVisible();
});

it("keeps the status filter when the selected tab is clicked again",async()=>{
 const user=userEvent.setup();
 setTasks([task,{...task,id:"failed-1",goal:"失败任务",status:"failed"}]);
 render(<NativeWhalePanel/>);
 await user.selectOptions(screen.getByRole("combobox",{name:"状态筛选"}),"failed");
 await user.click(screen.getByRole("button",{name:"任务"}));
 expect(screen.getByRole("combobox",{name:"状态筛选"})).toHaveValue("failed");
 expect(screen.queryByRole("button",{name:/验证任务/})).not.toBeInTheDocument();
});

it("keeps a removed record explicit and returns focus to its tab when its row is gone",async()=>{
 const user=userEvent.setup();
 const {rerender}=render(<NativeWhalePanel/>);
 await user.click(screen.getByRole("button",{name:/验证任务/}));
 setTasks([]);
 rerender(<NativeWhalePanel/>);
 expect(screen.getByRole("alert")).toHaveTextContent("记录已移除或未返回");
 await user.click(screen.getByRole("button",{name:"返回任务列表"}));
 expect(screen.getByRole("button",{name:"任务"})).toHaveFocus();
 expect(screen.queryByLabelText("详情导航")).not.toBeInTheDocument();
});
