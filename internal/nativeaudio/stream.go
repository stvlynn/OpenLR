// Package nativeaudio streams PCM and compressed audio through the desktop codec.
package nativeaudio

import (
	"errors"
	"fmt"
	"sync"
)

// MaxChunkBytes bounds each transfer and its working buffers, independent of
// the size of the source media.
const MaxChunkBytes = 64 << 10

var ErrUnavailable = errors.New("native audio codecs are unavailable")

type Config struct {
	Codec           string
	Decode          bool
	SampleRate      uint32
	Channels        uint32
	FramesPerPacket uint32
	Cookie          []byte
}

type Packet struct {
	Offset int
	Size   int
	Frames uint32
}

// Chunk contains interleaved Float32 little-endian PCM, or packed compressed
// packets. Packet durations describe coded frames before presentation edits.
type Chunk struct {
	Data    []byte
	Packets []Packet
}

type Output struct {
	Chunk
	Frames         uint32
	ConsumedFrames uint64
	NeedInput      bool
	Done           bool
}

type Info struct {
	SampleRate      uint32
	Channels        uint32
	FramesPerPacket uint32
	Cookie          []byte
	Prime           *Prime
}

type Prime struct {
	Leading  uint32
	Trailing uint32
}

type codec interface {
	fill(*input) (output Output, underflow bool, err error)
	info() (Info, error)
	close() error
}

type input struct {
	Chunk
	byteOffset  int
	packetIndex int
	final       bool
}

func (i *input) empty() bool { return i.byteOffset == len(i.Data) }

type Stream struct {
	mu     sync.Mutex
	codec  codec
	config Config
	input  input
	done   bool
	failed error
}

func Open(config Config) (*Stream, error) {
	if config.Codec != "opus" && config.Codec != "aac" {
		return nil, errors.New("unsupported native audio codec")
	}
	if config.SampleRate == 0 || config.Channels < 1 || config.Channels > 2 || len(config.Cookie) > MaxChunkBytes {
		return nil, errors.New("invalid native audio configuration")
	}
	backend, err := openCodec(config)
	if err != nil {
		return nil, err
	}
	return &Stream{codec: backend, config: config}, nil
}

// Process accepts one input chunk and returns at most one bounded output chunk.
// Call again with empty input to pull buffered output until NeedInput or Done.
// Mark final once the last input has been submitted, then pull until Done.
func (s *Stream) Process(chunk Chunk, final bool) (Output, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.codec == nil {
		return Output{}, errors.New("native audio stream is closed")
	}
	if s.failed != nil {
		return Output{}, s.failed
	}
	if err := s.validate(chunk); err != nil {
		return Output{}, err
	}
	if len(chunk.Data) != 0 {
		if s.input.final {
			return Output{}, errors.New("native audio input is finished")
		}
		if !s.input.empty() {
			return Output{}, errors.New("pull native audio output before adding input")
		}
		// The native converter can consume part of a chunk and continue on a
		// later call. Preserve its bytes independently of the caller.
		s.input = input{Chunk: Chunk{Data: append([]byte(nil), chunk.Data...), Packets: append([]Packet(nil), chunk.Packets...)}}
	}
	if s.done {
		return Output{Done: true}, nil
	}
	s.input.final = s.input.final || final
	if !s.input.final && s.input.empty() && len(s.input.Data) == 0 {
		return Output{NeedInput: true}, nil
	}
	previousOffset := s.input.byteOffset
	previousPacket := s.input.packetIndex
	output, underflow, err := s.codec.fill(&s.input)
	if err != nil {
		s.failed = err
		return Output{}, err
	}
	if underflow && s.input.final {
		s.failed = errors.New("native audio converter requested input after EOF")
		return Output{}, s.failed
	}
	if s.config.Decode {
		for _, packet := range s.input.Packets[previousPacket:s.input.packetIndex] {
			output.ConsumedFrames += uint64(packet.Frames)
		}
	} else {
		output.ConsumedFrames = uint64((s.input.byteOffset - previousOffset) / int(s.config.Channels*4))
	}
	if s.input.empty() {
		// After underflow, the converter is waiting for input. With final
		// input, only a successful fill returning zero output confirms EOF.
		if underflow || output.Frames == 0 {
			s.done = s.input.final && !underflow
			output.Done = s.done
			output.NeedInput = !s.input.final
			s.input = input{final: s.input.final}
		}
	} else if underflow || (output.Frames == 0 && s.input.byteOffset == previousOffset) {
		s.failed = errors.New("native audio converter did not consume input")
		return Output{}, s.failed
	}
	return output, nil
}

func (s *Stream) validate(chunk Chunk) error {
	if len(chunk.Data) > MaxChunkBytes {
		return errors.New("native audio chunk exceeds the transfer limit")
	}
	if !s.config.Decode {
		if len(chunk.Packets) != 0 || len(chunk.Data)%int(4*s.config.Channels) != 0 {
			return errors.New("invalid native audio PCM chunk")
		}
		return nil
	}
	end := 0
	for _, packet := range chunk.Packets {
		if packet.Offset != end || packet.Size <= 0 || packet.Size > len(chunk.Data)-end || packet.Frames == 0 {
			return errors.New("invalid native audio packet description")
		}
		if s.config.Codec == "opus" && opusPacketFrames(chunk.Data[end:end+packet.Size], s.config.SampleRate) != packet.Frames {
			return errors.New("native Opus packet duration differs from its TOC")
		}
		end += packet.Size
	}
	if end != len(chunk.Data) {
		return errors.New("native audio packet descriptions do not cover input")
	}
	return nil
}

func (s *Stream) Info() (Info, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.codec == nil {
		return Info{}, errors.New("native audio stream is closed")
	}
	return s.codec.info()
}

func (s *Stream) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.codec == nil {
		return nil
	}
	err := s.codec.close()
	s.codec = nil
	s.input = input{}
	if err != nil {
		return fmt.Errorf("close native audio stream: %w", err)
	}
	return nil
}
