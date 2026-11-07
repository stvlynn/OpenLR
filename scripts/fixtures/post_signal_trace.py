"""Read an owned, stopped ARM64 process using its saved original signal context."""

import json
from pathlib import Path
import re
import shlex

import lldb


PREFIX = "OpenLR post signal capture "
MAX_RECORDS = 12
U64_MAX = (1 << 64) - 1


def checked_hex(value):
    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-fA-F]{1,16}", value):
        raise ValueError("Context values must be hexadecimal unsigned 64-bit strings")
    return int(value, 16)


def safe_text(value, pattern, limit):
    return value if isinstance(value, str) and len(value) <= limit and re.fullmatch(pattern, value) else None


def error_text(error):
    # Keep tool failures visible without serializing arbitrary file paths or buffers.
    return safe_text(str(error), r"[A-Za-z0-9 .,:;_()+'=/<>\-]+", 240) or type(error).__name__


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
    }
    process = None
    attached = False
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
            try:
                report["detachRequestedKeepStopped"] = False
                detached = process.Detach(False)
                report["detachSuccess"] = bool(detached.Success())
                if not detached.Success():
                    report["detachError"] = {
                        "code": detached.GetError(),
                        "message": (detached.GetCString() or "Normal detach failed")[:240],
                    }
                    report["status"] = "error"
            except Exception as error:
                report["detachSuccess"] = False
                report["detachError"] = error_text(error)
                report["status"] = "error"
        print(PREFIX + json.dumps(report), flush=True)


def __lldb_init_module(debugger, _):
    debugger.HandleCommand("command script add -f post_signal_trace.capture_signal openlr-capture-signal")
