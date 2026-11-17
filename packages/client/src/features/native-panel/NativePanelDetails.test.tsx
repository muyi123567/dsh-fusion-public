import { fireEvent,render,screen } from "@testing-library/react";
import { describe,it,expect,vi } from "vitest";
import { NativePanelDetails,safeEvidenceUrl } from "./NativePanelDetails.js";
import type { NativePanelData } from "./types.js";
describe("details",()=>{
it("rejects unsafe evidence",()=>{for(const x of ["javascript:alert(1)","file:///tmp/a","https://user:password@example.com","/local","//example.com"])expect(safeEvidenceUrl(x)).toBeUndefined();expect(safeEvidenceUrl("https://example.com")).toBe("https://example.com/");});
it("recovers missing record and contains Escape",()=>{const back=vi.fn(),outer=vi.fn();const data={tasks:[],nodes:[],teams:[],loaded:true} as unknown as NativePanelData;render(<div onKeyDown={outer}><NativePanelDetails selection={{kind:"task",id:"gone"}} data={data} onBack={back} onSelect={vi.fn()}/></div>);expect(screen.getByRole("alert").textContent).toContain("record missing");fireEvent.keyDown(screen.getByRole("button",{name:"返回列表"}),{key:"Escape",isComposing:true});expect(back).not.toHaveBeenCalled();outer.mockClear();fireEvent.keyDown(screen.getByRole("button",{name:"返回列表"}),{key:"Escape"});expect(back).toHaveBeenCalledOnce();expect(outer).not.toHaveBeenCalled();fireEvent.keyDown(document.body,{key:"Escape"});expect(back).toHaveBeenCalledOnce();});
});
describe("membership contract",()=>{
 const fixture = {
  loaded:true,nodes:[],
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
