# 海域动画平滑与每帧开销

日期：2026-11-24。代码：`packages/client/src/features/whale/ambient/pod-motion.ts`、
`packages/client/src/features/whale/dive/scene.ts`。

## 目标

1. 深海 / 海面切换不再硬切，镜头、雾、背景与鲸群高度连续变化；
2. 群落巡游更有生命感：深水涌浪、转向侧倾；
3. 渲染循环减少每帧分配与重复工作，但不改变既有运动边界契约。

## 运动契约

`samplePodMotion` 保持原有参数与返回结构，新增两个可选参数：

- `out`：调用方复用的缓冲，避免每帧创建 `position` / `rotation` 数组；
- `viewMix`：0 表示深潜、1 表示海面；缺省时按 `view` 取 0 或 1，
  因此旧调用与既有测试语义不变。

高度为深潜与海面两条轨迹的线性混合，呼吸强度 `spout` 同样乘以 `viewMix`；
深潜段叠加 0.07 幅度慢涌浪，横向摆动的导数用于生成不超过 0.018 rad 的侧倾。
原有约束继续成立：位置边界、36s 呼吸周期、非重叠呼吸、单调 `swimTime`。

## 场景循环

- 视角用指数缓动收敛（`1 - exp(-dt * 2.6)`），同时插值相机位置、目标点、
  `FogExp2` 密度与背景色；体积光/尘埃/光束在过渡阈值处切换；
- 只有 `viewMix > 0.5` 时才计算喷潮世界坐标，深海视图跳过矩阵与水面判定；
- 选中高亮只在选中态变化时写 `emissive`；
- `camera.updateProjectionMatrix()` 仅在 `far` 实际变化超过 1 时调用；
- pod 查找改为 `Map`，移除每帧线性搜索；
- 渲染循环复用单个 `PodMotion` 缓冲，3 个 pod 每帧零小对象分配。

## 证据

- 采样吞吐：fresh 3.58M ops/s → pooled 4.12M ops/s（Node 22，200 万次）；
- WebGL 预览（SwiftShader，1280×860）：深海→海面→深海 `running`，
  帧计数 12→22→56→76，page/console 错误均为 0；
- 客户端 453 项测试通过，新增池化、视角混合、侧倾、深水涌浪 4 项。

证据目录：`/data/openlet/evidence/dsh-fusion-anim-20261124/`。

## 边界

- 软件渲染帧数不代表真实 GPU 或移动端帧率；
- 已发布 `v0.2.0-beta.15` 早于本次改动，优化需下个版本重新打包；
- 演示数据为合成海域，不代表真实团队业务。
