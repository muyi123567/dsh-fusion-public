import { useEffect, useRef, useState, type CSSProperties } from "react";
import { TaskStudy } from "./TaskStudy.js";
import type { StudyScenario, StudyTheme, StudyWidth } from "./design-fixture.js";
import "./design-study.css";

const params = new URLSearchParams(window.location.search);
const initialWidth = ["420", "560", "wide"].includes(params.get("width") ?? "") ? params.get("width") as StudyWidth : "wide";
const initialTheme: StudyTheme = params.get("theme") === "dark" ? "dark" : "light";
const initialScenario = ["normal", "long", "unknown", "stale", "empty", "unavailable", "not-configured", "missing"].includes(params.get("scenario") ?? "") ? params.get("scenario") as StudyScenario : "normal";
const initialView = params.get("view") === "detail" ? "detail" : "list";
const PRESENTATION_STEPS = ["list", "detail", "gap", "evidence", "ending"] as const;
type PresentationStep = typeof PRESENTATION_STEPS[number] | "idle";

export function StudyHarness() {
  const [width, setWidth] = useState<StudyWidth>(initialWidth);
  const [theme, setTheme] = useState<StudyTheme>(initialTheme);
  const [scenario, setScenario] = useState<StudyScenario>(initialScenario);
  const [draft, setDraft] = useState("");
  const [presentationStep, setPresentationStep] = useState<PresentationStep>("idle");
  const [playing, setPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const remainingMs = useRef(3000);
  const startedAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const panelWidth = width === "wide" ? "850px" : `${width}px`;

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener?.("change", update);
    return () => preference.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (reducedMotion && playing) {
      setPlaying(false);
      setManualMode(true);
    }
  }, [reducedMotion, playing]);

  useEffect(() => {
    if (!playing || reducedMotion || presentationStep === "idle") return;
    const advance = () => {
      timer.current = undefined;
      remainingMs.current = 3000;
      const index = PRESENTATION_STEPS.indexOf(presentationStep);
      if (index >= PRESENTATION_STEPS.length - 1) {
        setPlaying(false);
        setFinished(true);
      } else {
        setPresentationStep(PRESENTATION_STEPS[index + 1]!);
      }
    };
    const schedule = () => {
      if (document.visibilityState === "hidden") return;
      startedAt.current = Date.now();
      timer.current = window.setTimeout(advance, remainingMs.current);
    };
    const pauseForHiddenPage = () => {
      if (document.visibilityState === "hidden" && timer.current !== undefined) {
        window.clearTimeout(timer.current);
        timer.current = undefined;
        remainingMs.current = Math.max(0, remainingMs.current - (Date.now() - startedAt.current));
      } else if (document.visibilityState === "visible" && timer.current === undefined) {
        schedule();
      }
    };
    schedule();
    document.addEventListener("visibilitychange", pauseForHiddenPage);
    return () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = undefined;
      document.removeEventListener("visibilitychange", pauseForHiddenPage);
    };
  }, [playing, presentationStep, reducedMotion]);

  const stopPresentation = () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
    setPlaying(false);
    setPresentationStep("idle");
    setFinished(false);
    setManualMode(false);
    remainingMs.current = 3000;
  };
  const startPresentation = () => {
    setScenario("normal");
    setFinished(false);
    setManualMode(reducedMotion);
    remainingMs.current = 3000;
    setPresentationStep("list");
    setPlaying(!reducedMotion);
  };
  const advanceManually = () => {
    const index = PRESENTATION_STEPS.indexOf(presentationStep as typeof PRESENTATION_STEPS[number]);
    if (index < 0) return;
    if (index >= PRESENTATION_STEPS.length - 1) {
      setFinished(true);
      setManualMode(false);
      return;
    }
    setPresentationStep(PRESENTATION_STEPS[index + 1]!);
  };
  const pausePresentation = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      remainingMs.current = Math.max(0, remainingMs.current - (Date.now() - startedAt.current));
    }
    setPlaying(false);
  };
  const tourIndex = PRESENTATION_STEPS.indexOf(presentationStep as typeof PRESENTATION_STEPS[number]);

  return <main className="study-page" data-theme={theme} style={{ "--study-panel-width": panelWidth } as CSSProperties}>
    <header className="study-review-bar">
      <div className="study-review-title"><span>视觉研究 / 04</span><h1>航次日志</h1></div>
      <div className="study-review-controls" aria-label="独立审稿控制">
        <label>情境<select aria-label="审稿情境" value={scenario} onChange={event => { stopPresentation(); setScenario(event.currentTarget.value as StudyScenario); }}>
          <option value="normal">常规任务</option><option value="long">长标题 / 编号</option><option value="unknown">负责人未知</option><option value="stale">来源陈旧</option><option value="empty">合法空集合</option><option value="unavailable">来源不可用</option><option value="not-configured">来源未配置</option><option value="missing">原任务记录消失</option>
        </select></label>
        <div className="study-segment" role="group" aria-label="审稿面板宽度">
          {(["420", "560", "wide"] as const).map(value => <button key={value} aria-pressed={width === value} onClick={() => { stopPresentation(); setWidth(value); }}>{value === "wide" ? "宽版" : value}</button>)}
        </div>
        <div className="study-segment" role="group" aria-label="审稿主题">
          <button aria-pressed={theme === "light"} onClick={() => { stopPresentation(); setTheme("light"); }}>浅色</button>
          <button aria-pressed={theme === "dark"} onClick={() => { stopPresentation(); setTheme("dark"); }}>深色</button>
        </div>
        <div className="study-presentation-controls" aria-label="前端快速展示">
          <button className={presentationStep === "idle" ? "study-presentation-start" : undefined} onClick={
            presentationStep === "idle" || finished ? startPresentation : playing ? pausePresentation : manualMode ? advanceManually : () => setPlaying(true)
          }>{presentationStep === "idle" ? "快速展示" : finished ? "重新展示" : playing ? "暂停展示" : manualMode ? presentationStep === "ending" ? "结束展示" : "下一步" : "继续展示"}</button>
          {presentationStep !== "idle" ? <button onClick={stopPresentation}>退出展示</button> : null}
          {presentationStep !== "idle" ? <>
            <span role="status" aria-label="前端展示进度">{finished ? "演示结束 · 证据可读 · 独立审查未提供 · 未执行任务" : presentationStep === "ending" ? "结果 · 证据可读 · 独立审查未提供 · 未执行任务" : manualMode ? `手动步骤 ${tourIndex + 1} / 5` : `15秒展示 · ${tourIndex + 1} / 5`}</span>
            <progress className="study-presentation-progress" aria-label="展示进度" max={5} value={finished ? 5 : Math.max(tourIndex + 1, 0)} />
          </> : null}
        </div>
      </div>
    </header>
    <div className="study-disclosure"><strong>独立设计稿</strong><span>以下任务、证据与聊天均为合成演示；不连接数据，不执行操作。</span></div>

    <section className="study-stage" aria-label="宿主布局示意">
      <div className="study-host-caption"><span>宿主布局示意</span><span>聊天保留在旁 · 右侧为插件正文</span></div>
      <div className="study-host-layout" onPointerDownCapture={() => presentationStep !== "idle" && stopPresentation()} onKeyDownCapture={() => presentationStep !== "idle" && stopPresentation()} onInputCapture={() => presentationStep !== "idle" && stopPresentation()} onWheelCapture={() => presentationStep !== "idle" && stopPresentation()}>
        <aside className="study-host-rail" aria-label="宿主会话栏示意"><span>会话</span><span className="study-host-active">01</span><span>02</span><span>03</span></aside>
        <section className="study-host-chat" aria-label="宿主聊天示意">
          <header><span>会话恢复与任务接力</span><span>宿主聊天</span></header>
          <div className="study-chat-conversation">
            <div className="study-chat-date">11 月 20 日 / 09:32</div>
            <div className="study-chat-message study-chat-message--user"><span>你</span><p>先复核恢复补丁，确认重启后没有漏掉进行中的任务。</p></div>
            <div className="study-chat-message"><span>助手</span><p>先阅读右侧来源证据，再判断还缺什么。</p></div>
          </div>
          <div className="study-chat-composer"><label htmlFor="study-local-draft">未发送草稿<span>仅在本页保留</span></label>
            <textarea id="study-local-draft" placeholder="写下复核意见…" value={draft} onChange={event => setDraft(event.currentTarget.value)} />
            <span>布局演示中的输入区，不发送消息</span>
          </div>
        </section>
        <div className="study-host-divider" aria-hidden="true" />
        <div className="study-panel-slot"><TaskStudy scenario={scenario} initialView={initialView} width={width} theme={theme} onRetrySource={() => setScenario("normal")} presentationStep={presentationStep} reducedMotion={reducedMotion} onPresentationInteraction={stopPresentation} /></div>
      </div>
    </section>
    <footer className="study-review-footer"><span>任务优先 / 暖白纸面与墨色</span><span>审稿控制与宿主示意均不属于插件内容</span></footer>
  </main>;
}
