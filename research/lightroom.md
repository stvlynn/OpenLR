# 本机 Adobe Lightroom 调查与证据索引

调查日期：2026-11-05（Asia/Shanghai）。方法：REA 6.8.0 / reverse-engineer-anything skill v49，以及安装目录的只读资源检索。未上传或复制 Adobe 可执行文件、Lua 字节码、字体、图片、预设或模型到项目。

## 目标与边界

- 主目标：`C:/Program Files/Adobe/Adobe Lightroom CC/lightroom.exe`，Windows x86-64，PE32+，27,316,208 bytes。
- Windows 文件版本：`9.4`；ProductVersion：`9.4 (20260610-2051-a96e304)`；ProductName：Adobe Lightroom。
- EXE SHA-256：`02d95f07c18e3c932117af590f7b074c6a0c5cab4db4b4b7e717ddbc0eae7cf1`。
- 同机另有 Adobe Lightroom Classic；本报告不将 Classic 的行为混入 Lightroom 云版。
- 开始时 REA 没有活动二进制会话，retained evidence 为 0；没有可复用的当前 REA 记录。优先复用了本机安装资源，而非重新下载产品。
- 本轮没有启动 Lightroom、登录账户、导入用户照片、改动目录或执行网络捕获；以下是静态证据，不是实际点击后的运行观察。

## REA 证据账本

| 标识 | 操作、对象 | 观察和覆盖边界 |
| --- | --- | --- |
| R1 `ev_b95ac8eed4d87f5fc5c661b7f17cc4e7542aa25688ca56288715da4b3ade96fc` | `inspect_pe_resources`, lightroom.exe | 507 个资源目录项，247 个资源；资源树完整。Lua 等载荷保持不透明，仅记录名称、范围、摘要；不证明资源实际被执行。 |
| R2 `ev_a4d49195eff359706e8afa35f7305016e67f6580e9c4a4bbe9421846609e3774` | `inspect_desktop_application`, 安装根目录；`max_entries=15000`, `max_probe_bytes=16777216` | 实际检查 5,805 项、探测 45 文件、读 15,172 bytes；受 32 MiB 元数据表示预算限制，源扫描为 partial。没有候选运行时匹配不能证明不存在某运行时。 |
| R2 摘要 `ev_668b6885a0065f9ee5b8dfadd9c9ecb12c00705f51a2956e6d1df6cc70581790` | R2 的 retained summary | 摘要中的 5,804 文件条目视图已穷尽，仅代表此 retained view；不代表整个安装目录完整。目录摘要 `069b998e67d3751e84e6a6552b1b0eb45e9bad411571fe668bb51e5650e6ab42` 仅提交被检查元数据和已读范围。 |
| R3 `ev_cbea8addf38164e3b033afae01421e83a8ee34194c819f291be4525bd6f399e3` | `inspect_pe_resources`, Develop.lrmodule | 395 个目录项，195 个资源；资源树完整。文件 31,766,000 bytes，SHA-256 `6be2ee02ef6749458792e9ecb75c3f8762f33e7d576c2e8a676d222f8f0d5aae`。 |
| L1（本地资源观察，不是 REA Evidence ID） | `Resources/zh_cn/TranslatedStrings.txt` | 843,737 bytes，SHA-256 `99ef5188fd64ac4eb546a349290a84fecdd8cc4f4effcaa1f586a8793ec3ed34`。以下行号均指该本机文件；可通过 key 复查。翻译资源可能含共享、旧版或受开关控制的功能。 |
| L2（本地有限字节观察） | R1 的 `$NIMBUS$MENUS.LUA` 载荷 | 文件 offset 26,741,832，18,861 bytes；SHA-256 `ca61b211561f5b306f1a037cf996a9d46caa58e4ad221bb2368c4e5a66a4aec0`。首部为 `1b 4c 75 61 51`，与 Lua 5.1 字节码签名相符；只检索可打印常量，未反编译控制流。 |

REA 当前 Windows 原生 UI 观察工具 `observe_native_ui` / `capture_native_ui_scenario` 仅支持 macOS，本机不可用；Ghidra 未配置（`GHIDRA_INSTALL_DIR` 未设置）。本轮使用无需分析引擎的 target-free PE 解析器，没有安装软件或修改 REA 配置，也没有打开需要关闭的 native binary session。

## 功能入口与交互线索

以下“入口”是资源中可定位的命令/控件身份。除了资源本身的存在，交互效果需运行验证。

| 功能面 | 已观察的入口或文案 | 来源 | 能得出的结论 |
| --- | --- | --- | --- |
| 云端/本地照片 | `ag.organize.view.cloud`, `ag.organize.view.local`, `ag.file.addAssetsToCloud` | L2 | 菜单常量存在两个浏览入口和添加到云端命令；账户、同步及离线行为未知。 |
| 添加照片 | `Application/Menu/File/AddPhotos`，界面文字“添加照片”；另有 `Organize/Panel/ImportButtonTitlePhotos` | L1:2519、8503 | 存在菜单及面板按钮文案；导入去重、RAW 支持和写入路径未测。 |
| 相册组织 | `CollectionsPanel/ContextMenu/CreateAlbum`、`AddPhotosToAlbum` | L1:3754、3766 | 存在创建相册及加入相册命令文案；不是实际目录写入记录。 |
| 网格/详情/编辑 | `Organize/KeyboardShortcut/GridView=g`, `Detail=d`, `Edit=e` | L1:8127–8139 | 可据此建立视图与编辑模式的设计入口；不证明当前 Windows 快捷键映射已启用。 |
| 评级与旗标 | 星级 0–5；pick `z`，reject `x`，移除旗标 `u`；Shift 组合的 AndMove 项 | L1:8131–8135、8164–8176 | 常量表明确区分评级、留用、排除和下一张动作。不要误用共享 AgLibrary 文案中的 `p` 作为云版唯一留用键。 |
| 胶片窗格 | `Application/Menu/Panels/ShowFilmstrip`、`/Key=F6` | L1:2560–2561 | 胶片窗格可切换入口有资源支持；其默认位置、尺寸未知。 |
| 原图/效果比较 | `Organize/CompareView/Onboarding/BeforeAfter/message` | L1:6736–6737 | 文案描述选择图像后并排查看原始与编辑版本。此处是产品内提示，不是本轮运行测量。 |
| 光线调整 | 曝光、对比度、高光、阴影、白色色阶、黑色色阶及直方图区间 | L1:476、498、526、557、818–822 | 支持基础光线控件与直方图的概念；数值范围、曲线、色彩运算未逆向。 |
| 颜色调整 | 白平衡、色温/色调、中性色吸管；混色器 H/S/L；颜色分级的阴影/中间调/高光/全局 | L1:568、579–580、7006–7029、7236 | 文案支持白平衡、HSL 和分级面板；不能据此断言 Adobe 像素管线实现。 |
| 点颜色 | `DEVELOPPOINTCOLORCONTROLLER.LUA`、`DEVELOPPOINTCOLOROVERLAY.LUA`；采样超限/中性/过暗提示 | R3、L1:153–157、787–790 | 资源支持照片内颜色采样和范围可视化；最多 8 个选择的提示存在，尚未验证触发条件。 |
| 纹理与效果 | Texture、Clarity、Dehaze、Vibrance、Saturation、Grain | L1:469、493、552、567、578、7514 | 有相关参数名；项目中的预览算法应标为自身实现。 |
| 裁剪/拉直 | `DEVELOPCROPCONTROLLER.LUA`, `DEVELOPCROPVIEW.LUA`, `DEVELOPCROPKEYS.LUA`；Crop `c`，约束比例 `a`，切换比例方向 `x` | R3、L1:678、8122–8123、8178 | 裁剪有独立 controller/view/keys 资源，可作为局部工具模式线索。拖拽、变换顺序、边界处理未测。 |
| 蒙版 | `MASKCREATEMENU.LUA`, `MASKLISTVIEW.LUA`, `MASKOPTIONSUI.LUA`；LocalSelection `m`；brush `b`、linear `L`、radial `r` | R3、L1:8148–8163 | 资源支持蒙版创建、列表、工具选项和增减选区的命令层。AI 主体/天空选择的执行与模型不可由此确定。 |
| 修复/移除 | `AGCAMERARAWCONTROLLERSPOTHEALING.LUA`；HealingBrush `h`；画笔大小、羽化、不透明度、添加/减去选区 | R3、L1:4882–4896、7507–7510、8141 | 存在局部修复/移除工具及选区调整文案。生成式移除服务、质量、可用地区均未测。 |
| 编辑撤销/重置 | `AgUndo/UndoMenuItemTitleTempl`, Redo 对应项；ResetImageSettings | L1:2319–2322、8177 | 有带动作名称的撤销/重做及全图重置文案；历史栈持久化与事务边界未知。 |
| 导出 | `ag.file.export`, `ag.file.exportPreviousSettings` | L2 | 菜单区分导出和沿用上次设置；未执行导出。 |
| 导出选项 | JPG、TIF、PNG、DNG、AVIF、JXL、原始图像+设置；品质、色彩空间、输出锐化 | L1:1281–1298、1376–1385、1412–1421 | 选项资源存在，不保证每种输入、账户、平台下全部可选。初版项目可选 JPEG/PNG 作为自主范围。 |
| Photoshop 集成 | `ag.file.editInPs`, `editInPsAsSmartObject`, `editInPsAsLayers` | L2 | 资源包含集成命令；跨应用调用、权限和保存回流未验证。 |
| 键盘/可访问性 | 单键快捷键禁用设置、Tab 分组导航、空格选择、方向键滑块、Esc 退出 | L1:1896–1897、1945–1947 | 可作为键盘交互设计参考；本机是否开启未知。 |

L1 中 `Cmd` / `Option` 同时出现在跨平台资源；本报告只确认资源字符串，不将它们直接转换为已验证的 Windows Ctrl / Alt 行为。单键命令也应考虑焦点、活动工具、快捷键禁用设置。

## 可复查的 PE 资源位置

| 文件 | 资源名 | 文件 offset / bytes | 载荷 SHA-256 |
| --- | --- | --- | --- |
| lightroom.exe | `$APPLICATION$MENUS.LUA` | 25,880,728 / 6,702 | `3288a5de30362ee51312d9fc20c7a5fe9a430cbf0431582efd34937da66308db` |
| lightroom.exe | `$LIGHTROOM$MENU$ITEMS.LUA` | 26,494,624 / 16,387 | `6211a40527618d384125d51575aa1501f77b57e4ee694df9116fb59fc2d0e727` |
| lightroom.exe | `$AG$KEYBOARD$SHORTCUTS.LUA` | 25,644,552 / 20,691 | `1cf546ee4271f7ce3ad1858959695ba2562ac03cb927fd79568a1ff77b132410` |
| lightroom.exe | `$NIMBUS$MENUS.LUA` | 26,741,832 / 18,861 | `ca61b211561f5b306f1a037cf996a9d46caa58e4ad221bb2368c4e5a66a4aec0` |
| Develop.lrmodule | `DEVELOPCROPCONTROLLER.LUA` | 29,916,264 / 28,210 | `0c1031fbd6b100ba595cece5974140ded8ced0a2bf80e30a1c1916a6470d7438` |
| Develop.lrmodule | `DEVELOPCROPVIEW.LUA` | 29,960,208 / 82,718 | `21f15c2a0ca70d34033ffae85795eafcf5c49b711e51efeaf5495c3ef0b1e2cd` |
| Develop.lrmodule | `MASKCREATEMENU.LUA` | 31,072,968 / 25,520 | `a307b6d86a4e3b963984832458fa54feb70a544ed53a4ad7641dc6554b0e2283` |
| Develop.lrmodule | `MASKLISTVIEW.LUA` | 31,117,384 / 89,214 | `761ccf578ee8943f8c58fcdde3b1c7ed3fc4751f83138b638b7706b2cd3f3ad4` |
| Develop.lrmodule | `DEVELOPPOINTCOLORCONTROLLER.LUA` | 30,799,000 / 32,706 | `14d9baa91fe39a427c9e31866a1cfba6d0ef1224c50a63efe4b0bb7353fd006d` |

REA Evidence 在当前服务中 retained，可用 `get_evidence_bundle(detail:"summary", filters:{evidence_id:...})` 和 `inspect_analysis_view` 继续查询。这里保留身份、范围和限制，不把完整 Adobe 载荷提交到项目。

## 覆盖检查与后续验证

| 问题 | 状态 | 未覆盖项 |
| --- | --- | --- |
| 安装版本和主程序身份 | 已回答 | 未验证 Adobe 数字签名的信任链。 |
| 主要功能入口和工具分类 | 部分回答 | 资源、文案、命令常量已查；可见菜单启用条件未知。 |
| 编辑模式/网格/裁剪/蒙版的工具身份 | 部分回答 | 静态命令已查；没有用户动作到状态更新的运行 trace。 |
| 精确外观与布局 | 未回答 | 没有本轮屏幕截图、窗口大小、字体度量、间距/颜色测量；网页布局属于项目设计。 |
| 光线/颜色/RAW 算法 | 未回答 | 未反编译 CameraRaw.dll/WF 管线，未测像素输出，不声称与 Adobe 相同。 |
| 蒙版、修复、生成式 AI、降噪 | 部分回答 | 仅功能资源；没有模型权重、推理或服务请求证据。 |
| 导入/导出、数据库、同步、账户 | 未回答 | 没有运行导入/导出，没有访问用户 catalog/凭据，没有网络记录。 |
| Lightroom Classic | 未调查 | 另一个本机产品，需单独绑定目标和报告。 |

后续优先验证：在 Windows 可见 UI 中核对云端/本地入口、选中照片后的编辑工具栏、裁剪与蒙版切换、导出对话框；使用明确授权的示例照片。验证后新增 runtime 证据，不覆盖上述静态/未知边界。

### 菜单字节码的补充核对

以 R1/L2 给出的资源范围运行 `node research/menu-bytecode.mjs <安装程序> 26741832 18861 ag.file.export`。无须执行 Adobe 程序。Lua 5.1 主原型第 112、113 条指令在文件偏移 26742316 和 26742320 将导出和沿用上次设置两个不同命令载入相邻寄存器。第 119–121 条分别加载 Photoshop 编辑、智能对象和图层命令。第 129 条 CALL 的两个静态参数可追溯至高级编辑功能开关和编辑器偏好命令。第 584–585 条加载本地目录包含子目录的命令并将其传入函数。

这是按 PC 编号从 0 开始的直线指令分析。遇到条件分支会清除寄存器推断，未知被调函数保留为空；菜单是否在当前账户展示、实际权限和像素行为未由此验证。[Lua 5.1 指令定义](https://github.com/lua/lua/blob/v5.1/lopcodes.h)

补充静态核对：R3 的 DEVELOPCROPKEYS.LUA 资源从偏移 29950008 开始，长度 4004 字节。原型 0.0 的第 2–3 条指令把约束裁剪命令传给 performCommandID。CropController 原型 0 的第 250–257 条指令读取四个裁剪边界、角度和比例相关常量。导入语言资源 L1 的第 5177、5188–5190 行区分了当前批次的重复原件、先前已导入原件，以及将其加入当前相册。OpenLR 仅在文件名和尺寸候选匹配后做分片字节比较，避免重复复制同一原件。
