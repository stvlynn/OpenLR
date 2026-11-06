//go:build !darwin

package nativeaudio

func openCodec(Config) (codec, error) { return nil, ErrUnavailable }
