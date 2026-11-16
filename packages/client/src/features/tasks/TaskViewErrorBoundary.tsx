import { Component, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";

interface TaskViewErrorBoundaryProps {
  extensionId: string;
  onReset: () => void;
  children: ReactNode;
}

interface TaskViewErrorBoundaryState {
  failed: boolean;
}

export class TaskViewErrorBoundary extends Component<
  TaskViewErrorBoundaryProps,
  TaskViewErrorBoundaryState
> {
  state: TaskViewErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): TaskViewErrorBoundaryState {
    return { failed: true };
  }

  private reset = (): void => {
    this.setState({ failed: false });
    this.props.onReset();
  };

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <section className="fusion-task-view-error" role="alert">
          <CircleAlert size={22} aria-hidden="true" />
          <strong>扩展视图不可用</strong>
          <p>视图 {this.props.extensionId} 渲染失败，任务筛选、详情和其他视图仍可使用。</p>
          <button type="button" className="fusion-ghost-button" onClick={this.reset}>
            返回任务列表
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}
