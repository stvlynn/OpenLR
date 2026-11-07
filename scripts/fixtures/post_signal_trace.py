"""Read an owned, stopped ARM64 process using its saved original signal context."""

import json
from pathlib import Path
import re
import shlex
import time

import lldb


PREFIX = "OpenLR post signal capture "
MAX_RECORDS = 12
U64_MAX = (1 << 64) - 1
CONTINUATION_SECONDS = 10


def checked_hex(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{1,16}", value):
        raise ValueError("Context values must be hexadecimal unsigned 64-bit strings")
    return int(value, 16)


def safe_text(value, pattern, limit):
    return value if isinstance(value, str) and len(value) <= limit and re.fullmatch(pattern, value) else None


def error_text(error):
    # Keep tool failures visible without serializing arbitrary file paths or buffers.
    return safe_text(str(error), r"[A-Za-z0-9 .,:;_()+'=/<>\-]+", 240) or type(error).__name__


def native_error(error):
    return {"code": error.GetError(), "message": (error.GetCString() or "Native LLDB error")[:240]}


def state_name(state):
    for name in ("invalid", "unloaded", "connected", "attaching", "launching", "stopped",
                 "running", "stepping", "crashed", "detached", "exited", "suspended"):
        enum_name = "eState" + name.capitalize()
        if hasattr(lldb, enum_name) and state == getattr(lldb, enum_name):
            return name
    return "unknown-" + str(state)


def record_terminal(process, report):
    if process.GetProcessID() != report["pid"]:
        raise ValueError("Attached process PID differs from the owned request")
    state = process.GetState()
    report["terminalState"] = state_name(state)
    report["terminalStateValue"] = state
    if state == lldb.eStateExited:
        report["terminalExitStatus"] = process.GetExitStatus()
        report["sessionComplete"] = True
    return state


def configure_signal_policy(process, report):
    policy = {"configured": False, "signals": [],
              "scope": "Public LLDB signal policy; native termination requires independent verification"}
    report["signalPolicy"] = policy
    signals = process.GetUnixSignals()
    if not signals.IsValid():
        raise ValueError("Owned process Unix signal policy unavailable")
    for name in ("SIGTRAP", "SIGURG"):
        number = signals.GetSignalNumberFromName(name)
        entry = {"name": name, "number": number, "setters": {}, "values": {}}
        policy["signals"].append(entry)
        if not isinstance(number, int) or number < 0:
            raise ValueError("Required target signal unavailable")
        for label, setter, getter in (
            ("stop", "SetShouldStop", "GetShouldStop"),
            ("suppress", "SetShouldSuppress", "GetShouldSuppress"),
            ("notify", "SetShouldNotify", "GetShouldNotify"),
        ):
            entry["setters"][label] = bool(getattr(signals, setter)(number, False))
            entry["values"][label] = bool(getattr(signals, getter)(number))
        if not all(entry["setters"].values()) or any(entry["values"].values()):
            raise ValueError("Public LLDB signal policy did not accept pass-through settings")
    policy["configured"] = True


def continue_to_exit(debugger, process, listener, report):
    # Collection may fail, but releasing the original signal is a separate obligation.
    if record_terminal(process, report) == lldb.eStateExited:
        return
    if process.GetState() != lldb.eStateStopped:
        raise ValueError("Owned process is not stopped before continuation")
    configure_signal_policy(process, report)
    report["initialStopID"] = process.GetStopID()
    event = lldb.SBEvent()
    # Discard the attach stop before continuing. It is not a new product stop.
    drained = 0
    while drained < 64 and listener.GetNextEvent(event):
        drained += 1
    report["initialEventsDrained"] = drained
    debugger.SetAsync(True)
    resumed = process.Continue()
    report["resumeSuccess"] = bool(resumed.Success())
    if not resumed.Success():
        report["continuationError"] = native_error(resumed)
        raise ValueError("Owned process Continue failed")
    deadline = time.monotonic() + CONTINUATION_SECONDS
    report["continuationBudgetMs"] = CONTINUATION_SECONDS * 1000
    events = report["continuationEvents"]
    while True:
        state = record_terminal(process, report)
        if state == lldb.eStateExited:
            return
        if state in (lldb.eStateCrashed, lldb.eStateDetached, lldb.eStateInvalid):
            raise ValueError("Owned process reached an unexpected terminal state")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Owned process did not naturally exit within the continuation budget")
        # The public listener timeout is in whole seconds. Poll the final fraction.
        available = listener.WaitForEvent(1, event) if remaining >= 1 else listener.GetNextEvent(event)
        if not available:
            if remaining < 1:
                time.sleep(min(0.05, remaining))
            continue
        if not lldb.SBProcess.EventIsProcessEvent(event):
            continue
        event_state = lldb.SBProcess.GetStateFromEvent(event)
        restarted = bool(lldb.SBProcess.GetRestartedFromEvent(event))
        if len(events) < 24:
            events.append({"state": state_name(event_state), "value": event_state, "restarted": restarted})
        if event_state in (lldb.eStateStopped, lldb.eStateCrashed) and not restarted:
            record_terminal(process, report)
            raise ValueError("Owned process reported an unexpected stop during continuation")


def finish_session(debugger, process, listener, report, allow_continue):
    report["captureStatus"] = report["status"]
    try:
        if not allow_continue:
            raise ValueError("Attachment identity and success were not verified; continuation forbidden")
        continue_to_exit(debugger, process, listener, report)
    except Exception as error:
        if report["continuationError"] is None:
            report["continuationError"] = {"type": type(error).__name__, "message": error_text(error)}
        report["status"] = "error"
    if report["sessionComplete"]:
        return
    if allow_continue:
        try:
            if record_terminal(process, report) == lldb.eStateExited:
                return
        except Exception:
            # Retain the primary continuation error; still attempt to release attachment.
            pass
    # A failed capture/continuation never authorizes killing the inferior here.
    # Parent-owned cleanup still checks the actual child's final signal independently.
    try:
        report["detachRequestedKeepStopped"] = False
        detached = process.Detach(False)
        report["detachSuccess"] = bool(detached.Success())
        if not detached.Success():
            report["detachError"] = native_error(detached)
    except Exception as error:
        report["detachSuccess"] = False
        report["detachError"] = {"type": type(error).__name__, "message": error_text(error)}
    if report["detachSuccess"] is False:
        report["cleanupError"] = report["detachError"]
    if allow_continue:
        try:
            record_terminal(process, report)
        except Exception as error:
            report["cleanupError"] = report["cleanupError"] or {
                "type": type(error).__name__, "message": error_text(error)
            }


def region_at(process, address):
    info = lldb.SBMemoryRegionInfo()
    error = process.GetMemoryRegionInfo(address, info)
    if not error.Success():
        raise ValueError("Memory region query failed")
    return {
        "base": hex(info.GetRegionBase()),
        "end": hex(info.GetRegionEnd()),
        "mapped": bool(info.IsMapped()),
        "readable": bool(info.IsReadable()),
    }


def describe_code(target, raw_address, address, source):
    record = {"source": source, "rawAddress": hex(raw_address), "address": hex(address)}
    if not address or address == U64_MAX or address & 3:
        return dict(record, status="unmapped", error="Invalid aligned code address")
    resolved = target.ResolveLoadAddress(address)
    module = resolved.GetModule()
    section = resolved.GetSection()
    if not resolved.IsValid() or not module.IsValid() or not section.IsValid():
        return dict(record, status="unmapped", error="Code address has no loaded module and section")
    base = module.GetObjectFileHeaderAddress().GetLoadAddress(target)
    uuid = safe_text(module.GetUUIDString(), r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32}", 36)
    image = safe_text(module.GetFileSpec().GetFilename(), r"[A-Za-z0-9_.+ -]+", 80)
    if base == U64_MAX or base > address or not uuid or not image:
        return dict(record, status="unmapped", error="Loaded image identity or base unavailable")
    function = resolved.GetFunction()
    symbol = function.GetName() if function.IsValid() else None
    if not symbol:
        symbol = resolved.GetSymbol().GetName()
    return dict(
        record,
        status="mapped",
        image=image,
        uuid=uuid,
        base=hex(base),
        imageOffset=address - base,
        section=safe_text(section.GetName(), r"[A-Za-z0-9_.$+-]+", 80),
        symbol=safe_text(symbol, r"[A-Za-z0-9_.$:<>,()\[\] +\-~*&!]+", 160),
    )


def collect(process, target, raw_context, report):
    capabilities = report["capabilities"]
    if not all(capabilities[name] for name in ("fixAddress", "getAddressMask", "codeEnum", "dataEnum")):
        raise ValueError("Required public LLDB address normalization API unavailable")
    if process.GetAddressByteSize() != 8:
        raise ValueError("Expected a 64-bit target")
    triple = target.GetTriple() or ""
    if not triple.startswith(("arm64", "aarch64")):
        raise ValueError("Expected an ARM64 target")
    report["targetTriple"] = safe_text(triple, r"[A-Za-z0-9_.-]+", 100)
    code_type, data_type = lldb.eAddressMaskTypeCode, lldb.eAddressMaskTypeData
    code_mask, data_mask = process.GetAddressMask(code_type), process.GetAddressMask(data_type)
    invalid_mask = getattr(lldb, "LLDB_INVALID_ADDRESS_MASK", U64_MAX)
    report["masks"] = {
        "code": hex(code_mask),
        "data": hex(data_mask),
        "codeKnown": code_mask != invalid_mask,
        "dataKnown": data_mask != invalid_mask,
        "scope": "LLDB ABI normalization; stripping does not authenticate pointers",
    }
    report["normalizationScope"] = (
        "process-masks-reported" if code_mask != invalid_mask and data_mask != invalid_mask
        else "unknown-process-mask; LLDB ABI fallback is not proof of complete PAC stripping"
    )
    original = {name: checked_hex(raw_context[name]) for name in ("pc", "lr", "sp", "fp")}
    normalized = {
        name: process.FixAddress(value, code_type if name in ("pc", "lr") else data_type)
        for name, value in original.items()
    }
    if any(not isinstance(value, int) or not 0 <= value <= U64_MAX for value in normalized.values()):
        raise ValueError("LLDB returned an invalid normalized address")
    report["context"]["normalized"] = {name: hex(value) for name, value in normalized.items()}
    report["frames"] = [
        describe_code(target, original[name], normalized[name], "original-" + name)
        for name in ("pc", "lr")
    ]
    if any(frame["status"] != "mapped" for frame in report["frames"]):
        raise ValueError("Original PC or LR could not be resolved to an identified loaded image")
    sp, fp = normalized["sp"], normalized["fp"]
    stack = region_at(process, sp)
    report["stackRegion"] = stack
    lower, upper = int(stack["base"], 16), int(stack["end"], 16)
    if not stack["mapped"] or not stack["readable"] or not lower <= sp < upper:
        raise ValueError("Original SP is outside a mapped readable region")
    if sp & 15:
        raise ValueError("Original SP is not 16-byte aligned")
    order = process.GetByteOrder()
    if order not in (lldb.eByteOrderLittle, lldb.eByteOrderBig):
        raise ValueError("Target byte order unavailable")
    byte_order = "little" if order == lldb.eByteOrderLittle else "big"
    report["byteOrder"] = byte_order
    seen = set()
    raw_fp = original["fp"]
    report["stopReason"] = "depth-limit"
    for index in range(MAX_RECORDS):
        if fp == 0:
            report["stopReason"] = "null-frame-pointer"
            break
        if fp & 15:
            report["stopReason"] = "unaligned-frame-pointer"
            break
        if fp in seen:
            report["stopReason"] = "repeated-frame-pointer"
            break
        if fp < sp or fp < lower or fp > upper - 16:
            report["stopReason"] = "frame-pointer-out-of-bounds"
            break
        try:
            current_region = region_at(process, fp)
        except Exception as error:
            report["stopReason"] = "frame-pointer-region-unavailable"
            report["error"] = error_text(error)
            break
        if not current_region["mapped"] or not current_region["readable"]:
            report["stopReason"] = "frame-pointer-unmapped-or-unreadable"
            break
        if current_region != stack:
            report["stopReason"] = "frame-pointer-region-mismatch"
            break
        seen.add(fp)
        record = {"index": index, "rawFP": hex(raw_fp), "fp": hex(fp)}
        report["records"].append(record)
        error = lldb.SBError()
        data = process.ReadMemory(fp, 16, error)
        if not error.Success() or not isinstance(data, bytes) or len(data) != 16:
            record["readSuccess"] = bool(error.Success())
            record["bytesRead"] = len(data) if isinstance(data, bytes) else 0
            record["readError"] = safe_text(error.GetCString(), r"[A-Za-z0-9 .,:;_()+'=/<>\-]+", 240)
            report["stopReason"] = "frame-record-read-failed"
            break
        raw_next = int.from_bytes(data[:8], byte_order)
        raw_lr = int.from_bytes(data[8:], byte_order)
        next_fp = process.FixAddress(raw_next, data_type)
        saved_lr = process.FixAddress(raw_lr, code_type)
        record.update(rawNextFP=hex(raw_next), nextFP=hex(next_fp), rawSavedLR=hex(raw_lr), savedLR=hex(saved_lr))
        frame = describe_code(target, raw_lr, saved_lr, "frame-record-" + str(index))
        report["frames"].append(frame)
        if frame["status"] != "mapped":
            report["stopReason"] = "saved-return-address-unmapped"
            break
        if next_fp == 0:
            report["stopReason"] = "end-of-chain"
            break
        if next_fp <= fp:
            report["stopReason"] = "non-monotonic-frame-pointer"
            break
        raw_fp, fp = raw_next, next_fp
    report["status"] = "captured" if report["stopReason"] == "end-of-chain" else "partial"
    if not report["masks"]["codeKnown"] or not report["masks"]["dataKnown"]:
        report["status"] = "partial"


def capture_signal(debugger, command, _context, _result, _internal):
    report = {
        "pid": None, "nonce": None, "status": "error", "error": None,
        "lldbVersion": None,
        "capabilities": {}, "context": {"raw": {}}, "frames": [], "records": [],
        "stopReason": "capture-not-started", "detachSuccess": None, "detachError": None,
        "captureStatus": None, "resumeSuccess": False, "signalPolicy": None,
        "terminalState": None, "terminalStateValue": None, "terminalExitStatus": None,
        "sessionComplete": False, "continuationError": None, "cleanupError": None,
        "continuationEvents": [],
    }
    process = None
    attached = False
    attachment_verified = False
    try:
        report["lldbVersion"] = safe_text(
            lldb.SBDebugger.GetVersionString(), r"[A-Za-z0-9 .,:;_()+'=/<>\-\n]+", 240
        )
        arguments = shlex.split(command)
        if len(arguments) != 1 or not Path(arguments[0]).is_absolute():
            raise ValueError("Pass exactly one absolute request JSON path")
        request_path = Path(arguments[0])
        if request_path.stat().st_size > 16384:
            raise ValueError("Request JSON exceeds the diagnostic bound")
        request = json.loads(request_path.read_text(encoding="utf-8"))
        pid, nonce, raw_context = request.get("pid"), request.get("nonce"), request.get("context")
        if isinstance(pid, bool) or not isinstance(pid, int) or not 0 < pid <= 0x7FFFFFFF:
            raise ValueError("Request requires a positive owned PID")
        report["pid"] = pid
        if not isinstance(nonce, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", nonce):
            raise ValueError("Request requires a bounded nonce")
        report["nonce"] = nonce
        if not isinstance(raw_context, dict) or not 4 <= len(raw_context) <= 40:
            raise ValueError("Request requires a bounded original register context")
        for name, value in raw_context.items():
            if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", name):
                raise ValueError("Invalid context register name")
            checked_hex(value)
        if not all(name in raw_context for name in ("pc", "lr", "sp", "fp")):
            raise ValueError("Request requires original PC LR SP FP")
        report["context"]["raw"] = dict(raw_context)
        debugger.SetAsync(False)
        target = debugger.CreateTarget("")
        listener = lldb.SBListener("openlr-post-signal")
        error = lldb.SBError()
        process = target.AttachToProcessWithID(listener, pid, error)
        attached = process.IsValid()
        if not error.Success() or not attached or process.GetProcessID() != pid:
            raise ValueError("Could not attach to the owned PID")
        attachment_verified = True
        if process.GetState() != lldb.eStateStopped:
            raise ValueError("Owned process is not stopped")
        report["capabilities"] = {
            "fixAddress": hasattr(process, "FixAddress"),
            "getAddressMask": hasattr(process, "GetAddressMask"),
            "codeEnum": hasattr(lldb, "eAddressMaskTypeCode"),
            "dataEnum": hasattr(lldb, "eAddressMaskTypeData"),
        }
        collect(process, target, raw_context, report)
    except Exception as error:
        report["status"] = "error"
        report["error"] = error_text(error)
        report["stopReason"] = "capture-error"
    finally:
        if attached:
            finish_session(debugger, process, listener, report, attachment_verified)
        print(PREFIX + json.dumps(report), flush=True)


def __lldb_init_module(debugger, _):
    debugger.HandleCommand("command script add -f post_signal_trace.capture_signal openlr-capture-signal")
