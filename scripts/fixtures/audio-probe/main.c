#include <AudioToolbox/AudioToolbox.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

enum { inputFrames = 9601, outputFrames = 32768, maxPackets = 64, maxEncodedBytes = 65536,
    pcmWindowStart = 6400, pcmWindowFrames = 1600 };
static const double tau = 6.283185307179586;
static const double tones[] = {333, 777};
static const OSStatus notAttempted = INT32_MIN;

typedef struct {
    const float *samples;
    UInt32 channels;
    UInt32 offset;
} PcmInput;

typedef struct {
    const uint8_t *bytes;
    AudioStreamPacketDescription description;
    UInt32 frames;
} Packet;

typedef struct {
    const Packet *packets;
    UInt32 count;
    UInt32 index;
    UInt32 channels;
    AudioStreamPacketDescription description;
} PacketInput;

static OSStatus feedPcm(AudioConverterRef converter, UInt32 *count, AudioBufferList *buffers,
    AudioStreamPacketDescription **description, void *context)
{
    (void)converter;
    PcmInput *input = context;
    UInt32 remaining = inputFrames - input->offset;
    if (*count > remaining)
        *count = remaining;
    buffers->mNumberBuffers = 1;
    buffers->mBuffers[0] = (AudioBuffer){input->channels, *count * input->channels * sizeof(float),
        *count ? (void *)(input->samples + input->offset * input->channels) : NULL};
    if (description)
        *description = NULL;
    input->offset += *count;
    return noErr;
}

static OSStatus feedPackets(AudioConverterRef converter, UInt32 *count, AudioBufferList *buffers,
    AudioStreamPacketDescription **description, void *context)
{
    (void)converter;
    PacketInput *input = context;
    buffers->mNumberBuffers = 1;
    if (!*count || input->index == input->count) {
        *count = 0;
        buffers->mBuffers[0] = (AudioBuffer){input->channels, 0, NULL};
        if (description)
            *description = NULL;
        return noErr;
    }
    const Packet *packet = &input->packets[input->index++];
    input->description = packet->description;
    *count = 1;
    buffers->mBuffers[0] = (AudioBuffer){input->channels, packet->description.mDataByteSize, (void *)packet->bytes};
    if (description)
        *description = &input->description;
    return noErr;
}

static OSStatus converterProperty(AudioConverterRef converter, AudioConverterPropertyID property, void *value, UInt32 size)
{
    return AudioConverterGetProperty(converter, property, &size, value);
}

static UInt32 opusFrames(const uint8_t *bytes, UInt32 length, UInt32 rate)
{
    if (!length)
        return 0;
    const UInt32 config = bytes[0] >> 3;
    UInt32 micros;
    if (config >= 16)
        micros = 2500u << (config & 3);
    else if (config >= 12)
        micros = 10000u << (config & 1);
    else
        micros = (config & 3) == 3 ? 60000u : 10000u << (config & 3);
    const UInt32 mode = bytes[0] & 3;
    const UInt32 frames = mode == 0 ? 1 : mode < 3 ? 2 : length >= 2 ? bytes[1] & 63 : 0;
    return (UInt32)((uint64_t)micros * frames * rate / 1000000);
}

static void printHex(const uint8_t *bytes, UInt32 size)
{
    putchar('"');
    for (UInt32 i = 0; i < size; i++)
        printf("%02x", (unsigned)bytes[i]);
    putchar('"');
}

static void printStatus(OSStatus status)
{
    if (status == notAttempted)
        printf("null");
    else
        printf("%d", (int)status);
}

static void printPrime(OSStatus status, AudioConverterPrimeInfo prime)
{
    printf("{\"status\":");
    printStatus(status);
    if (!status)
        printf(",\"leading\":%u,\"trailing\":%u", (unsigned)prime.leadingFrames, (unsigned)prime.trailingFrames);
    putchar('}');
}

static void printSignal(const float *samples, UInt32 frames, UInt32 rate, UInt32 channels)
{
    putchar('[');
    for (UInt32 channel = 0; frames && channel < channels; channel++) {
        UInt32 peakIndex = 0;
        double peak = 0;
        for (UInt32 i = rate / 8; i < frames; i++) {
            const double value = fabs(samples[i * channels + channel]);
            if (isfinite(value) && value > peak) {
                peak = value;
                peakIndex = i;
            }
        }
        const int pulseOffset = (int)peakIndex - (int)(rate * 145 / 1000);
        double sine = 0, cosine = 0;
        UInt32 count = 0;
        for (UInt32 i = rate * 50 / 1000; i < rate * 90 / 1000; i++) {
            const int source = (int)i + pulseOffset;
            if (source < 0 || (UInt32)source >= frames)
                continue;
            const double value = samples[(UInt32)source * channels + channel];
            if (!isfinite(value))
                continue;
            const double angle = tau * tones[channel] * i / rate;
            sine += value * sin(angle);
            cosine += value * cos(angle);
            count++;
        }
        const double amplitude = count ? 2 * hypot(sine, cosine) / count : 0;
        printf("%s{\"peak\":%.9g,\"pulseOffset\":%d,\"toneAmplitude\":%.9g}",
            channel ? "," : "", peak, pulseOffset, amplitude);
    }
    putchar(']');
}

typedef struct {
    const char *stage;
    OSStatus status;
    OSStatus cookieStatus;
    OSStatus setMethodStatus;
    OSStatus methodStatus;
    UInt32 method;
    OSStatus primeStatus;
    AudioConverterPrimeInfo prime;
    UInt32 frames;
    UInt32 firstFrames;
    UInt32 firstPackets;
} DecodeProbe;

static DecodeProbe decodePackets(const AudioStreamBasicDescription *compressed,
    const AudioStreamBasicDescription *pcm, const Packet *packets, UInt32 packetCount,
    const uint8_t *cookie, UInt32 cookieSize, bool noPrime, float *output)
{
    DecodeProbe result = {.stage = "decoder-create", .cookieStatus = notAttempted,
        .setMethodStatus = notAttempted, .methodStatus = notAttempted, .primeStatus = notAttempted};
    AudioConverterRef decoder = NULL;
    result.status = AudioConverterNew(compressed, pcm, &decoder);
    if (result.status)
        goto finish;
    if (cookieSize) {
        result.stage = "decoder-cookie";
        result.cookieStatus = AudioConverterSetProperty(decoder, kAudioConverterDecompressionMagicCookie, cookieSize, cookie);
        result.status = result.cookieStatus;
        if (result.status)
            goto finish;
    }
    if (noPrime) {
        const UInt32 method = kConverterPrimeMethod_None;
        result.stage = "decoder-prime-method";
        result.setMethodStatus = AudioConverterSetProperty(decoder, kAudioConverterPrimeMethod, sizeof(method), &method);
        result.status = result.setMethodStatus;
        if (result.status)
            goto finish;
    }
    result.stage = "decode";
    PacketInput input = {.packets = packets, .count = packetCount, .channels = pcm->mChannelsPerFrame};
    while (true) {
        UInt32 count = outputFrames - result.frames;
        if (!count) {
            result.status = -1;
            goto finish;
        }
        const UInt32 capacity = count;
        const UInt32 channels = pcm->mChannelsPerFrame, bytesPerFrame = pcm->mBytesPerFrame;
        AudioBufferList buffer = {1, {{channels, capacity * bytesPerFrame, output + result.frames * channels}}};
        result.status = AudioConverterFillComplexBuffer(decoder, feedPackets, &input, &count, &buffer, NULL);
        if (result.status)
            goto finish;
        if (!count)
            break;
        if (count > capacity || buffer.mBuffers[0].mDataByteSize != count * bytesPerFrame) {
            result.status = -1;
            goto finish;
        }
        if (!result.frames) {
            result.firstFrames = count;
            result.firstPackets = input.index;
        }
        result.frames += count;
    }
    if (!result.frames || input.index != packetCount) {
        result.status = -1;
        goto finish;
    }
    result.primeStatus = converterProperty(decoder, kAudioConverterPrimeInfo, &result.prime, sizeof(result.prime));
    result.stage = "complete";

finish:
    if (decoder) {
        result.methodStatus = converterProperty(decoder, kAudioConverterPrimeMethod, &result.method, sizeof(result.method));
        AudioConverterDispose(decoder);
    }
    return result;
}

static void printDecoderVariant(const char *name, DecodeProbe result, const float *output,
    UInt32 rate, UInt32 channels)
{
    printf("{\"name\":\"%s\",\"stage\":\"%s\",\"status\":%d,\"decodedFrames\":%u,"
        "\"firstFrames\":%u,\"firstPackets\":%u,\"cookieStatus\":",
        name, result.stage, (int)result.status, (unsigned)result.frames,
        (unsigned)result.firstFrames, (unsigned)result.firstPackets);
    printStatus(result.cookieStatus);
    printf(",\"setPrimeMethodStatus\":");
    printStatus(result.setMethodStatus);
    printf(",\"primeMethod\":{\"status\":");
    printStatus(result.methodStatus);
    if (!result.methodStatus)
        printf(",\"value\":%u", (unsigned)result.method);
    printf("},\"prime\":");
    printPrime(result.primeStatus, result.prime);
    printf(",\"signal\":");
    printSignal(output, result.frames, rate, channels);
    printf(",\"pcmWindowF32le\":");
    if (result.frames >= pcmWindowStart + pcmWindowFrames)
        printHex((const uint8_t *)(output + pcmWindowStart * channels), pcmWindowFrames * channels * sizeof(float));
    else
        printf("null");
    putchar('}');
}

static void probe(const char *name, AudioFormatID codec, UInt32 rate, UInt32 channels)
{
    AudioConverterRef encoder = NULL;
    uint8_t encoded[maxEncodedBytes], cookie[4096];
    float input[inputFrames * 2], output[outputFrames * 2];
    Packet packets[maxPackets];
    UInt32 packetCount = 0, codedFrames = 0, decodedFrames = 0, encodedBytes = 0, cookieSize = 0;
    OSStatus status, cookieStatus = notAttempted, encodePrimeStatus = notAttempted;
    AudioConverterPrimeInfo encodePrime = {0};
    DecodeProbe decoded = {.primeStatus = notAttempted};
    const char *stage = "encoder-create";
    const UInt32 bytesPerFrame = channels * sizeof(float);
    const AudioStreamBasicDescription pcm = {
        .mSampleRate = rate,
        .mFormatID = kAudioFormatLinearPCM,
        .mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagsNativeEndian,
        .mBytesPerPacket = bytesPerFrame,
        .mFramesPerPacket = 1,
        .mBytesPerFrame = bytesPerFrame,
        .mChannelsPerFrame = channels,
        .mBitsPerChannel = 32
    };
    AudioStreamBasicDescription compressed = {
        .mSampleRate = rate,
        .mFormatID = codec,
        .mFramesPerPacket = codec == kAudioFormatOpus ? rate / 50 : 1024,
        .mChannelsPerFrame = channels
    };
    for (UInt32 i = 0; i < inputFrames; i++) {
        for (UInt32 channel = 0; channel < channels; channel++) {
            const double time = (double)i / rate;
            input[i * channels + channel] = (float)(time >= .145 && time < .147 ? .75
                : time >= .035 && time < .105 ? .22 * sin(tau * tones[channel] * time) : 0);
        }
    }

    status = AudioConverterNew(&pcm, &compressed, &encoder);
    if (status)
        goto finish;
    stage = "encoder-format";
    status = converterProperty(encoder, kAudioConverterCurrentOutputStreamDescription, &compressed, sizeof(compressed));
    if (status)
        goto finish;
    if (compressed.mSampleRate != rate || compressed.mChannelsPerFrame != channels) {
        status = -1;
        goto finish;
    }

    stage = "encode";
    PcmInput pcmInput = {input, channels, 0};
    while (true) {
        if (packetCount == maxPackets || encodedBytes == maxEncodedBytes) {
            status = -1;
            goto finish;
        }
        UInt32 count = 1;
        const UInt32 capacity = maxEncodedBytes - encodedBytes;
        AudioBufferList buffer = {1, {{channels, capacity, encoded + encodedBytes}}};
        AudioStreamPacketDescription description = {0};
        status = AudioConverterFillComplexBuffer(encoder, feedPcm, &pcmInput, &count, &buffer, &description);
        if (status)
            goto finish;
        if (!count)
            break;
        const UInt32 size = buffer.mBuffers[0].mDataByteSize;
        if (!description.mDataByteSize)
            description.mDataByteSize = size;
        if (count != 1 || size > capacity || description.mStartOffset < 0
            || (uint64_t)description.mStartOffset + description.mDataByteSize > size) {
            status = -1;
            goto finish;
        }
        const uint8_t *bytes = encoded + encodedBytes + description.mStartOffset;
        UInt32 frames = description.mVariableFramesInPacket ? description.mVariableFramesInPacket : compressed.mFramesPerPacket;
        if (codec == kAudioFormatOpus)
            frames = opusFrames(bytes, description.mDataByteSize, rate);
        if (!frames || !description.mDataByteSize) {
            status = -1;
            goto finish;
        }
        description.mStartOffset = 0;
        packets[packetCount++] = (Packet){bytes, description, frames};
        codedFrames += frames;
        encodedBytes += size;
    }
    if (codedFrames < inputFrames || pcmInput.offset != inputFrames) {
        status = -1;
        goto finish;
    }
    encodePrimeStatus = converterProperty(encoder, kAudioConverterPrimeInfo, &encodePrime, sizeof(encodePrime));
    cookieStatus = AudioConverterGetPropertyInfo(encoder, kAudioConverterCompressionMagicCookie, &cookieSize, NULL);
    if (!cookieStatus && cookieSize > sizeof(cookie)) {
        stage = "encoder-cookie";
        status = -1;
        cookieSize = 0;
        goto finish;
    }
    if (!cookieStatus && cookieSize)
        cookieStatus = AudioConverterGetProperty(encoder, kAudioConverterCompressionMagicCookie, &cookieSize, cookie);
    if (cookieStatus)
        cookieSize = 0;

    decoded = decodePackets(&compressed, &pcm, packets, packetCount, cookie, cookieSize, false, output);
    stage = decoded.stage;
    status = decoded.status;
    decodedFrames = decoded.frames;

finish:
    if (encoder)
        AudioConverterDispose(encoder);
    printf("{\"name\":\"%s\",\"codec\":\"%s\",\"sampleRate\":%u,\"channels\":%u,\"stage\":\"%s\",\"status\":%d,"
        "\"inputFrames\":%u,\"codedFrames\":%u,\"decodedFrames\":%u,\"framesPerPacket\":%u,\"encoderPrime\":",
        name, codec == kAudioFormatOpus ? "opus" : "aac", (unsigned)rate, (unsigned)channels, stage, (int)status,
        (unsigned)inputFrames, (unsigned)codedFrames, (unsigned)decodedFrames, (unsigned)compressed.mFramesPerPacket);
    printPrime(encodePrimeStatus, encodePrime);
    printf(",\"decoderPrime\":");
    printPrime(decoded.primeStatus, decoded.prime);
    printf(",\"cookieStatus\":");
    printStatus(cookieStatus);
    printf(",\"cookie\":");
    printHex(cookie, cookieSize);
    printf(",\"signal\":");
    printSignal(output, decodedFrames, rate, channels);
    printf(",\"packets\":[");
    for (UInt32 i = 0; i < packetCount; i++) {
        printf("%s{\"frames\":%u,\"data\":", i ? "," : "", (unsigned)packets[i].frames);
        printHex(packets[i].bytes, packets[i].description.mDataByteSize);
        putchar('}');
    }
    printf("],\"opusDecoderVariants\":[");
    if (codec == kAudioFormatOpus && decoded.stage) {
        printDecoderVariant("encoder-cookie-default", decoded, output, rate, channels);
        const uint8_t opusHead[] = {'O', 'p', 'u', 's', 'H', 'e', 'a', 'd', 1, (uint8_t)channels,
            0, 0, 0x80, 0xbb, 0, 0, 0, 0, 0};
        uint8_t opusHeadWithPreSkip[sizeof(opusHead)];
        for (size_t i = 0; i < sizeof(opusHead); i++)
            opusHeadWithPreSkip[i] = opusHead[i];
        opusHeadWithPreSkip[10] = 0x38;
        opusHeadWithPreSkip[11] = 0x01; // 312 samples in the explicit test header.
        const struct {
            const char *name;
            const uint8_t *cookie;
            UInt32 size;
            bool noPrime;
        } variants[] = {
            {"no-cookie-default", NULL, 0, false},
            {"opushead-zero-default", opusHead, sizeof(opusHead), false},
            {"encoder-cookie-no-prime", cookie, cookieSize, true},
            {"opushead-312-default", opusHeadWithPreSkip, sizeof(opusHeadWithPreSkip), false},
        };
        for (size_t i = 0; i < sizeof(variants) / sizeof(*variants); i++) {
            putchar(',');
            const DecodeProbe variant = decodePackets(&compressed, &pcm, packets, packetCount,
                variants[i].cookie, variants[i].size, variants[i].noPrime, output);
            printDecoderVariant(variants[i].name, variant, output, rate, channels);
        }
    }
    printf("]}");
}

static void formats(AudioFormatPropertyID property)
{
    UInt32 size = 0;
    OSStatus status = AudioFormatGetPropertyInfo(property, 0, NULL, &size);
    AudioFormatID *ids = status || !size ? NULL : malloc(size);
    bool aac = false, opus = false;
    if (ids) {
        status = AudioFormatGetProperty(property, 0, NULL, &size, ids);
        if (!status) {
            for (UInt32 i = 0; i < size / sizeof(*ids); i++) {
                aac |= ids[i] == kAudioFormatMPEG4AAC;
                opus |= ids[i] == kAudioFormatOpus;
            }
        }
    } else if (!status) {
        status = -1;
    }
    printf("{\"status\":%d,\"aac\":%s,\"opus\":%s}", (int)status, aac ? "true" : "false", opus ? "true" : "false");
    free(ids);
}

int main(void)
{
    printf("{\"encodeFormats\":");
    formats(kAudioFormatProperty_EncodeFormatIDs);
    printf(",\"decodeFormats\":");
    formats(kAudioFormatProperty_DecodeFormatIDs);
    printf(",\"candidates\":[");
    probe("opus-48000-mono", kAudioFormatOpus, 48000, 1);
    putchar(',');
    probe("opus-48000-stereo", kAudioFormatOpus, 48000, 2);
    putchar(',');
    probe("aac-48000-mono", kAudioFormatMPEG4AAC, 48000, 1);
    putchar(',');
    probe("aac-48000-stereo", kAudioFormatMPEG4AAC, 48000, 2);
    putchar(',');
    probe("aac-44100-stereo", kAudioFormatMPEG4AAC, 44100, 2);
    puts("]}");
    return ferror(stdout) ? EXIT_FAILURE : EXIT_SUCCESS;
}
