import { fireEvent,render,screen,within } from "@testing-library/react";
import { describe,it,expect,vi } from "vitest";
import { NativePanelDetails,safeEvidenceUrl } from "./NativePanelDetails.js";
import type { NativePanelData } from "./types.js";
import type { TaskRecord } from "@dsh-fusion/core";
import { buildWhalePanelModel } from "../whale/model.js";
const emptyModel=buildWhalePanelModel({nodes:[],tasks:[],agentTeams:[],demo:false,loaded:true,stale:false});
describe("details",()=>{
it("rejects unsafe evidence",()=>{for(const x of ["javascript:alert(1)","file:///tmp/a","https://user:password@example.com","/local","//example.com"])expect(safeEvidenceUrl(x)).toBeUndefined();expect(safeEvidenceUrl("https://example.com")).toBe("https://example.com/");});
it("recovers missing record and contains Escape",()=>{const back=vi.fn(),outer=vi.fn();const data:NativePanelData={tasks:[],nodes:[],teams:[],loaded:true,model:emptyModel};render(<div onKeyDown={outer}><NativePanelDetails selection={{kind:"task",id:"gone"}} data={data} onBack={back} onSelect={vi.fn()}/></div>);expect(screen.getByRole("alert").textContent).toContain("record missing");fireEvent.keyDown(screen.getByRole("button",{name:"返回列表"}),{key:"Escape",isComposing:true});expect(back).not.toHaveBeenCalled();outer.mockClear();fireEvent.keyDown(screen.getByRole("button",{name:"返回列表"}),{key:"Escape"});expect(back).toHaveBeenCalledOnce();expect(outer).not.toHaveBeenCalled();fireEvent.keyDown(document.body,{key:"Escape"});expect(back).toHaveBeenCalledOnce();});
});
describe("task context inspection",()=>{
 const fixture=(overrides:Partial<TaskRecord>&{description?:string}={}):NativePanelData=>({
  loaded:true,nodes:[],teams:[],model:emptyModel,
  tasks:[{id:"context-task",goal:"核对迁移步骤",targetNodeIds:[],transport:"ssh",status:"queued",evidence:[],createdAt:"",updatedAt:"",...overrides}],
 });
 const show=(data:NativePanelData)=>render(<NativePanelDetails selection={{kind:"task",id:"context-task"}} data={data} onBack={vi.fn()} onSelect={vi.fn()}/>);

 it("keeps the full task body separate from its goal and renders markup as text",()=>{
  const description='<img src=x onerror="alert(1)">\n先记录检查点，再运行回归。';
  const {container}=show(fixture({description}));
  const disclosure=screen.getByText("完整任务正文",{selector:"summary"});
  expect(disclosure.parentElement).not.toHaveAttribute("open");
  fireEvent.click(disclosure);
  const body=screen.getByRole("region",{name:"任务正文"});
  expect(within(body).getByText(/先记录检查点/).textContent).toBe(description);
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText("核对迁移步骤")).toBeVisible();
 });

 it("presents the source result before the full task body even when the task is still awaiting independent review",()=>{
  show(fixture({status:"verifying",description:"完整任务内容",evidence:[{kind:"summary",label:"交接摘要",value:"只记录已提交，尚待审查。"}]}));
  expect(screen.getByRole("heading",{name:"核对迁移步骤"})).toBeVisible();
  expect(screen.getByText("独立审查结论未提供",{exact:false})).toBeVisible();
  const evidence=screen.getByRole("region",{name:"来源证据"});
  const body=screen.getByText("完整任务正文",{selector:"summary"});
  expect(evidence.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 });

 it("marks missing context as unknown without inventing a body or owner",()=>{
  show(fixture());
  expect(screen.getByRole("region",{name:"任务正文"})).toHaveTextContent("任务正文未提供");
  const context=screen.getByRole("region",{name:"只读协作上下文"});
  expect(context).toHaveTextContent("协作上下文未提供");
  for(const label of ["负责人","上游任务 ID","上游修订","上游就绪（ready）"]){
   expect(within(context).getByText(label).nextElementSibling).toHaveTextContent("未提供");
  }
  expect(screen.getByRole("region",{name:"预期证据"})).toHaveTextContent("预期证据未提供");
 });

 it("allows an explicitly empty body without substituting the goal",()=>{
  show(fixture({description:""}));
  expect(screen.queryByRole("region",{name:"任务正文"})).toBeNull();
  expect(screen.getAllByText("核对迁移步骤")).toHaveLength(1);
 });

 it("shows owner, upstream identity, false readiness, advisory scopes and raw warnings",()=>{
  const warning='<strong>共享范围冲突</strong>\n请先联系另一位协作者。';
  const {container}=show(fixture({agentTeamTask:{teamId:"unknown-team",taskId:"upstream-task-7",revision:0,ownerId:"owner-7",ownerName:"协作者甲",blockedBy:[],writeScopes:["packages/client/**","docs/计划.md"],ready:false,writeScopeWarnings:[warning]}}));
  const context=screen.getByRole("region",{name:"只读协作上下文"});
  expect(within(context).getByText("负责人").nextElementSibling).toHaveTextContent("协作者甲");
  expect(within(context).getByText("上游任务 ID").nextElementSibling).toHaveTextContent("upstream-task-7");
  expect(within(context).getByText("上游修订").nextElementSibling).toHaveTextContent("0");
  expect(within(context).getByText("上游就绪（ready）").nextElementSibling).toHaveTextContent("否（false）");
  expect(context).toHaveTextContent("writeScopes 仅为协作提示，不是文件锁或执行授权");
  expect(within(context).getByText("packages/client/**")).toBeVisible();
  expect(within(context).getByText("docs/计划.md")).toBeVisible();
  expect(within(context).getByText(/请先联系另一位协作者/).textContent).toBe(warning);
  expect(container.querySelector("strong")).toBeNull();
  expect(screen.getByText(/状态：等待中/)).toBeVisible();
  expect(within(context).queryByRole("button")).toBeNull();
  expect(within(context).queryByRole("textbox")).toBeNull();
 });

 it("falls back to the supplied owner ID and distinguishes true readiness",()=>{
  show(fixture({agentTeamTask:{teamId:"team-other",taskId:"upstream-owned",ownerId:"owner-id-only",blockedBy:[],writeScopes:[],ready:true}}));
  const context=screen.getByRole("region",{name:"只读协作上下文"});
  expect(within(context).getByText("负责人").nextElementSibling).toHaveTextContent("owner-id-only");
  expect(within(context).getByText("上游就绪（ready）").nextElementSibling).toHaveTextContent("是（true）");
  expect(within(context).getByText("上游修订").nextElementSibling).toHaveTextContent("未提供");
 });

 it("keeps omitted readiness distinct from false on an existing projection",()=>{
  show(fixture({agentTeamTask:{teamId:"team-other",taskId:"upstream-unknown",blockedBy:[],writeScopes:[]}}));
  const context=screen.getByRole("region",{name:"只读协作上下文"});
  expect(within(context).getByText("上游就绪（ready）").nextElementSibling).toHaveTextContent("未提供");
  expect(within(context).getByText("负责人").nextElementSibling).toHaveTextContent("未提供");
 });

 it("presents expected evidence as unverified requirements even when a record exists",()=>{
  show(fixture({status:"completed",expectedEvidence:["command","artifact"],evidence:[{kind:"command",label:"来源命令",value:"pnpm test"}]}));
  const expected=screen.getByRole("region",{name:"预期证据"});
  expect(expected).toHaveTextContent("仅为证据要求，尚未核验是否满足");
  expect(within(expected).getByText("命令（command）")).toBeVisible();
  expect(within(expected).getByText("产物（artifact）")).toBeVisible();
  expect(expected).not.toHaveTextContent(/已满足|已通过|验收通过/);
  expect(screen.getByText("pnpm test")).toBeVisible();
 });

 it("does not infer team membership from an owner or upstream team metadata",()=>{
  const data=fixture({agentTeamTask:{teamId:"declared-team",taskId:"upstream-owned",ownerId:"declared-team",ownerName:"声明团队",blockedBy:[],writeScopes:[]}});
  data.teams=[{id:"declared-team",providerId:"synthetic",name:"声明团队",phase:"staged",workspace:"workspace",captainSessionId:"captain-session",memberIds:[],taskIds:[]}];
  show(data);
  expect(screen.queryByRole("button",{name:"声明团队"})).toBeNull();
 });

 it("keeps evidence URL validation and new-window protections while showing context",()=>{
  show(fixture({description:"查看来源链接。",evidence:[
   {kind:"artifact",label:"安全来源",value:"https://example.com/evidence"},
   {kind:"log",label:"危险来源",value:"javascript:alert(1)"},
   {kind:"log",label:"带认证来源",value:"https://reader@example.com/log"},
  ]}));
  const link=screen.getByRole("link",{name:"https://example.com/evidence"});
  expect(link).toHaveAttribute("href","https://example.com/evidence");
  expect(link).toHaveAttribute("target","_blank");
  expect(link).toHaveAttribute("rel","noreferrer noopener");
  expect(screen.getAllByRole("link")).toHaveLength(1);
  fireEvent.click(screen.getByRole("tab",{name:"危险来源"}));
  let panel=screen.getByRole("tabpanel");
  expect(within(panel).getByText("javascript:alert(1)")).toBeVisible();
  expect(within(panel).queryByRole("link")).toBeNull();
  fireEvent.click(screen.getByRole("tab",{name:"带认证来源"}));
  panel=screen.getByRole("tabpanel");
  expect(within(panel).getByText("https://reader@example.com/log")).toBeVisible();
  expect(within(panel).queryByRole("link")).toBeNull();
 });
});
describe("membership contract",()=>{
 const fixture = {
  loaded:true,nodes:[],model:emptyModel,
  tasks:[
   {id:"declared",goal:"明确成员",status:"queued",transport:"ssh",targetNodeIds:[],evidence:[]},
   {id:"inferred",goal:"不应推断成员",status:"queued",transport:"ssh",targetNodeIds:[],evidence:[],agentTeamTask:{teamId:"team",taskId:"native",blockedBy:[],writeScopes:[]}}
  ],
  teams:[{id:"team",name:"测试团队",phase:"staged",workspace:"workspace",taskIds:["declared","declared"]}]
 } as unknown as NativePanelData;
 it("uses only taskIds and deduplicates team task links",()=>{
  const {unmount}=render(<NativePanelDetails selection={{kind:"team",id:"team"}} data={fixture} onBack={vi.fn()} onSelect={vi.fn()}/>);
  expect(screen.getAllByRole("button",{name:"明确成员"})).toHaveLength(1);
  expect(screen.queryByRole("button",{name:"不应推断成员"})).toBeNull();
  expect(screen.getByText("准备中 · workspace")).toBeTruthy();
  unmount();
 });
 it("does not infer a task team from agentTeamTask.teamId",()=>{
  const {unmount}=render(<NativePanelDetails selection={{kind:"task",id:"inferred"}} data={fixture} onBack={vi.fn()} onSelect={vi.fn()}/>);
  expect(screen.queryByRole("button",{name:"测试团队"})).toBeNull();
  unmount();
 });
});
