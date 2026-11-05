# 验收记录

对照目标为本机 Adobe Lightroom 9.4 云桌面版。REA 证据来自可执行文件及其资源；登录后的 Windows 运行观察已核对裁剪、蒙版入口及导出设置，见 [运行记录](../research/lightroom.md#登录后的-windows-运行观察)。当前仍未建立全部功能逐屏、逐像素的 Adobe 对照。静态入口、独立实现及实际通过的测试分别记录。

| 流程 | 可复查的验证 |
| --- | --- |
| 图库导入、编辑、重启、恢复、导出 | `tests/workflow.test.js` 实际驱动 Chrome，读回 PNG 尺寸和原件字节 |
| RAW 解码与方向 | `tests/raw.test.js` 生成无嵌入预览的 CFA DNG，检查像素、方向、失败恢复和 Worker 生命周期 |
| TIFF、AVIF、JPEG XL | `tests/codecs.test.js` 检查真实编码签名、像素往返与透明度 |
| 局部编辑 | `tests/local-tools.test.js` 覆盖画笔动作、蒙版、克隆、修复、撤销、重新加载及裁剪框外的源 |
| 裁剪构图 | `tests/crop-guides.test.js`、`tests/crop.test.js` 检查九种辅助线的独立几何、UI/CLI 同步、缩放和拖拽，以及预览/导出不变；原生命令往返在 `scripts/native-smoke.mjs` 中 |
| 组织 | `tests/organization.test.js` 覆盖多选、整理、版本、批量粘贴和重载 |
| 直接浏览磁盘目录 | `local_test.go`、`tests/local.test.js`、`scripts/native-local-smoke.mjs` 核对目录授权、原件和 sidecar |
| Agent 协议 | `tests/agent-cli.test.js`、`agent_test.go`、`scripts/native-smoke.mjs` 检查退出状态、字节返回、当前 GUI 的真实操作和截图 |
| 原生保存 | `desktop_test.go` 验证分块写入、覆盖和取消清理 |
| 三端 | 工作流 `.github/workflows/desktop.yml` 在 Windows、Linux、macOS 启动实际 GUI，执行 CLI 往返。每次运行的结论以 GitHub Actions 为准 |

## 补充验证

- **输出色彩空间**。JPEG/PNG/TIFF/AVIF/JPEG XL 的五种空间经过像素转换及 ICC 封装；5,265 色独立 Little CMS 对照与 25 种文件往返检查实际执行。AVIF/JPEG XL 绑定从固定源代码重建，额外验证真实码流、ICC、无损样本及线程/SIMD，见 [AVIF 实验](../research/avif-color-binding.md) 和 [JPEG XL 实验](../research/jxl-color-binding.md)。Windows 原生 GUI/CLI 对四个中间调色块重导入采样，PNG/TIFF/AVIF/JPEG XL 最大误差 2、JPEG 最大误差 4 个通道等级。此为目标编码，不是恢复 RAW 广色域；定义与剩余范围见 [输出颜色](export-color.md)。

- **高位深栅格输入**。TIFF 的 1,056 个生成布局验证了条带／分块、双端序、四种压缩和预测器；AVIF 使用实际 WASM 验证 10/12-bit 低位及透明度。真实浏览器 GUI 经导入、Linear、TIFF16 导出、重导入与重载，保留超过 256 个等级和原件字节。ICC matrix/TRC 输入与独立 Little CMS 2.17/2.19 的 16 种配置、每种 10,557 色对照；解析曲线最大线性误差 3.15e−7，采样曲线约 2.21e−5。生成 ICC 的 TIFF16 往返最多相差一个样本码值。可复现范围及不支持的配置见 [TIFF](../research/high-depth-tiff.md)、[AVIF](../research/high-depth-avif.md) 和 [输入颜色](../research/float-input-color.md)，合成数据不代表所有相机或 TIFF 文件均已验证。

- **RAW 传递函数**。固定 LibRaw 源码与实际 WASM 实验确认旧的默认 BT.709 曲线和标准 sRGB 在生成梯度上最多相差 17 个字节等级。普通与线性 RAW 现共用 16-bit 线性解码，显示显式转为标准 sRGB；逐通道回读及旧缩略图按需持久化更新均已验证。见 [精度实验](../research/high-precision-raw.md)。

- **图像处理**。公开 CC0 Canon CRW 导出 16-bit LinearRaw DNG，通过 LibRaw 回读。颜色采样、裁剪手柄、红眼、镜头配置、校正后的局部坐标、HDR 和全景均有像素断言。
- **模型**。人物、主体、天空、深度、栅格降噪和超分经过实际推理。可选模型首次获取后可离线使用。记录了输入、授权、对照与误差。查看 [模型实验](../research/ai-masks.md) 和 [增强实验](../research/enhance.md)。
- **视频与审阅**。带音轨的片段经过剪辑、调色和编码。原生宿主用生成的图像向回环服务器发布相册，实际浏览器提交喜欢和评论，撤销链接后访问被拒绝。
- **迁移与设备**。合成 Classic SQLite schema 与 Apple Photos 标准导出文件验证了原件引用、缺失重试、星级和相册。原生编辑器测试启动独立进程并读回保存成果。相机模拟器的捕获与回库使用与设备后端相同的图库入口。
- **存储**。140 MiB + 17 字节的原件在重开后逐字节一致。WebKit 临时会话实测会在 Blob 写入阶段停滞，统一为有索引的分片后，在独立 WebKit 运行中复验了导入、人物推理及 TIFF 导出。
- **CLI**。命令可同时返回数据和工作区截图。长轮询 watch 实测可跟随另一条命令的已提交更改，返回新修订号与 PNG。分割覆盖图可独立导出。

## 对等性边界

浮点流程已接入明确选择的处理版本、GUI/CLI、侧车和同步。生成 RAW → 宽色域 Float32 → 局部/全局编辑 → 16-bit ICC TIFF 的浏览器链路每通道保留 2,040 个梯度值，曝光 +4/−4 EV 恢复误差为零。实际界面测试覆盖切换、原图比较、重置、撤销、版本、预设、XMP、重新加载；两种模式共 50 个格式／色彩空间输出回读通过，水印之外保留 TIFF16 低位。原生套件另行验证 CLI 输出样本、本地侧车与重启。边界与复现命令见 [浮点处理](linear-working-frames.md)，各平台结果必须依据对应运行，不能由浏览器结果推断。

- Adobe 云账户、发现社区、Firefly 服务、Photoshop 智能对象和多层往返仍未建立真实服务验收。OpenLR 的 WebDAV 和审阅服务使用独立协议。
- 显示输出仍为 8-bit sRGB；Linear 静态编辑保留浮点 RAW 样本，Original 模式保持旧处理行为。PNG/TIFF 无符号整数、AVIF 10/12-bit 以及支持配置的 JPEG XL 整数／浮点输入可直接进入浮点流程；超出已实现 ICC 范围或 CICP 组合的输入仍有显示解码精度边界。栅格模型增强、16-bit RAW 合并和 LinearRaw DNG 均有实测。传感器级 AI 降噪、Adobe 色彩匹配及广色域 HDR 编辑的全面等价性尚未验证。
- 实体相机拍摄、真实私人 Lightroom Classic 目录、原生 Apple Photos 资料库与所有相机型号尚未验收。原生选择器的桌面自动化授权超时，授权已知测试目录后的读写流程通过。
- 未完成针对商业产品所有入口的真机逐屏、逐功能对照。已验证的入口和未决范围见 [交互清单](../research/interaction-coverage.md)。

Windows、Ubuntu 24.04、macOS 15 Intel 对提交 ee08007 的原生 GUI/CLI 验收均已通过。[三端运行记录](https://github.com/stvlynn/OpenLR/actions/runs/41882461866)

本地后续验收增加了 XMP/原件包、曝光包围与全景、非 DNG 传感器文件输出 LinearRaw DNG、AI 人物和天空蒙版，以及保留音轨的视频裁剪导出。测试机上的初版运行曾发现 WebView2 无法启动模块 Worker，修复后同一解码内核可处理该启动失败。独立相机格式的来源与回读误差见 RAW/DNG 记录。

2026-11-05 本地 Windows / Node 24.9 / Chrome 155 高位深输入验收：`OPENLR_TEST_CMS=1 npm test` 为 155/155、无跳过；`go test ./...`、`go vet ./...` 与 Windows 构建通过。七组原生 GUI/CLI 套件全部通过，其中 TIFF16、AVIF10/12 → Linear → TIFF16 各检查 1,016 个含低位样本，已测最大码值误差均为零，原件逐字节一致。后续补充了带 ICC 的调色板默认导入、FillOrder 与预测器验证、未知压缩可见失败；调色板原生结果单独记录在对应运行日志中。这些数字仅代表所列生成样本；三端结论以对应提交的 Actions 原生日志为准。

2026-11-05 PNG 工作输入补充：`OPENLR_TEST_CMS=1 npm test` 实际通过 179/179、无跳过。720 个静态布局与 60 个 APNG 首帧组合检查重建样本；512 个 PNG16 相邻源值在新路径全部保留，浏览器字节读回仅剩 3 个等级。独立 libpng 1.6.46 的 11 组原始样本读回逐字一致，LCMS 2.19 解析曲线最大线性差约 1.2e−7、灰度采样曲线约 1.06e−5。Windows 原生 CLI 的普通 PNG16、EXIF 旋转 PNG16、排除默认图的 APNG16 首帧均保留低位样本，TIFF16 测试输出最大码值误差为零，原件逐字节一致。PNG 输出仍为 8-bit，HDR、通用 ICC、动画编辑与任意大图资源行为未由这些生成样本证明；复现及范围见 [PNG 重建](../research/high-depth-png.md) 与 [输入颜色](../research/png-input-color.md)。

2026-11-05 JPEG XL 工作输入补充：本地 Windows / Node 24.9 / Chrome 155 的 `OPENLR_TEST_CMS=1 npm test` 通过 184/184、无跳过，Go 测试与 vet、最终桌面构建通过。七组原生套件通过，最终 XYZ LUT 修正安装后另行重跑原生 smoke 通过。JXL16 → Linear → TIFF16 保留 512 个相邻红色等级和 8,160 个低位红色样本，最大码值误差为 1；浮点源高光 1.5 经 −2 EV 后恢复，TIFF16 最大误差为 2，原件保持逐字节一致。21 个生成样本及 15 组独立 LCMS 对照覆盖精度、色彩、透明度与兼容边界；41 个实际文件的新旧字节解码对照完全一致。已修正固定版 skcms 的 XYZ LUT 缩放位置，保留 Original 模式行为。PQ/HLG、无标准定义的 XYZ mft1 和超出采样曲线范围的浮点输入仍明确使用兼容解码；固定编解码器对的小宽度 FLOAT 往返缺陷已记录，未据此臆造尺寸限制。来源、误差和复现见 [JPEG XL 输入](../research/high-depth-jxl.md) 与 [独立色彩实验](../research/jxl-input-color.md)。

2026-11-05 图库一致性补充：普通筛选与智能相册共用中性编辑判定，Linear 版本标记本身不会使照片进入 Edited。网格撤销通过共享 `history-undo`/`history-redo` 比较图库操作与当前照片编辑的会话次序，保持明确的照片／图库命令和批量粘贴逐照片撤销范围。新增浏览器测试覆盖旧错误复现、保存／重载智能相册、交错撤销重做和当前照片隔离。本地 Windows `OPENLR_TEST_CMS=1 npm test` 通过 189/189、零跳过；Go test/vet、桌面构建及七组原生套件通过。真实 CLI 同时验证撤销顺序、Detail 范围、原件一致和两种智能相册的成员。初次原生运行仅因测试对同步 CLI 参数错误使用了异步断言而中止，修正测试后完整重跑通过。三端结论以该提交的 Actions 日志为准。
