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
// OpenLR diagnostic addition. The Go runtime source retains its BSD-3-Clause license.
// Called after badsignal has obtained an M and before the original signal is re-raised.
// The signal code has already been normalized by Darwin fixsigcode.
//go:nosplit
//go:nowritebarrierrec
func openlrOriginalSignal(sig uint32, c *sigctxt) {
	var record [160]byte
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
}
`
await writeFile(sourcePath, source.replace(entry, hook) + helper)
console.log(JSON.stringify({ diagnosticToolchain: destination, version }))
