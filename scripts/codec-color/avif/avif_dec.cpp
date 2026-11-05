// Adapted from jSquash b7fa9ac9ec02f224847ad23d19d115f9e296a368,
// packages/avif/codec/dec/avif_dec.cpp. Copyright Google and Jamie Sinclair.
// Licensed under Apache-2.0; see LICENSE.jsquash.
// OpenLR changes: expose native RGB with ICC/CICP, check conversion failures.
#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <memory>
#include <string>
#include <utility>
#include "avif/avif.h"

using namespace emscripten;
thread_local const val Uint8ClampedArray = val::global("Uint8ClampedArray");
thread_local const val Uint16Array = val::global("Uint16Array");
thread_local const val Uint8Array = val::global("Uint8Array");
thread_local const val ImageData = val::global("ImageData");
thread_local const val Object = val::global("Object");

val decodeInternal(std::string bytes, uint32_t bitDepth, bool withColor) {
  if (bitDepth != 8 && bitDepth != 10 && bitDepth != 12 && bitDepth != 16) return val::null();
  std::unique_ptr<avifImage, decltype(&avifImageDestroy)> image(avifImageCreateEmpty(), avifImageDestroy);
  std::unique_ptr<avifDecoder, decltype(&avifDecoderDestroy)> decoder(avifDecoderCreate(), avifDecoderDestroy);
  if (!image || !decoder) return val::null();
  if (avifDecoderReadMemory(decoder.get(), image.get(), reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size()) != AVIF_RESULT_OK) return val::null();
  decoder.reset();

  avifRGBImage rgb;
  avifRGBImageSetDefaults(&rgb, image.get());
  rgb.depth = bitDepth;
  if (avifRGBImageAllocatePixels(&rgb) != AVIF_RESULT_OK) return val::null();
  if (avifImageYUVToRGB(image.get(), &rgb) != AVIF_RESULT_OK) {
    avifRGBImageFreePixels(&rgb);
    return val::null();
  }
  val pixels = bitDepth == 8
      ? Uint8ClampedArray.new_(typed_memory_view(static_cast<size_t>(rgb.rowBytes) * rgb.height, rgb.pixels))
      : Uint16Array.new_(typed_memory_view(static_cast<size_t>(rgb.width) * rgb.height * 4, reinterpret_cast<uint16_t*>(rgb.pixels)));
  val result = Object.new_();
  if (withColor || bitDepth != 8) {
    // Native RGB code values require caller color management before display.
    result.set("data", pixels);
    result.set("width", rgb.width);
    result.set("height", rgb.height);
  } else {
    result = ImageData.new_(pixels, rgb.width, rgb.height);
  }
  if (withColor) {
    result.set("icc", Uint8Array.new_(typed_memory_view(image->icc.size, image->icc.data)));
    result.set("colorPrimaries", static_cast<int>(image->colorPrimaries));
    result.set("transferCharacteristics", static_cast<int>(image->transferCharacteristics));
    result.set("matrixCoefficients", static_cast<int>(image->matrixCoefficients));
    result.set("fullRange", image->yuvRange == AVIF_RANGE_FULL);
    result.set("bitDepth", bitDepth);
    result.set("sourceBitDepth", image->depth);
  }
  avifRGBImageFreePixels(&rgb);
  return result;
}
val decode(std::string bytes, uint32_t bitDepth = 8) {
  return decodeInternal(std::move(bytes), bitDepth, false);
}
val decodeWithColor(std::string bytes, uint32_t bitDepth = 8) {
  return decodeInternal(std::move(bytes), bitDepth, true);
}
EMSCRIPTEN_BINDINGS(my_module) {
  function("decode", &decode);
  function("decodeWithColor", &decodeWithColor);
}
