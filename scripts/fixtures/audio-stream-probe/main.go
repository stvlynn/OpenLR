// audio-stream-probe compares the pure Go streaming path with the standalone
// AudioToolbox fixture on the same macOS host.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"openlr/internal/nativeaudio"
)

const inputFrames = 9601

var tones = []float64{333, 777}

type candidate struct {
	Name            string
	Codec           string
	Stage           string
	SampleRate      uint32
	Channels        uint32
	FramesPerPacket uint32
	CodedFrames     uint32
	DecodedFrames   uint32
	Cookie          string
	EncoderPrime    struct {
		Status            *int32
		Leading, Trailing uint32
	}
	Signal []signal
}

type signal struct {
	Peak          float64 `json:"peak"`
	PulseOffset   int     `json:"pulseOffset"`
	ToneAmplitude float64 `json:"toneAmplitude"`
}

func samples(config candidate) []byte {
	pcm := make([]byte, inputFrames*int(config.Channels)*4)
	for frame := 0; frame < inputFrames; frame++ {
		t := float64(frame) / float64(config.SampleRate)
		for channel := 0; channel < int(config.Channels); channel++ {
			var value float64
			switch {
			case t >= .145 && t < .147:
				value = .75
			case t >= .035 && t < .105:
				value = .22 * math.Sin(2*math.Pi*tones[channel]*t)
			}
			binary.LittleEndian.PutUint32(pcm[(frame*int(config.Channels)+channel)*4:], math.Float32bits(float32(value)))
		}
	}
	return pcm
}

func measure(pcm []byte, rate, channels int) []signal {
	frames := len(pcm) / (4 * channels)
	result := make([]signal, channels)
	for channel := range result {
		sample := func(frame int) float64 {
			return float64(math.Float32frombits(binary.LittleEndian.Uint32(pcm[(frame*channels+channel)*4:])))
		}
		var peakIndex int
		for frame := rate / 8; frame < frames; frame++ {
			value := math.Abs(sample(frame))
			if value > result[channel].Peak {
				result[channel].Peak = value
				peakIndex = frame
			}
		}
		shift := peakIndex - rate*145/1000
		result[channel].PulseOffset = shift
		var sine, cosine float64
		var count int
		for frame := rate * 50 / 1000; frame < rate*90/1000; frame++ {
			if source := frame + shift; source >= 0 && source < frames {
				value := sample(source)
				angle := 2 * math.Pi * tones[channel] * float64(frame) / float64(rate)
				sine += value * math.Sin(angle)
				cosine += value * math.Cos(angle)
				count++
			}
		}
		if count != 0 {
			result[channel].ToneAmplitude = 2 * math.Hypot(sine, cosine) / float64(count)
		}
	}
	return result
}

type collected struct {
	data       []byte
	packets    []nativeaudio.Packet
	frames     uint32
	consumed   uint64
	underflows int
}

func (c *collected) pump(stream *nativeaudio.Stream, chunk nativeaudio.Chunk, final bool) error {
	for step := 0; step < 128; step++ {
		output, err := stream.Process(chunk, final)
		if err != nil {
			return err
		}
		for _, packet := range output.Packets {
			packet.Offset += len(c.data)
			c.packets = append(c.packets, packet)
		}
		c.data = append(c.data, output.Data...)
		c.frames += output.Frames
		c.consumed += output.ConsumedFrames
		if output.NeedInput && !final {
			c.underflows++
			return nil
		}
		if output.Done && final {
			return nil
		}
		chunk = nativeaudio.Chunk{}
	}
	return fmt.Errorf("fixture did not reach underflow or EOF")
}

func encode(config nativeaudio.Config, data []byte, splits []int) (output collected, info nativeaudio.Info, err error) {
	stream, err := nativeaudio.Open(config)
	if err != nil {
		return output, info, err
	}
	defer func() {
		if closeErr := stream.Close(); err == nil {
			err = closeErr
		}
	}()
	for offset, i := 0, 0; offset < len(data); i++ {
		end := min(offset+splits[i%len(splits)]*int(config.Channels)*4, len(data))
		if err = output.pump(stream, nativeaudio.Chunk{Data: data[offset:end]}, false); err != nil {
			return output, info, err
		}
		offset = end
	}
	if err = output.pump(stream, nativeaudio.Chunk{}, true); err != nil {
		return output, info, err
	}
	info, err = stream.Info()
	return output, info, err
}

func decode(config nativeaudio.Config, encoded collected, splits []int) (output collected, err error) {
	stream, err := nativeaudio.Open(config)
	if err != nil {
		return output, err
	}
	defer func() {
		if closeErr := stream.Close(); err == nil {
			err = closeErr
		}
	}()
	for offset, i := 0, 0; offset < len(encoded.packets); i++ {
		end := min(offset+splits[i%len(splits)], len(encoded.packets))
		packets := append([]nativeaudio.Packet(nil), encoded.packets[offset:end]...)
		start := packets[0].Offset
		last := packets[len(packets)-1]
		for j := range packets {
			packets[j].Offset -= start
		}
		if err = output.pump(stream, nativeaudio.Chunk{Data: encoded.data[start : last.Offset+last.Size], Packets: packets}, false); err != nil {
			return output, err
		}
		offset = end
	}
	err = output.pump(stream, nativeaudio.Chunk{}, true)
	return output, err
}

func compare(reference candidate, framesPerPacket uint32, pcmSplits, packetSplits []int) (map[string]any, error) {
	config := nativeaudio.Config{Codec: reference.Codec, SampleRate: reference.SampleRate, Channels: reference.Channels, FramesPerPacket: framesPerPacket}
	encoded, info, err := encode(config, samples(reference), pcmSplits)
	if err != nil {
		return nil, fmt.Errorf("stream encode: %w", err)
	}
	config.Decode = true
	config.FramesPerPacket, config.Cookie = info.FramesPerPacket, info.Cookie
	decoded, err := decode(config, encoded, packetSplits)
	if err != nil {
		return nil, fmt.Errorf("stream decode: %w", err)
	}
	if encoded.underflows < 2 || decoded.underflows < 2 || len(encoded.packets) == 0 {
		return nil, fmt.Errorf("fixture did not exercise streaming underflows")
	}
	if encoded.consumed != inputFrames || decoded.consumed != uint64(encoded.frames) {
		return nil, fmt.Errorf("stream input counts do not match the fixture: PCM %d, coded %d", encoded.consumed, decoded.consumed)
	}
	if encoded.frames != reference.CodedFrames || decoded.frames != reference.DecodedFrames ||
		len(info.Cookie) != len(reference.Cookie)/2 || info.FramesPerPacket != reference.FramesPerPacket {
		return nil, fmt.Errorf("native stream shape differs from C reference: coded %d/%d, decoded %d/%d, cookie %d/%d, packet frames %d/%d",
			encoded.frames, reference.CodedFrames, decoded.frames, reference.DecodedFrames,
			len(info.Cookie), len(reference.Cookie)/2, info.FramesPerPacket, reference.FramesPerPacket)
	}
	if reference.EncoderPrime.Status != nil && *reference.EncoderPrime.Status == 0 &&
		(info.Prime == nil || info.Prime.Leading != reference.EncoderPrime.Leading || info.Prime.Trailing != reference.EncoderPrime.Trailing) {
		return nil, fmt.Errorf("stream priming differs from C reference: %+v vs %d/%d", info.Prime, reference.EncoderPrime.Leading, reference.EncoderPrime.Trailing)
	}
	signal := measure(decoded.data, int(config.SampleRate), int(config.Channels))
	if len(signal) != len(reference.Signal) {
		return nil, fmt.Errorf("C reference signal is incomplete")
	}
	for channel, actual := range signal {
		want := reference.Signal[channel]
		if math.Abs(float64(actual.PulseOffset-want.PulseOffset)) > 1 || math.Abs(actual.Peak-want.Peak) > .01 ||
			math.Abs(actual.ToneAmplitude-want.ToneAmplitude) > .01 {
			return nil, fmt.Errorf("stream signal differs from C reference in channel %d: %+v vs %+v", channel, actual, want)
		}
	}
	return map[string]any{"codedFrames": encoded.frames, "decodedFrames": decoded.frames, "signal": signal,
		"encodeChunks": encoded.underflows, "decodeChunks": decoded.underflows}, nil
}

func run(referencePath string) error {
	path, err := filepath.Abs(referencePath)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	data, err := exec.CommandContext(ctx, path).Output()
	if err != nil {
		return fmt.Errorf("run C reference: %w", err)
	}
	var reference struct{ Candidates []candidate }
	if err := json.Unmarshal(data, &reference); err != nil {
		return err
	}
	if len(reference.Candidates) != 5 {
		return fmt.Errorf("incomplete C reference")
	}
	encoder := json.NewEncoder(os.Stdout)
	for _, candidate := range reference.Candidates {
		if candidate.Stage != "complete" {
			return fmt.Errorf("%s C reference stopped at %s", candidate.Name, candidate.Stage)
		}
		var framesPerPacket uint32 = 1024
		if candidate.Codec == "opus" {
			framesPerPacket = candidate.SampleRate / 50
		}
		for i, matrix := range []struct{ pcm, packets []int }{
			{[]int{37, 127, 960, 401, 1800}, []int{1, 3, 2}},
			{[]int{2048, 633, 1023}, []int{4, 1, 2}},
		} {
			result, err := compare(candidate, framesPerPacket, matrix.pcm, matrix.packets)
			if err != nil {
				return fmt.Errorf("%s split %d: %w", candidate.Name, i+1, err)
			}
			result["candidate"], result["split"], result["nativeAudioStream"] = candidate.Name, i+1, "passed"
			if err := encoder.Encode(result); err != nil {
				return err
			}
		}
	}
	return nil
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "Pass the standalone AudioToolbox C fixture executable")
		os.Exit(1)
	}
	if err := run(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
