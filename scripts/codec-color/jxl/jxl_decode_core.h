// OpenLR shared public-API decoder core. No color conversion or quantization.
#ifndef OPENLR_JXL_DECODE_CORE_H
#define OPENLR_JXL_DECODE_CORE_H

#include <jxl/decode.h>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <vector>

struct OpenLRJxlDecoded {
  JxlBasicInfo info{};
  JxlColorEncoding originalColor{}, dataColor{};
  bool hasOriginalColor = false, hasDataColor = false;
  std::vector<uint8_t> originalICC, dataICC;
  std::vector<float> pixels;
};

inline bool OpenLRJxlICC(JxlDecoder* decoder, const JxlPixelFormat& format,
                       JxlColorProfileTarget target, std::vector<uint8_t>& out) {
  size_t size;
  if (JxlDecoderGetICCProfileSize(decoder, &format, target, &size) != JXL_DEC_SUCCESS)
    return false;
  out.resize(size);
  return JxlDecoderGetColorAsICCProfile(decoder, &format, target, out.data(), size)
      == JXL_DEC_SUCCESS;
}

inline bool OpenLRDecodeJxl(const std::string& bytes, OpenLRJxlDecoded& out) {
  std::unique_ptr<JxlDecoder, decltype(&JxlDecoderDestroy)> decoder(
      JxlDecoderCreate(nullptr), JxlDecoderDestroy);
  if (!decoder || JxlDecoderSubscribeEvents(decoder.get(),
          JXL_DEC_BASIC_INFO | JXL_DEC_COLOR_ENCODING | JXL_DEC_FULL_IMAGE)
          != JXL_DEC_SUCCESS ||
      JxlDecoderSetInput(decoder.get(), reinterpret_cast<const uint8_t*>(bytes.data()),
          bytes.size()) != JXL_DEC_SUCCESS) return false;
  JxlDecoderCloseInput(decoder.get());
  const JxlPixelFormat format = {4, JXL_TYPE_FLOAT, JXL_NATIVE_ENDIAN, 0};
  bool basic = false, color = false, buffer = false;
  for (;;) {
    const auto status = JxlDecoderProcessInput(decoder.get());
    if (status == JXL_DEC_BASIC_INFO) {
      if (JxlDecoderGetBasicInfo(decoder.get(), &out.info) != JXL_DEC_SUCCESS ||
          !out.info.xsize || !out.info.ysize ||
          (out.info.num_color_channels != 1 && out.info.num_color_channels != 3) ||
          static_cast<size_t>(out.info.xsize) > std::numeric_limits<size_t>::max() /
              static_cast<size_t>(out.info.ysize) / 4 / sizeof(float)) return false;
      basic = true;
    } else if (status == JXL_DEC_COLOR_ENCODING) {
      if (!basic) return false;
      OpenLRJxlICC(decoder.get(), format, JXL_COLOR_PROFILE_TARGET_ORIGINAL, out.originalICC);
      if (!OpenLRJxlICC(decoder.get(), format, JXL_COLOR_PROFILE_TARGET_DATA, out.dataICC))
        return false;
      out.hasOriginalColor = JxlDecoderGetColorAsEncodedProfile(decoder.get(), &format,
          JXL_COLOR_PROFILE_TARGET_ORIGINAL, &out.originalColor) == JXL_DEC_SUCCESS;
      out.hasDataColor = JxlDecoderGetColorAsEncodedProfile(decoder.get(), &format,
          JXL_COLOR_PROFILE_TARGET_DATA, &out.dataColor) == JXL_DEC_SUCCESS;
      color = true;
    } else if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t size;
      const size_t samples = static_cast<size_t>(out.info.xsize) * out.info.ysize * 4;
      if (!basic || !color || buffer ||
          JxlDecoderImageOutBufferSize(decoder.get(), &format, &size) != JXL_DEC_SUCCESS ||
          size != samples * sizeof(float)) return false;
      out.pixels.resize(samples);
      if (JxlDecoderSetImageOutBuffer(decoder.get(), &format, out.pixels.data(), size)
          != JXL_DEC_SUCCESS) return false;
      buffer = true;
    } else if (status == JXL_DEC_FULL_IMAGE) {
      // The published decoder returns the first coalesced display frame too.
      // Defaults apply codestream orientation; do not apply EXIF a second time.
      return basic && color && buffer;
    } else {
      return false;
    }
  }
}
#endif
