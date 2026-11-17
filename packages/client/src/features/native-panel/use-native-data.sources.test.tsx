import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useNativeData } from "./use-native-data.js";

const team = {id:"team-old",name:"旧团队",providerId:"test",workspace:"/test",phase:"active",memberIds:[],taskIds:[]};
const response = (value:unknown) => ({ok:true,json:async()=>value}) as Response;
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it("marks retained pods stale when the team source is unavailable despite a successful HTTP read",async()=>{
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response({nodes:[],tasks:[],agentTeams:[team],sources:{nodes:"live",tasks:"live",agentTeams:"unavailable"},providers:{agentTeams:{state:"offline"}}})));
 const {result}=renderHook(()=>useNativeData("/state",true));
 await waitFor(()=>expect(result.current.data.loaded).toBe(true));
 expect(result.current.data.error).toBeUndefined();
 expect(result.current.data.model.pods[0]?.id).toBe("team-old");
 expect(result.current.data.model.freshness).toBe("stale");
 expect(result.current.sourceNotices.team).toBe("团队来源不可用");
});

it("treats an explicitly synthetic snapshot without source metadata as demo rather than unknown live data",async()=>{
 vi.stubGlobal("fetch",vi.fn().mockResolvedValue(response({nodes:[],tasks:[],agentTeams:[team],demo:true})));
 const {result}=renderHook(()=>useNativeData("/state",true));
 await waitFor(()=>expect(result.current.data.loaded).toBe(true));
 expect(result.current.data.model.demo).toBe(true);
 expect(result.current.data.model.freshness).toBe("current");
 expect(result.current.sourceNotices).toEqual({task:undefined,host:undefined,team:undefined});
 expect(result.current.sourceWarning).toBeUndefined();
});
