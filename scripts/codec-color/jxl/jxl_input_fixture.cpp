// Validation-only original fixture encoder. Never installed as a runtime asset.
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <jxl/encode.h>
#include <cstdint>
#include <cmath>
#include <limits>
#include <memory>
#include <string>
#include <vector>

using emscripten::val;
struct FixtureOptions {
  uint32_t bitsPerSample, exponentBitsPerSample, numColorChannels;
  uint32_t alphaBits, alphaExponentBits;
  bool alphaPremultiplied, usesOriginalProfile;
  int orientation, structuredTransfer;
  float intensityTarget;
  bool lossless;
};
val finish(JxlEncoder* encoder) {
  JxlEncoderCloseInput(encoder);
  std::vector<uint8_t> bytes(4096);
  size_t used = 0;
  for (;;) {
    uint8_t* next = bytes.data() + used;
    size_t remaining = bytes.size() - used;
    const auto status = JxlEncoderProcessOutput(encoder, &next, &remaining);
    used = bytes.size() - remaining;
    if (status == JXL_ENC_SUCCESS) {
      return val::global("Uint8Array").new_(emscripten::typed_memory_view(used, bytes.data()));
    }
    if (status != JXL_ENC_NEED_MORE_OUTPUT || bytes.size() > std::numeric_limits<size_t>::max() / 2)
      return val::null();
    bytes.resize(bytes.size() * 2);
  }
}
bool configure(JxlEncoder* encoder, JxlBasicInfo& info, const std::string& icc,
               const FixtureOptions& options) {
  info.bits_per_sample = options.bitsPerSample;
  info.exponent_bits_per_sample = options.exponentBitsPerSample;
  info.num_color_channels = options.numColorChannels;
  info.num_extra_channels = options.alphaBits ? 1 : 0;
  info.alpha_bits = options.alphaBits;
  info.alpha_exponent_bits = options.alphaExponentBits;
  info.alpha_premultiplied = options.alphaPremultiplied;
  info.uses_original_profile = options.usesOriginalProfile;
  info.orientation = static_cast<JxlOrientation>(options.orientation);
  info.intensity_target = options.intensityTarget;
  if (JxlEncoderSetBasicInfo(encoder, &info) != JXL_ENC_SUCCESS) return false;
  // This pinned AddImageFrame imports only straight buffers. Associated fixture
  // samples are queued as-is, then their shared channel metadata is tagged
  // before ProcessOutput below. No production or pinned source is modified.
  if (options.alphaBits) {
    JxlExtraChannelInfo alpha;
    JxlEncoderInitExtraChannelInfo(JXL_CHANNEL_ALPHA, &alpha);
    alpha.bits_per_sample = options.alphaBits;
    alpha.exponent_bits_per_sample = options.alphaExponentBits;
    alpha.alpha_premultiplied = JXL_FALSE;
    if (JxlEncoderSetExtraChannelInfo(encoder, 0, &alpha) != JXL_ENC_SUCCESS) return false;
  }
  if (options.structuredTransfer < 0) {
    return !icc.empty() && JxlEncoderSetICCProfile(encoder,
        reinterpret_cast<const uint8_t*>(icc.data()), icc.size()) == JXL_ENC_SUCCESS;
  }
  JxlColorEncoding encoding;
  JxlColorEncodingSetToSRGB(&encoding, options.numColorChannels == 1);
  encoding.transfer_function = static_cast<JxlTransferFunction>(options.structuredTransfer);
  if (options.structuredTransfer == 16 || options.structuredTransfer == 18)
    encoding.primaries = JXL_PRIMARIES_2100;
  return JxlEncoderSetColorEncoding(encoder, &encoding) == JXL_ENC_SUCCESS;
}
JxlEncoderFrameSettings* settings(JxlEncoder* encoder, bool lossless) {
  auto* result = JxlEncoderFrameSettingsCreate(encoder, nullptr);
  if (!result || JxlEncoderFrameSettingsSetOption(result, JXL_ENC_FRAME_SETTING_EFFORT, 3) != JXL_ENC_SUCCESS ||
      JxlEncoderFrameSettingsSetOption(result, JXL_ENC_FRAME_SETTING_KEEP_INVISIBLE, 1) != JXL_ENC_SUCCESS ||
      JxlEncoderSetFrameDistance(result, lossless ? 0 : 1) != JXL_ENC_SUCCESS ||
      JxlEncoderSetFrameLossless(result, lossless) != JXL_ENC_SUCCESS) return nullptr;
  return result;
}
val encodeFixture(std::string bytes, uint32_t width, uint32_t height,
                  std::string icc, FixtureOptions options) {
  const uint32_t channels = options.numColorChannels + (options.alphaBits ? 1 : 0),
      sampleBytes = options.exponentBitsPerSample ? 4 : 2;
  if (!width || !height || (options.numColorChannels != 1 && options.numColorChannels != 3) ||
      options.orientation < 1 || options.orientation > 8 ||
      !std::isfinite(options.intensityTarget) || options.intensityTarget <= 0 ||
      static_cast<size_t>(width) > std::numeric_limits<size_t>::max() / height / channels / sampleBytes ||
      bytes.size() != static_cast<size_t>(width) * height * channels * sampleBytes) return val::null();
  std::unique_ptr<JxlEncoder, decltype(&JxlEncoderDestroy)> encoder(JxlEncoderCreate(nullptr), JxlEncoderDestroy);
  if (!encoder) return val::null();
  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info); info.xsize = width; info.ysize = height;
  if (!configure(encoder.get(), info, icc, options)) return val::null();
  auto* frame = settings(encoder.get(), options.lossless);
  const JxlPixelFormat format = {channels, options.exponentBitsPerSample ? JXL_TYPE_FLOAT : JXL_TYPE_UINT16, JXL_NATIVE_ENDIAN, 0};
  if (!frame || JxlEncoderAddImageFrame(frame, &format, bytes.data(), bytes.size()) != JXL_ENC_SUCCESS)
    return val::null();
  if (options.alphaBits && options.alphaPremultiplied) {
    JxlExtraChannelInfo alpha;
    JxlEncoderInitExtraChannelInfo(JXL_CHANNEL_ALPHA, &alpha);
    alpha.bits_per_sample = options.alphaBits;
    alpha.exponent_bits_per_sample = options.alphaExponentBits;
    alpha.alpha_premultiplied = JXL_TRUE;
    if (JxlEncoderSetExtraChannelInfo(encoder.get(), 0, &alpha) != JXL_ENC_SUCCESS) return val::null();
  }
  return finish(encoder.get());
}
val encodeAnimationFixture() {
  std::unique_ptr<JxlEncoder, decltype(&JxlEncoderDestroy)> encoder(JxlEncoderCreate(nullptr), JxlEncoderDestroy);
  if (!encoder) return val::null();
  JxlBasicInfo info; JxlEncoderInitBasicInfo(&info);
  info.xsize = 2; info.ysize = 1; info.have_animation = JXL_TRUE;
  info.animation.tps_numerator = 10; info.animation.tps_denominator = 1;
  const FixtureOptions options{16,0,3,16,0,false,true,1,13,255,true};
  if (!configure(encoder.get(), info, "", options)) return val::null();
  const JxlPixelFormat format{4,JXL_TYPE_UINT16,JXL_NATIVE_ENDIAN,0};
  const uint16_t samples[2][8] = {{65535,0,0,65535,65535,0,0,65535},{0,65535,0,65535,0,65535,0,65535}};
  for (const auto& pixels : samples) {
    auto* frame = settings(encoder.get(), true);
    JxlFrameHeader header; JxlEncoderInitFrameHeader(&header); header.duration = 1;
    if (!frame || JxlEncoderSetFrameHeader(frame, &header) != JXL_ENC_SUCCESS ||
        JxlEncoderAddImageFrame(frame, &format, pixels, sizeof(pixels)) != JXL_ENC_SUCCESS) return val::null();
  }
  return finish(encoder.get());
}
EMSCRIPTEN_BINDINGS(openlr_jxl_fixture) {
  emscripten::value_object<FixtureOptions>("FixtureOptions")
    .field("bitsPerSample", &FixtureOptions::bitsPerSample)
    .field("exponentBitsPerSample", &FixtureOptions::exponentBitsPerSample)
    .field("numColorChannels", &FixtureOptions::numColorChannels)
    .field("alphaBits", &FixtureOptions::alphaBits)
    .field("alphaExponentBits", &FixtureOptions::alphaExponentBits)
    .field("alphaPremultiplied", &FixtureOptions::alphaPremultiplied)
    .field("usesOriginalProfile", &FixtureOptions::usesOriginalProfile)
    .field("orientation", &FixtureOptions::orientation)
    .field("structuredTransfer", &FixtureOptions::structuredTransfer)
    .field("intensityTarget", &FixtureOptions::intensityTarget)
    .field("lossless", &FixtureOptions::lossless);
  emscripten::function("encodeFixture", &encodeFixture);
  emscripten::function("encodeAnimationFixture", &encodeAnimationFixture);
}
