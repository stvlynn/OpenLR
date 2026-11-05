# OpenLR

OpenLR 是用 Go、MyGo 和原生 ES modules 构建的桌面照片编辑器。可以从图库导入照片，也可以直接浏览磁盘上的目录。缩略图、详情预览、导出和 agent CLI 使用同一份编辑参数。

## 运行

需要 Go 1.27.3 或更高版本和 Node.js 24。Windows 使用 WebView2，macOS 使用系统 WKWebView，Linux 使用 GTK 3 和 WebKitGTK 4.1。生产前端和图像编解码器随应用打包。

```sh
npm ci
npm run doctor
npm run desktop
```

`npm run build:desktop` 为当前平台打包。完整的平台依赖、交叉编译和产物路径见[桌面宿主说明](docs/desktop.md)。

## 编辑照片

- **图库与本地目录**。图库保留导入的原始文件。本地目录按需读取照片，编辑参数存入同目录的 `.openlr.json` 文件。使用旗标、星级、关键词、相册、筛选和多选整理照片。
- **无损编辑**。调整光线、白平衡、曲线、混色、锐化、降噪和暗角，裁剪、翻转或旋转照片。可以复制选定参数、保存预设和命名版本、比较原图与编辑效果。
- **点曲线**。通过图形、数值或 CLI 编辑 RGB 主曲线和红、绿、蓝通道，拖动时预览，完成后一次撤销。规则与保存边界见[点曲线](docs/tone-curves.md)。
- **局部处理**。渐变、径向和画笔蒙版支持局部调整。克隆与纹理修复使用原图坐标，即使后续裁剪也能引用框外像素。
- **RAW 与输出**。LibRaw 解码传感器数据。支持输出 JPEG、PNG、TIFF、AVIF、JPEG XL 和未改动的原始文件。渲染导出可指定长边和文字水印。交互预览使用 8-bit sRGB。DNG 和 HDR 路径分别保留原始 DNG 或生成 16-bit LinearRaw DNG，以及从线性曝光合并得到的 RGBE 辐照度。

可选的 [WebDAV 同步](docs/library-sync.md) 在设备间传递导入的图库。多张照片可合并为 HDR 或全景；视频支持剪辑、逐帧调整、音轨保留和导出。导出 DNG、XMP、外部编辑器和相机格式的边界见 [交互范围](research/interaction-coverage.md)。

主体、人物、背景和天空使用本地推理生成软蒙版。可用色域、亮度、深度和布尔运算细化范围，按 O 查看选区。降噪、三倍超分和深度模糊的模型、下载大小及实测结果见 [AI 蒙版](docs/ai-masks.md)、[深度工具](docs/range-depth-tools.md) 和 [增强](docs/enhance.md)。

可以用 [独立审阅服务](docs/shared-albums.md) 共享相册并收取评论，通过 [外部编辑器](docs/external-editors.md) 编辑 TIFF 副本，也能从 [Classic 目录或 Photos 导出文件](docs/catalog-migration.md) 迁移到图库。

JPEG、PNG、TIFF、AVIF 和 JPEG XL 可选择 [输出色彩空间](docs/export-color.md)，将当前 sRGB 编辑结果转换为 Display P3、Adobe RGB、ProPhoto RGB 或 Rec.2020 SDR，并写入匹配的 ICC 配置文件。

渲染导出也可选择[仅版权或版权与照片信息](docs/export-metadata.md)，在五种格式中保留明确列出的字段；默认不携带源照片元数据。GUI、CLI 和沿用上次设置共用这一策略，原件导出保持原始字节。

[输出锐化](docs/output-sharpening.md)可在最终导出尺寸上选择低、标准或高强度，默认关闭。它在水印之前处理成片，不改变照片的编辑参数、预览或原件，也可通过 `--outputSharpening standard` 和沿用上次设置使用。

在详情页选择 **Processing → Linear**，或运行 `processing --version 2`，可对静态照片启用[浮点线性处理](docs/linear-working-frames.md)。RAW 保留宽色域 16-bit 解码样本；支持的 PNG/TIFF 整数样本和 AVIF 8/10/12-bit 源直接进入浮点帧，并按支持的 RGB 矩阵/TRC 配置或 SDR 色彩声明转换。TIFF 直接输出 16-bit，其他渲染格式在目标色彩空间量化为 8-bit。Info 和 `state` 显示实际解码精度；不支持的 ICC/CICP 路径可使用明确标注的 8-bit 兼容解码，JPEG XL 按实际解码配置转换整数和浮点源；PQ/HLG 等边界明确使用兼容解码。原有照片和普通新导入默认保持原处理方式，切换可撤销，重置保留处理版本。

## Agent CLI

安装包附带单文件 Node CLI。也可以在工作区运行以下命令。GUI 和 CLI 操作同一份实时状态。

```sh
node cli/openlr.mjs open
node cli/openlr.mjs cli search "exposure"
node cli/openlr.mjs import ./photo.dng
node cli/openlr.mjs edit --key Exposure --value 0.5 --capture workspace.png
node cli/openlr.mjs state --summary true
node cli/openlr.mjs preview --output preview.png
node cli/openlr.mjs export --format image/png --output edited.png
node cli/openlr.mjs export-previous --output next.png
node cli/openlr.mjs export-selection --format image/png --output-dir ./exports
```

多选后可通过 **Export N** 或 `export-selection` [逐张导出到文件夹](docs/batch-export.md)，自动为重名文件编号并报告实际完成清单。

`--capture` 在一次命令中返回操作数据和窗口截图路径。单独使用 `screenshot` 可查看当前窗口，`preview` 可读取照片渲染结果。`schema`、`--help` 和 `--dry-run` 可离线使用。更多示例见 [CLI 文档](docs/agent-cli.md)。

## 验证与来源

```sh
npm test
go test ./...
go vet ./...
npm run test:native -- /path/to/OpenLR
```

浏览器测试使用本机 Chrome，原生 smoke 使用生成的测试图和临时会话。验收范围与剩余差距见[验收记录](docs/acceptance.md)。照片处理算法是独立实现，项目没有捆绑 Adobe 的程序、素材、字体或模型。

- [Lightroom 9.4 安装包的 REA 证据索引](research/lightroom.md)
- [预览分辨率消融实验](docs/decisions/003-preview-resolution.md)
- [RAW 解码与组件来源](docs/raw-decoding.md)
- [代码模板与来源](docs/template-sources.md)
- [贡献约定](AGENTS.md) · [AGPL-3.0-only](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md)

