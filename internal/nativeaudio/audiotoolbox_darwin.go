//go:build darwin

package nativeaudio

import (
	"fmt"
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/ebitengine/purego"
)

// AudioConverter.h and CoreAudioTypes.h, using the 64-bit Darwin ABI.
type streamDescription struct {
	sampleRate      float64
	formatID        uint32
	formatFlags     uint32
	bytesPerPacket  uint32
	framesPerPacket uint32
	bytesPerFrame   uint32
	channels        uint32
	bitsPerChannel  uint32
	reserved        uint32
}

type audioBuffer struct {
	channels uint32
	byteSize uint32
	data     unsafe.Pointer
}

type bufferList struct {
	count  uint32
	buffer audioBuffer
}

type packetDescription struct {
	offset int64
	frames uint32
	size   uint32
}

var (
	_ [40]byte = [unsafe.Sizeof(streamDescription{})]byte{}
	_ [16]byte = [unsafe.Sizeof(audioBuffer{})]byte{}
	_ [24]byte = [unsafe.Sizeof(bufferList{})]byte{}
	_ [8]byte  = [unsafe.Offsetof(bufferList{}.buffer)]byte{}
	_ [16]byte = [unsafe.Sizeof(packetDescription{})]byte{}
	_ [8]byte  = [unsafe.Sizeof(Prime{})]byte{}
)

func fourCC(s string) uint32 {
	return uint32(s[0])<<24 | uint32(s[1])<<16 | uint32(s[2])<<8 | uint32(s[3])
}

const needInputStatus int32 = 0x6f6c6e64 // 'olnd', private callback status for temporary underflow.

type audioAPI struct {
	create   func(*streamDescription, *streamDescription, *uintptr) int32
	get      func(uintptr, uint32, *uint32, unsafe.Pointer) int32
	getInfo  func(uintptr, uint32, *uint32, *uint8) int32
	set      func(uintptr, uint32, uint32, unsafe.Pointer) int32
	fill     func(uintptr, uintptr, uintptr, *uint32, *bufferList, *packetDescription) int32
	dispose  func(uintptr) int32
	malloc   func(uintptr) unsafe.Pointer
	free     func(unsafe.Pointer)
	callback uintptr
}

var loadAPI = sync.OnceValues(func() (*audioAPI, error) {
	library, err := purego.Dlopen("/System/Library/Frameworks/AudioToolbox.framework/AudioToolbox", purego.RTLD_LAZY|purego.RTLD_LOCAL)
	if err != nil {
		return nil, fmt.Errorf("load AudioToolbox: %w", err)
	}
	api := &audioAPI{}
	for _, binding := range []struct {
		library uintptr
		name    string
		fn      any
	}{
		{library, "AudioConverterNew", &api.create},
		{library, "AudioConverterGetProperty", &api.get},
		{library, "AudioConverterGetPropertyInfo", &api.getInfo},
		{library, "AudioConverterSetProperty", &api.set},
		{library, "AudioConverterFillComplexBuffer", &api.fill},
		{library, "AudioConverterDispose", &api.dispose},
		{purego.RTLD_DEFAULT, "malloc", &api.malloc},
		{purego.RTLD_DEFAULT, "free", &api.free},
	} {
		symbol, err := purego.Dlsym(binding.library, binding.name)
		if err != nil {
			_ = purego.Dlclose(library)
			return nil, fmt.Errorf("load %s: %w", binding.name, err)
		}
		purego.RegisterFunc(binding.fn, symbol)
	}
	// purego's callback slots are permanent. One callback serves all streams.
	api.callback = purego.NewCallback(feedAudio)
	return api, nil
})

var (
	callbackStreams sync.Map
	nextStreamID    atomic.Uintptr
)

type audioToolbox struct {
	api          *audioAPI
	converter    uintptr
	id           uintptr
	current      *input
	compressed   streamDescription
	inputBuffer  unsafe.Pointer
	outputBuffer unsafe.Pointer
	description  unsafe.Pointer
	cookie       unsafe.Pointer
	decode       bool
}

func statusError(action string, status int32) error {
	return fmt.Errorf("AudioToolbox %s failed (%d)", action, status)
}

func openCodec(config Config) (codec, error) {
	api, err := loadAPI()
	if err != nil {
		return nil, err
	}
	pcm := streamDescription{
		sampleRate: float64(config.SampleRate), formatID: fourCC("lpcm"), formatFlags: 1 | 8,
		bytesPerPacket: config.Channels * 4, framesPerPacket: 1, bytesPerFrame: config.Channels * 4,
		channels: config.Channels, bitsPerChannel: 32,
	}
	formatID := fourCC("opus")
	if config.Codec == "aac" {
		formatID = fourCC("aac ")
	}
	compressed := streamDescription{sampleRate: pcm.sampleRate, formatID: formatID,
		framesPerPacket: config.FramesPerPacket, channels: config.Channels}
	source, destination := &pcm, &compressed
	if config.Decode {
		source, destination = destination, source
	}
	a := &audioToolbox{api: api, decode: config.Decode}
	if status := api.create(source, destination, &a.converter); status != 0 {
		return nil, statusError("create converter", status)
	}
	ready := false
	defer func() {
		if !ready {
			_ = a.close()
		}
	}()
	if config.Decode && len(config.Cookie) != 0 {
		a.cookie = api.malloc(uintptr(len(config.Cookie)))
		if a.cookie == nil {
			return nil, fmt.Errorf("allocate AudioToolbox cookie")
		}
		copy(unsafe.Slice((*byte)(a.cookie), len(config.Cookie)), config.Cookie)
		if status := api.set(a.converter, fourCC("dmgc"), uint32(len(config.Cookie)), a.cookie); status != 0 {
			return nil, statusError("set decoder cookie", status)
		}
	}
	descriptionProperty := fourCC("acod")
	if config.Decode {
		descriptionProperty = fourCC("acid")
	}
	if status := a.get(descriptionProperty, unsafe.Pointer(&a.compressed), unsafe.Sizeof(a.compressed)); status != 0 {
		return nil, statusError("read negotiated format", status)
	}
	if a.compressed.sampleRate != pcm.sampleRate || a.compressed.channels != pcm.channels || a.compressed.formatID != compressed.formatID {
		return nil, fmt.Errorf("AudioToolbox negotiated a different audio format")
	}
	a.inputBuffer = api.malloc(MaxChunkBytes)
	a.outputBuffer = api.malloc(MaxChunkBytes)
	a.description = api.malloc(unsafe.Sizeof(packetDescription{}))
	if a.inputBuffer == nil || a.outputBuffer == nil || a.description == nil {
		return nil, fmt.Errorf("allocate AudioToolbox buffers")
	}
	a.id = nextStreamID.Add(1)
	callbackStreams.Store(a.id, a)
	ready = true
	return a, nil
}

func (a *audioToolbox) get(property uint32, value unsafe.Pointer, capacity uintptr) int32 {
	size := uint32(capacity)
	return a.api.get(a.converter, property, &size, value)
}

func feedAudio(_ uintptr, count *uint32, buffers *bufferList, description **packetDescription, token uintptr) int32 {
	registered, ok := callbackStreams.Load(token)
	if !ok {
		*count = 0
		return -50
	}
	a := registered.(*audioToolbox)
	in := a.current
	buffers.count = 1
	buffers.buffer = audioBuffer{channels: a.compressed.channels}
	if description != nil {
		*description = nil
	}
	if in == nil {
		*count = 0
		return -50
	}
	if in.empty() {
		*count = 0
		if in.final {
			return 0
		}
		return needInputStatus
	}
	if *count == 0 {
		return -50
	}
	var size int
	if a.decode {
		packet := in.Packets[in.packetIndex]
		in.packetIndex++
		*count = 1
		size = packet.Size
		if description != nil {
			frames := packet.Frames
			if frames == a.compressed.framesPerPacket {
				frames = 0
			}
			entry := (*packetDescription)(a.description)
			*entry = packetDescription{frames: frames, size: uint32(size)}
			*description = entry
		}
	} else {
		bytesPerFrame := a.compressed.channels * 4
		*count = min(*count, uint32(len(in.Data)-in.byteOffset)/bytesPerFrame)
		size = int(*count * bytesPerFrame)
	}
	copy(unsafe.Slice((*byte)(a.inputBuffer), size), in.Data[in.byteOffset:in.byteOffset+size])
	in.byteOffset += size
	buffers.buffer = audioBuffer{a.compressed.channels, uint32(size), a.inputBuffer}
	return 0
}

func (a *audioToolbox) fill(in *input) (Output, bool, error) {
	buffer := bufferList{1, audioBuffer{a.compressed.channels, MaxChunkBytes, a.outputBuffer}}
	count := uint32(1)
	var descriptor packetDescription
	var description *packetDescription
	if a.decode {
		count = MaxChunkBytes / (4 * a.compressed.channels)
	} else {
		description = &descriptor
	}
	capacity := count
	a.current = in
	status := a.api.fill(a.converter, a.api.callback, a.id, &count, &buffer, description)
	a.current = nil
	underflow := status == needInputStatus
	if status != 0 && !underflow {
		return Output{}, false, statusError("convert audio", status)
	}
	if count == 0 {
		return Output{}, underflow, nil
	}
	if count > capacity || buffer.count != 1 || buffer.buffer.data != a.outputBuffer || buffer.buffer.byteSize > MaxChunkBytes {
		return Output{}, false, fmt.Errorf("invalid AudioToolbox output buffer")
	}
	data := unsafe.Slice((*byte)(a.outputBuffer), buffer.buffer.byteSize)
	if a.decode {
		if len(data) != int(count*a.compressed.channels*4) {
			return Output{}, false, fmt.Errorf("invalid AudioToolbox PCM output length")
		}
		return Output{Chunk: Chunk{Data: append([]byte(nil), data...)}, Frames: count}, underflow, nil
	}
	if descriptor.size == 0 {
		descriptor.size = uint32(len(data))
	}
	if descriptor.offset < 0 || descriptor.offset > int64(len(data)) || int64(descriptor.size) > int64(len(data))-descriptor.offset {
		return Output{}, false, fmt.Errorf("invalid AudioToolbox packet description")
	}
	data = append([]byte(nil), data[descriptor.offset:descriptor.offset+int64(descriptor.size)]...)
	frames := descriptor.frames
	if frames == 0 {
		frames = a.compressed.framesPerPacket
	}
	if a.compressed.formatID == fourCC("opus") {
		frames = opusPacketFrames(data, uint32(a.compressed.sampleRate))
	}
	if len(data) == 0 || frames == 0 {
		return Output{}, false, fmt.Errorf("AudioToolbox returned an empty or untimed packet")
	}
	return Output{Chunk: Chunk{Data: data, Packets: []Packet{{Size: len(data), Frames: frames}}}, Frames: frames}, underflow, nil
}

func (a *audioToolbox) info() (Info, error) {
	info := Info{SampleRate: uint32(a.compressed.sampleRate), Channels: a.compressed.channels, FramesPerPacket: a.compressed.framesPerPacket}
	var prime Prime
	if a.get(fourCC("prim"), unsafe.Pointer(&prime), unsafe.Sizeof(prime)) == 0 {
		info.Prime = &prime
	}
	if !a.decode {
		var size uint32
		if status := a.api.getInfo(a.converter, fourCC("cmgc"), &size, nil); status == 0 && size != 0 {
			if size > MaxChunkBytes {
				return Info{}, fmt.Errorf("AudioToolbox cookie exceeds the transfer limit")
			}
			cookie := make([]byte, size)
			if status := a.api.get(a.converter, fourCC("cmgc"), &size, unsafe.Pointer(&cookie[0])); status != 0 {
				return Info{}, statusError("read encoder cookie", status)
			}
			if size > uint32(len(cookie)) {
				return Info{}, fmt.Errorf("invalid AudioToolbox cookie length")
			}
			info.Cookie = cookie[:size]
		}
	}
	return info, nil
}

func (a *audioToolbox) close() error {
	if status := a.api.dispose(a.converter); status != 0 {
		// A failed disposal leaves ownership uncertain. Keep native input
		// storage valid for the lifetime of the process.
		return statusError("dispose converter", status)
	}
	if a.id != 0 {
		callbackStreams.Delete(a.id)
	}
	for _, ptr := range []unsafe.Pointer{a.inputBuffer, a.outputBuffer, a.description, a.cookie} {
		if ptr != nil {
			a.api.free(ptr)
		}
	}
	return nil
}
