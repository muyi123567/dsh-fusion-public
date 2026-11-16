# Whale 面板资产离线减重

本提交只交付脚本、固定工具清单和许可说明；未安装、未处理、未生成轻量 GLB，所有性能及外观目标未验证。原 36 秒预览资产保持不变。

## Instabox 执行

在父代理授权的 Instabox 隔离 checkout 中执行，Node >=24.9.0。不要在 Windows 或 CUE 执行。先审查脚本；安装目录在仓库外，避免影响主 lockfile：

```sh
TOOLS=$(mktemp -d /tmp/whale-asset-tools.XXXXXX)
npm install --prefix "$TOOLS" --save-exact --no-audit --no-fund @gltf-transform/core@4.2.1 @gltf-transform/functions@4.2.1 @gltf-transform/extensions@4.2.1 meshoptimizer@0.22.0 sharp@0.33.5
WHALE_ASSET_TOOLS="$TOOLS" node scripts/optimize-whale-assets.mjs 1024
# 若 1024 候选未达到体积预算，再从同一原件生成独立的 512 候选：
WHALE_ASSET_TOOLS="$TOOLS" node scripts/optimize-whale-assets.mjs 512
```

以上是待执行命令，不是安装成功证据。归档首次安装产生的 package-lock.json、npm ls --prefix "$TOOLS" --all、Node/OS 版本和退出码；之后用该 lockfile 和 npm ci 复现传递依赖。本脚本逐包核对顶层精确版本，不自动安装。工具仅用于离线生产，不加入客户端依赖。

输出到 packages/client/src/features/whale/ambient/assets/humpback-whale-panel-{1024|512}.glb，附同名 .glb.json。重复执行拒绝覆盖。父代理整合时通过打包器资产 URL 导入选中的 GLB；本提交不修改场景和原 public 资产。

## 算法与验收

基于实际索引数计算约 20000 三角的简化比例；误差阈值 0.001、锁定边界，保留 UV、法线、材质及骨架。误差保护可能让简化提前停止，不保证强行达到目标。meshoptimizer 只执行离线简化；不启用 meshopt/draco、量化或 KTX2，不需要额外运行时 decoder。脚本检查输入与输出扩展及自包含性，重新读取序列化产物计算指标。

纹理最大 1024 或 512，保持比例且不放大；不透明颜色图 JPEG 82、4:4:4，有 alpha 或用于法线/数据的图采用 PNG。保留原纹理和材质关联，不以纯色替代。

报告记录输入/输出字节数、SHA256、三角数、各 primitive 三角数、每张纹理的尺寸、编码、字节和 SHA，以及工具版本。预算为严格小于 1000000 字节、16000–24000 三角、存在纹理且不超指定尺寸；未达标仍保留候选与报告并返回 2，不能宣称通过。0 仅代表数值通过，仍须视觉验收。

在 Instabox 对原件和两个候选使用相同相机/光照，检查侧面、正面、腹面、尾部及手机画面：嘴线、喉沟、胸鳍轮廓、尾鳍分叉、皮肤纹理均须可辨。还需检查摆尾变形、GLTFLoader 无 decoder 加载、网络尺寸和长时面板渲染。若细节损失或预算失败，由父代理审查参数调整，不能自动以更大误差换取通过。

官方算法参考：[simplify](https://gltf-transform.dev/modules/functions/functions/simplify)。当前 API 文档只能辅助审查，指定版本的实际兼容性待 Instabox 验证。

## 来源与许可

原件 Grab3D Humpback Whale light GLB，来源 https://grab3d.com/models/animals/humpback-whale/ ，原下载 https://grab3d.com/dl/humpback-whale/humpback-whale-light.glb 。
仓库来源记录为 3705864 字节，SHA256 c07b1cec69fb3292165c51d00acf224809476b6d9d899c3a810d6050e9611c58；脚本强制匹配。原件许可 CC0-1.0，原 manifest 明确为 AI 辅助来源，不标作扫描或科学模型。来源声明依仓库留存文件，未重新核验发布方授权。

保留 packages/client/public/whale-assets/{CREDITS.md,LICENSE.txt,manifest.json}，派生产物随附 assets/LICENSE.txt 与 CREDITS.md。CC0 不要求署名，仍保留来源以便追溯。glTF Transform、meshoptimizer、sharp 是 MIT 工具；若再分发工具本体，应保留安装包内各自及传递依赖许可证。项目 MIT 不替代模型 CC0。
