# 色彩管理与真实广色域输出调查

调查日期：2026-11-05。本文是只读源代码和上游文档研究，以及待执行的实验设计；不是已实现功能、性能测量或产品架构决议。本次只新增此研究文件，没有改变处理代码，也没有运行新的图像转换或导出实验。

## 证据和结论的边界

Windows Lightroom 9.4 的真实导出下拉可见 sRGB、Display P3、Adobe RGB、ProPhoto RGB、Rec.2020，默认选中 sRGB。会话没有改选空间并导出图像。因此只能确认菜单存在，不能推断其 ICC 字节、转换意图、传递函数、量化、各格式支持或内部工作空间。现有运行时记录归 [Lightroom 证据](lightroom.md) 所有；静态 REA 资源入口也不能证明这些算法。

OpenLR 的产品边界见 [验收记录](../docs/acceptance.md)、[图像编解码](../docs/image-codecs.md)、[RAW 解码](../docs/raw-decoding.md)、[DNG 输出](../docs/dng-export.md) 和 [HDR 合并](../docs/photo-merge.md)。当前普通编辑和渲染导出确实是 8-bit sRGB。已有 16-bit 线性 RAW 和 Float32 HDR 分支不等于完整的广色域编辑器。

结论：缺口包含明确的像素颜色契约、输出空间转换和相匹配的文件颜色声明，后续才是保留原始广色域与高精度编辑。仅增加下拉菜单或替换 ICC 标签不能补齐缺口。不过也不能说项目完全没有 ICC 转换：已捆绑的 JPEG XL 解码器内部确实通过 skcms 将输入 ICC 颜色转为 sRGB。

## 当前实现逐层核对

| 位置 | 可复查的当前行为 | 限制 |
| --- | --- | --- |
| `web/decode.js` 的 `decodePhoto` | JPEG/PNG 等交给 `createImageBitmap(file)`；TIFF/AVIF/JXL 走打包编解码器 | 普通浏览器解码的颜色行为由宿主实现；这不是 OpenLR 自有通用 ICC 入口，也没有保留显式输入颜色契约 |
| `web/raw-kernel.js:14` | 固定 `setOutputColor(1)`；普通路径 `setOutputBps(8)` | 普通 RAW 先转 sRGB，之后无法恢复已经丢掉的原始色域和精度 |
| 同文件 `linear` 分支 | 16-bit、单位 gamma，再产生 Float32 线性通道和 8-bit 显示通道 | 仍固定 sRGB 基色；现有 DNG/HDR 消费此数据，不能静默改变它的颜色含义 |
| `web/render.js:32`、`:52` | 默认 2D canvas、默认 `getImageData`，sRGB 反传递函数后做部分线性光计算 | 结果写回 `Uint8ClampedArray`；中间计算为浮点不代表保留浮点图像或超出色域的数据 |
| `web/color.js`、`web/local-tools.js:320`、`web/optics.js:345`、`web/range-masks.js` | HSL、颜色参考、亮度系数、局部操作与采样多处以 sRGB/8-bit 为规则 | 改工作空间必须明确旧配方的颜色含义，不能只替换主渲染器的矩阵 |
| `web/encode.js:4` | TIFF/AVIF/JXL 从默认 `getImageData` 取像素；JPEG/PNG 直接 `canvas.toBlob` | 没有目标颜色空间、ICC 字节或精度参数；浏览器是否写入默认颜色元数据不能从调用本身推定 |
| `web/codec-kernel.js:80` | TIFF 经 `UTIF.toRGBA8`；不消费 ICC 进行颜色变换 | 16-bit TIFF 导入最终也变成 8-bit；通用 CMYK 计算不是 ICC 印刷流程 |
| `web/codec-kernel.js:102` | TIFF 调用 `UTIF.encodeImage`，仅额外写 alpha 和软件标签 | 没有 ICC 输出标签 |
| `web/codec-kernel.js:109` | AVIF/JXL 仅传质量和 lossless | 未暴露输入 profile、输出 profile、CICP 或高精度像素 |
| `web/agent-protocol.js:782`、`web/export-options.js`、`web/app.js:1628` | GUI/CLI 共用导出 dispatcher，参数为格式、长边、水印和质量 | 新颜色能力必须进入相同 schema、能力判断和 dispatcher，不能给 GUI 做一套空实现 |
| `web/metadata.js` | 只提取选定 EXIF 拍摄字段 | 没有保留输入 ICC 的应用级字段 |

### 已有输入颜色处理并不一致

打包版本的上游源码明确显示：

- [JXL 解码器](https://github.com/jamsinclair/jSquash/blob/1b1964194611ece3ec984ab91c04726d1088f05e/packages/jxl/codec/dec/jxl_dec.cpp) 查询 `JXL_COLOR_PROFILE_TARGET_DATA` 的 ICC，以 float 解码，再调用 `skcms_Parse`、`skcms_Transform`，最终返回 8-bit sRGB `ImageData`。这是实际的上游颜色转换实现，调用范围被封装在该 WASM 内；不能直接作为其他格式可调用的 JS CMS。
- [AVIF 解码器](https://github.com/jamsinclair/jSquash/blob/b7fa9ac9ec02f224847ad23d19d115f9e296a368/packages/avif/codec/dec/avif_dec.cpp) 调用 libavif 的 YUV→RGB，再构造像素对象；没有读取并应用 ICC 的步骤。YUV 矩阵还原和 RGB 色彩空间转换是不同责任。
- TIFF 的应用适配器没有 ICC 颜色变换。JPEG/PNG 走浏览器；应通过真实带 profile 的合成输入核对 Windows WebView2、WKWebView 和 WebKitGTK，而不是假定它们与上述 WASM 一致。

### 编码器能力和应用能力需要分开

| 格式 | 当前 OpenLR | 底层真实能力与最小接入障碍 |
| --- | --- | --- |
| JPEG | 默认 sRGB canvas 编码 | 文件可用 APP2 `ICC_PROFILE` 分段嵌入；需转换像素、处理旧颜色声明并验证真实文件，不能只改 EXIF 名称 |
| PNG | 默认 sRGB canvas 编码 | 标准支持 `iCCP`；需 CRC、压缩及一致的色彩声明，避免与 `sRGB`/其他颜色块冲突 |
| TIFF | UTIF 8-bit RGBA | TIFF 可用 ICC tag 34675；当前 UTIF helper 不能直接承担可靠 ICC 输出，见下文 |
| AVIF | 8-bit 输入；未设置 ICC/CP/TC | 已打包 wrapper 其实接受 8/10/12-bit，超过 8-bit 需 `Uint16Array`；[编码 C++](https://github.com/jamsinclair/jSquash/blob/b7fa9ac9ec02f224847ad23d19d115f9e296a368/packages/avif/codec/enc/avif_enc.cpp) 不暴露 ICC 或颜色基色/传递参数。不能因为底层 libavif 有 API 就宣称当前绑定已支持 |
| JPEG XL | 固定 8-bit sRGB | [当前打包编码 C++](https://github.com/jamsinclair/jSquash/blob/1b1964194611ece3ec984ab91c04726d1088f05e/packages/jxl/codec/enc/jxl_enc.cpp) 写死 `ColorEncoding::SRGB` 与 8-bit；需重建绑定才能接入目标 profile/精度 |
| 原件、DNG、RGBE | 各自现有保留/线性契约 | 应保持语义；DNG 的相机矩阵不是给普通 RGB 输出贴上的 ICC，RGBE HDR 也不是 HDR 显示能力 |

特别注意 [固定 UTIF 3.1.0 源码](https://github.com/photopea/UTIF.js/blob/27f1098a67c3cfd4348c9b8fd887fcd8cd171095/UTIF.js)：`encodeImage` 固定四个 8-bit 通道、像素偏移 1000；`encode` 固定 20000 字节的 IFD 暂存区；写 IFD 的代码没有实现 BYTE/UNDEFINED 数据写入，且 `ttypes` 没有 34675。简单设置 `ttypes[34675]` 和传入 profile 数组会遇到类型写入及布局问题。应单独选择已验证的 TIFF writer，或明确修复该序列化器并使用真实 profile/偏移交叉验证；现有 DNG writer也不应不经合同检查就充当普通 TIFF writer。

ICC 的 [嵌入技术说明](https://archive.color.org/files/technotes/ICC-Technote-ProfileEmbedding.pdf) 说明 JPEG、PNG、TIFF、AVIF 和 JXL 均可承载颜色 profile；承载能力本身不会执行颜色转换。[PNG 第三版规范](https://www.w3.org/TR/png-3/#11iCCP) 是 PNG 块规则的依据。

## 输出空间转换和真正广色域编辑

**可以独立完成且真实有效的第一阶段**：将当前已编辑的 sRGB 像素转换为目标 RGB 数字，再写入匹配的 ICC/颜色声明。目标文件有正确的颜色解释，跨支持色彩管理的查看器能保持原来外观。这是在目标空间内表达现有 sRGB 内容，不会找回导入或编辑时已裁掉的色域，也不会把 8-bit 输入变回传感器精度。

**错误的捷径**：保持 sRGB RGB 数字不变，仅贴 Display P3、Adobe RGB 或 ProPhoto 的标签。那会改变数字的颜色解释，而非保持外观的转换。转完像素但不写相符标签同样不完整。

**真正广色域处理**：必须在变为普通 sRGB canvas 前取得有明确颜色含义的高精度数据，保留足够宽的工作空间，并让全局/局部编辑、几何重采样、颜色范围、预览和输出共同消费它。最终显示变换和文件输出变换是两个不同用途；SDR 广色域、HDR 辐照度和 HDR 显示应分别验收。

建议的最小合同是显式像素帧，包含尺寸、通道/布局、数值类型/有效位数、基色与白点、传递函数或 profile、alpha 约定、资产 ID 和编辑修订。编辑规则面向此合同，CMS、解码器、编码器和宿主是适配器。异步结果仍需核对资产和修订。旧的 sRGB 配方保持可重现，新工作空间的行为通过有版本的配方或显式迁移定义。

Display P3 不能用 DCI-P3 标签替代；ProPhoto 涉及 D50 白点及相应适应，不能只换基色。Rec.2020 标签还不足以决定传递函数：例如本次查看的 [CSS Color 4 2026-11-03 草案](https://www.w3.org/TR/2026/CRD-css-color-4-20261103/#predefined) 对预定义显示 `rec2020` 使用 BT.1886 gamma 2.4；广播 OETF、线性、PQ、HLG 是另一些合同。后续须公开 OpenLR 所选定义，并独立检查实际导出的 Lightroom ICC，才可讨论具体 profile 对等性。标准公式可用作独立实现依据；本文没有复制 Adobe profile 或资产。

## 候选技术及证据版本

Context7 的 `/mm2/little-cms` 和 `/aomediacodec/libavif` 用于 API 发现；固定版本的直接 GitHub 源码用于核对当前应用真正暴露的能力。不能拿最新文档代替已打包版本事实。

| 候选 | 本次核对的版本/固定证据 | 可解决什么 | 不能直接推断什么 |
| --- | --- | --- | --- |
| Little CMS | 最新发布 [lcms2.20](https://github.com/mm2/Little-CMS/releases/tag/lcms2.20)，2026-10-31；查看的 master 为 [`689a84bcae6dc0173f3f45b55ffb8dea721c3d6b`](https://github.com/mm2/Little-CMS/tree/689a84bcae6dc0173f3f45b55ffb8dea721c3d6b) | [头文件](https://github.com/mm2/Little-CMS/blob/689a84bcae6dc0173f3f45b55ffb8dea721c3d6b/include/lcms2.h) 确认 RGB profile 创建、float/16-bit 转换和 profile 序列化 API；MIT 许可 | 尚未打包或测量 WASM，不能宣称现有 OpenLR 已可调用；采用前固定构建、许可及来源记录 |
| 重新暴露 skcms | 现有 JXL 固定 revision 已内部使用；项目保留其 `LICENSE.skcms` | 可作为较小 CMS 候选，对矩阵/TRC 与受支持 profile 做转换 | 隐藏在现有 WASM 不等于通用 API；通用 profile 覆盖、目标 profile 构造/序列化仍须核对，不能假定与完整 ICC 引擎等价 |
| 自有固定 RGB 公式 | 上述 W3C 草案给出空间定义、适应和转换参考 | 仅针对五个明确命名的矩阵/TRC 空间，可做依赖较少的输出变换及独立对照 | 不是任意输入 ICC、CMYK、LUT 或软打样引擎；仍需正确 profile 写出和独立数值参考 |
| 浏览器 P3 canvas | [HTML canvas 标准](https://html.spec.whatwg.org/multipage/canvas.html#serialising-bitmaps-to-a-file)，查看时更新于 2026-11-04 | 可作为支持 P3 的宿主显示/编码适配器候选 | 标准支持不证明三个目标 WebView 实测；不能覆盖任意 ICC、Adobe RGB、ProPhoto 或所有宽色域输出 |
| LibRaw | 项目实际 0.22.1-Release，commit [`b860248a89d9082b8e0a1e202e516f46af9adb29`](https://github.com/LibRaw/LibRaw/tree/b860248a89d9082b8e0a1e202e516f46af9adb29)，wrapper 1.1.1 | [参数文档](https://github.com/LibRaw/LibRaw/blob/b860248a89d9082b8e0a1e202e516f46af9adb29/doc/API-datastruct.html) 定义多种输出空间和 16-bit；可评估普通解码前的宽工作空间 | 项目打包构建没有 LCMS 集成；不能直接启用 ICC 文件选项就声称生效，也不能把其 DCI-P3 选项称作 Display P3 |
| libavif | 打包为 1.0.1；当前 main [`485b18ea52e769ec5b618211459e154728d10540`](https://github.com/AOMediaCodec/libavif/tree/485b18ea52e769ec5b618211459e154728d10540) 头文件为 1.4.2-devel | 当前 [头文件](https://github.com/AOMediaCodec/libavif/blob/485b18ea52e769ec5b618211459e154728d10540/include/avif/avif.h) 有 `avifImageSetProfileICC` 和 CICP 字段 | 更新或重编是独立工作；[官方 CICP 说明](https://github.com/AOMediaCodec/libavif/wiki/CICP) 强调 ICC 不取代仍用于 YUV 还原的 MC |
| libjxl | 打包源码 gitlink `9f544641ec83f6abd9da598bdd08178ee8a003e0`；当前 main [`38353ef442df5520e41e1c1d5ccdf46d066eaa68`](https://github.com/libjxl/libjxl/tree/38353ef442df5520e41e1c1d5ccdf46d066eaa68) | 当前公开 [编码头文件](https://github.com/libjxl/libjxl/blob/38353ef442df5520e41e1c1d5ccdf46d066eaa68/lib/include/jxl/encode.h) 有 `JxlEncoderSetICCProfile` 或 `JxlEncoderSetColorEncoding` | 这些能力未被项目旧的内部 C++ 编码绑定暴露；升级需真正编译和回读 |

jSquash AVIF 2.1.1 的固定仓库 commit 为 `b7fa9ac9ec02f224847ad23d19d115f9e296a368`；JXL 1.3.0 为 `1b1964194611ece3ec984ab91c04726d1088f05e`；UTIF 3.1.0 为 `27f1098a67c3cfd4348c9b8fd887fcd8cd171095`。现有清单和来源详见 `web/vendor/codecs/manifest.json`、`web/vendor/codecs/notices/sources.json` 和 `THIRD_PARTY_NOTICES.md`。本文没有引入新依赖或更改既有许可。

## 可执行的阶段与消融实验

以下全部为**待执行**，没有测量结果。实现前应把选定方案记录为 ADR，并同改产品能力和验证文档。

1. **建立基线与颜色合同**。用生成的带 profile JPEG/PNG/TIFF/AVIF/JXL 样本核对导入差异；建立编码器实际能力表。先完成独立 profile/块解析与解码回读，再暴露空间选项。不支持的格式×空间组合必须在共用 schema/能力层明确拒绝。
2. **当前 sRGB 编辑结果的真实空间转换输出**。先选择一种能独立检查颜色标记的无损格式，接通目标数字转换和标签。比较固定 RGB 公式与 Little CMS；若需求包含通用输入 ICC，优先验证同一 CMS 的双向入口。保留当前 sRGB 默认，不把此阶段称为广色域 RAW 编辑。JPEG/PNG 如保留 canvas 编码，必须验证中间没有第二次颜色变换，并替换相冲突声明；选择显式 raw-pixel 编码器更易给出合同。
3. **可保留精度的 RAW/栅格路径**。评估由 LibRaw 直接得到宽基色、16-bit 线性数据，进入独立浮点处理合同；逐步适配局部操作、光学校正和颜色选择。DNG/合并仍通过明确的转换适配保持旧合同。先用单一可验证的宽工作空间，再决定显示适配；不要同时改所有配方语义。
4. **扩展格式与显示**。修复/替换 TIFF writer，重建并测试 AVIF/JXL 的 ICC/颜色参数绑定，再逐个开放经过验收的组合。宽色域显示、HDR 传递与显示输出分别设计并验证。

| 消融 | 实验操作 | 必须读回的证据 | 决策依据 |
| --- | --- | --- | --- |
| 标签与像素 | 同一合成色块分别输出原样 sRGB、只换标签的负对照、真实转换+标签 | 独立取 ICC/颜色块；由独立 CMS 转回共同 XYZ/Lab；验证负对照出现偏色 | 排除“文件名/下拉/标签存在即成功”的假功能 |
| 公式、LCMS、skcms | 同一 profile 定义和渲染意图，遍历 17³ RGB 网格、近黑/中性/高饱和颜色及随机样本 | 最大/分位数 XYZ 或 ΔE、往返误差、alpha；记录 clipping 与 gamut mapping 策略 | 若固定五空间足够，公式可胜任；通用 ICC 需求须以真实 profile 覆盖决定 CMS，不能只比较包大小 |
| 白点/传递函数 | D65↔D50 的白/灰，ProPhoto 黑部断点，P3/Rec.2020 各选定传递函数 | 相同中性色的白点、TRC 与最终像素一致；profile 必须被独立解析器读取 | 防止 DCI-P3/Display P3、Rec.2020/PQ/HLG 混名 |
| 8-bit 与高精度 | 已知高精度梯度和超 sRGB 的 P3/ProPhoto 颜色，分别在导入即夹到8-bit或全程浮点后最终量化 | 输出阶调、超 sRGB 色块差异、饱和点比例；16-bit 输出需真正不同于8-bit乘257 | 证明真实色域/精度保存，不以高位深容器代替精度 |
| 格式绑定 | 无损 TIFF/PNG、AVIF/JXL lossless，JPEG单独设有损容差 | 文件签名、位深、ICC/CP/TC/MC、尺寸、像素误差及透明度；分别读回输入profile和数据profile | 避免包装层默认 sRGB 或 YUV 声明错误 |
| 宿主与性能 | Windows WebView2、macOS WKWebView、Linux WebKitGTK；生成小图与较大图，冷/热各重复测量 | 真正 GUI/CLI 导出文件、总时间/变换时间、峰值内存、Worker启动失败与可见错误 | 选择统一 WASM 或宿主适配；不能用 Chrome 通过代替原生三端 |
| 会话一致性 | 转换中切换资产/编辑、取消或让编解码失败；检查原件哈希 | 旧结果不覆盖新选中图，输出失败可见，原件逐字节未变 | 符合当前 dispatcher、修订和原件保留合同 |

数值门槛应在实验前按位深和无损/有损路径分别固定；例如先考察浮点共同 XYZ 最大绝对误差 `1e-5`、16-bit 量化往返一至数个等级、8-bit 一至数个等级是否可达，并公布未达到的样本，不能执行后只选择好看的阈值。不同 CMS 的意图、黑点补偿、TRC 实现及越界处理不一致时，先统一合同再比较。性能至少报告样本尺寸、宿主版本、硬件、重复次数和中位数，不能把单图结果称为普遍结论。

测试图应由代码生成并携带可核验颜色定义；需要真实相机样本时仅使用已有授权的小型夹具。不得使用私人照片、Adobe ICC/安装资产或未经审查的外部 profile 集作为分发素材。未来真实 Lightroom 输出对照也只使用用户授权的生成图，记录输出文件 profile 与像素，再讨论其行为；不能从当前菜单证据反推算法。
