import { Component, lazy, Suspense, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { Waves } from "lucide-react";
import type { WhaleHabitatProps } from "../whale/ambient/contracts.js";

type OceanLoader = () => Promise<{ default: ComponentType<WhaleHabitatProps> }>;
const loadOcean: OceanLoader = () => import("../whale/ambient/WhaleHabitat.js").then(module => ({ default: module.WhaleHabitat }));

class OceanErrorBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="wb-ocean-failure"><Waves size={24} /><p role="alert">海域加载失败，任务与证据仍可查看。</p><button type="button" onClick={this.props.onRetry}>重试海域</button></div>;
    return this.props.children;
  }
}

/** A new lazy type on retry avoids reusing React's cached rejected load. */
export function OceanPreviewBoundary({ loader = loadOcean, ...props }: WhaleHabitatProps & { loader?: OceanLoader }) {
  const [attempt, setAttempt] = useState(() => ({ id: 0, Ocean: lazy(loader) }));
  const Ocean = attempt.Ocean;
  return <OceanErrorBoundary key={attempt.id} onRetry={() => setAttempt(current => ({ id: current.id + 1, Ocean: lazy(loader) }))}>
    <Suspense fallback={<div className="wb-ocean-loading"><Waves size={25} /><span>正在加载海域预览</span></div>}><Ocean {...props} /></Suspense>
  </OceanErrorBoundary>;
}
