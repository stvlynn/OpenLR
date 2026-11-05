# AVIF 原生颜色绑定

调查/实现日期：2026-11-05。本文区分固定源代码证据、实现选择和实际编译验证；它不改变编辑管线仍为 8-bit sRGB 的产品边界。

## 固定上游证据

当前项目使用 npm `@jsquash/avif` 2.1.1，gitHead `b7fa9ac9ec02f224847ad23d19d115f9e296a368`。检查的是该固定版本，不用当前 main 的文档替代其 ABI。

- [编码绑定](https://github.com/jamsinclair/jSquash/blob/b7fa9ac9ec02f224847ad23d19d115f9e296a368/packages/avif/codec/enc/avif_enc.cpp)接受像素和质量/采样/位深；创建 `avifImage` 后仅设置 MC：无损 identity 0，有损 BT.601 6。没有 ICC、CP 或 TC 入口。
- [解码绑定](https://github.com/jamsinclair/jSquash/blob/b7fa9ac9ec02f224847ad23d19d115f9e296a368/packages/avif/codec/dec/avif_dec.cpp)经 `avifImageYUVToRGB` 返回 RGBA，随后销毁 `avifImage`，没有返回 ICC/CICP，也没有执行 gamut/TRC CMS 转换。原始 RGB 值被包成默认 ImageData 不能证明其为 sRGB。
- [构建主文件](https://github.com/jamsinclair/jSquash/blob/b7fa9ac9ec02f224847ad23d19d115f9e296a368/packages/avif/codec/Makefile)和[辅助文件](https://github.com/jamsinclair/jSquash/blob/b7fa9ac9ec02f224847ad23d19d115f9e296a368/packages/avif/codec/helper.Makefile)固定 libavif v1.0.1、libaom v3.7.0、libwebp `e2c85878f6a33f29948b43d3492d9cdaf801aa54` 的 SharpYUV。`git ls-remote` 实际将 release tags 解析为 libavif `d1c26facaf5a8a97919ceee06814d05d10e25622`、libaom `6054fae218eda6e53e1e3b4f7ef0fff4877c7bf1`；新的 recipe 直接使用这两个 commit。
- [libavif API](https://github.com/AOMediaCodec/libavif/blob/d1c26facaf5a8a97919ceee06814d05d10e25622/include/avif/avif.h)提供 `avifImageSetProfileICC`、CP/TC/MC 和 `yuvRange`。API 明确 RGB buffer 是 full range，YUV 转换负责位深及 limited/full rescaling。
- [libavif reformat](https://github.com/AOMediaCodec/libavif/blob/d1c26facaf5a8a97919ceee06814d05d10e25622/src/reformat.c)依据 MC 做 RGB↔YUV；它不是 ICC CMS，也不会替调用者执行目标 RGB 基色/传递函数转换。
- [AV1 规范](https://aomediacodec.github.io/av1-spec/av1-spec.pdf)的 sequence-header/color-config 语法用于测试侧独立读取实际 `mdat` OBU 的 CP/TC/MC/range，避免只查看容器 `nclx`。测试读取器仅覆盖本次 8-bit reduced-still fixtures；不是通用生产 AV1 parser。

Context7 `/jamsinclair/jsquash` 也实际查询了手工模块初始化与构建。检索结果提供 `init`/`locateFile` 用法，但其 AVIF README quantizer 示例落后于固定 C++ 的 quality API。因此实际结构和构建输入以固定源码为准。

## 选择与替代方案

采用 `scripts/codec-color/avif/` 内的薄 C++ 绑定和 CMake 集成，重新编译固定 libavif/libaom/SharpYUV。编码前调用共享颜色转换，传入真实目标样本；绑定在 `avifImageRGBToYUV` **之前**设置 ICC 和 CICP。这样容器和 AV1 码流由同一原生图像状态生成，不需要后处理改写 `colr`。

ICC 是具名输出空间的精确定义。带 ICC 的输出 CP/TC 采用 unspecified 2，避免为 Adobe RGB/ProPhoto/Rec.2020 gamma 2.4 选择近似或错误 CICP。MC 是实际存储变换而不是 RGB 空间名：无损为 full-range identity/4:4:4；有损保留上游 BT.601 YUV。不能因目标为 Rec.2020 就只改 MC 标签而不改变实际变换。

`decodeWithColor` 返回 native RGBA 和拷贝的 ICC/CICP/depth。绑定不伪称这些 native code values 为 sRGB；应用可以将 ICC 和 native RGB 包为 PNG，复用已有宿主 CMS，再回到编辑用 sRGB。无 ICC 的输入必须单独处理 CICP。旧 `decode` 只保留 ABI，不能用作广色域 CMS。

替代方案的具体边界：

1. 在现成 WASM 外部添加 `colr` 能嵌 ICC，但原绑定缺少 CP/TC/MC 控制、解码又丢弃 profile；也无法证明 AV1 bitstream 与容器一致，因此不采用。
2. 将输入先包为 ICC PNG 再交给浏览器 AVIF encoder 不可行：项目依赖的 canvas API 并不提供可移植 AVIF 编码器或保留任意目标 RGB profile 的保证。
3. 新写独立 libavif C ABI 也可行，但会重复已有质量、线程、SharpYUV、位深路径。保留当前 jSquash 绑定形状能缩小适配范围。
4. 将所有输入 RGB 都改为 sRGB 可以保持旧解码表象，却无法满足真实具名目标空间输出。

构建使用独立 encoder/decoder libavif codec table，以便链接器丢弃 libaom archive 中未使用的回调和代码。decoder target 从上游实际 CMake target 取得源列表及属性，避免手工维护第二份原生源文件清单。libaom 的 `CONFIG_MULTITHREAD` 必须是生成 C header 可识别的数值 0/1；CMake 字符串 ON/OFF 会变成 C 预处理器未定义名字，不能据此声称启用了线程。threaded binding 保留发布版的 `navigator.hardwareConcurrency` 预备 worker pool，避免同步 libaom join 阻塞首次创建的浏览器 Worker 初始化。

## 来源与验证

适配的编码/解码 C++ 和 `pre.js` 源自上述固定 jSquash 路径，保留完整 Apache-2.0 文本 `LICENSE.jsquash`，每个修改的 C++ 有来源及修改注释。原生库源码不修改。libavif BSD-2-Clause（含其自身保留第三方声明）、libaom BSD-2-Clause + AOM patent license、libwebp BSD-3-Clause + WebM patent grant 和 Emscripten 许可均继续适用。不可只以 jSquash wrapper 的 Apache-2.0 描述整个 WASM。

构建要求和真实命令归 [build README](../scripts/codec-color/avif/README.md)，固定 revision/URL/条款归 [sources.json](../scripts/codec-color/avif/sources.json)。源代码、SDK、构建产物位于 ignored `.tools/`，运行时无需网络。没有增加源包 SHA 校验门禁。

已执行：固定源包下载/解包、Windows Node 24.9.0 脚本语法检查；WSL Ubuntu 24.04、Emscripten 3.1.64、CMake 3.31.6、Ninja 1.11.1 编译单线程编码与解码 WASM。测试执行于 Windows Node 24.9.0：

```sh
node scripts/codec-color/avif/smoke.mjs
PYTHONPATH=.tools/color-cms python scripts/codec-color/avif/check-cms.py
```

五个具名空间均实际编码 32×24 生成 RGBA byte ramp；解码 native RGB/alpha 与编码前目标样本最大差 **0**，ICC 逐字节相同；独立 BMFF `colr` 读取验证 ICC/nclx；独立 reduced-still OBU 读取验证实际 AV1 色彩配置为 CP=2/TC=2/MC=0/full-range。有损路径验证实际 AV1 CP=1/TC=13/MC=6/full-range，损坏输入/错误像素长度返回失败。libavif 的 `mdat` 可以先存储独立 monochrome alpha item，测试明确跳过其 sequence-header，读取实际彩色 item，不能将 alpha 的 MC=2 当作彩色码流。

Pillow 12.0.0 / libavif 1.3.0 的独立 AVIF decoder 读取相同五文件，其 native RGB/alpha 和 ICC 同样逐字节匹配。Little CMS 2.17 以相对比色 intent 转回 sRGB 后，RGB byte 最大差/平均差为：

| 空间 | 最大差 | 平均差 |
| --- | ---: | ---: |
| sRGB | 0 | 0 |
| Display P3 | 3 | 0.214844 |
| Adobe RGB | 2 | 0.234375 |
| ProPhoto RGB | 5 | 0.484375 |
| Rec.2020 gamma 2.4 | 4 | 0.410156 |

这里的 CMS 往返差包含现有 8-bit 目标量化，与 codec native 样本完全无损是不同测量。fixture 不是任意照片、全色域/阶调质量或高精度能力的证明。原始输出和测量 JSON 位于 ignored `.tools/codec-color/avif/fixtures/`，命令可重新生成。

`node scripts/codec-color/avif/smoke-threaded.mjs` 已在 Windows Chrome 155、COOP/COEP cross-origin isolation 下通过：实际 pthread encoder 对五空间编码，native RGB/alpha 差为 0、ICC 相同、解码 CP/TC/MC/range 为 2/2/0/full。初次 sandbox 阻止 localhost 导航产生 `ERR_NETWORK_ACCESS_DENIED`；在允许 localhost 的同机环境重跑通过，不把网络拒绝当作 codec 故障。

最终 encoder/decoder table 裁剪后重新编译并完整重跑以上 Node、Pillow/CMS、Chrome pthread 三项验证，均通过且数值相同。最终 WASM 大小为 ST encoder **3,507,983** bytes、pthread encoder **3,547,986** bytes、decoder **1,158,246** bytes；裁剪前 ST 两模块合计约 7.4 MB，裁剪后约 4.7 MB。最终生成代码使用数值 thread config 0/1。临时 Linux SDK 消失导致的 ignored CMake cache 路径失效通过恢复到同版本 workspace SDK 解决；这不是图像失败，也没有修改固定原生库源码。整个产品导出/导入集成仍需其各自测试，不以绑定层通过代替；跨平台 WebView/HDR/高精度范围也不能从这些小图验证推出。
