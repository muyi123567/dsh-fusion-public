import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeOceanBoundary } from "./NativeOceanBoundary.js";
import { buildWhalePanelModel } from "../whale/model.js";

afterEach(()=>{cleanup();vi.restoreAllMocks();});
it("contains lazy rejection, leaves sibling tabs usable and retries a fresh import",async()=>{
 vi.spyOn(console,"error").mockImplementation(()=>{});
 const model=buildWhalePanelModel({nodes:[],tasks:[],demo:false,loaded:true,stale:false});
 const loader=vi.fn()
  .mockRejectedValueOnce(new Error("chunk unavailable"))
  .mockResolvedValueOnce({default:()=> <div>海域已恢复</div>});
 const switchTab=vi.fn();
 render(<div><button onClick={switchTab}>任务</button><button onClick={switchTab}>主机</button>
  <NativeOceanBoundary loader={loader} model={model} visible onSelectTeam={()=>{}}/>
 </div>);
 expect(await screen.findByRole("alert")).toHaveTextContent("海域加载失败");
 fireEvent.click(screen.getByRole("button",{name:"任务"}));
 fireEvent.click(screen.getByRole("button",{name:"主机"}));
 expect(switchTab).toHaveBeenCalledTimes(2);
 fireEvent.click(screen.getByRole("button",{name:"重试海域"}));
 expect(await screen.findByText("海域已恢复")).toBeInTheDocument();
 expect(loader).toHaveBeenCalledTimes(2);
});
it("contains rendering errors as well as loading errors",async()=>{
 vi.spyOn(console,"error").mockImplementation(()=>{});
 const model=buildWhalePanelModel({nodes:[],tasks:[],demo:false,loaded:true,stale:false});
 const loader=async()=>({default:()=>{throw new Error("render failed");}});
 render(<NativeOceanBoundary loader={loader} model={model} visible onSelectTeam={()=>{}}/>);
 expect(await screen.findByRole("alert")).toHaveTextContent("海域加载失败");
});

it("keeps local retry available after closing and reopening without disturbing the session",async()=>{
 vi.spyOn(console,"error").mockImplementation(()=>{});
 const user=userEvent.setup();
 const model=buildWhalePanelModel({nodes:[],tasks:[],demo:false,loaded:true,stale:false});
 const loader=vi.fn().mockRejectedValueOnce(new Error("chunk unavailable")).mockResolvedValueOnce({default:({visible}:{visible:boolean})=><p>{visible ? "海域运行" : "海域已停止"}</p>});
 const View=({visible}:{visible:boolean})=><><input aria-label="DSH 会话"/><div hidden={!visible}><NativeOceanBoundary loader={loader} model={model} visible={visible} onSelectTeam={()=>{}}/></div></>;
 const {rerender}=render(<View visible/>);
 expect(await screen.findByRole("alert")).toHaveTextContent("海域加载失败");
 await user.type(screen.getByRole("textbox",{name:"DSH 会话"}),"未发送内容");
 rerender(<View visible={false}/>);
 expect(screen.queryByRole("button",{name:"重试海域"})).not.toBeInTheDocument();
 rerender(<View visible/>);
 expect(screen.getByRole("button",{name:"重试海域"})).toBeVisible();
 expect(screen.getByRole("textbox",{name:"DSH 会话"})).toHaveFocus();
 await user.click(screen.getByRole("button",{name:"重试海域"}));
 expect(await screen.findByText("海域运行")).toBeVisible();
 expect(screen.getByRole("textbox",{name:"DSH 会话"})).toHaveValue("未发送内容");
 rerender(<View visible={false}/>);
 expect(screen.getByText("海域已停止")).not.toBeVisible();
 rerender(<View visible/>);
 expect(screen.getByText("海域运行")).toBeVisible();
});
