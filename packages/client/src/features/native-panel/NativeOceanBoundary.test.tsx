import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NativeOceanBoundary } from "./NativeOceanBoundary.js";
import { buildWhalePanelModel } from "../whale/model.js";

afterEach(()=>vi.restoreAllMocks());
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
