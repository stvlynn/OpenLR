"""An LLDB command for the owned OpenLR host in a native diagnostic."""

import json
from pathlib import Path
import re
import shlex
import signal
import time

import lldb


def emit(pid, phase, **fields):
    print("OpenLR host LLDB " + json.dumps(dict(pid=pid, phase=phase, **fields)), flush=True)


def identifier(value, pattern):
    return value if value and re.fullmatch(pattern, value) else None


def fault(process):
    priority = {
        lldb.eStopReasonException: 3,
        lldb.eStopReasonSignal: 2,
        lldb.eStopReasonBreakpoint: 1,
    }
    threads = (process.GetThreadAtIndex(index) for index in range(process.GetNumThreads()))
    thread = max(threads, key=lambda candidate: priority.get(candidate.GetStopReason(), 0), default=None)
    if thread is None or not priority.get(thread.GetStopReason()):
        return {}
    reason = thread.GetStopReason()
    names = {
        lldb.eStopReasonException: "exception",
        lldb.eStopReasonSignal: "signal",
        lldb.eStopReasonBreakpoint: "breakpoint",
    }
    description = thread.GetStopDescription(160) or ""
    exception = re.search(r"\bEXC_[A-Z0-9_]{1,48}\b", description)
    frames = []
    for index in range(min(thread.GetNumFrames(), 12)):
        frame = thread.GetFrameAtIndex(index)
        module = frame.GetModule()
        address = frame.GetPCAddress().GetFileAddress()
        base = module.GetObjectFileHeaderAddress().GetFileAddress()
        frames.append({
            "image": identifier(module.GetFileSpec().GetFilename(), r"[A-Za-z0-9_.+ -]{1,80}"),
            "uuid": identifier(module.GetUUIDString(), r"[0-9A-Fa-f-]{1,36}"),
            "symbol": identifier(frame.GetFunctionName(), r"[A-Za-z0-9_.$:<>,()\[\] +\-~*&!]{1,128}"),
            "imageOffset": address - base if base <= address < lldb.LLDB_INVALID_ADDRESS else None,
        })
    registers = {}
    frame = thread.GetFrameAtIndex(0)
    if frame.IsValid():
        # Numeric stopped-thread state only; never dereference application buffers.
        names = ("pc", "lr", "fp", "sp", "x0", "x1", "x2", "x3",
                 "x19", "x20", "x21", "x22", "x23", "x24")
        for name in names:
            register = frame.FindRegister(name)
            if register.IsValid():
                error = lldb.SBError()
                value = register.GetValueAsUnsigned(error)
                if error.Success():
                    registers[name] = hex(value)
    return {
        "thread": thread.GetIndexID(),
        "mainQueue": thread.GetQueueName() == "com.apple.main-thread",
        "reason": names[reason],
        "exception": exception.group() if exception else None,
        "signal": thread.GetStopReasonDataAtIndex(0) if reason == lldb.eStopReasonSignal else None,
        "frames": frames,
        "registers": registers,
    }


def trace_host(debugger, command, _context, _result, _internal):
    pid_text, finished, runtime = shlex.split(command)
    pid = int(pid_text)
    debugger.SetAsync(False)
    listener = lldb.SBListener("openlr-host-trace")
    error = lldb.SBError()
    target = debugger.CreateTarget("")
    emit(pid, "attach-started")
    process = target.AttachToProcessWithID(listener, pid, error)
    if not error.Success() or not process.IsValid() or process.GetProcessID() != pid:
        emit(pid, "attach-failed", code=error.GetError())
        return

    event = lldb.SBEvent()
    # The stop caused by attaching is expected and is not a product fault.
    while listener.GetNextEvent(event):
        pass
    signals = process.GetUnixSignals()
    signals.SetShouldStop(signal.SIGTRAP, True)
    signals.SetShouldNotify(signal.SIGTRAP, True)
    # Go uses SIGURG for asynchronous preemption. Pass it to the runtime.
    signals.SetShouldStop(signal.SIGURG, False)
    signals.SetShouldNotify(signal.SIGURG, False)
    signals.SetShouldSuppress(signal.SIGURG, False)
    debugger.SetAsync(True)
    error = process.Continue()
    if not error.Success():
        emit(pid, "resume-failed", code=error.GetError())
        process.Detach()
        return

    deadline = time.monotonic() + int(runtime)
    running = False
    while time.monotonic() < deadline:
        if not listener.GetNextEvent(event):
            if Path(finished).exists():
                detached = process.Detach()
                emit(pid, "detached" if detached.Success() else "detach-failed", code=detached.GetError())
                return
            if not listener.WaitForEvent(1, event):
                continue
        if not lldb.SBProcess.EventIsProcessEvent(event):
            continue
        state = lldb.SBProcess.GetStateFromEvent(event)
        if state == lldb.eStateRunning and not running:
            running = True
            emit(pid, "running")
        elif state in (lldb.eStateStopped, lldb.eStateCrashed) and not lldb.SBProcess.GetRestartedFromEvent(event):
            details = fault(process)
            if details.get("signal") != signal.SIGTRAP and details.get("exception") != "EXC_BREAKPOINT":
                emit(pid, "unexpected-stop", **details)
                process.Detach()
                return
            emit(pid, "fault", **details)
            # This diagnostic owns the inferior. It has already stopped on the fault.
            # End it so the waiting CLI sees a closed broker rather than a frozen one.
            killed = process.Kill()
            if not killed.Success():
                emit(pid, "kill-failed", code=killed.GetError())
            return
        elif state == lldb.eStateExited:
            emit(pid, "inferior-exited", code=process.GetExitStatus())
            return

    emit(pid, "trace-deadline")
    process.Detach()


def __lldb_init_module(debugger, _):
    debugger.HandleCommand("command script add -f host_trace.trace_host openlr-trace-host")
