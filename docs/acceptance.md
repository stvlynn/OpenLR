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

2026-11-05 导出复用补充：`export-previous` 与 GUI 的 Export again、Ctrl/Command-E 共用现有导出管线；`export-settings` 提供照片／视频独立设置的读取与显式配置。只在输出适配器成功后记忆捕获的设置，取消、写入失败或拒绝覆盖保留旧设置。Windows / Node 24.9 / Chrome 155 全量测试 203/203、零跳过；Go test/vet、桌面构建与七组原生套件通过。实际 CLI 验证原件逐字一致、P3／尺寸／水印复用和覆盖失败后的设置保留。浏览器测试检查真实下载字节、当前照片编辑、重启、视频／照片隔离、旧设置兼容及保存边界故障；原生选择器的取消与故障由注入适配器模拟，不声称自动操作了系统选择器。提前记忆与完成后记忆的四场景消融均完成，后者在取消和写失败时保留旧设置。最后缩短顶栏标签、让搜索框收缩，1024px 与 1280px 截图已检查，相关十项浏览器／设置测试再次通过。详情见[导出设置](export-settings.md)及[实验记录](../research/catalog-organization.md#shared-previous-export-workflow)。

首次三端 CI 中 macOS／Linux 原生套件通过，Windows 的新增保存边界测试提前读取了空调用列表。已定位到固定 Playwright 版本把异步等待谓词返回的 Promise 当作真值；挂起实际 GUI close 处理器的确定性实验复现了“返回 false 仍结束等待、调用列表为空”，放行后实际保存与记忆正常完成。测试改为同步观察持久化结果，并等待每次原始异步处理器结束后再检查或重置模拟器；未增加延时、重试或更改生产导出行为。最终平台结论以修正提交的 Actions 结果为准。

2026-11-05 浏览器验收可靠性补充：11 份工作流测试中的 16 处异步等待改为先等待谓词的最终值，再判断条件；读取错误立即失败，未匹配状态在截止时间内继续观察，不重复编辑动作。键盘撤销／重做增加参数和评级的独立值断言，蒙版工作流重启后检查同一照片、蒙版和组件的 min=0.5。新增六项 helper 测试包含真实 Chrome 的旧／新等待对照及受控 deferred 条件、错误传播；超时边界另用明确标注的传输桩确定性检查。本地 Windows / Node 24.9 / Chrome 155 的 OPENLR_TEST_CMS=1 npm test 实际通过 209/209、零跳过；迁移工作流定向 26 项及历史／范围蒙版 5 项均通过。生产代码未改，三端原生结果以本提交的 Actions 日志为准。验证方法与来源见[浏览器等待](browser-verification.md)。外部编辑文档同时纠正了已过时的仅 8-bit 描述，共享 TIFF 输出的现有 Original 8-bit／Linear 16-bit 行为未改变。

2026-11-05 渲染元数据补充：JPEG／PNG／TIFF／AVIF／JPEG XL 共用 None、Copyright only、Copyright & photo info 三策略，默认保持 none；GUI、CLI 和完成后记忆的导出设置一致。版权与十项明确字段按策略重建 EXIF/XMP，Unicode 使用 XMP，尺寸／方向／目标 ICC 由成片确定，GPS、关键词、旧编辑与未知私有信息不照搬。现有 TIFF writer 同时生成 EXIF payload 和 8/16-bit TIFF 元数据目录，AVIF/JXL 五套编码变体使用原库 API，未增加运行时依赖。本地 Windows / Node 24.9 / Chrome 155 的 OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test 通过 226/226、零跳过，Go test/vet 和桌面构建通过。七组 Windows 原生套件通过；新矩阵实际执行两处理版本×五格式×三策略的 30 次导出、沿用上次设置字节对照与重导入，独立 ExifTool 13.60 校验全部输出，包含 Unicode、时间偏移／子秒、方向尺寸及隐私字段排除。Linear TIFF16 样本、当前照片原件与既有色彩验收均通过。1024px 导出对话框已截图检查。浏览器 oracle 初次错误假设 ExifTool 会暴露 JXL 码流 ICC；核对工具范围后改由 libjxl 读取实际 original ICC，元数据盒仍由 ExifTool 独立校验，完整重跑通过。来源、字段及未测边界见[元数据合同](export-metadata.md)和[实验](../research/export-metadata.md)。本轮三端远程验收受 GitHub 账户计费限制影响，不能将 Windows 本地结果当成新提交的 macOS／Linux 原生通过。

随后补充多作者署名：按 XMP 有序数组保留完整创建者列表，单作者仍兼容原字符串；实际 PNG／TIFF 回读与独立数组断言通过。最终代码全量测试为 227/227、零跳过，重新打包后的 Windows 原生 smoke（含 30 个元数据文件独立校验）再次通过。

2026-11-05 本机 Linux 验收与 PNG 方向补充：Ubuntu 24.04／WSL2（6.6.87.2）／WebKitGTK 2.52.6 的真实 MyGo 窗口发现旧 PNG 显示解码忽略 EXIF 方向，而 Chrome 已应用方向。现由共享显示适配器保留原生色彩管理、临时移除 eXIf 后应用既有方向映射，与 Linear 和兼容路径一致。八种方向×两种处理版本的实际 TIFF 像素及原件字节检查通过；五格式×三策略×两版本的 30 个元数据文件通过独立 ExifTool 校验。旧 PNG 图库沿用现有 RAW 懒刷新队列，原子持久化缩略图、正确尺寸和预览版本，保持原件及编辑参数，过期记录不覆盖新行。

完整回归曾在无 IntersectionObserver 的旧缓存刷新场景发现实际存储竞态：旧记录与媒体分片分两个事务读取，替换可在中间回收旧分片。修复为同一只读事务后，确定性测试检查完整旧／新快照、真正回收和真实缺块报错；同一测试注入旧模块稳定失败，新模块通过。没有添加缺块重试或放宽错误检查。最终 Windows／Node 24.9／Chrome 155 的 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 通过 **234/234、零跳过**。Linux Go test、race、vet 和正式 deb／tar.gz 打包通过，最终源码与隔离 Linux 工作副本逐文件一致；七组原生 GUI/CLI 套件全部通过，共享审阅访客使用 Linux Chrome 157.0.8103.38，实际工作区截图已检查。

同一最终代码的 Windows 安装包构建及七组 WebView2 原生 GUI/CLI 套件也全部通过，包括八方向 PNG、30 文件元数据、外部编辑、相机模拟器、共享审阅和合成／真实 CRW／模型集成流程。

该 Linux 结果来自 Xvfb／D-Bus 下的真实 GTK/WebKit 与 IPC，不等同于物理显示器、GPU 或原生文件选择器操作验收。前置环境曾因临时目录消失与缺少访客 Chrome 中止，补齐持久目录和浏览器后完整重跑，未将中止运行计为通过。GitHub 远程三端任务此前因账户计费未启动，本轮 macOS 结论仍须对应实际运行；不由 Windows／WSL 结果推断。复现步骤见[桌面宿主](desktop.md#local-linux-acceptance)，方向与存储依据见 [PNG 研究](../research/high-depth-png.md#native-png-orientation-correction)和[目录存储](catalog-storage.md)。

2026-11-05 输出锐化补充：五种渲染照片格式新增 None／Low／Standard／High，GUI、CLI、设置记忆和沿用上次设置共用合同；原件、DNG、配方和视频容器拒绝非 None。生成消融比较现有逐通道锐化、亮度 Gaussian USM 和不同残差限制；选定算法在该数据集上以较低噪声放大获得更好的细节恢复，并限制光晕。滤镜在最终尺寸、水印之前运行，保留 Linear 的负值／HDR／TIFF16，alpha 和隐藏透明 RGB 不变，不修改照片编辑或预览。没有声称 Adobe 算法等价或纸张校准。

Windows／Node 24.9／Chrome 155 的 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 最终通过 **242/242、零跳过**。新增浏览器矩阵读回两处理版本×五格式×四强度的 40 个实际文件，核对 None 字节恒等、像素变化、ICC、版权、透明度与 TIFF16 低位；均匀照片带水印的 None／High 字节一致，验证了水印后的内容没有被锐化。GUI 实际下载、重载、取消和复用通过，1024×768 对话框截图已检查。最初测试夹具以错误类型提供 PNG chunk 导致夹具生成失败，修正测试数据后重跑通过，未为此修改生产逻辑。

最终 Windows 安装包及 Ubuntu 24.04／WSL2／WebKitGTK 2.52.6 的 deb／tar.gz 构建通过，两个平台各七组原生套件全部通过。新增 CLI 矩阵实际导出并重导入两处理版本×五格式，采样 TIFF 像素验证成片变化，并检查上次设置逐字节复用、预览／配方／原件不变及拒绝不支持的组合。复现算法与来源见[研究](../research/output-sharpening.md)，行为和资源边界见[输出锐化](output-sharpening.md)。本轮不据此推断未重新执行的 macOS、物理打印或全部照片的最优锐化强度。

随后，提交 `04b3475` 的 [三端 CI 42006040430](https://github.com/stvlynn/OpenLR/actions/runs/42006040430) 在 Windows、Ubuntu 24.04、macOS 15 Intel 全部通过，各平台实际运行七组原生套件及新增输出锐化矩阵。Windows CI 浏览器测试共 242 项、通过 234、跳过 8 项可选本地模型／色彩／ExifTool oracle；本地对应 242 项全执行通过。远程 ExifTool 未安装时明确跳过独立元数据 oracle，但仍实际执行 30 个 CLI 文件导出／重导入；本地 Windows 与 WSL 的独立 oracle 已通过。macOS 构建为 universal，实际运行环境为 Intel，不等同于 Apple Silicon 验收。

2026-11-05 局部工具分发补充：真实 Chrome 复现 GUI 在裁剪中选择 Brush 仅改变下拉值、没有画笔交互层及变化通知，而 CLI `local-tool` 正确退出裁剪。GUI 现通过同一 dispatcher，内部 `setMode` 仅负责应用状态，避免递归；完整和简要 `state` 新增选定模式 `localTool`，不改变 `localSelection` 的已有形状。新浏览器测试验证裁剪／比较切换、单次通知、真实指针笔画、模式切换不改配方、原件保持不变及 Grid 下选定模式的可观察性。最终本地 Windows 全量 **243/243、零跳过**，Windows／WSL Linux 重新打包后各七组原生套件通过。新增 CLI 检查覆盖退出裁剪／比较、全部工具的完整／简要状态、真实截图和配方不变；远程最终平台结论以此修复提交的 Actions 运行记录为准。


2026-11-05 多选导出补充：GUI Export N／Export again 与 CLI `export-selection` 共用单张照片准备和逐张文件夹写入，保持活动照片、编辑历史、选择与视频播放位置。支持混合媒体原件、裁剪起点的视频静帧、照片／视频独立设置，以及 CLI `--capture` 的实际工作区截图。已有文件使用编号后缀保护；部分失败返回实际完成清单，清理错误不覆盖主错误，全部完成后一次写入两个设置槽。96 MiB 传输消融中，逐张分块的 RSS 增量约 53 MiB，全组 base64 JSON 约 472 MiB，现有 zipSync 约 192 MiB；这不代表编解码器总内存上限。

Windows／Node 24.9／Chrome 155 的 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 通过 **252/252、零跳过**。浏览器专项验证两种处理版本、成片字节／像素／ICC、GUI 多选与复用、混合视频、原件／预览不变、排队编辑隔离、取消与部分失败、设置原子提交及错误清理。另用 Chrome 实际 OPFS 写入流验证冲突名、Unicode、读回和写失败；普通浏览器目录 API 无独占创建，不能保证外部并发同名写入安全，失败时可能保留新建空占位文件。原生适配器真实文件测试验证无覆盖发布及竞态。1024×768 下批量导出对话框已截图检查。

最终 Windows 安装包与 WSL Ubuntu 24.04／WebKitGTK 2.52.6 构建通过，两个环境各七组原生 GUI/CLI 套件全部通过；Linux Go test、race、vet 通过。新增真实 CLI 用同名源、不同处理版本导出 TIFF，保留已有目标，检查尺寸／字节／像素、再次导出及真实 PNG 截图，选择、配方、预览和原件不变。系统文件夹选择器由程序化目标替代，未声称自动操作 OS 选择器；Xvfb 结果不证明物理显示器/GPU。现阶段没有运行中批量取消／进度查询，CLI 超时不取消后端写入。合同与来源见[批量导出](batch-export.md)和[研究](../research/batch-export.md)，远程三端以本提交 Actions 实际记录为准。


2026-11-05 导出实时控制补充：`export-status`／`export-cancel` 使用独立原生接收通道，但仍走中央 dispatcher 与共享参数验证；普通编辑维持串行。GUI 显示已保存数量和取消按钮，CLI `watch --command export-status --images ...` 复用变化通知并读取真实窗口。取消请求和终止分开，512 KiB 传输边界及发布前检查信号；已发布文件仍计数，设置只在全批完成后提交。最后一项 DNG 预检取消不再打开目录选择器，观察者异常不再卡死生命周期。原生关闭／删除错误回传并保留失败清理跟踪，不以成功取消掩盖错误。

最终 Windows／Node 24.9／Chrome 155 的 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 通过 **260/260、零跳过**。实际 Chrome 测试在第二个写入处暂停，验证状态／GUI 取消可越过排队编辑、第一文件保留、当前传输取消、旧设置不变；附加测试覆盖发布完成与取消竞态、真实写入错误优先、清理失败、快照隔离、旧任务 ID、观察者异常及 DNG 预检检查点。Chrome 实际文件系统流另验分块进度、取消与关闭提交边界。Go 测试验证普通队列满时控制仍可达、过期请求跳过以及实际文件删除错误回传；Linux test/race/vet 通过。1024×768 的进度面板截图已检查。

Windows 与 WSL Ubuntu 24.04／WebKitGTK 2.52.6 的最终桌面构建及各七组原生套件通过。新增验收使用带 64 MiB 生成尾随原始字节的 PNG，在实际写入第二个文件时查询状态、通过 watch 保存真实 PNG 窗口截图、排队编辑后再取消；检查只有第一文件已发布、无当前临时文件、设置保留，编辑在取消后执行。没有通过测试后门挂起生产导出。此结果不等于同步编解码器可抢占、崩溃恢复、物理显示器或 OS 选择器验收；最新 macOS 结果仍须对应远程实际运行。合同与调度消融见[批量导出](batch-export.md)、[研究](../research/export-progress.md)及 [ADR 016](decisions/016-export-control-lane.md)。前一提交 `97ca4c2` 的远程任务 [42011667925](https://github.com/stvlynn/OpenLR/actions/runs/42011667925) 因账户付款／限额未开始，未算作通过。


2026-11-05 智能相册规则编辑补充：GUI **Edit rules** 与 CLI `album-rule` 完整替换已有搜索、最低星级、旗标、编辑状态四项条件；复用目录筛选验证和匹配，不创建第二套规则引擎。保存保留相册 ID、名称和当前临时搜索／筛选，视图继续取交集；成员及选择随规则更新。已有图库撤销／重做恢复规则，相同规则不写入或增加历史，普通相册及本地目录模式拒绝修改。主源资料与完整替换／局部补丁实验见[研究](../research/smart-album-editing.md)，本机 Adobe 智能相册编辑仍未由运行观察证明。

最终 Windows／Node 24.9／Chrome 155 的 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 通过 **263/263、零跳过**。新增实际浏览器测试覆盖预填、取消、保存、非默认临时筛选保持、成员实时变化、选择边界、重载和原件字节；注入 IndexedDB 写入失败后独立读取存储，验证内存／存储／历史均不变。1024×768 对话框已截图检查。首轮回归的旧筛选定位同时匹配隐藏对话框内同名控件，已限定为目录筛选面板；原生无效参数测试误用异步拒绝断言处理同步解析异常，改为同步断言。上述是测试修正，未用它们放宽生产校验，最终完整重跑通过。

Windows 与 WSL Ubuntu 24.04／WebKitGTK 2.52.6 的桌面构建及各七组原生套件通过。真实 CLI 验证规则替换、成员结果、视图筛选保留、撤销／重做、无操作历史及实际 PNG 工作区截图；两个平台另行运行最终 Local smoke，确认本地目录状态拒绝改写已有图库相册且保存规则不变。最新 macOS 验收仍须对应实际远程运行，不能由本地结果推断。此前 `67fedc9` 的远程任务 [42013971933](https://github.com/stvlynn/OpenLR/actions/runs/42013971933) 因账户付款／限额未执行任何步骤。

2026-11-05 原图范围取样补充：GUI 的 Sample range color 通过共享 `local-tool color-sample` 退出裁剪、比较、双图和白平衡取样，真实指针与 CLI `range-color` 共用原图坐标取样及已有蒙版更新路径。完整／摘要状态公开当前工具和范围颜色；可明确指定嵌套组件或只填写新范围草稿，照片保护拒绝过期操作。既有 `sample-color` 保持编辑后图像语义。范围参考取自解码器的 8-bit sRGB 显示面，不声称传感器或无界浮点取样。

Windows／Node 24.9／Chrome 155 的 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 通过 **266/266、零跳过**。新增三项真实浏览器测试覆盖两种处理版本、所有四分之一旋转与翻转／裁剪／镜头映射、嵌套组件更新和撤销／重载、明确草稿、无效目标及原件保持。单像素源矩形与完整源画布的六次消融值完全一致，并与加曝光的成片取样明确不同。初次专项测试未打开 Masks 面板，修正测试操作后完整回归通过；生产行为未为测试放宽。来源及可复现实验见[范围取样研究](../research/range-color-sampling.md)。
Windows 与 WSL Ubuntu 24.04／WebKitGTK 2.52.6 的最终桌面构建及各七组原生套件全部通过。真实 CLI 检查两种处理版本的原图／成片颜色差异、裁剪／比较退出、实际 PNG 工作区截图、选中范围更新／撤销、过期照片拒绝及原件逐字节保持。Linux 在 Xvfb／D-Bus 下运行真实 GTK/WebKit；不代表物理显示器、GPU 或 OS 文件选择器验收。最新 macOS 结论仍须对应实际远程运行。前一提交 `bf4ce28` 的远程任务 [42015919034](https://github.com/stvlynn/OpenLR/actions/runs/42015919034) 因账户付款／限额未启动任何作业步骤。

2026-11-05 点颜色选择补充：Point color 下拉框与 `point-select` 共用应用持有的照片关联选择，完整／摘要状态公开 `selectedPoint`。选择不写配方、不占用撤销记录、不重新计算图像；添加在保存成功后选中新样本，删除／重置／撤销与配方替换保留有效选择或回到首项，切换照片独立重建选择，复制配方的相同样本 ID 不会跨照片携带选点。更新／删除仍明确指定 ID，吸管仍新增样本。真实浏览器新旧消融确认旧版选择不可观测、新版命令与下拉框双向对应，两者配方均不变。来源与实验见[点颜色研究](../research/point-color-selection.md)。

验收期间另行复现了拉直工具吞掉后续颜色取样点击的真实错误，包含尚未选参考点与已点击第一参考点两种情况。新增指针回归先在旧代码三秒内持续失败，加入既有工具退出清单后通过；未新增几何或取样实现。定向 `node --test tests/point-selection.test.js tests/point-color.test.js tests/optics-workflow.test.js` 为 **5/5、零跳过**。实际测试浏览器版本为 Chrome **156.0.8078.80**，此前验收历史中的浏览器版本不用于推断本轮环境。

修复后的最终 Windows／Node 24.9／Chrome 156 全量 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 为 **269/269、零跳过**。Windows WebView2 与 WSL Ubuntu 24.04／WebKitGTK 2.52.6 均重新构建，随后各七组原生 GUI／CLI 套件全部通过；新增原生检查包含完整／摘要选点、实际 PNG 窗口截图、不改配方与撤销顺序、删除／重置／换照片、无效与过期目标拒绝、原件逐字节一致。命令 schema、离线 dry-run 和代码格式检查通过。Linux 为 Xvfb／D-Bus 的真实原生 IPC 验收，不代表物理 GPU／显示器或 OS 文件选择器。macOS 的本轮结果仍须实际远程运行；前一提交 `41fba14` 的 [42018284168](https://github.com/stvlynn/OpenLR/actions/runs/42018284168) 因账户付款／限额未启动任何作业步骤，未计为通过。

2026-11-05 异步 XMP 目标保护补充：实际浏览器审计复现了读取侧车期间切换照片导致改错目标，以及同一照片的新编辑被迟到配方覆盖。GUI 现于读取前捕获照片和编辑引用，通过共享 `apply-xmp` 在队列执行时检查；新增可选 `photoId` 也供 CLI 使用。未指定保护的 CLI 保持执行时活动照片语义，未引入新持久化版本、校验和门禁或第二套解析／保存路径。读取错误进入现有可见提示，成功或失败后清空文件输入以允许重试。研究及旧行为证据见[异步编辑目标](../research/async-edit-targets.md)。

新增三项实际 Chrome 156.0.8078.80 文件输入测试明确注入读取等待／失败，未替换生产队列、XMP 解析或保存。换照片后独立重载检查两张照片均未变化；同照片新编辑保留且撤销仍回到真正的编辑；读取失败没有未处理异常，同文件重试可成功导入 Unicode 关键词、评级、旗标与曝光。CLI 有效／过期目标、撤销／重做与原件字节也通过定向检查。`node --test tests/xmp-target.test.js tests/process-version-transport.test.js tests/point-color.test.js` 为 **6/6、零跳过**。注入的时间安排用于确定性验证边界，不代表测量了物理磁盘延迟。

最终 Windows／Node 24.9／Chrome 156 的 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 通过 **272/272、零跳过**；代码格式与实际 CLI schema 检查通过。Windows WebView2 与 WSL Ubuntu 24.04／WebKitGTK 2.52.6 均完成桌面构建及各七组原生套件。新增原生验收从实际导出的 XMP 读回文本，检查过期照片拒绝、有效应用、真实 PNG 工作区截图、撤销／重做及原件逐字节不变；异步读取时间注入只在浏览器专项中使用。Linux 为 Xvfb／D-Bus 真实 GTK/WebKit 与 IPC，不代表物理显示器、GPU 或系统文件选择器操作。当前 macOS 仍须对应实际远程运行；前一提交 `509abb5` 的 [42020066091](https://github.com/stvlynn/OpenLR/actions/runs/42020066091) 因账户付款／限额未启动任何作业步骤，未计为通过。

2026-11-05 确认目标补充：实际 Chrome 156.0.8078.80 审计复现了永久删除确认期间 A→B 换选，以及保持活动 A 但扩选 A+C 时错误删除新目标；相册重命名／删除在切换 scope 后也错误操作 B。现有永久删除对话框捕获完整选择，通过共享 `purge` 的可选 `expectedIds` 在事务前比较集合；成员变化拒绝，顺序变化允许。相册对话框捕获原始 ID，沿用现有显式 ID 命令。未新增确认步骤、独立删除事务或强制 CLI 门禁；取消本已正常，不把它作为旧缺陷。来源及设计取舍见[确认目标研究](../research/confirmation-targets.md)。

新增三项实际浏览器测试与既有组织／堆栈测试共 **5/5、零跳过**。真实对话框按钮和 Escape 验证目标漂移拒绝、同集合换序成功、取消、共享原件保留与最后引用释放；独立读取存储并重载确认，过期确认没有删除任何照片。相册 A 的改名／删除在 scope B 下仍只作用 A，B 和照片保留。未注入 I/O 延迟、伪造 close 事件或替换生产队列；测试只使用生成图片和隔离目录。

最终 Windows／Node 24.9／Chrome 156 的 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 为 **275/275、零跳过**，代码格式与实际 CLI dry-run 通过。Windows WebView2 和 WSL Ubuntu 24.04／WebKitGTK 2.52.6 均完成桌面构建及各七组原生套件。新增原生流程使用两个生成原件及一个保留的虚拟副本，验证不匹配集合拒绝、换序集合成功删除、实际 PNG 工作区截图、共享原件逐字节保留与磁盘源文件不变。Linux 使用 Xvfb／D-Bus 运行真实 GTK/WebKit 与 IPC，未证明物理 GPU／显示器或 OS 选择器交互。最新 macOS 仍需对应远程实际验收；前一提交 `89d30d9` 的 [42021424979](https://github.com/stvlynn/OpenLR/actions/runs/42021424979) 因账户付款／限额未执行任何作业步骤，未算作通过。

2026-11-05 选择性复制补充：先在本机 Lightroom 实际打开复制设置窗口和选择菜单后取消，记录可见类别与观察边界，未复制私人照片或 Adobe 资源。OpenLR 的冻结旧版浏览器消融确认完整复制会替换裁剪，已有 `copy-edits keys` 则保留未选参数；新增 Choose edits 对话框复用该命令与原有粘贴、保存、逐照片撤销路径。`localTools` 和 `optics` 保持实际原子边界，未虚构嵌套项独立复制。来源和实验见[选择性复制研究](../research/selective-copy.md)。

新增两项实际 Chrome 测试与组织／处理版本回归共 **5/5、零跳过**。真实复选框、按钮和 Escape 验证空选择禁用、会话选择保留、取消不改剪贴板、换照片后拒绝、同照片确认时取最新编辑、复制后快照独立、缺失项重置、裁剪／版本保持、批量逐照片撤销及原件字节不变。1024×768 实际截图已检查，所有类别和操作可见，无截断或横向溢出。CLI schema dry-run 与生产／测试代码格式检查通过。

最终 Windows／Node 24.9／Chrome 156.0.8078.80 全量 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 为 **277/277、零跳过**。Windows WebView2 与 WSL Ubuntu 24.04／WebKitGTK 2.52.6 均完成桌面构建及各七组原生套件；新增原生步骤验证来源保护、实际 PNG 工作区截图、选择性粘贴与缺失项重置、目标裁剪／处理版本保持、撤销及原件逐字节一致。首次 Windows 打包因沙箱 DNS 无法下载 NSIS 失败，获得网络权限后完成安装包；首次原生启动早于打包资源复制完成而读到旧 schema、拒绝 `photoId`，完整打包后重跑通过。Linux 使用 Xvfb／D-Bus，未证明物理显示器、GPU 或系统文件选择器交互。本轮 macOS 尚需远程实际运行；前一提交 `aebff7e` 的 [42022718374](https://github.com/stvlynn/OpenLR/actions/runs/42022718374) 因账户付款／限额没有启动任何作业步骤，未计为通过。
