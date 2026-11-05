# 裁剪构图辅助线

在 **Crop & rotate** 中打开 **Crop area** 后，**Composition guide** 提供九种构图方式：Grid、Thirds、Fifths、Diagonal、Center、Triangle、Golden ratio、Golden spiral、Aspect ratios，另有 None 关闭辅助线。默认 Thirds。Triangle 与 Golden spiral 可通过 **Guide orientation** 水平、垂直或双向镜像。其他模式隐藏方向控件，但保留所选方向，切回非对称模式时继续使用。

辅助线是当前窗口会话的视图设置，不属于照片编辑参数；切换照片和关闭/重开裁剪工具时保留，重新启动窗口恢复默认。切换辅助线不提交草稿、不生成撤销步骤、不修改原图、预览像素或导出字节，也不写入相册、预设、版本、XMP 或本地 sidecar。辅助线只在裁剪工具打开时显示，始终跟随当前草稿框和窗口尺寸；保存照片只保存实际裁剪矩形。

## OpenLR 的几何定义

这些是独立实现的 OpenLR 构图规则，不是 Lightroom 辅助线的逐像素复刻。

| 方式 | 定义 |
| --- | --- |
| Grid | 横向和纵向各八等分 |
| Thirds / Fifths | 横纵各三/五等分 |
| Diagonal | 从四角画与框边成 45° 的线段，长度受短边限制 |
| Center | 经过中心的水平和垂直线 |
| Triangle | 一条对角线，以及另外两角到该对角线的垂线 |
| Golden ratio | 横纵各在约 0.382 和 0.618 处画线 |
| Golden spiral | 半径每四分之一圈扩大 φ 的三圈对数螺线，等比缩放后居中放入框内；任意裁剪比例下不拉伸螺线 |
| Aspect ratios | 居中的 1:1、4:5、3:2、16:9 参考框及标签；不会更改实际 Aspect 设置 |

几何坐标属于 optics 校正后的裁剪基准画布，与现有裁剪草稿一致。现有裁剪模式暂时忽略 quarter-turn/flip 来编辑基准矩形，辅助线跟随同一显示框；辅助线方向与照片旋转、翻转互相独立。见[几何坐标约定](optics-geometry.md)。

## 共用命令

UI、浏览器 agent 与原生 CLI 共用 `crop-guide` dispatcher 和 `web/agent-protocol.js` schema。命令可在未打开裁剪工具时预设类型，不会自动打开裁剪。

```sh
node cli/openlr.mjs schema crop-guide
node cli/openlr.mjs crop-tool
node cli/openlr.mjs crop-guide --type golden-spiral --orientation 1
node cli/openlr.mjs state --summary true
node cli/openlr.mjs crop-guide --type none
```

`type` 是 `none/grid/thirds/fifths/diagonal/center/triangle/golden-ratio/golden-spiral/aspect-ratios`。可选 `orientation` 是整数 0（默认）、1（水平镜像）、2（垂直镜像）、3（双镜像），省略则保留当前值。返回 `{cropGuide:{type,orientation}}`。完整及摘要 `state` 均返回同样的 `cropGuide`，并继续返回未提交的 `cropDraft`。类型或方向不合法时，schema 会在变更视图之前拒绝命令。变更辅助线会通知实时观察者。

## 验证

```sh
node --test tests/crop-guides.test.js tests/crop.test.js
node tests/crop-guide-ablation.mjs
```

2026-11-05，Windows 10、Chrome 155、DPR 1 的针对性测试实际通过：几何范围与垂线/比例、无效 schema、既有裁剪交互及新构图 E2E。浏览器 E2E 遍历全部模式，验证 UI 与序列化 agent 命令互相同步，草稿坐标不变，窗口缩放后位置正确，SVG 不拦截拖拽，照片 canvas 像素和 PNG 导出逐字节一致，完成裁剪后 recipe 只含实际 crop。原生 CLI 验收由 `scripts/native-smoke.mjs` 覆盖，浏览器通过本身不代表原生通过。

渲染候选的实测、来源与限制见[研究记录](../research/crop-guides.md)和[架构决定](decisions/005-crop-composition-guides.md)。

随后 Windows 完整 `npm test` 53 项全部通过。官方 MyGo CLI 构建的 Windows/amd64 包通过 `node scripts/native-smoke.mjs build/release/windows-amd64/OpenLR.exe`：真实原生命令设置黄金螺线及水平镜像、返回截图和相同实时状态，保持裁剪草稿不变，切换前后的 PNG 导出逐字节一致。

JPEG XL 增量的 Windows CI 暴露了构图测试的缩放等待竞态：`setViewportSize` 后，旧 SVG 的非零 viewBox 已满足原等待条件，但 `ResizeObserver` 尚未按新 canvas 尺寸重绘。测试现等待裁剪框的位置和尺寸匹配新 canvas，再执行原有的像素坐标断言；不增加固定延时，也不放宽坐标误差。应用裁剪行为未因此修改。
