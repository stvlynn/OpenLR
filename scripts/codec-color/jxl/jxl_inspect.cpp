// Validation-only OpenLR binding: inspect real codestream metadata and samples.
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <jxl/decode.h>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include "jxl_decode_core.h"

using emscripten::val;
val bytes(const std::vector<uint8_t>& data) {
  return val::global("Uint8Array").new_(
      emscripten::typed_memory_view(data.size(), data.data()));
}

val inspect(std::string image) {
  std::unique_ptr<JxlDecoder, decltype(&JxlDecoderDestroy)> decoder(
      JxlDecoderCreate(nullptr), JxlDecoderDestroy);
  if (!decoder || JxlDecoderSubscribeEvents(decoder.get(),
          JXL_DEC_BASIC_INFO | JXL_DEC_COLOR_ENCODING | JXL_DEC_FULL_IMAGE) !=
          JXL_DEC_SUCCESS ||
      JxlDecoderSetInput(decoder.get(),
          reinterpret_cast<const uint8_t*>(image.data()), image.size()) !=
          JXL_DEC_SUCCESS) return val::null();
  JxlDecoderCloseInput(decoder.get());
  const JxlPixelFormat format = {4, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
  JxlBasicInfo info{};
  std::vector<uint8_t> pixels, originalICC, dataICC;
  bool complete = false;
  for (;;) {
    const auto status = JxlDecoderProcessInput(decoder.get());
    if (status == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(decoder.get(), &info) != JXL_DEC_SUCCESS)
        return val::null();
    } else if (status == JXL_DEC_COLOR_ENCODING) {
      size_t size;
      if (JxlDecoderGetICCProfileSize(decoder.get(), &format,
              JXL_COLOR_PROFILE_TARGET_ORIGINAL, &size) != JXL_DEC_SUCCESS)
        return val::null();
      originalICC.resize(size);
      if (JxlDecoderGetColorAsICCProfile(decoder.get(), &format,
              JXL_COLOR_PROFILE_TARGET_ORIGINAL, originalICC.data(), size) !=
              JXL_DEC_SUCCESS ||
          JxlDecoderGetICCProfileSize(decoder.get(), &format,
              JXL_COLOR_PROFILE_TARGET_DATA, &size) != JXL_DEC_SUCCESS)
        return val::null();
      dataICC.resize(size);
      if (JxlDecoderGetColorAsICCProfile(decoder.get(), &format,
              JXL_COLOR_PROFILE_TARGET_DATA, dataICC.data(), size) !=
              JXL_DEC_SUCCESS) return val::null();
    } else if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t size;
      if (JxlDecoderImageOutBufferSize(decoder.get(), &format, &size) !=
          JXL_DEC_SUCCESS) return val::null();
      pixels.resize(size);
      if (JxlDecoderSetImageOutBuffer(decoder.get(), &format, pixels.data(), size)
          != JXL_DEC_SUCCESS) return val::null();
    } else if (status == JXL_DEC_FULL_IMAGE) {
      complete = true;
    } else if (status == JXL_DEC_SUCCESS) {
      if (!complete) return val::null();
      auto result = val::object();
      result.set("width", info.xsize);
      result.set("height", info.ysize);
      result.set("bitsPerSample", info.bits_per_sample);
      result.set("alphaBits", info.alpha_bits);
      result.set("usesOriginalProfile", static_cast<bool>(info.uses_original_profile));
      result.set("originalICC", bytes(originalICC));
      result.set("dataICC", bytes(dataICC));
      result.set("pixels", bytes(pixels));
      return result;
    } else {
      return val::null();
    }
  }
}

val inspectFloat(std::string image) {
  OpenLRJxlDecoded decoded;
  if (!OpenLRDecodeJxl(image, decoded)) return val::null();
  auto result = val::object();
  result.set("width", decoded.info.xsize); result.set("height", decoded.info.ysize);
  result.set("sourceBits", decoded.info.bits_per_sample);
  result.set("sourceExponentBits", decoded.info.exponent_bits_per_sample);
  result.set("usesOriginalProfile", static_cast<bool>(decoded.info.uses_original_profile));
  result.set("sourceAlphaPremultiplied", static_cast<bool>(decoded.info.alpha_premultiplied));
  result.set("alphaBits", decoded.info.alpha_bits);
  result.set("alphaExponentBits", decoded.info.alpha_exponent_bits);
  result.set("intensityTarget", decoded.info.intensity_target);
  result.set("originalICC", bytes(decoded.originalICC)); result.set("dataICC", bytes(decoded.dataICC));
  result.set("originalTransferFunction", decoded.hasOriginalColor ? static_cast<int>(decoded.originalColor.transfer_function) : -1);
  result.set("dataTransferFunction", decoded.hasDataColor ? static_cast<int>(decoded.dataColor.transfer_function) : -1);
  result.set("data", val::global("Float32Array").new_(
      emscripten::typed_memory_view(decoded.pixels.size(), decoded.pixels.data())));
  return result;
}

EMSCRIPTEN_BINDINGS(openlr_jxl_inspector) {
  emscripten::function("inspect", &inspect);
  emscripten::function("inspectFloat", &inspectFloat);
}
