package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"openlr/internal/nativeaudio"
)

type testNativeAudioStream struct {
	mu      sync.Mutex
	process func(nativeaudio.Chunk, bool) (nativeaudio.Output, error)
	info    nativeaudio.Info
	infoErr error
	closed  atomic.Int32
	onClose func()
}

func (s *testNativeAudioStream) Process(chunk nativeaudio.Chunk, final bool) (nativeaudio.Output, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.process(chunk, final)
}

func (s *testNativeAudioStream) Info() (nativeaudio.Info, error) { return s.info, s.infoErr }
func (s *testNativeAudioStream) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed.Add(1)
	if s.onClose != nil {
		s.onClose()
	}
	return nil
}

func audioTestReceive[T any](t *testing.T, value <-chan T) T {
	t.Helper()
	select {
	case result := <-value:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for native audio test operation")
		var zero T
		return zero
	}
}

func TestNativeAudioWindowOwnsCodecHandleAndWireData(t *testing.T) {
	if _, err := newNativeAudio().Open(t.Context(), nativeAudioConfig{}); !errors.Is(err, errAudioWindow) {
		t.Fatalf("missing MyGo caller should fail: %v", err)
	}
	packet := nativeaudio.Packet{Size: 4, Frames: 960}
	chunk := nativeaudio.Chunk{Data: []byte{1, 2, 3, 4}, Packets: []nativeaudio.Packet{packet}}
	stream := &testNativeAudioStream{
		info: nativeaudio.Info{
			SampleRate: 48000, Channels: 2, FramesPerPacket: 960, Cookie: []byte{5},
			Prime: &nativeaudio.Prime{Leading: 312, Trailing: 647},
		},
		process: func(got nativeaudio.Chunk, final bool) (nativeaudio.Output, error) {
			if !reflect.DeepEqual(got, chunk) || !final {
				t.Fatalf("bad codec input: %+v, final %v", got, final)
			}
			return nativeaudio.Output{Chunk: chunk, Frames: 960, ConsumedFrames: 1920, Done: true}, nil
		},
	}
	manager := &nativeAudioManager{openCodec: func(config nativeaudio.Config) (nativeAudioStream, error) {
		want := nativeaudio.Config{
			Codec: "opus", Decode: true, SampleRate: 48000, Channels: 2, FramesPerPacket: 960, Cookie: []byte{3},
		}
		if !reflect.DeepEqual(config, want) {
			t.Fatalf("bad codec configuration: %+v", config)
		}
		return stream, nil
	}}
	manager.addWindow(1)
	manager.addWindow(2)
	handle, err := manager.open(t.Context(), 1, nativeAudioConfig{
		Codec: "opus", Decode: true, SampleRate: 48000, Channels: 2, FramesPerPacket: 960, Cookie: "Aw==",
	})
	if err != nil || handle.ID == "" || !reflect.DeepEqual(handle.Info, nativeAudioInfo{
		SampleRate: 48000, Channels: 2, FramesPerPacket: 960, Cookie: "BQ==",
		Prime: &nativeAudioPrime{Leading: 312, Trailing: 647},
	}) {
		t.Fatalf("bad audio handle: %+v, %v", handle, err)
	}
	input := nativeAudioInput{Data: "AQIDBA==", Packets: []nativeAudioPacket{nativeAudioPacket(packet)}, Final: true}
	if _, err := manager.process(2, handle.ID, input); !errors.Is(err, errAudioStream) {
		t.Fatalf("foreign process should fail: %v", err)
	}
	if _, err := manager.lookup(2, handle.ID); !errors.Is(err, errAudioStream) {
		t.Fatalf("foreign info should fail: %v", err)
	}
	if err := manager.close(2, handle.ID); err != nil || stream.closed.Load() != 0 {
		t.Fatalf("foreign close changed stream ownership: %v", err)
	}
	got, err := manager.process(1, handle.ID, input)
	if want := (nativeAudioOutput{
		Data: "AQIDBA==", Packets: input.Packets, Frames: 960, ConsumedFrames: 1920, Done: true,
	}); err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("bad codec response: %+v, %v", got, err)
	}
	for range 2 {
		if err := manager.close(1, handle.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err := manager.closeWindow(1); err != nil || stream.closed.Load() != 1 {
		t.Fatalf("native stream was not closed exactly once: %v", err)
	}
}

func TestNativeAudioBoundsTransfersBeforeCodecAndClosesOnOpenFailure(t *testing.T) {
	infoFailure := errors.New("negotiated audio info unavailable")
	failed := &testNativeAudioStream{infoErr: infoFailure}
	oversized := &testNativeAudioStream{process: func(nativeaudio.Chunk, bool) (nativeaudio.Output, error) {
		return nativeaudio.Output{Chunk: nativeaudio.Chunk{Data: make([]byte, nativeaudio.MaxChunkBytes+1)}}, nil
	}}
	var opens int
	manager := &nativeAudioManager{openCodec: func(config nativeaudio.Config) (nativeAudioStream, error) {
		opens++
		if config.Decode {
			return failed, nil
		}
		if len(config.Cookie) != nativeaudio.MaxChunkBytes {
			t.Fatalf("valid boundary cookie lost bytes: %d", len(config.Cookie))
		}
		return oversized, nil
	}}
	manager.addWindow(1)
	data := bytes.Repeat([]byte{0xAB}, nativeaudio.MaxChunkBytes+1)
	overLimit := base64.StdEncoding.EncodeToString(data)
	if _, err := manager.open(t.Context(), 1, nativeAudioConfig{Cookie: overLimit}); !errors.Is(err, errAudioChunk) || opens != 0 {
		t.Fatalf("oversized cookie reached native codec: %v", err)
	}
	if _, err := manager.open(t.Context(), 1, nativeAudioConfig{Decode: true}); !errors.Is(err, infoFailure) ||
		failed.closed.Load() != 1 || len(manager.windows[1].streams) != 0 {
		t.Fatalf("failed open did not close an unpublished codec: %v", err)
	}
	valid := base64.StdEncoding.EncodeToString(data[:nativeaudio.MaxChunkBytes])
	handle, err := manager.open(t.Context(), 1, nativeAudioConfig{Cookie: valid})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.process(1, handle.ID, nativeAudioInput{Data: overLimit}); !errors.Is(err, errAudioChunk) {
		t.Fatalf("oversized input was accepted: %v", err)
	}
	if _, err := manager.process(1, handle.ID, nativeAudioInput{Data: "@@"}); err == nil {
		t.Fatal("invalid base64 input was accepted")
	}
	if _, err := manager.process(1, handle.ID, nativeAudioInput{Data: valid}); !errors.Is(err, errAudioChunk) {
		t.Fatalf("oversized output was accepted: %v", err)
	}
	if err := manager.quit(); err != nil || oversized.closed.Load() != 1 {
		t.Fatalf("quit did not close the active native codec: %v", err)
	}
	manager.addWindow(2)
	if _, err := manager.open(t.Context(), 2, nativeAudioConfig{}); !errors.Is(err, errAudioWindow) {
		t.Fatalf("manager accepted a new stream after quit: %v", err)
	}
}

func TestNativeAudioWindowCloseDrainsAnUnpublishedOpen(t *testing.T) {
	openStarted, releaseOpen, activeClosed := make(chan struct{}), make(chan struct{}), make(chan struct{})
	release := sync.OnceFunc(func() { close(releaseOpen) })
	defer release()
	active := &testNativeAudioStream{onClose: func() { close(activeClosed) }}
	pending := &testNativeAudioStream{}
	manager := &nativeAudioManager{openCodec: func(config nativeaudio.Config) (nativeAudioStream, error) {
		if config.Decode {
			close(openStarted)
			<-releaseOpen
			return pending, nil
		}
		return active, nil
	}}
	manager.addWindow(1)
	if _, err := manager.open(t.Context(), 1, nativeAudioConfig{}); err != nil {
		t.Fatal(err)
	}
	opened, closed := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := manager.open(t.Context(), 1, nativeAudioConfig{Decode: true})
		opened <- err
	}()
	audioTestReceive(t, openStarted)
	go func() { closed <- manager.closeWindow(1) }()
	audioTestReceive(t, activeClosed)
	select {
	case <-closed:
		t.Fatal("window close returned before an in-flight open was disposed")
	default:
	}
	release()
	if err := audioTestReceive(t, opened); !errors.Is(err, errAudioWindow) {
		t.Fatalf("open after window close published a handle: %v", err)
	}
	if err := audioTestReceive(t, closed); err != nil || pending.closed.Load() != 1 || active.closed.Load() != 1 {
		t.Fatalf("window close lost a stream: %v", err)
	}
}

func TestNativeAudioConversionDoesNotBlockAnotherWindow(t *testing.T) {
	processing, releaseProcess := make(chan struct{}), make(chan struct{})
	release := sync.OnceFunc(func() { close(releaseProcess) })
	defer release()
	first := &testNativeAudioStream{process: func(nativeaudio.Chunk, bool) (nativeaudio.Output, error) {
		close(processing)
		<-releaseProcess
		return nativeaudio.Output{}, nil
	}}
	second := &testNativeAudioStream{process: func(nativeaudio.Chunk, bool) (nativeaudio.Output, error) {
		return nativeaudio.Output{NeedInput: true}, nil
	}}
	manager := &nativeAudioManager{openCodec: func(config nativeaudio.Config) (nativeAudioStream, error) {
		if config.Decode {
			return first, nil
		}
		return second, nil
	}}
	manager.addWindow(1)
	manager.addWindow(2)
	handle, err := manager.open(t.Context(), 1, nativeAudioConfig{Decode: true})
	if err != nil {
		t.Fatal(err)
	}
	firstResult, secondResult := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := manager.process(1, handle.ID, nativeAudioInput{})
		firstResult <- err
	}()
	audioTestReceive(t, processing)
	go func() {
		other, err := manager.open(t.Context(), 2, nativeAudioConfig{})
		if err == nil {
			_, err = manager.process(2, other.ID, nativeAudioInput{})
		}
		secondResult <- err
	}()
	if err := audioTestReceive(t, secondResult); err != nil {
		t.Fatal(err)
	}
	release()
	if err := audioTestReceive(t, firstResult); err != nil {
		t.Fatal(err)
	}
	if err := manager.quit(); err != nil || first.closed.Load() != 1 || second.closed.Load() != 1 {
		t.Fatalf("quit lost a window stream: %v", err)
	}
}

func TestNativeAudioCanceledOpenDisposesUnpublishedCodec(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	stream := &testNativeAudioStream{}
	manager := &nativeAudioManager{openCodec: func(nativeaudio.Config) (nativeAudioStream, error) {
		cancel()
		return stream, nil
	}}
	manager.addWindow(1)
	if _, err := manager.open(ctx, 1, nativeAudioConfig{}); !errors.Is(err, context.Canceled) || stream.closed.Load() != 1 {
		t.Fatalf("canceled open retained its codec: %v", err)
	}
}
