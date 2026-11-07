import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// This toolchain belongs only to the isolated original-signal experiment.
const go = process.env.GO_BINARY || 'go'
const version = execFileSync(go, ['env', 'GOVERSION'], { encoding: 'utf8' }).trim()
assert.equal(version, 'go1.27.3', 'Review the signal hook when changing the diagnostic toolchain')
const original = execFileSync(go, ['env', 'GOROOT'], { encoding: 'utf8' }).trim()
const destination = path.resolve('build/signal-toolchain')
await mkdir(path.dirname(destination), { recursive: true })
await cp(original, destination, { recursive: true, force: false, errorOnExist: true })
const sourcePath = path.join(destination, 'src/runtime/signal_unix.go')
const source = await readFile(sourcePath, 'utf8')
const entry = 'func raisebadsignal(sig uint32, c *sigctxt) {'
assert.equal(source.split(entry).length, 2, 'Expected the reviewed Go signal forwarding entry')
const hook = `${entry}
	if GOOS == "darwin" && GOARCH == "arm64" && sig == _SIGTRAP {
		openlrOriginalSignal(sig, c)
	}
`
const helper = String.raw`
// Linker-selected only in the opt-in post-fault diagnostic build.
var openlrFreezeSignal = "0"

// OpenLR diagnostic addition. The Go runtime source retains its BSD-3-Clause license.
// Called after badsignal has obtained an M and before the original signal is re-raised.
// The signal code has already been normalized by Darwin fixsigcode.
//go:nosplit
//go:nowritebarrierrec
func openlrOriginalSignal(sig uint32, c *sigctxt) {
	var record [320]byte
	n := copy(record[:], "OpenLR forwarded signal sig/code/pc/lr/sp ")
	values := [5]uint64{uint64(sig), uint64(c.sigcode()), uint64(c.sigpc()), uint64(c.siglr()), uint64(c.sigsp())}
	const digits = "0123456789abcdef"
	for _, value := range values {
		record[n] = '0'
		record[n+1] = 'x'
		n += 2
		for shift := 60; shift >= 0; shift -= 4 {
			record[n] = digits[(value>>uint(shift))&15]
			n++
		}
		record[n] = ' '
		n++
	}
	record[n] = '\n'
	writeErrData(&record[0], int32(n+1))

	n = copy(record[:], "OpenLR forwarded registers fp/x0/x1/x2/x3/x19/x20/x21/x22/x23/x24 ")
	registers := [11]uint64{c.r29(), c.r0(), c.r1(), c.r2(), c.r3(), c.r19(), c.r20(), c.r21(), c.r22(), c.r23(), c.r24()}
	for _, value := range registers {
		record[n] = '0'
		record[n+1] = 'x'
		n += 2
		for shift := 60; shift >= 0; shift -= 4 {
			record[n] = digits[(value>>uint(shift))&15]
			n++
		}
		record[n] = ' '
		n++
	}
	record[n] = '\n'
	writeErrData(&record[0], int32(n+1))
	if openlrFreezeSignal == "1" {
		raiseproc(_SIGSTOP)
	}
}
`
await writeFile(sourcePath, source.replace(entry, hook) + helper)
console.log(JSON.stringify({ diagnosticToolchain: destination, version }))
