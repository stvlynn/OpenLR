// Adapted from jSquash b7fa9ac9ec02f224847ad23d19d115f9e296a368,
// packages/avif/codec/enc/avif_enc.cpp. Copyright Google and Jamie Sinclair.
// Licensed under Apache-2.0; see LICENSE.jsquash.
// OpenLR changes: ICC/CICP/range, optional Exif/XMP, and input validation.
#include <emscripten/bind.h>
#include <emscripten/threading.h>
#include <emscripten/val.h>
#include "avif/avif.h"

#include <memory>
#include <limits>
#include <string>

#define RETURN_NULL_IF(expression) \
  do {                             \
    if (expression)                \
      return val::null();          \
  } while (false)

using namespace emscripten;

using AvifImagePtr = std::unique_ptr<avifImage, decltype(&avifImageDestroy)>;
using AvifEncoderPtr = std::unique_ptr<avifEncoder, decltype(&avifEncoderDestroy)>;

struct AvifOptions {
  // [0 - 100]
  // 0 = worst quality
  // 100 = lossless
  int quality;
  // As above, but -1 means 'use quality'
  int qualityAlpha;
  // [0 - 6]
  // Creates 2^n tiles in that dimension
  int tileRowsLog2;
  int tileColsLog2;
  // [0 - 10]
  // 0 = slowest
  // 10 = fastest
  int speed;
  // 0 = 4:0:0
  // 1 = 4:2:0
  // 2 = 4:2:2
  // 3 = 4:4:4
  int subsample;
  // Extra chroma compression
  bool chromaDeltaQ;
  // 0-7
  int sharpness;
  // 0 = auto
  // 1 = PSNR
  // 2 = SSIM
  int tune;
  // 0-50
  int denoiseLevel;
  // toggles AVIF_CHROMA_DOWNSAMPLING_SHARP_YUV
  bool enableSharpYUV;
  // 8, 10, or 12 bit depth
  int bitDepth;
  // ICC describes native input RGB; libavif only performs the YUV transform.
  std::string icc;
  int colorPrimaries;
  int transferCharacteristics;
  // -1 retains upstream's identity (lossless) / BT.601 (lossy) choice.
  int matrixCoefficients;
  bool fullRange;
};

thread_local const val Uint8Array = val::global("Uint8Array");

val encodeImpl(std::string buffer, int width, int height, AvifOptions options,
               const std::string& exif, const std::string& xmp) {
  avifResult status;  // To check the return status for avif API's

  int depth = options.bitDepth;
  RETURN_NULL_IF(width <= 0 || height <= 0);
  RETURN_NULL_IF(options.subsample < 0 || options.subsample > 3);
  RETURN_NULL_IF(options.colorPrimaries < 0 || options.colorPrimaries > 255);
  RETURN_NULL_IF(options.transferCharacteristics < 0 || options.transferCharacteristics > 255);
  RETURN_NULL_IF(options.matrixCoefficients < -1 || options.matrixCoefficients > 255);
  if (depth != 8 && depth != 10 && depth != 12) {
    EM_ASM({
      throw new Error("Invalid bit depth. Supported values are 8, 10, or 12.");
    });
    return val::null();
  }

  const size_t bytesPerPixel = depth > 8 ? 8 : 4;
  RETURN_NULL_IF(static_cast<size_t>(width) > std::numeric_limits<uint32_t>::max() / bytesPerPixel);
  const size_t rowBytes = static_cast<size_t>(width) * bytesPerPixel;
  RETURN_NULL_IF(static_cast<size_t>(height) > std::numeric_limits<size_t>::max() / rowBytes);
  RETURN_NULL_IF(buffer.size() != rowBytes * static_cast<size_t>(height));

  avifPixelFormat format;
  switch (options.subsample) {
    case 0:
      format = AVIF_PIXEL_FORMAT_YUV400;
      break;
    case 1:
      format = AVIF_PIXEL_FORMAT_YUV420;
      break;
    case 2:
      format = AVIF_PIXEL_FORMAT_YUV422;
      break;
    case 3:
      format = AVIF_PIXEL_FORMAT_YUV444;
      break;
  }

  bool lossless = options.quality == AVIF_QUALITY_LOSSLESS &&
                  (options.qualityAlpha == -1 || options.qualityAlpha == AVIF_QUALITY_LOSSLESS) &&
                  format == AVIF_PIXEL_FORMAT_YUV444;

  // Smart pointer for the input image in YUV format
  AvifImagePtr image(avifImageCreate(width, height, depth, format), avifImageDestroy);
  RETURN_NULL_IF(image == nullptr);

  image->colorPrimaries = static_cast<avifColorPrimaries>(options.colorPrimaries);
  image->transferCharacteristics = static_cast<avifTransferCharacteristics>(options.transferCharacteristics);
  image->yuvRange = options.fullRange ? AVIF_RANGE_FULL : AVIF_RANGE_LIMITED;
  RETURN_NULL_IF(lossless && !options.fullRange);
  RETURN_NULL_IF(lossless && options.matrixCoefficients > 0);
  status = avifImageSetProfileICC(image.get(), reinterpret_cast<const uint8_t*>(options.icc.data()), options.icc.size());
  RETURN_NULL_IF(status != AVIF_RESULT_OK);
  if (!exif.empty()) {
    status = avifImageSetMetadataExif(image.get(), reinterpret_cast<const uint8_t*>(exif.data()), exif.size());
    RETURN_NULL_IF(status != AVIF_RESULT_OK);
  }
  if (!xmp.empty()) {
    status = avifImageSetMetadataXMP(image.get(), reinterpret_cast<const uint8_t*>(xmp.data()), xmp.size());
    RETURN_NULL_IF(status != AVIF_RESULT_OK);
  }
  if (options.matrixCoefficients >= 0) {
    image->matrixCoefficients = static_cast<avifMatrixCoefficients>(options.matrixCoefficients);
  } else if (lossless) {
    image->matrixCoefficients = AVIF_MATRIX_COEFFICIENTS_IDENTITY;
  } else {
    image->matrixCoefficients = AVIF_MATRIX_COEFFICIENTS_BT601;
  }

  avifRGBImage srcRGB;
  avifRGBImageSetDefaults(&srcRGB, image.get());

  uint8_t* rgba = reinterpret_cast<uint8_t*>(const_cast<char*>(buffer.data()));
  srcRGB.pixels = rgba;

  srcRGB.depth = depth;
  srcRGB.rowBytes = static_cast<uint32_t>(rowBytes);

  if (options.enableSharpYUV) {
    srcRGB.chromaDownsampling = AVIF_CHROMA_DOWNSAMPLING_SHARP_YUV;
  }
  status = avifImageRGBToYUV(image.get(), &srcRGB);
  RETURN_NULL_IF(status != AVIF_RESULT_OK);

  // Create a smart pointer for the encoder
  AvifEncoderPtr encoder(avifEncoderCreate(), avifEncoderDestroy);
  RETURN_NULL_IF(encoder == nullptr);

  if (lossless) {
    encoder->quality = AVIF_QUALITY_LOSSLESS;
    encoder->qualityAlpha = AVIF_QUALITY_LOSSLESS;
  } else {
    status = avifEncoderSetCodecSpecificOption(encoder.get(), "sharpness",
                                               std::to_string(options.sharpness).c_str());
    RETURN_NULL_IF(status != AVIF_RESULT_OK);

    // Set base quality
    encoder->quality = options.quality;
    // Conditionally set alpha quality
    if (options.qualityAlpha == -1) {
      encoder->qualityAlpha = options.quality;
    } else {
      encoder->qualityAlpha = options.qualityAlpha;
    }

    if (options.tune == 2 || (options.tune == 0 && options.quality >= 50)) {
      status = avifEncoderSetCodecSpecificOption(encoder.get(), "tune", "ssim");
      RETURN_NULL_IF(status != AVIF_RESULT_OK);
    }

    if (options.chromaDeltaQ) {
      status = avifEncoderSetCodecSpecificOption(encoder.get(), "color:enable-chroma-deltaq", "1");
      RETURN_NULL_IF(status != AVIF_RESULT_OK);
    }

    status = avifEncoderSetCodecSpecificOption(encoder.get(), "color:denoise-noise-level",
                                               std::to_string(options.denoiseLevel).c_str());
    RETURN_NULL_IF(status != AVIF_RESULT_OK);
  }

  encoder->maxThreads = emscripten_num_logical_cores();
  encoder->tileRowsLog2 = options.tileRowsLog2;
  encoder->tileColsLog2 = options.tileColsLog2;
  encoder->speed = options.speed;

  avifRWData output = AVIF_DATA_EMPTY;
  avifResult encodeResult = avifEncoderWrite(encoder.get(), image.get(), &output);
  auto js_result = val::null();
  if (encodeResult == AVIF_RESULT_OK) {
    js_result = Uint8Array.new_(typed_memory_view(output.size, output.data));
  }

  avifRWDataFree(&output);
  return js_result;
}

val encode(std::string buffer, int width, int height, val options) {
  // Keep the old required options intact. Optional byte payloads are read from
  // the same JS options object without making existing callers supply fields.
  const auto metadata = [&options](const char* key) {
    const val payload = options[key];
    return payload.isUndefined() || payload.isNull() ? std::string() : payload.as<std::string>();
  };
  return encodeImpl(buffer, width, height, options.as<AvifOptions>(), metadata("exif"), metadata("xmp"));
}

EMSCRIPTEN_BINDINGS(my_module) {
  value_object<AvifOptions>("AvifOptions")
      .field("quality", &AvifOptions::quality)
      .field("qualityAlpha", &AvifOptions::qualityAlpha)
      .field("tileRowsLog2", &AvifOptions::tileRowsLog2)
      .field("tileColsLog2", &AvifOptions::tileColsLog2)
      .field("speed", &AvifOptions::speed)
      .field("chromaDeltaQ", &AvifOptions::chromaDeltaQ)
      .field("sharpness", &AvifOptions::sharpness)
      .field("tune", &AvifOptions::tune)
      .field("denoiseLevel", &AvifOptions::denoiseLevel)
      .field("subsample", &AvifOptions::subsample)
      .field("enableSharpYUV", &AvifOptions::enableSharpYUV)
      .field("bitDepth", &AvifOptions::bitDepth)
      .field("icc", &AvifOptions::icc)
      .field("colorPrimaries", &AvifOptions::colorPrimaries)
      .field("transferCharacteristics", &AvifOptions::transferCharacteristics)
      .field("matrixCoefficients", &AvifOptions::matrixCoefficients)
      .field("fullRange", &AvifOptions::fullRange);

  function("encode", &encode);
}
