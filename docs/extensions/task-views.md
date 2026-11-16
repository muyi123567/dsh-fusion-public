# 任务视图扩展 API

任务页的布局不是硬编码的三个分支。它建立在一个公共模型和视图注册表上：

1. **拓扑契约**：`FusionTaskTopology`（v1）描述 owner、task、node、evidence 四类实体，
   以及 `owns / executes_on / produces` 三类关系。
2. **视图契约**：`FusionTaskViewDefinition` 描述一个视图的 `id`、`label`、`Icon`
   和 React `Component`。
3. **运行时入口**：`window.__DSH_FUSION_TASK_VIEWS__` 只在 Fusion workspace 存活期间
   存在；入口带 generation、API 版本和 `has()` 探测。
4. **公共类型**：扩展可从 `dsh-fusion/client` 导入 `FusionTaskViewDefinition`、
   `FusionTaskViewProps`、`FusionTaskViewAction` 与 `FusionTaskViewGlobal`。

## 内置视图

| id | 名称 | 用途 |
| --- | --- | --- |
| `bridge` | 鹊桥画布 | 四段泳道连线，适合看“谁发起、落在哪台机器、产生什么证据”。 |
| `satellite` | 卫星视图 | 以 DSH 控制面为中心，按节点看任务轨道和健康状态。 |
| `radial` | 放射树 | 以来源和任务做放射层级，适合追踪派发路径。 |
| `list` | 列表 | 精确查看时间、进度和取消操作。 |

## 注册示例

```tsx
import type {
  FusionTaskViewDefinition,
  FusionTaskViewProps,
} from "dsh-fusion/client";

function MatrixView({ topology, selectedTaskId, onSelectTask }: FusionTaskViewProps) {
  return (
    <section aria-label="矩阵视图">
      {topology.entities.filter((entity) => entity.kind === "task").map((task) => (
        <button
          key={task.id}
          type="button"
          aria-pressed={selectedTaskId === task.id.slice("task:".length)}
          onClick={() => onSelectTask(task.id.slice("task:".length))}
        >
          {task.label}
        </button>
      ))}
    </section>
  );
}

const view: FusionTaskViewDefinition = {
  id: "matrix",
  label: "矩阵",
  description: "按自定义分组渲染任务",
  group: "extension",
  priority: 70,
  actions: ["dispatch", "cancel"],
  Component: MatrixView,
};

const surface = window.__DSH_FUSION_TASK_VIEWS__;
if (surface === undefined || !surface.ready || surface.api.major !== 1 || !surface.has("register")) {
  throw new Error("FUSION_TASK_VIEW_API_UNSUPPORTED");
}
const cleanup = surface.register(view);

// 扩展卸载或热更新时调用；同一 cleanup 重复调用是安全的。
cleanup();
```

如果扩展比 Fusion workspace 更早加载，可等待就绪事件：

```ts
window.addEventListener("dsh-fusion:task-views-ready", (event) => {
  const detail = (event as CustomEvent<{
    generation: number;
    api: { major: number; minor: number };
  }>).detail;
  console.info("Fusion task views ready", detail);
});
```

## 契约规则

- 组件收到的是筛选后的 `tasks`、全部 `nodes` 和共享 `topology`。
- 视图必须通过 `onSelectTask(taskId)` 更新共享选中状态；不要维护第二个选中态。
- 动作能力必须显式声明：`actions: ["dispatch", "cancel"]`。宿主只会把
  `onDispatchTask` / `onCancelTask` 传给声明了对应动作的视图；未声明时属性是
  `undefined`，调用前必须判断。
- 宿主还必须开启 `allowExtensionActions`；默认关闭。因此声明动作只是申请，
  不是授权。Fusion 当前生产入口默认不把写动作交给扩展。
- `onDispatchTask` 的入参与任务工作台 composer 相同：`goal / command / nodeIds`。
  它仍经过 Fusion 的校验、同源、任务账本和 provider 路由；扩展不能绕过这些边界。
- `id` 必须唯一；内置 `bridge / satellite / radial` 是保留 ID。
- 同一个扩展 ID 只能注册一次；重复注册会得到
  `FUSION_TASK_VIEW_ID_ALREADY_REGISTERED:<id>`。热更新应先调用旧 cleanup 再注册。
- `register()` 返回 cleanup；扩展卸载时应调用它。
- `api.major` 是硬兼容边界；`api.minor` 只做新增能力提示。调用前用 `has(method)`
  探测，未知方法返回 `false`，不要靠异常探测。
- 每次 workspace 激活都会递增 `generation`。旧入口的 `ready` 变为 `false`，
  迟到 `register / unregister / list` 会得到 `FUSION_TASK_VIEW_REGISTRY_STALE`。
- 旧 cleanup 只会删除它自己注册的那个定义，不会删除新代际中同 ID 的替代视图。
- 组件不要直接写仓库、ledger 或远端状态；写操作仍走 Fusion 受控工具。
- `topology.version !== 1` 时应显示“暂不支持”并保留降级路径，不要崩溃。
- 扩展组件由独立错误边界包裹。渲染抛错时只显示“扩展视图不可用”和“返回任务列表”，
  任务搜索、筛选、详情与其他视图继续可用。这不是安全沙箱，扩展仍属于受信任代码。

## 稳定错误码

| 错误码 | 含义 |
| --- | --- |
| `FUSION_TASK_VIEW_API_UNSUPPORTED` | 扩展侧发现入口缺失、未就绪或不支持所需主版本 |
| `FUSION_TASK_VIEW_REGISTRY_STALE` | 使用旧 generation 的入口执行注册、注销或列表读取 |
| `FUSION_TASK_VIEW_ID_REQUIRED` | 视图 ID 缺失或为空 |
| `FUSION_TASK_VIEW_ID_RESERVED:<id>` | 试图注册内置保留 ID |
| `FUSION_TASK_VIEW_ID_ALREADY_REGISTERED:<id>` | 同一 ID 已注册，必须先 cleanup |
| `FUSION_TASK_VIEW_ACTION_UNKNOWN:<action>` | 声明了未支持的动作能力 |
| `FUSION_TASK_VIEW_COMPONENT_REQUIRED` | 未提供可渲染的 React 组件 |

## 与 Orca 的对应关系

这是借鉴 Orca 的分层方式：宿主/数据层塑形，客户端视图只渲染；能力通过显式注册、
API 版本和 `has()` 呈现，而不是靠客户端猜测。Fusion 当前先开放视图插槽；后续扩展
路由、筛选器和动作时，沿用同一个版本化契约，而不是把新能力塞进某个具体布局。
