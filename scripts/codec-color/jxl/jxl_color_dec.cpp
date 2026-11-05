// OpenLR original binding using public libjxl and its existing bundled skcms.
// The legacy byte policy matches fixed jSquash 1b1964194611ece3ec984ab91c04726d1088f05e.
// No jSquash implementation is copied; provenance and comparisons are recorded separately.
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include "jxl_decode_core.h"
#include "skcms.h"
#include "skcms_internal.h"
#include <cmath>

using emscripten::val;

val OpenLRJxlColor(const JxlColorEncoding& color) {
  auto out = val::object();
  out.set("colorSpace", static_cast<int>(color.color_space));
  out.set("whitePoint", static_cast<int>(color.white_point));
  out.set("whitePointXY", val::array(std::vector<double>(color.white_point_xy, color.white_point_xy + 2)));
  out.set("primaries", static_cast<int>(color.primaries));
  out.set("redXY", val::array(std::vector<double>(color.primaries_red_xy, color.primaries_red_xy + 2)));
  out.set("greenXY", val::array(std::vector<double>(color.primaries_green_xy, color.primaries_green_xy + 2)));
  out.set("blueXY", val::array(std::vector<double>(color.primaries_blue_xy, color.primaries_blue_xy + 2)));
  out.set("transferFunction", static_cast<int>(color.transfer_function));
  out.set("gamma", color.gamma);
  out.set("renderingIntent", static_cast<int>(color.rendering_intent));
  return out;
}
val OpenLRJxlBytes(const std::vector<uint8_t>& bytes) {
  return val::global("Uint8Array").new_(emscripten::typed_memory_view(bytes.size(), bytes.data()));
}
val OpenLRJxlMetadata(const OpenLRJxlDecoded& decoded) {
  const auto& info = decoded.info;
  auto out = val::object();
  out.set("width", info.xsize); out.set("height", info.ysize);
  out.set("sourceBits", info.bits_per_sample);
  out.set("sourceExponentBits", info.exponent_bits_per_sample);
  out.set("alphaBits", info.alpha_bits);
  out.set("alphaExponentBits", info.alpha_exponent_bits);
  out.set("sourceAlphaPremultiplied", static_cast<bool>(info.alpha_premultiplied));
  out.set("usesOriginalProfile", static_cast<bool>(info.uses_original_profile));
  out.set("intensityTarget", info.intensity_target);
  out.set("minNits", info.min_nits);
  out.set("relativeToMaxDisplay", static_cast<bool>(info.relative_to_max_display));
  out.set("linearBelow", info.linear_below);
  out.set("numColorChannels", info.num_color_channels);
  out.set("numExtraChannels", info.num_extra_channels);
  out.set("animated", static_cast<bool>(info.have_animation));
  out.set("orientation", static_cast<int>(info.orientation));
  out.set("originalICC", OpenLRJxlBytes(decoded.originalICC));
  out.set("dataICC", OpenLRJxlBytes(decoded.dataICC));
  out.set("originalColorEncoding", decoded.hasOriginalColor ? OpenLRJxlColor(decoded.originalColor) : val::null());
  out.set("dataColorEncoding", decoded.hasDataColor ? OpenLRJxlColor(decoded.dataColor) : val::null());
  out.set("alphaMode", std::string("straight"));
  out.set("decodedFrame", std::string("first"));
  return out;
}

bool OpenLRJxlLegacyPixels(const OpenLRJxlDecoded& decoded, const skcms_ICCProfile& source,
                          std::vector<uint8_t>& pixels) {
  pixels.resize(decoded.pixels.size());
  // Preserve the published decoder's alpha policy even for associated sources.
  return skcms_Transform(decoded.pixels.data(), skcms_PixelFormat_RGBA_ffff,
      decoded.info.alpha_premultiplied ? skcms_AlphaFormat_PremulAsEncoded : skcms_AlphaFormat_Unpremul,
      &source, pixels.data(), skcms_PixelFormat_RGBA_8888,
      skcms_AlphaFormat_Unpremul, skcms_sRGB_profile(), pixels.size() / 4);
}
val OpenLRJxlDisplay(const OpenLRJxlDecoded& decoded, const skcms_ICCProfile& source) {
  std::vector<uint8_t> pixels;
  if (!OpenLRJxlLegacyPixels(decoded, source, pixels)) return val::null();
  auto result = OpenLRJxlMetadata(decoded);
  result.set("data", val::global("Uint8ClampedArray").new_(
      emscripten::typed_memory_view(pixels.size(), pixels.data())));
  result.set("colorSpace", std::string("srgb"));
  return result;
}
uint32_t OpenLRJxlXYZLutType(const skcms_ICCProfile& source) {
  if (!source.has_A2B || source.pcs != skcms_Signature_XYZ)
    return 0;
  skcms_ICCTag selected;
  // Match this pinned parser's selected A2B0, otherwise A2B1, without another
  // ICC directory parser. Parse rejects malformed A2B0 before this function;
  // it does not choose A2B1 over an invalid A2B0. Other LUT types differ.
  if (!skcms_GetTagBySignature(&source, 0x41324230, &selected) &&
      !skcms_GetTagBySignature(&source, 0x41324231, &selected)) return 0;
  return selected.type;
}

val decode(std::string bytes) {
  OpenLRJxlDecoded decoded;
  skcms_ICCProfile source;
  if (!OpenLRDecodeJxl(bytes, decoded) ||
      !skcms_Parse(decoded.dataICC.data(), decoded.dataICC.size(), &source)) return val::null();
  return OpenLRJxlDisplay(decoded, source);
}

val decodeWorking(std::string bytes) {
  OpenLRJxlDecoded decoded;
  skcms_ICCProfile source;
  if (!OpenLRDecodeJxl(bytes, decoded) ||
      !skcms_Parse(decoded.dataICC.data(), decoded.dataICC.size(), &source)) return val::null();
  bool outsideRange = false, bounded = source.has_A2B;
  for (const auto& curve : source.trc) bounded = bounded || curve.table_entries > 0;
  for (size_t i = 0; i < decoded.pixels.size(); i++) {
    const float value = decoded.pixels[i];
    if (!std::isfinite(value)) return val::null();
    if (i % 4 != 3 && (value < 0 || value > 1)) outsideRange = true;
  }
  const auto hdr = [](bool present, const JxlColorEncoding& encoding) {
    return present && (encoding.transfer_function == JXL_TRANSFER_FUNCTION_PQ ||
        encoding.transfer_function == JXL_TRANSFER_FUNCTION_HLG);
  };
  const uint32_t xyzLutType = OpenLRJxlXYZLutType(source);
  const char* compatibility = hdr(decoded.hasOriginalColor, decoded.originalColor) ||
      hdr(decoded.hasDataColor, decoded.dataColor) ? "jxl-hdr-transfer" :
      xyzLutType == 0x6d667431 ? "jxl-profile-unsupported" : // mft1 XYZ is not standardized.
      outsideRange && bounded ? "jxl-profile-range" : nullptr;
  if (compatibility) {
    auto result = OpenLRJxlDisplay(decoded, source);
    if (!result.isNull()) {
      result.set("compatibilityReason", std::string(compatibility));
      result.set("profileTransform", std::string(source.has_A2B ? "lut" : "matrix-trc"));
    }
    return result;
  }
  skcms_ICCProfile target = *skcms_sRGB_profile();
  skcms_SetTransferFunction(&target, skcms_Identity_TransferFunction());
  const bool normalizeXYZ = xyzLutType == 0x6d414220 || xyzLutType == 0x6d667432; // mAB or mft2.
  skcms_ICCProfile workingSource = source;
  if (xyzLutType == 0x6d414220 && workingSource.A2B.matrix_channels == 3) {
    // Pinned skcms inserts encoded-PCS normalization before B curves. Undo it
    // in this parsed matrix, then apply normalization after those curves below.
    for (auto& row : workingSource.A2B.matrix.vals)
      for (float& value : row) value /= 65535.0f / 32768.0f;
  }
  if (!skcms_Transform(decoded.pixels.data(), skcms_PixelFormat_RGBA_ffff,
          skcms_AlphaFormat_Unpremul, &workingSource, decoded.pixels.data(),
          skcms_PixelFormat_RGBA_ffff, skcms_AlphaFormat_Unpremul,
          &target, decoded.pixels.size() / 4)) return val::null();
  if (normalizeXYZ) {
    // Apply XYZ's encoded-PCS scale after B curves and the linear RGB matrix;
    // these operations commute. Alpha and the legacy byte policy stay intact.
    for (size_t i = 0; i < decoded.pixels.size(); i++)
      if (i % 4 != 3) decoded.pixels[i] *= 65535.0f / 32768.0f;
  }
  for (const float sample : decoded.pixels) if (!std::isfinite(sample)) return val::null();
  auto result = OpenLRJxlMetadata(decoded);
  result.set("data", val::global("Float32Array").new_(
      emscripten::typed_memory_view(decoded.pixels.size(), decoded.pixels.data())));
  result.set("colorSpace", std::string("srgb-linear"));
  result.set("colorTransform", std::string("skcms-float"));
  result.set("profileTransform", std::string(source.has_A2B ? "lut" : "matrix-trc"));
  if (normalizeXYZ) result.set("profileCorrection", std::string("xyz-lut-output-scale"));
  return result;
}

EMSCRIPTEN_BINDINGS(openlr_jxl_decoder) {
  emscripten::function("decode", &decode);
  emscripten::function("decodeWorking", &decodeWorking);
}
