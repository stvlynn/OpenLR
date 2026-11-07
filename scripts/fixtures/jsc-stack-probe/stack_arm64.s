//go:build darwin && arm64

#include "textflag.h"

// Observation only: never changes the target's stack or register context.
TEXT ·readStackPointer(SB), NOSPLIT|NOFRAME, $0-8
	MOVD RSP, R0
	MOVD R0, ret+0(FP)
	RET
