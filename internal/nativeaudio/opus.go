package nativeaudio

// opusPacketFrames reads the duration from the Opus TOC and frame-count byte
// as specified by RFC 6716 section 3. It does not validate the encoded payload.
func opusPacketFrames(data []byte, rate uint32) uint32 {
	if len(data) == 0 {
		return 0
	}
	config := data[0] >> 3
	var micros uint32
	switch {
	case config >= 16:
		micros = 2500 << (config & 3)
	case config >= 12:
		micros = 10000 << (config & 1)
	case config&3 == 3:
		micros = 60000
	default:
		micros = 10000 << (config & 3)
	}
	count := uint32(1)
	switch data[0] & 3 {
	case 1, 2:
		count = 2
	case 3:
		if len(data) < 2 {
			return 0
		}
		count = uint32(data[1] & 63)
	}
	if micros*count > 120000 {
		return 0
	}
	return uint32(uint64(micros*count) * uint64(rate) / 1000000)
}
