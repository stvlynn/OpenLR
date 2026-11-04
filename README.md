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
- **局部处理**。渐变、径向和画笔蒙版支持局部调整。克隆与纹理修复使用原图坐标，即使后续裁剪也能引用框外像素。
- **RAW 与输出**。LibRaw 解码传感器数据。支持输出 JPEG、PNG、TIFF、AVIF、JPEG XL 和未改动的原始文件。渲染导出可指定长边和文字水印。当前显示及渲染输出基于 8-bit sRGB。

可选的 [WebDAV 同步](docs/library-sync.md) 在设备间传递导入的图库。多张照片可合并为 HDR 或全景；视频支持剪辑、逐帧调整、音轨保留和导出。导出 DNG、XMP、外部编辑器和相机格式的边界见 [交互范围](research/interaction-coverage.md)。

## Agent CLI

启动桌面应用，在工作区执行以下命令。GUI 用户和 CLI 操作的是同一份实时状态。

```sh
node cli/openlr.mjs cli search "exposure"
node cli/openlr.mjs import ./photo.dng
node cli/openlr.mjs edit --key Exposure --value 0.5 --capture workspace.png
node cli/openlr.mjs state
node cli/openlr.mjs preview --output preview.png
node cli/openlr.mjs export --format image/png --output edited.png
```

`--capture` 在一次命令中返回操作数据和窗口截图路径。单独使用 `screenshot` 可查看当前窗口，`preview` 可读取照片渲染结果。`schema`、`--help` 和 `--dry-run` 可离线使用。更多示例见 [CLI 文档](docs/agent-cli.md)。

## 验证与来源

```sh
npm test
go test ./...
go vet ./...
node scripts/native-smoke.mjs /path/to/OpenLR
```

浏览器测试使用本机 Chrome，原生 smoke 使用生成的测试图和临时会话。验收范围与剩余差距见[验收记录](docs/acceptance.md)。照片处理算法是独立实现，项目没有捆绑 Adobe 的程序、素材、字体或模型。

- [Lightroom 9.4 安装包的 REA 证据索引](research/lightroom.md)
- [预览分辨率消融实验](docs/decisions/003-preview-resolution.md)
- [RAW 解码与组件来源](docs/raw-decoding.md)
- [代码模板与来源](docs/template-sources.md)
- [贡献约定](AGENTS.md) · [AGPL-3.0-only](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md)

