package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log"
	"sync"

	"github.com/egoist/mygo"
	"openlr/internal/nativeaudio"
)

type nativeAudioConfig struct {
	Codec           string `json:"codec"`
	Decode          bool   `json:"decode"`
	SampleRate      uint32 `json:"sampleRate"`
	Channels        uint32 `json:"channels"`
	FramesPerPacket uint32 `json:"framesPerPacket"`
	Cookie          string `json:"cookie"`
}

type nativeAudioPacket struct {
	Offset int    `json:"offset"`
	Size   int    `json:"size"`
	Frames uint32 `json:"frames"`
}

type nativeAudioInput struct {
	Data    string              `json:"data"`
	Packets []nativeAudioPacket `json:"packets"`
	Final   bool                `json:"final"`
}

type nativeAudioOutput struct {
	Data           string              `json:"data"`
	Packets        []nativeAudioPacket `json:"packets"`
	Frames         uint32              `json:"frames"`
	ConsumedFrames uint64              `json:"consumedFrames"`
	NeedInput      bool                `json:"needInput"`
	Done           bool                `json:"done"`
}

type nativeAudioPrime struct {
	Leading  uint32 `json:"leading"`
	Trailing uint32 `json:"trailing"`
}

type nativeAudioInfo struct {
	SampleRate      uint32            `json:"sampleRate"`
	Channels        uint32            `json:"channels"`
	FramesPerPacket uint32            `json:"framesPerPacket"`
	Cookie          string            `json:"cookie"`
	Prime           *nativeAudioPrime `json:"prime"`
}

type nativeAudioHandle struct {
	ID   string          `json:"id"`
	Info nativeAudioInfo `json:"info"`
}

type nativeAudioStream interface {
	Process(nativeaudio.Chunk, bool) (nativeaudio.Output, error)
	Info() (nativeaudio.Info, error)
	Close() error
}

type nativeAudioWindow struct {
	streams map[string]nativeAudioStream
	pending sync.WaitGroup
}

type nativeAudioManager struct {
	mu        sync.Mutex
	windows   map[int]*nativeAudioWindow
	stopped   bool
	closing   sync.WaitGroup
	openCodec func(nativeaudio.Config) (nativeAudioStream, error)
}

var (
	errAudioWindow = errors.New("no active native audio window")
	errAudioStream = errors.New("unknown native audio stream")
	errAudioChunk  = errors.New("native audio transfer exceeds 64 KiB")
)

func (m *nativeAudioManager) addWindow(id int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.stopped || m.windows[id] != nil {
		return
	}
	if m.windows == nil {
		m.windows = make(map[int]*nativeAudioWindow)
	}
	m.windows[id] = &nativeAudioWindow{streams: make(map[string]nativeAudioStream)}
}

func decodeAudioTransfer(encoded string) ([]byte, error) {
	if len(encoded) > base64.StdEncoding.EncodedLen(nativeaudio.MaxChunkBytes) {
		return nil, errAudioChunk
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, errors.New("invalid base64 native audio transfer")
	}
	if len(data) > nativeaudio.MaxChunkBytes {
		return nil, errAudioChunk
	}
	return data, nil
}

func audioStreamInfo(stream nativeAudioStream) (nativeAudioInfo, error) {
	info, err := stream.Info()
	if err != nil {
		return nativeAudioInfo{}, err
	}
	if len(info.Cookie) > nativeaudio.MaxChunkBytes {
		return nativeAudioInfo{}, errAudioChunk
	}
	result := nativeAudioInfo{
		SampleRate: info.SampleRate, Channels: info.Channels, FramesPerPacket: info.FramesPerPacket,
		Cookie: base64.StdEncoding.EncodeToString(info.Cookie),
	}
	if info.Prime != nil {
		result.Prime = &nativeAudioPrime{Leading: info.Prime.Leading, Trailing: info.Prime.Trailing}
	}
	return result, nil
}

func (m *nativeAudioManager) open(ctx context.Context, windowID int, config nativeAudioConfig) (_ nativeAudioHandle, result error) {
	cookie, err := decodeAudioTransfer(config.Cookie)
	if err != nil {
		return nativeAudioHandle{}, err
	}
	m.mu.Lock()
	owner := m.windows[windowID]
	if owner == nil {
		m.mu.Unlock()
		return nativeAudioHandle{}, errAudioWindow
	}
	owner.pending.Add(1)
	m.mu.Unlock()
	defer owner.pending.Done()
	if err := ctx.Err(); err != nil {
		return nativeAudioHandle{}, err
	}
	stream, err := m.openCodec(nativeaudio.Config{
		Codec: config.Codec, Decode: config.Decode, SampleRate: config.SampleRate, Channels: config.Channels,
		FramesPerPacket: config.FramesPerPacket, Cookie: cookie,
	})
	if err != nil {
		return nativeAudioHandle{}, err
	}
	published := false
	defer func() {
		if !published {
			result = errors.Join(result, stream.Close())
		}
	}()
	info, err := audioStreamInfo(stream)
	if err != nil {
		return nativeAudioHandle{}, err
	}
	id := rand.Text()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.windows[windowID] != owner {
		return nativeAudioHandle{}, errAudioWindow
	}
	if err := ctx.Err(); err != nil {
		return nativeAudioHandle{}, err
	}
	if owner.streams[id] != nil {
		return nativeAudioHandle{}, errors.New("could not assign native audio stream ID")
	}
	owner.streams[id] = stream
	published = true
	return nativeAudioHandle{ID: id, Info: info}, nil
}

func (m *nativeAudioManager) lookup(windowID int, id string) (nativeAudioStream, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	owner := m.windows[windowID]
	if owner == nil {
		return nil, errAudioWindow
	}
	stream := owner.streams[id]
	if stream == nil {
		return nil, errAudioStream
	}
	return stream, nil
}

func (m *nativeAudioManager) process(windowID int, id string, input nativeAudioInput) (nativeAudioOutput, error) {
	stream, err := m.lookup(windowID, id)
	if err != nil {
		return nativeAudioOutput{}, err
	}
	data, err := decodeAudioTransfer(input.Data)
	if err != nil {
		return nativeAudioOutput{}, err
	}
	if len(input.Packets) > len(data) {
		return nativeAudioOutput{}, errors.New("invalid native audio packet descriptions")
	}
	chunk := nativeaudio.Chunk{Data: data, Packets: make([]nativeaudio.Packet, len(input.Packets))}
	for index, packet := range input.Packets {
		chunk.Packets[index] = nativeaudio.Packet(packet)
	}
	output, err := stream.Process(chunk, input.Final)
	if err != nil {
		return nativeAudioOutput{}, err
	}
	if len(output.Data) > nativeaudio.MaxChunkBytes {
		return nativeAudioOutput{}, errAudioChunk
	}
	result := nativeAudioOutput{
		Data: base64.StdEncoding.EncodeToString(output.Data), Packets: make([]nativeAudioPacket, len(output.Packets)),
		Frames: output.Frames, ConsumedFrames: output.ConsumedFrames, NeedInput: output.NeedInput, Done: output.Done,
	}
	for index, packet := range output.Packets {
		result.Packets[index] = nativeAudioPacket(packet)
	}
	return result, nil
}

func (m *nativeAudioManager) close(windowID int, id string) error {
	m.mu.Lock()
	owner := m.windows[windowID]
	if owner == nil {
		m.mu.Unlock()
		return errAudioWindow
	}
	stream := owner.streams[id]
	if stream == nil {
		m.mu.Unlock()
		return nil
	}
	delete(owner.streams, id)
	owner.pending.Add(1)
	m.mu.Unlock()
	defer owner.pending.Done()
	return stream.Close()
}

func (w *nativeAudioWindow) close() error {
	var result error
	for _, stream := range w.streams {
		result = errors.Join(result, stream.Close())
	}
	w.pending.Wait()
	return result
}

func (m *nativeAudioManager) closeWindow(id int) error {
	m.mu.Lock()
	owner := m.windows[id]
	if owner == nil {
		m.mu.Unlock()
		return nil
	}
	delete(m.windows, id)
	m.closing.Add(1)
	m.mu.Unlock()
	defer m.closing.Done()
	return owner.close()
}

func (m *nativeAudioManager) quit() error {
	m.mu.Lock()
	windows := m.windows
	m.windows = nil
	m.stopped = true
	m.mu.Unlock()
	var result error
	for _, owner := range windows {
		result = errors.Join(result, owner.close())
	}
	m.closing.Wait()
	return result
}

// NativeAudio exposes bounded codec transfers owned by the calling window.
type NativeAudio struct{ manager *nativeAudioManager }

func newNativeAudio() *NativeAudio {
	return &NativeAudio{manager: &nativeAudioManager{
		openCodec: func(config nativeaudio.Config) (nativeAudioStream, error) {
			return nativeaudio.Open(config)
		},
	}}
}

func nativeAudioCaller(ctx context.Context) (int, error) {
	window := mygo.CallerWindow(ctx)
	if window == nil {
		return 0, errAudioWindow
	}
	return window.ID(), ctx.Err()
}

func (b *NativeAudio) Open(ctx context.Context, config nativeAudioConfig) (nativeAudioHandle, error) {
	windowID, err := nativeAudioCaller(ctx)
	if err != nil {
		return nativeAudioHandle{}, err
	}
	return b.manager.open(ctx, windowID, config)
}

func (b *NativeAudio) Process(ctx context.Context, id string, input nativeAudioInput) (nativeAudioOutput, error) {
	windowID, err := nativeAudioCaller(ctx)
	if err != nil {
		return nativeAudioOutput{}, err
	}
	return b.manager.process(windowID, id, input)
}

func (b *NativeAudio) Info(ctx context.Context, id string) (nativeAudioInfo, error) {
	windowID, err := nativeAudioCaller(ctx)
	if err != nil {
		return nativeAudioInfo{}, err
	}
	stream, err := b.manager.lookup(windowID, id)
	if err != nil {
		return nativeAudioInfo{}, err
	}
	return audioStreamInfo(stream)
}

func (b *NativeAudio) Close(ctx context.Context, id string) error {
	windowID, err := nativeAudioCaller(ctx)
	if err != nil {
		return err
	}
	return b.manager.close(windowID, id)
}

func (b *NativeAudio) observeWindow(window *mygo.Window) {
	id := window.ID()
	b.manager.addWindow(id)
	window.OnClosed(func() {
		if err := b.manager.closeWindow(id); err != nil {
			log.Print("OpenLR native audio cleanup: ", err)
		}
	})
}

func (b *NativeAudio) quit() {
	if err := b.manager.quit(); err != nil {
		log.Print("OpenLR native audio cleanup: ", err)
	}
}
