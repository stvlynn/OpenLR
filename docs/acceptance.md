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

- **原生整理与堆叠状态（2026-11-06）**。新 `native-organization-smoke` 接入标准原生套件，实际 CLI 验证搜索／分页／选择反转、标签与关键词／时间／重命名、相册与版本重命名／删除、删除／恢复、预设 CRUD、手动堆叠／封面／展开／解除和时间／相似性自动堆叠。该检查发现展开后解除堆叠会残留公开 ID；现在只报告当前完整目录存在的堆叠，保留会话偏好以支持撤销恢复，过滤不会清除偏好。真实 Chrome 覆盖解除、撤销／重做、软删除及最终成员永久删除。Windows 独立 WebView2 profile、适配器配置及 MyGo socket 中重启后读回实际记录，预设像素由 `#465265` 变为 `#57657c`，两种自动堆叠均为一组两张，三张原件逐字节一致。其他平台该脚本使用临时会话，不声称其重启持久性。缩短临时前缀以适应标准 macOS socket 路径，最终脚本在 Windows 再次通过。

  新 Windows MyGo 包及安装包构建成功，八组原生套件全部通过，包含独立 ExifTool 校验、真实外部编辑器进程、相机模拟器、审阅服务、迁移与合并／RAW 集成；各自既有边界保持不变。完整 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` **351/351、零失败、零跳过**，约 251.1 秒，使用被动视频诊断。新增启动失败诊断的 4 项受控 HTTP 测试另复核通过；保留错误、隔离进程和清理行为见[启动记录](../research/native-startup.md)。日志为忽略目录 `.workspace/organization-state-*`、`.workspace/native-organization-final.log`。本次新代码的远程三平台验证另行跟进。

- **`0c030e5` 三平台终态**。[Actions 42105066362](https://github.com/stvlynn/OpenLR/actions/runs/42105066362) 首次执行全部成功：Windows 浏览器 339/347、8 项可选资源跳过、0 失败；三平台七组原生套件及打包均完成。Windows 的 Photos 截图为 1028×749，导航文字亮像素打开 726、关闭 0。本结果对应面板修复，不包含随后新增的第八组整理套件或启动诊断，也不解释此前 `3163f36` 的启动超时。

- **面板 GUI／CLI 一致性（2026-11-06）**。21 项定向检查通过，覆盖 20 个折叠面板及 Photos 导航的稳定名称、显式开关／队列切换、完整与摘要状态、真实鼠标／Enter／空格、单次通知、带计数的 Filters、Photo 菜单自动关闭、隐藏的 inspector 重新显示，以及画面像素／裁剪草稿／编辑与原件保持。Windows／Node 24.9／Chrome 156 完整 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` **347/347 通过、零失败、零跳过**，约 264.2 秒，继续使用被动视频诊断。新的 Windows MyGo 完整安装包通过主原生 smoke（WebView2 156.0.4314.58）：实际 CLI、`watch`、状态及截图均验证；解码截图为 1783×1154，Photos 导航文字区域的亮像素打开为 1,529、关闭为 0。该运行还通过独立 ExifTool 30 文件检查。首次安装包构建因受限 DNS 无法下载 NSIS，授权网络后的完整构建成功；首次原生检查用了错误的测试筛选枚举 `edited`，改为现有合法值 `yes` 后全程通过。没有因此修改产品筛选规则、超时或重试。日志 `.workspace/panel-state-*`。本项为本地 Windows 主原生流程，不冒充远程三端或其他六组原生套件。

- **`3163f36` 远程启动失败边界**。[Actions 42103142177](https://github.com/stvlynn/OpenLR/actions/runs/42103142177) 首次执行 Linux、macOS Intel 成功；Windows 浏览器 338/346 通过、8 项可选资源跳过、0 失败，安装包构建成功。Windows 原生主流程在首次 `state --summary true --timeout 30` 请求超时，位置为该提交的 `scripts/native-smoke.mjs:429`，尚未开始导入照片或白平衡测试。现有日志不能确认 WebView/页面/桥接的具体停顿位置，不能称作白平衡算法失败或已被面板修改修复。保留 `.workspace/crop-white-balance-ci-windows.log`，继续调查启动证据；不通过增大超时或盲目重跑消除失败记录。

- **裁剪捕获与白平衡归属（2026-11-06）**。裁剪／构图定向 6/6 通过；同一捕获回归使用 `ca1299b` 旧模块时失败，确认能检出草稿未恢复。白平衡及相关屏幕取样／光学定向 8/8，通过最终独立 2/2 核对 5×5 混合色块计算、真实点击、变换坐标、排队换照片及同照片重绘、撤销／重载、预览／PNG 导出与原件。重新构建的 Windows MyGo 包通过主原生 smoke：白平衡两种坐标命令返回相同 Temperature/Tint 和预览像素，保护过期照片、返回实际 PNG 截图并正确撤销。Windows／Node 24.9／Chrome 156 的完整 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 为 **346/346、零失败、零跳过**，约 242.5 秒，启用既有被动视频诊断；通过不代表已修复偶发视频导入故障。日志为忽略目录 `.workspace/crop-white-balance-full.log` 与 `.workspace/white-balance-*`。本项原生验证不是七组全套，也不是后续修改的远程三平台结果。

- **`ca1299b` 三平台与独立 CLI 交付**。[Actions 42099315887](https://github.com/stvlynn/OpenLR/actions/runs/42099315887) 首次执行三平台全部成功；Windows 浏览器 335 通过、8 项可选资源跳过、0 失败，共 343 项。另从该提交的全新受跟踪归档构建 Windows 包，将单文件 CLI 单独复制到项目外目录，实际连接 GUI，独立解码预览与导出像素并验证截图、撤销和原件字节一致；精确范围见[交付记录](delivery-review.md#windows-standalone-package-verification)。这份归档不包含随后的裁剪／白平衡修复。

- **共用屏幕取色（2026-11-06）**。新 `point-sample` 与真实 GUI 点击均在 100% Linear 预览中保存 `#ff0000`，同时既有 `sample-color` 保持缩小读取 `#bc0000`；受控真实缩略图保存期间的旧画面点击，修复前写入过期色样，修复后拒绝且仅保留原定编辑。新增 Chrome 两项及既有 point/range/optics 九项通过；完整运行 **343/343 通过、无跳过**，约 239.2 秒，仍带被动视频诊断 preload。新 Windows MyGo 构建和主原生 smoke 通过实际 CLI 取色 `#5a85b0`、照片保护、选中项、PNG 截图和撤销。另有两帧真实 VP9 暂停视频观察，边界见[取色研究](../research/point-color-selection.md#display-sampling-follow-up-2026-11-06)。初次沙箱浏览器运行被 loopback 网络限制阻止，放行本地验证后执行成功；没有伪称该初次运行通过。日志 `.workspace/point-sampling-*`，该新提交远程三平台结果尚未产生。

- **`ce20ab4` 三平台验收终态**。[Actions 42097263586](https://github.com/stvlynn/OpenLR/actions/runs/42097263586) 首次执行全部成功，Windows 浏览器 333 通过、8 项可选资源跳过、0 失败，共 341 项，三个平台完成原生套件和打包。本项覆盖裁剪原图对比与统一 Grid 放映退出，不包含随后的屏幕取色改动。

- **`a84b5b5` 三平台验收终态**。[Actions 42095718221](https://github.com/stvlynn/OpenLR/actions/runs/42095718221) 首次执行全部成功，Windows 浏览器 331 通过、8 项可选资源跳过、0 失败，共 339 项；三个平台完成原生套件和打包。这是颜色分级连续输入修复的远程结果，不覆盖后续裁剪／放映或屏幕取色改动。先前 `a70cb9b` 的失败记录仍用于保留修复前证据。

- **裁剪对比与统一 Grid 放映退出（2026-11-06）**。`tests/compare-crop.test.js` 在旧代码上分别复现 Original／Linear 显示原图时仍出现编辑后的白色像素，修正后两项通过；核对实际 canvas 原始颜色／比例、草稿清除、已保存 crop、处理版本、原件字节、撤销／重做和重启。扩展放映测试先复现布局入口未停止，再验证布局、scope、空搜索及退出后定时器不再切图。完整 Chrome **341/341 通过、无跳过**，保留被动视频诊断 preload；新 Windows 构建及主原生 smoke 通过，包含实际 CLI 裁剪对比和布局退出放映。视频未复现不代表其间歇失败已修复。日志 `.workspace/display-transition-*`、`.workspace/display-transitions-*`；当前提交尚无新的远程三平台结果。

- **颜色分级连续数值输入（2026-11-06）**。原先两个受控保存时序及无关更新测试均复现丢失输入；修复后定向 13/13 通过，最终中性更新清理后再核对 10/10。消融八例确认草稿保护和字段更新缺一不可，见[控制审计](../research/cli-control-audit.md#sequential-grading-input-follow-up)。完整实际 Chrome 运行 **339/339 通过、无跳过**，约 375.5 秒；本次通过忽略目录的被动视频诊断 preload 执行，保持原 bitmap 调用与返回 promise，不能作为未加诊断的性能结果。新 Windows MyGo 构建和主原生 smoke 通过，新增实际 CLI `grading-set --patch`、同字段冲突拒绝和两步撤销检查。日志 `.workspace/grading-input-*`、`.workspace/grading-full-instrumented.log`。其余六组本地原生套件未重跑；该修复的新提交尚无远程三平台结果。

- **`535d0f5` 三平台验收终态**。[Actions 42093258967](https://github.com/stvlynn/OpenLR/actions/runs/42093258967) 首次执行全部成功，Windows 浏览器 325 通过、8 项可选资源跳过、0 失败，共 333 项；Windows、Linux、macOS Intel 完成原生套件和打包。本项代码包含 clipping 状态与放映退出修正，尚不包含后续颜色分级输入竞争修复。它不能推翻 `a70cb9b` 的分级失败或上一轮本地视频导入失败；两者的证据仍保留。

- **显示状态与放映退出（2026-11-06）**。新增 Chrome 检查验证 clipping 的完整／摘要状态、实际红蓝提示像素、导出不带提示、真实按钮／快捷键和取色器清理；放映测试在旧代码上复现 Grid 仍保持播放，修正后验证 GUI Escape、命令切换、再次播放和停止后的定时器行为。新 Windows 构建及主原生 smoke 通过，包含实际 CLI 状态读回和退出放映。完整浏览器运行 **333 项，332 通过、1 失败、无跳过**：失败为混合媒体批量导出测试在视频导入时收到 `createImageBitmap` 不可用源错误，见[调查记录](../research/video-poster-failure.md)。本次新增两项及颜色分级测试通过；不能将这次完整运行称为全绿。日志 `.workspace/display-state-*`。

- **`a70cb9b` 远程失败记录**。[Actions 42091276291](https://github.com/stvlynn/OpenLR/actions/runs/42091276291) 首次执行 Linux、macOS 原生成功；Windows 浏览器 322 通过、1 失败、8 跳过，共 331 项，未进入原生构建。颜色分级测试在连续修改 Balance／Blending 后等待最终值超时。控制实际存储完成时机的 Chrome 调查已复现第二次旧状态提交被拒绝和未提交文本被重绘覆盖两条路径；远程日志不能区分当时是哪条。本项没有通过重跑或增加超时宣称修复。

- **无源修正时的重复扫描（2026-11-06）**。`tests/source-preparation.test.js` 的 10 项检查核对无修正、空列表、显式中性配方、四类单独／组合修正，以及坏浮点样本和尺寸错误；实际准备与渲染结果逐样本对照显式阶段组合，原始缓冲区保持不变。完整浏览器 **331/331 通过、无跳过**，约 253.6 秒；新 Windows MyGo 构建和主原生 smoke 通过。24MP 对照保留完整输出一致性，但只观察到首次主线程停顿减少，总完成时间没有改善，详见[性能记录](dehaze-performance.md#empty-linear-source-corrections-2026-11-06)。日志位于忽略目录 `.workspace/source-preparation-*`。本项尚不包含新提交的远程三平台结果。

- **`daf0a11` 三平台验收终态**。[Actions 42088804293](https://github.com/stvlynn/OpenLR/actions/runs/42088804293) 首次执行全部成功，Windows 浏览器 313 通过、8 项可选资源跳过、0 失败，共 321 项；Windows、Linux、macOS Intel 完成实际原生套件、打包及产物上传。此结果覆盖共享 sRGB 字节编码器，不包含随后进行的空源修正扫描优化。

- **实际 sRGB 字节编码器（2026-11-06）**。消融选定的 20 位 Float32 索引方案已接入共享 `linearFrameToRgba8`，量化边界仍调用原标量曲线；未修改浮点渲染、目标色彩空间导出或源 alpha。独立标量测试覆盖全部 255 个字节分界及相邻 Float32、256 个区间中心、符号／HDR／次正规数、读取器舍入与非有限值、切片哨兵及既有验证错误。Chrome 实际编码 Worker 的全部源分辨率字节与标量结果相等，取消／重试／显式启动回退也通过；观察器首次不兼容 Blob URL 导致测试交接观察失败，修正测试后定向 5/5。完整浏览器 **321/321 通过，无跳过**，约 238.7 秒；新 Windows MyGo 构建通过主原生 smoke。Original／Linear 的实际 24MP 渲染对照全像素一致，具体延迟与首次阻塞恶化见[性能记录](dehaze-performance.md#production-byte-encoding-2026-11-06)。本项不声称尚未运行的新提交远程三平台验收，也不将 Chrome 延迟推广到其他引擎。日志为忽略目录 `.workspace/srgb-production-*`。

- **`9e623b5` 三平台验收终态**。[Actions 42083004415](https://github.com/stvlynn/OpenLR/actions/runs/42083004415) 首次执行全部成功：Windows 浏览器 310 通过、8 项可选资源跳过、0 失败，共 318 项；Windows、macOS Intel、Linux 完成打包、七组原生套件和产物上传。Linux 曾长时间停留在系统依赖安装，之后在同一作业继续执行并成功；没有因观察等待重启任务。该结果覆盖局部创建完成状态一致性修正，不包括尚未进入生产的 [sRGB 编码实验](../research/srgb-byte-encoding.md)。

- **局部创建完成状态一致性（2026-11-06）**。`tests/local-postcommit.test.js` 先复现直接 `repair.add` 返回未选中新修复，再复现直接 `ai-mask` 保留 Brush 模式。修正后定向五项通过；完整浏览器 **318/318 通过、无跳过**，约 237.7 秒。新测试检查命令返回、变更事件发生瞬间的下拉控件、真实鼠标修复、GUI／直接命令调用的 Person 模型推理、模式／选中项／覆盖层／面板／光标一致性。Windows MyGo 新构建的主原生 smoke 通过，新增实际 CLI 断言确认 AI 从 Brush 转到 Off、修复创建立即选中新对象、撤销恢复原配方。忽略日志为 `.workspace/local-postcommit-*`；其他平台和其他六组原生套件未在本地重复执行，本项不沿用 `a05a501` 的远程成功结论。

- **修复源三平台验收终态**。`a05a501` 的 [Actions 42080915924](https://github.com/stvlynn/OpenLR/actions/runs/42080915924) 首次执行全部成功：Windows 浏览器 309 通过、8 项可选资源跳过、0 失败，共 317 项；Windows／Linux／macOS Intel 完成打包和七组原生套件。Windows 日志明确包含修复源状态、照片守卫、取消、PNG 截图与配方不变断言。该结果不覆盖之后的创建完成状态一致性修正。

- **修复源会话（2026-11-06）**。新增 `repair-source` 将 Clone/Heal 的源点、选择源按钮和 Alt 点击接入共享分发器，完整／摘要状态均可读取。`tests/repair-source-session.test.js` 实际验证通知与只读查询、GUI／CLI／输入焦点下 Escape 取消、过期照片／无效坐标拒绝、修改源点取消未完成笔画、克隆配方和红色目标像素、撤销及视图／照片切换清理。首次全量测试发现新命令缺少嵌套坐标校验；已复用 `validateLocalChanges`，并将互斥参数校验放入协议层。修正后完整浏览器 **317/317 通过，无跳过**，约 258.6 秒。Windows MyGo 明确输出至 `build/release/windows-amd64` 后，主原生 smoke 通过实际源点／选择器状态、拒绝过期照片、取消、PNG 截图及配方不变。第一次修正后原生测试误用异步异常断言处理 CLI 同步校验错误；改为同步断言后同一产物通过，未修改应用行为。日志为忽略目录 `.workspace/repair-source-*`；本项不把前一提交的三平台结果转记为当前提交验收。

- **`38f35af` 远程验收终态**。[同一次 Actions](https://github.com/stvlynn/OpenLR/actions/runs/42073613235) 第二次尝试已全部成功：Windows 浏览器 308 通过、8 项可选资源跳过、0 失败，共 316 项；Windows、Linux、macOS Intel 均完成打包、七组原生套件及产物上传，包含新增拉直 CLI 状态／取消验证。首次视频导入失败与本地 125 次未复现实验见[调查记录](../research/video-poster-failure.md)。未修改应用代码、测试断言或超时后仅重跑失败 Windows 作业；成功重跑不代表视频问题根因已确定。以下进度段保留首轮证据，已由本终态更新。

- **`38f35af` 远程验收进度**。[Actions 42073613235](https://github.com/stvlynn/OpenLR/actions/runs/42073613235) 的 Linux 构建及七组原生套件通过；Windows 浏览器套件为 307 通过、1 失败、8 跳过，新增拉直测试通过。失败在 `export-previous-workflow.test.js` 的视频导入，返回 `createImageBitmap` 图像源不可用，尚未证明根因；本地独立执行该文件 4/4 通过。没有提高超时、改变断言或添加推测性的解码重试。源码已经等待 `loadeddata`；Context7 的 HTMLMediaElement 就绪状态资料不能解释该次失败的实际浏览器状态。macOS 原生套件在本次记录时仍运行，未计为通过。Windows 单作业重跑请求被 GitHub 拒绝；整轮终态和后续失败作业复查仍待完成。日志保存在忽略目录 `.workspace/straighten-*`。

- **拉直参考会话（2026-11-06）**。`tests/straighten-session.test.js` 用真实 Chrome 核对首点的 full/summary 回读及变更通知、输入焦点下 Escape、按钮与带照片身份的 CLI 取消、过期请求拒绝、退出视图、重新拉直和撤销；几何相关定向测试 8/8，通过后完整浏览器回归 316/316，无失败或跳过，约 210 秒。Windows 本次 MyGo 构建的 `build/windows-amd64/OpenLR.exe` 通过主原生 smoke，包括实际 CLI 状态、取消、PNG 截图和配方不变。首次原生命令误用了较旧的 `build/release` 产物，因不认识新增 `photoId` 参数而失败；核对构建路径和时间后改用实际新产物通过，未将旧产物失败当作功能通过。本项不声称原生鼠标手势或本次其他六组原生套件已在本地重跑；公开 Actions 的旧版本结果仍保留独立版本边界。

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

2026-11-05 点／通道曲线补充：在 REA 资源与有限 Lua 常量核对、Context7 原始文档和可复现线性／PCHIP 消融之后，新增 RGB 主曲线及独立红绿蓝通道。共享领域验证与插值供图形、字节渲染和连续浮点渲染使用，旧三滑块和历史配方保持原计算。图形／数值／键盘与 CLI 共同进入 `curve-channel`、`curve-select`、`curve-set`；拖动实时预览，完成后一次保存／撤销，取消恢复，来源和通道旧值保护在保存前生效。合同及 HDR 延伸边界见[点曲线](tone-curves.md)和[决策 017](decisions/017-point-tone-curves.md)。

四项领域测试和三项实际浏览器工作流验证节点、非单调形状、极近输入位置、恒等、主／通道顺序、负值和 HDR、alpha／原件不变；实际鼠标增删拖动、方向键与 Escape、拖动中照片像素变化但配方未变、取消恢复、换照片及并发通道编辑后旧草稿不覆盖。两种处理版本的 PNG 导出对生成色块检查红通道约 77、绿 96、蓝 128；曲线经过预设、版本、OpenLR XMP、选择性复制、重载后保持。1024×768 图形面板截图已检查，完整操作区域无横向溢出。早期测试坐标在滚动区域外及导入后切回 Grid 的夹具安排已修正，未将这些测试同步问题记作产品缺陷。

两项额外实际 Chrome 边界测试使用真实 IndexedDB 和注入的同步／本地适配器，验证损坏 XMP、存储预设、远端照片／版本／预设在写入或下载前拒绝。审查发现无效本地侧车可使新曲线面板阻断图库绘制，以及历史 null 配方被误拒绝；修复后保留既有可见错误，禁用该曲线面板和编辑，图库／筛选仍可使用，无副作用写入，历史 null 继续视为空配方。此适配器注入不是物理文件系统证据。

修复后的 Windows／Node 24.9／Chrome 156.0.8078.80 全量 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 为 **286/286、零跳过**。最终代码格式和 CLI dry-run 通过。Windows 与 Linux 实际 Local 原生检查另行读取生成的 `.openlr.json`，检查当前曲线及命名版本，并重启应用、重新打开目录后验证二者仍在；原件逐字节不变。Linux 这项补充检查在全套运行后以更新后的测试脚本再次独立执行，通过。文件夹许可由夹具预置，未操作系统目录选择器。

最终 Windows WebView2 与 WSL Ubuntu 24.04／WebKitGTK 2.52.6 均已重新构建并通过各七组原生套件，Windows 安装包生成成功。新增 native smoke 对两种处理版本的实际 TIFF 解码检查通道像素，验证来源／通道旧值拒绝、CLI 通道与选点状态、真实 PNG 工作区截图、撤销及原件保持。Linux 仍是 Xvfb／D-Bus 原生 GTK/WebKit 与 IPC 验收，不代表物理 GPU／显示器；相机仍为模拟器、迁移仍为合成 schema。macOS 必须对应实际运行，不能以这两端替代；上一个实现提交 `ecef1f4` 的 [42024891353](https://github.com/stvlynn/OpenLR/actions/runs/42024891353) 因账户付款／额度没有执行任何作业步骤。


2026-11-05 颜色分级补充：基于已记录的 REA 资源／控制器常量与本机 Lightroom 三色轮、单区和全局面板观察，结合 Context7／原始项目文档及零亮度色偏／平滑权重消融，独立实现 `colorGrading`。旧配方不变；三色轮、单区／全局、亮度、混合和平衡支持数值、键盘、拖动预览、一次提交／撤销和取消。图形与 CLI 共用 `grading-mode`、`grading-set`，当前照片和旧分级值保护在保存前检查。曲线和分级复用同一带照片／配方关联的临时预览适配器。规则、精度与输出边界见[颜色分级](color-grading.md)和[决策 018](decisions/018-color-grading.md)。

Windows／Node 24.9／Chrome 156.0.8078.80 最终 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 为 **295/295、零失败、零跳过**。新增四项领域测试、三项实际浏览器工作流和两项复用既有传输测试框架的分级边界检查。覆盖明暗权重／连续性、色偏线性亮度守恒、亮度增益、负值／HDR、alpha／原件保持；拖动时照片像素变化但配方不变、取消／换照片保护、数值／键盘／模式／重置；两种处理版本实际 PNG 像素；预设、命名版本、XMP、选择性复制及重载。真实 IndexedDB 配合注入同步／本地适配器验证无效分级在写入前拒绝，错误侧车不破坏图库／筛选也不能被覆盖；该注入检查不等于物理磁盘验收。

1024×768 实际面板截图检查通过，无横向溢出。现有公共领域 NASA astronaut 夹具与生成的渐变／原色色块，经实际 dispatcher 在两种处理版本导出 PNG 后制作联系表检查。温和配方下肤色略暖、暗部略冷，未见明显色调突变或细节丢失；渐变最大相邻通道差 2/255，黑色精确保持零。饱和原色表现出预期的输出裁切与原色相变化，因此不声称输出后亮度守恒或感知均匀性。完整配方与数值见[研究](../research/color-grading.md)。未使用私人照片。

最终 Windows WebView2 与 WSL Ubuntu 24.04／WebKitGTK 2.52.6 均重新构建并通过各七组原生套件，Windows 安装包成功生成。新增原生检查通过实际 CLI 与窗口截图读取模式，并独立解码两种处理版本的 TIFF，验证分级亮度增益、过期来源／分级旧值拒绝、撤销和原件逐字节保持。实际 Local 侧车检查同时读回当前分级及命名版本，重启应用／重新打开目录后仍保持。文件夹许可仍由测试夹具预置；Linux 使用 Xvfb／D-Bus，未证明系统选择器、物理显示器或 GPU；相机为模拟器，迁移为合成 schema。macOS 仍需真实远程执行；前一实现提交 `3c50489` 的 [42029595968](https://github.com/stvlynn/OpenLR/actions/runs/42029595968) 因账户付款／额度三个作业均未执行步骤，不能计为通过。

颜色分级提交 `60d21ce` 推送后确认仓库仍为 private。最新 [CI 42032635421](https://github.com/stvlynn/OpenLR/actions/runs/42032635421) 的 Windows、Ubuntu 和 macOS 作业步骤数均为零；macOS check-run `127262648812` 注明账户付款失败或支出限额需要调整。该运行未提供任何平台执行证据，不改变本地两端已通过、当前 macOS 尚未验证的结论。


2026-11-05 去雾功能与精确优化：在已记录的本机 Dehaze 控件证据、原始论文／Context7 文档及独立消融之后，实现源图尺度的暗通道、空气光、加权引导透射率与共享线性重建。正值去雾、负值加雾，Effects 滑块和 `edit --key Dehaze` 共用现有配方、历史、预设、版本、XMP 和复制路径；无额外文件大小门禁。零值保持旧渲染。见[去雾合同](dehaze.md)、[决策 019](decisions/019-dehaze.md)。

Windows／Node 24.9／Chrome 156.0.8078.80 的 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 通过 **302/302、零失败、零跳过**。四项领域测试用独立朴素窗口参考核验透射率、空气光、透明污染、负值／HDR、极小 alpha、恒等与溢出错误；两项真实浏览器测试核验两种处理版本的正负像素、裁剪／缩放输出、光学编辑缓存失效、键盘／撤销、预设／版本／XMP／选择复制／重载与原件。另有 192 组合的融合几何逐位比较，覆盖四种强度、裁剪、旋转、翻转、输出尺寸和混合 alpha／负值／HDR；结果与完整 Float32 重建后再变换完全一致。

最终 Windows WebView2 与 WSL Ubuntu 24.04／WebKitGTK 2.52.6 均已重新构建并通过各七组原生套件。Windows 安装包成功生成。新增原生检查独立解码两种处理版本 TIFF 的去雾／加雾结果，检查真实窗口截图、撤销及原件逐字节保持；实际 Local `.openlr.json` 当前配方和命名版本均保存 Dehaze，重启／重新打开后仍在。Linux 使用 Xvfb／D-Bus；目录权限由夹具预置、相机为模拟器、迁移为合成 schema，不扩大为物理设备或系统选择器验收。当前 macOS 仍需实际远程执行。

此轮功能测试通过**不代表大图交互完成**。24MP 精确分析的流式统计与融合重建，把 Linear 首次预览从约 22.12 秒降至 7.02 秒、缓存调节从约 1.14 秒降至 .40 秒；Original Chrome 首次 9.76 秒、缓存约 2.10 秒，仍同步阻塞。详细机器、内存、测量范围及未完成项见[性能记录](dehaze-performance.md)。固定 512／1024／2048 RGB 分析图因丢失暗点线索、产生明显重建误差而被[消融实验](../research/dehaze-scale.md)拒绝，未用降低质量掩盖延迟。[后台处理提案](../research/dehaze-background.md)记录下一步的共享 worker、所有权与验收要求，目前尚未实现。

公共领域 astronaut、生成雾场和明亮无雾渐变已通过实际 dispatcher 导出后目视检查，两种处理版本全部六项重置均恢复原像素。高强度会使明亮无雾场景过暗并放大量化条带；这是已保留的负面结果，不声称自动识别雾、无光晕或普遍改善。代码格式、CLI 合法值 dry-run 和越界拒绝亦已执行。


2026-11-05 去雾后台传输基础：共享 `runImageWorker` 新增可选 AbortSignal，排队取消释放消息引用、握手前取消保留待转移缓冲区、运行中取消终止 worker；已启动的异步兼容回退保留队列占位直至实际结束，避免重叠图像堆。新增去雾 worker／owned-frame 客户端仅调用既有精确算法，使用双向 transfer list，不传走缓存原件。此步未接入应用 renderer，不能声称已消除既有大图阻塞。

真实 Chrome 新增两项测试验证排队／握手前／运行中／预先取消、队列恢复、无意外回退、异步回退占位；去雾 worker 与同步空气光／透射率逐值相同，返回源样本不变，单独保留的原件仍附着，取消后重试成功。2048×1536 的一次分析约 823ms，10ms 主线程心跳触发 82 次；这是适配器事件循环证据，不是原生 GUI 或 24MP 完整工作流证明。启动失败仍调用同一算法，已有实际 RAW／编解码器 fallback 测试通过。

Windows／Node 24.9／Chrome 156.0.8078.80 的最终 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 为 **304/304、零失败、零跳过**。格式和 diff 检查通过。本步未重跑原生平台套件；应用级分析缓存、预览／导出接入及来源取消仍待实现。[后台提案](../research/dehaze-background.md)明确该边界及后续验收。


2026-11-05 去雾后台分析接入：生产预览、缩略图、直出／沿用设置／批量导出、导入／迁移／同步／Local、增强／分享以及视频导出均经共享准备后调用原渲染函数。相同源图／前置配方共享 pending 分析，取消草稿仅释放自己的使用权；编辑保存／导出等显式消费者仍可等待同一结果。负值转正值升级不会传走已发布快照的缓冲区。照片、配方或显示请求变化后，旧结果不能发布；Local 缩略图在等待后重新检查目录代际和配方。批量取消沿用原 signal reason 和已完成文件语义。同步数值 API 与明确记录的 startup fallback 仍存在，不引入第二套图像算法。

Windows／Node 24.9／Chrome 156.0.8078.80 的完整 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 为 **306/306、零失败、零跳过**。随后扩充同一后台专项文件，最终 **3/3** 通过：共享任务与独立取消、失败后重试、负正升级的快照保持、交叠源校正版本、可变画布更新、实际 photo-export 取消原因；实际滑块连续草稿／提交仅一次分析与一次撤销、换照片无旧画面覆盖；Local 后台缩略图取消后不发布旧尺寸／像素，重新打开可成功。Local 测试用实际浏览器 worker 和注入文件适配器，不冒充物理文件系统验收。该新增目录取消用例在完整 306 项运行之后单独执行，未把完整命令计数改写为 307。

最终 Windows WebView2 与 WSL Ubuntu 24.04／WebKitGTK 2.52.6 均重新构建并通过各七组原生套件；Windows 安装包生成成功。新增 native smoke 明确检查没有 `dehaze-worker.js` startup fallback，再核验两种处理版本 TIFF、捕获、撤销与原件。Windows 七组运行包含此断言；Linux 在七组完成后使用更新脚本额外运行 native smoke，通过无回退断言。Local 侧车／版本重启保持，其他已有原生工作流继续通过。目录选择器未自动化、相机仍为模拟器、迁移仍是合成 schema；Linux 是 Xvfb／D-Bus 原生 IPC，不扩展为物理 GPU／显示器性能证据。macOS 仍需对应真实执行。

24MP 集成后的浏览器单次测量：Linear 首次 6.061s，10ms 心跳 533 次、最大间隔 .413s，缓存约 .302/.293s；Original 首次 9.079s，心跳 569 次、最大间隔 1.795s，缓存约 1.780/1.659s。分析阶段已后台化，但源图转换和最终重建／编码仍同步，不能声称整条交互链路流畅。完整协议、进程内存与限制见[性能记录](dehaze-performance.md)。未采用已被质量实验否定的降分辨率分析。

2026-11-05 Original 后台重建／编码补充：生产 `renderPrepared` 在既有串行 worker 队列中执行共享去雾像素映射与 sRGB 字节转换。源图和透射图只在任务实际开始时复制，排队取消不分配大图副本，已发布缓存保持可读；返回 RGBA 后仍使用原几何和颜色处理。Linear 浮点路径保持原有重建方式。真实 Chrome 测试验证正负强度、负值／HDR／alpha 输入、裁剪／旋转／曝光后的完整像素一致，活动转换取消、原图与缓存保留、启动回退及重试。既有拖动、换图、Local 目录取消和实际导出检查继续通过。

Windows／Node 24.9／Chrome 156.0.8078.80 全量 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 完成 **309/309，零失败、零跳过**。Windows WebView2 和 WSL Ubuntu 24.04／WebKitGTK 2.52.6 均完成重新构建及各七组原生套件；Windows 安装包生成成功。更新后的原生断言同时检查分析与 Original 编码 worker 没有启动回退，实际 TIFF 像素、CLI 截图、撤销、侧车重启及原件保持检查通过。Linux 仍使用 Xvfb／D-Bus，物理 GPU、系统选择器、真实相机及真实外部目录的既有限制不变。

集成后 24MP Original 缓存调整耗时仍约 1.683/1.696s，主线程最大心跳间隔降到 81/85ms；首次源转换仍阻塞约 1.717s。单次活动渲染进程峰值从先前约 1.195GB 增至 1.572GB，保留为实际代价，详见[性能记录](dehaze-performance.md)。macOS 本轮未执行；`51508cf` 的 [CI 42043897131](https://github.com/stvlynn/OpenLR/actions/runs/42043897131) 三个作业均为零步骤，macOS 注释明确报告账户付款／额度问题，不记作代码测试失败或验收通过。

2026-11-05 视口 CLI 补充：[命令／控件审计](../research/cli-control-audit.md)发现放大后的照片只能由用户滚动，agent 无法读取或移动相同视口。新增 `viewport` 通过中央 dispatcher 使用原 DOM 滚动位置，返回实际坐标、尺寸与边界；完整／摘要 state 同步报告，鼠标滚动通知现有 watch。照片配方、缩放和输出范围不变，未新增界面控件。

Windows／Node 24.9／Chrome 156 全量 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 为 **310/310、零跳过**；新增测试后续仅做格式修正，单项实际浏览器复核通过。测试包含发现／dry-run、参数边界、实际鼠标滚动、state、过期照片拒绝、边界与未提供轴保持、配方保持和 Grid 拒绝。Windows WebView2 与 WSL Ubuntu 24.04／WebKitGTK 2.52.6 均重新构建并通过 `scripts/native-smoke.mjs`，实际 CLI 滚动、PNG 工作区截图、原件逐字节保持通过。本轮运行的是两端主原生 smoke，不重述为七组全套；上一轮七组结果另见上文。

首次原生脚本因新增变量重名在启动前报语法错误，修复后运行；Windows 首次实际执行发现 CSSOM 整数宽度与 DPI 下小数滚动终点相差约 .6 CSS 像素。断言依据整数 extent／小数 offset 的 API 语义改为最多 1px 取整差，并额外验证请求更远坐标仍停在同一终点，复跑通过；生产代码未为测试伪造滚动值。Linux 原断言即通过。当前 macOS、完整模块命令覆盖与最终干净检出验收仍未完成。

2026-11-05 审阅面板补充：功能模块命令审计发现桌面共享审阅区域直接输出协议 JSON。现在按照片显示署名、评论、时间和点赞人数，内部标识不展示，CLI 数据字段保持不变。新增真实 Chrome dispatcher 测试使用明确注入的原生接口夹具，验证结构化返回、HTML 样式评论作为文字、照片分组、空／撤销状态及窄栏无横向溢出；**1/1 通过**，1024×768 截图已实际查看。没有把注入边界记作真实服务器证据。

Windows WebView2 和 WSL Ubuntu／WebKitGTK 均重新构建，并通过各自 `native-sharing-smoke.mjs`：仅本地独立服务器，实际发布编辑图、浏览器点赞／评论、GUI／CLI 回读、无权访问和撤销检查通过。Linux 首次单独调用时漏建服务可执行文件而等待超时；确认文件缺失且无遗留服务后执行 `go build -o build/openlr-share ./cmd/openlr-share`，复跑通过。此次没有重跑全量或七组原生套件，上一轮 310 项结果仍对应上一轮代码。当前 macOS与最终完整性限制不变。

2026-11-05 干净交付复现：仅将已提交的 `afbdcb8` 以 Git archive 导出到新目录，不复制未跟踪依赖、模型或生成文件。`npm ci`、Go test/vet、MyGo Windows 安装包构建、独立目录中打包 CLI 发现／dry-run、许可证与来源清单逐字节比对均通过。默认浏览器套件 **311 项中 304 通过、7 跳过、零失败**；跳过的模型和独立校验工具资源清单见[交付审查](delivery-review.md)。使用该快照新构建程序及 helper 的 Windows 七组原生套件全部通过。外部 Go 工具链／缓存及已安装 Chrome 属于明确的宿主前提；没有声称离线空缓存构建、二进制确定性、当前 macOS或无跳过全覆盖。

同一 `afbdcb8` 归档随后在新的 WSL Linux 目录复现：独立 `npm ci`、Go test／**race**／vet、MyGo Linux 打包，以及 Xvfb／D-Bus 下七组原生套件全部通过；独立 CLI 发现／dry-run 和包内许可证／来源清单比对通过。未复制旧 Linux 构建或 Windows 依赖。此次未运行 Linux 全量浏览器套件；ExifTool 可选原生 oracle 因未安装明确跳过，既有实际导出／回读仍执行。当前已核实的 [CI 42052317375](https://github.com/stvlynn/OpenLR/actions/runs/42052317375) 三端均零步骤，macOS 服务端注释仍为账户付款／额度限制，不能记作运行通过。

2026-11-05 字节源转换优化：24MP 消融发现重复计算 sRGB 转移函数占据主要前置时间。颜色模块现统一拥有 256 项 Float64 精确表，供 RGBA8 转浮点、字节渲染、局部处理、光学校正和输出空间转换复用，删除原有重复表生成。全部字节码、alpha、切片和原件保持检查与标量公式一致；没有改变全分辨率分析、连续浮点／HDR 公式或几何规则。

Windows／Node 24.9／Chrome 156 全量 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 完成 **312/312，零失败、零跳过**，包含独立 CMS／元数据校验。重新打包后的 Windows WebView2 与 WSL Linux WebKitGTK 各七组原生套件全部通过。单次集成测试首次最大主线程间隔从之前约 1.717s 降到 .657s，但总耗时仍为 8.830s，缓存完成时间本次更慢；完整负面结果及资源数据见[性能记录](dehaze-performance.md)，不声称整体吞吐或所有交互已改善。此前干净快照证据仍明确对应 `afbdcb8`，不冒充本轮新实现的独立快照验收。

2026-11-05 Original 去雾字节转换现由既有分析 worker 执行，主线程只交付独占的校正后 RGBA8。共享组合复用原转换与分析函数，启动兼容回退使用同一实现，已发布的线性缓存不被转移。新增实际 Chrome 测试验证正／负分析模式的全部样本和透射率、原件保持、启动回退、错误和重试。

本轮首次全量为 313 项中 312 通过、1 失败、零跳过：颜色分级手势测试等待条件超时，未启用去雾。原日志保留在忽略的 `.workspace/dehaze-byte-worker-full.log`。独立复跑颜色分级 **3/3** 通过；为共享等待助手加入原调用位置作为错误 cause 后，完整 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` 复跑 **313/313，零失败、零跳过**，约 194.4 秒。没有修改该手势测试、延长等待或削弱断言；首次超时未复现，根因尚未证实，不能把复跑通过称为已修复交互缺陷。复跑记录为 `.workspace/dehaze-byte-worker-full-recheck.log`。

Windows WebView2 与 WSL Ubuntu 24.04／WebKitGTK 2.52.6 均重新构建，七组原生套件分别全部通过，分析和 Original 编码 worker 没有启动回退。24MP 集成首帧约 8.059s、最长主线程间隔 .428s，缓存完成约 1.639/1.744s；[性能记录](dehaze-performance.md)保留资源代价与单次测量限制。仍不声称流畅拖动、当前 macOS 验收或覆盖本轮代码的干净快照交付。

2026-11-06 局部手势取消审计：真实 Chrome 复现 Escape 后残留草稿覆盖层；没有据此声称发生错误持久化。现由局部 UI 适配器统一清除草稿和指针捕获，Escape 与新增 `local-cancel` 共用 dispatcher；工具／视图切换、捕获丢失和 pointercancel 亦清理同一状态。命令可校验照片身份，取消不改变所选工具或已提交配方。

Windows／Node 24.9／Chrome 156 的 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` **314/314、零失败、零跳过**，约 231.9 秒。新增真实鼠标矩阵覆盖笔刷、线性／径向渐变、克隆／修复、保留输入焦点时 Escape、CLI 身份保护、实际 releasePointerCapture、注入 pointercancel、视图／工具／面板切换和取消后的正常绘制／撤销。首次测试误用 SVG path 定位，改为实际 image 覆盖层后才得到残留缺陷证据；捕获释放用例的指针记录改为捕获阶段，以免被已有 stopPropagation 隔断。生产逻辑未为测试延长等待或放宽断言。

Windows WebView2 和 WSL Ubuntu 24.04／WebKitGTK 2.52.6 均重新打包并通过各自 `native-smoke.mjs`，包含实际 CLI 空闲取消结果、所选工具保持，以及原有图像导出／观察／截图检查。本轮运行两端主 smoke，不冒称七组全套或原生鼠标手势已覆盖。Linux 首次同步命令因跨 shell 参数传递错误未进入构建，改为独立脚本后成功。最新核实的 [CI 42059549193](https://github.com/stvlynn/OpenLR/actions/runs/42059549193) 对应 `b9d4849`，三端作业均零步骤；macOS 注释仍为账户付款／额度问题。大图响应、完整交互覆盖和最终快照验收继续保留。

2026-11-06 Linear 去雾重建后台接入：将既有校正后浮点几何／颜色／空间处理抽取到 `frame-render.js`，同步 API、薄 worker 和启动回退共用同一函数。非零去雾的生产预览／浮点导出经既有队列执行，Original 与 Linear 共用入队执行时的快照复制逻辑；原件和已发布 source/map 保持附着，完成后继续检查取消及应用资产／配方身份。

Windows／Node 24.9／Chrome 156 的 `OPENLR_TEST_CMS=1 OPENLR_TEST_METADATA=1 npm test` **315/315、零失败、零跳过**，约 258.3 秒。新增实际 worker 检查完整 Float32 样本与预览字节、有符号／高亮／透明样本、负／正强度、几何和后续颜色效果、并发、运行中终止、重试与启动回退。零去雾路径也经抽取后的共享函数，已有完整回归覆盖其原行为。

重新打包的 Windows WebView2 和 WSL Ubuntu 24.04／WebKitGTK 2.52.6 均通过七组原生套件。主 smoke 独立检查分析、Original 编码和 Linear 重建 worker 均未启动回退，并验证两种处理版本的真实 TIFF 像素、撤销和原件保持；Local 侧车重启等既有套件亦通过。当前 macOS 未执行，本轮不是最终干净快照验收。24MP Linear 完整预览缓存最大间隔由约 .344/.353s 降至 .093/.099s，但首帧约 .467s 间隔未改善，活动渲染进程峰值从约 1.243GB 增至 1.591GB；[测量记录](dehaze-performance.md#linear-reconstruction-worker-2026-11-06)明确保留这些代价和单次实验限制。
