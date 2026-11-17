import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useNativeData } from "./use-native-data.js";

afterEach(() => { vi.unstubAllGlobals(); });
const response = (value: unknown) => ({ok:true,json:async()=>value}) as Response;

it("accepts missing teams, preserves demo and reports unknown team source", async()=>{
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response({nodes:[],tasks:[],demo:true})));
 const {result,unmount}=renderHook(()=>useNativeData("/state",true));
 await waitFor(()=>expect(result.current.data.loaded).toBe(true));
 expect(result.current.data.model.demo).toBe(true);
 expect(result.current.data.teams).toEqual([]);
 expect(result.current.sourceWarning).toContain("未知");
 unmount();
});

it("keeps the last snapshot stale after a failed refresh",async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response({nodes:[],tasks:[],agentTeams:[]})).mockRejectedValueOnce(new Error("offline"));
 vi.stubGlobal("fetch",fetcher);
 const {result,unmount}=renderHook(()=>useNativeData("/state",true));
 await waitFor(()=>expect(result.current.data.loaded).toBe(true));
 act(()=>result.current.refresh());
 await waitFor(()=>expect(result.current.data.error).toBeDefined());
 expect(result.current.data.loaded).toBe(true);
 expect(result.current.data.model.freshness).toBe("stale");
 unmount();
});

it("aborts hidden reads and ignores late results from a replaced source",async()=>{
 const pending: Array<{signal:AbortSignal;resolve:(value:Response)=>void}>=[];
 const fetcher=vi.fn((_url:unknown,options:{signal:AbortSignal})=>new Promise<Response>(resolve=>pending.push({signal:options.signal,resolve})));
 vi.stubGlobal("fetch",fetcher);
 const {result,rerender,unmount}=renderHook(({url,visible})=>useNativeData(url,visible),{initialProps:{url:"/first",visible:true}});
 expect(pending).toHaveLength(1);
 rerender({url:"/first",visible:false});
 expect(pending[0]!.signal.aborted).toBe(true);
 act(()=>result.current.refresh());
 expect(fetcher).toHaveBeenCalledTimes(1);
 rerender({url:"/second",visible:true});
 expect(pending).toHaveLength(2);
 await act(async()=>pending[0]!.resolve(response({nodes:[],tasks:[],demo:true})));
 expect(result.current.data.loaded).toBe(false);
 await act(async()=>pending[1]!.resolve(response({nodes:[],tasks:[],agentTeams:[],demo:false})));
 await waitFor(()=>expect(result.current.data.loaded).toBe(true));
 expect(result.current.data.model.demo).toBe(false);
 unmount();
 expect(pending[1]!.signal.aborted).toBe(true);
});
