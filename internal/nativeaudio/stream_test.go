package nativeaudio

import (
	"errors"
	"reflect"
	"testing"
)

type fakeCodec struct {
	fillFunc func(*input) (Output, bool, error)
	closed   int
}

func (f *fakeCodec) fill(i *input) (Output, bool, error) { return f.fillFunc(i) }
func (f *fakeCodec) info() (Info, error)                 { return Info{SampleRate: 48000}, nil }
func (f *fakeCodec) close() error                        { f.closed++; return nil }

func TestStreamRetainsInputAndOutputsWhileDraining(t *testing.T) {
	var calls int
	var consumed []byte
	driver := &fakeCodec{fillFunc: func(in *input) (Output, bool, error) {
		calls++
		switch calls {
		case 1, 2, 3:
			consumed = append(consumed, in.Data[in.byteOffset])
			in.byteOffset += 4
			return Output{Frames: 1}, in.empty(), nil
		case 4:
			if !in.final || !in.empty() {
				t.Fatal("finish must deliver EOF only after input is exhausted")
			}
			return Output{Frames: 2}, false, nil
		default:
			return Output{}, false, nil
		}
	}}
	stream := &Stream{config: Config{Channels: 1}, codec: driver}
	process := func(chunk Chunk, final bool) Output {
		t.Helper()
		output, err := stream.Process(chunk, final)
		if err != nil {
			t.Fatal(err)
		}
		return output
	}
	if out := process(Chunk{}, false); !out.NeedInput || calls != 0 {
		t.Fatalf("empty input did not request input: %+v", out)
	}
	data := []byte{11, 0, 0, 0, 22, 0, 0, 0}
	if out := process(Chunk{Data: data}, false); out.NeedInput || out.Frames != 1 || out.ConsumedFrames != 1 {
		t.Fatalf("unexpected first output: %+v", out)
	}
	if _, err := stream.Process(Chunk{Data: make([]byte, 4)}, false); err == nil {
		t.Fatal("accepted input before draining the pending chunk")
	}
	data[4] = 99
	if out := process(Chunk{}, false); !out.NeedInput || out.Frames != 1 {
		t.Fatalf("lost output on temporary underflow: %+v", out)
	}
	if out := process(Chunk{Data: []byte{33, 0, 0, 0}}, false); !out.NeedInput || out.Frames != 1 {
		t.Fatalf("could not continue after temporary underflow: %+v", out)
	}
	if !reflect.DeepEqual(consumed, []byte{11, 22, 33}) {
		t.Fatalf("wrong retained input: %v", consumed)
	}
	if out := process(Chunk{}, true); out.Done || out.Frames != 2 || out.ConsumedFrames != 0 {
		t.Fatalf("lost buffered output at EOF: %+v", out)
	}
	if out := process(Chunk{}, false); !out.Done || out.Frames != 0 {
		t.Fatalf("did not finish draining: %+v", out)
	}
	if out := process(Chunk{}, true); !out.Done || calls != 5 {
		t.Fatal("repeated finish invoked the native converter again")
	}
	if _, err := stream.Process(Chunk{Data: make([]byte, 4)}, false); err == nil {
		t.Fatal("accepted input after EOF")
	}
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	if err := stream.Close(); err != nil || driver.closed != 1 {
		t.Fatal("close was not idempotent")
	}
}

func TestStreamValidatesPacketBoundsAndKeepsConverterFailure(t *testing.T) {
	failure := errors.New("converter failure")
	driver := &fakeCodec{fillFunc: func(in *input) (Output, bool, error) {
		return Output{}, false, failure
	}}
	stream := &Stream{config: Config{Decode: true, Channels: 1}, codec: driver}
	for _, malformed := range []Chunk{
		{Data: make([]byte, MaxChunkBytes+1)},
		{Data: []byte{1}},
		{Data: []byte{1}, Packets: []Packet{{Offset: 1, Size: 1, Frames: 1}}},
		{Data: []byte{1}, Packets: []Packet{{Size: 2, Frames: 1}}},
		{Data: []byte{1}, Packets: []Packet{{Size: 1}}},
	} {
		if _, err := stream.Process(malformed, false); err == nil || errors.Is(err, failure) {
			t.Fatalf("invalid chunk reached driver: %v", err)
		}
	}
	if _, err := stream.Process(Chunk{Data: []byte{1}, Packets: []Packet{{Size: 1, Frames: 960}}}, false); !errors.Is(err, failure) {
		t.Fatalf("converter error was not returned: %v", err)
	}
	if _, err := stream.Process(Chunk{}, true); !errors.Is(err, failure) {
		t.Fatalf("failed converter was restarted: %v", err)
	}
	if err := stream.Close(); err != nil || driver.closed != 1 {
		t.Fatal("failed converter was not disposed")
	}
}

func TestOpusPacketFrames(t *testing.T) {
	for _, test := range []struct {
		packet []byte
		frames uint32
	}{
		{[]byte{0x78}, 960},
		{[]byte{0x81}, 240},
		{[]byte{0x1a}, 5760},
		{[]byte{0x83, 3}, 360},
		{[]byte{0x83}, 0},
		{[]byte{0x83, 49}, 0},
		{[]byte{0x83, 0}, 0},
	} {
		if actual := opusPacketFrames(test.packet, 48000); actual != test.frames {
			t.Errorf("packet %x: got %d frames, want %d", test.packet, actual, test.frames)
		}
	}
}

func TestStreamCountsCodedFramesConsumedIndependentlyOfPCMOutput(t *testing.T) {
	driver := &fakeCodec{fillFunc: func(in *input) (Output, bool, error) {
		in.byteOffset = len(in.Data)
		in.packetIndex = len(in.Packets)
		return Output{Frames: 750}, true, nil
	}}
	stream := &Stream{config: Config{Decode: true, Codec: "opus", SampleRate: 48000, Channels: 1}, codec: driver}
	chunk := Chunk{Data: []byte{0x78}, Packets: []Packet{{Size: 1, Frames: 840}}}
	if _, err := stream.Process(chunk, false); err == nil {
		t.Fatal("accepted frame count that did not match the Opus TOC")
	}
	chunk.Packets[0].Frames = 960
	output, err := stream.Process(chunk, false)
	if err != nil || output.Frames != 750 || output.ConsumedFrames != 960 || !output.NeedInput {
		t.Fatalf("did not separate coded and decoded counts: %+v, %v", output, err)
	}
}
