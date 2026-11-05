// OpenLR original binding. libjxl remains under its retained BSD-style license.
// Only public libjxl APIs are used; pixels must already match the supplied ICC.
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <jxl/encode.h>
#ifdef __EMSCRIPTEN_PTHREADS__
#include <jxl/thread_parallel_runner.h>
#endif
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <vector>

using emscripten::val;

val encodeColorImpl(const std::string& pixels, int width, int height,
                   const std::string& icc, float quality, bool lossless,
                   int effort, bool inputIsSrgb, bool modular,
                   const std::string& exif = {}, const std::string& xmp = {}) {
  if (width <= 0 || height <= 0 || icc.empty() || !std::isfinite(quality) ||
      quality < 0 || quality > 100 || effort < 1 || effort > 9 ||
      static_cast<size_t>(width) > std::numeric_limits<size_t>::max() /
          static_cast<size_t>(height) / 4 ||
      pixels.size() != static_cast<size_t>(width) * height * 4) {
    return val::null();
  }
#ifdef __EMSCRIPTEN_PTHREADS__
  std::unique_ptr<void, decltype(&JxlThreadParallelRunnerDestroy)> runner(
      nullptr, JxlThreadParallelRunnerDestroy);
#endif
  std::unique_ptr<JxlEncoder, decltype(&JxlEncoderDestroy)> encoder(
      JxlEncoderCreate(nullptr), JxlEncoderDestroy);
  if (!encoder) return val::null();
  const bool hasMetadata = !exif.empty() || !xmp.empty();
  if (hasMetadata && JxlEncoderUseBoxes(encoder.get()) != JXL_ENC_SUCCESS)
    return val::null();
#ifdef __EMSCRIPTEN_PTHREADS__
  runner.reset(JxlThreadParallelRunnerCreate(nullptr,
      JxlThreadParallelRunnerDefaultNumWorkerThreads()));
  if (!runner || JxlEncoderSetParallelRunner(encoder.get(),
          JxlThreadParallelRunner, runner.get()) != JXL_ENC_SUCCESS)
    return val::null();
#endif

  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize = width;
  info.ysize = height;
  info.bits_per_sample = 8;
  info.num_color_channels = 3;
  info.num_extra_channels = 1;
  info.alpha_bits = 8;
  info.alpha_premultiplied = JXL_FALSE;
  // With false, this pinned API assumes UINT8 input is sRGB, regardless of ICC.
  // Only explicitly sRGB lossy input uses XYB; custom-target samples never do.
  info.uses_original_profile = inputIsSrgb && !lossless ? JXL_FALSE : JXL_TRUE;
  if (JxlEncoderSetBasicInfo(encoder.get(), &info) != JXL_ENC_SUCCESS ||
      JxlEncoderSetICCProfile(encoder.get(),
          reinterpret_cast<const uint8_t*>(icc.data()), icc.size()) !=
          JXL_ENC_SUCCESS) return val::null();

  auto* settings = JxlEncoderFrameSettingsCreate(encoder.get(), nullptr);
  if (!settings) return val::null();
  const float distance = quality >= 30 ? 0.1f + (100 - quality) * 0.09f
      : 6.4f + std::pow(2.5f, (30 - quality) / 5.0f) / 6.25f;
  if (JxlEncoderFrameSettingsSetOption(settings,
          JXL_ENC_FRAME_SETTING_EFFORT, effort) != JXL_ENC_SUCCESS ||
      JxlEncoderFrameSettingsSetOption(settings,
          JXL_ENC_FRAME_SETTING_MODULAR, modular ? 1 : 0) != JXL_ENC_SUCCESS ||
      JxlEncoderFrameSettingsSetOption(settings,
          JXL_ENC_FRAME_SETTING_KEEP_INVISIBLE, 1) != JXL_ENC_SUCCESS ||
      JxlEncoderSetFrameDistance(settings, std::min(distance, 25.0f)) != JXL_ENC_SUCCESS ||
      JxlEncoderSetFrameLossless(settings, lossless ? JXL_TRUE : JXL_FALSE) !=
          JXL_ENC_SUCCESS) return val::null();

  const JxlPixelFormat format = {4, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
  if (JxlEncoderAddImageFrame(settings, &format, pixels.data(), pixels.size()) !=
      JXL_ENC_SUCCESS) return val::null();
  if (!exif.empty()) {
    if (exif.size() > exif.max_size() - 4) return val::null();
    // Exif box contents start with a big-endian TIFF-header offset, measured
    // after these four bytes. The supplied payload already starts at TIFF.
    std::string box(4, '\0');
    box += exif;
    if (JxlEncoderAddBox(encoder.get(), "Exif", reinterpret_cast<const uint8_t*>(box.data()),
            box.size(), JXL_FALSE) != JXL_ENC_SUCCESS) return val::null();
  }
  // The pinned tool implementation uses lowercase "xml ", despite the old
  // public header's uppercase spelling. This is the standard XMP box type.
  if (!xmp.empty() && JxlEncoderAddBox(encoder.get(), "xml ",
          reinterpret_cast<const uint8_t*>(xmp.data()), xmp.size(), JXL_FALSE) != JXL_ENC_SUCCESS)
    return val::null();
  JxlEncoderCloseInput(encoder.get());
  std::vector<uint8_t> output(16384);
  size_t used = 0;
  for (;;) {
    uint8_t* next = output.data() + used;
    size_t available = output.size() - used;
    const auto status = JxlEncoderProcessOutput(encoder.get(), &next, &available);
    used = output.size() - available;
    if (status == JXL_ENC_SUCCESS) break;
    if (status != JXL_ENC_NEED_MORE_OUTPUT ||
        output.size() > output.max_size() / 2) return val::null();
    output.resize(output.size() * 2);
  }
  return val::global("Uint8Array").new_(
      emscripten::typed_memory_view(used, output.data()));
}

val encodeColorWithMetadata(std::string pixels, int width, int height, std::string icc,
                            float quality, bool lossless, int effort, bool inputIsSrgb,
                            std::string exif, std::string xmp) {
  return encodeColorImpl(pixels, width, height, icc, quality, lossless, effort,
                         inputIsSrgb, false, exif, xmp);
}

val encodeColor(std::string pixels, int width, int height, std::string icc,
                float quality, bool lossless, int effort, bool inputIsSrgb) {
  return encodeColorImpl(pixels, width, height, icc, quality, lossless, effort,
                         inputIsSrgb, false);
}

#ifdef OPENLR_JXL_EXPERIMENTS
val encodeColorExperiment(std::string pixels, int width, int height,
                          std::string icc, float quality, bool lossless,
                          int effort, bool inputIsSrgb, bool modular) {
  return encodeColorImpl(pixels, width, height, icc, quality, lossless, effort,
                         inputIsSrgb, modular);
}
#endif

val buildFeatures() {
  auto result = val::object();
  result.set("encoderVersion", JxlEncoderVersion());
#ifdef __EMSCRIPTEN_PTHREADS__
  result.set("threads", true);
#else
  result.set("threads", false);
#endif
#ifdef __wasm_simd128__
  result.set("simd", true);
#else
  result.set("simd", false);
#endif
  return result;
}

EMSCRIPTEN_BINDINGS(openlr_jxl_color_encoder) {
  emscripten::function("encodeColor", &encodeColor);
  emscripten::function("encodeColorWithMetadata", &encodeColorWithMetadata);
#ifdef OPENLR_JXL_EXPERIMENTS
  emscripten::function("encodeColorExperiment", &encodeColorExperiment);
#endif
  emscripten::function("buildFeatures", &buildFeatures);
}
