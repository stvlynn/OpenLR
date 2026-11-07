"""Inspect bounded ARM64 instructions in the UUID-matched loaded system image."""

import json
from pathlib import Path
import posixpath
import re
import shlex

import lldb


PREFIX = "OpenLR signal code inspection "
JSC_PATH = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/JavaScriptCore"
MAX_INSTRUCTIONS = 512
MAX_POINTS = 16
MAX_FUNCTIONS = 8
U64_MAX = (1 << 64) - 1


def text(value, limit=512):
    return str(value or "")[:limit]


def uuid_key(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F-]{32,36}", value):
        raise ValueError("Expected a UUID")
    key = value.replace("-", "").upper()
    if len(key) != 32:
        raise ValueError("Expected a 128-bit UUID")
    return key


def native_error(error):
    return {"code": error.GetError(), "message": text(error.GetCString(), 240)}


def loaded(target, address):
    value = address.GetLoadAddress(target)
    if not address.IsValid() or value == lldb.LLDB_INVALID_ADDRESS or not 0 <= value < U64_MAX:
        raise ValueError("Code load address unavailable")
    return value


def checked_code(target, value, expected_uuid):
    if value % 4:
        raise ValueError("ARM64 code address is not aligned")
    address = target.ResolveLoadAddress(value)
    if not address.IsValid() or loaded(target, address) != value:
        raise ValueError("Code point has no loaded address")
    module, section = address.GetModule(), address.GetSection()
    if not module.IsValid() or uuid_key(module.GetUUIDString()) != expected_uuid:
        raise ValueError("Code point is outside the expected UUID")
    if not section.IsValid() or section.GetSectionType() != lldb.eSectionTypeCode:
        raise ValueError("Code point is outside a code section")
    start = section.GetLoadAddress(target)
    end = start + section.GetByteSize()
    if not 0 <= start <= value < end <= U64_MAX:
        raise ValueError("Code point is outside loaded section bounds")
    return address, start, end


def read_code(target, start, end, count, expected_uuid):
    if not 0 < count <= MAX_INSTRUCTIONS or start + 4 * count > end:
        raise ValueError("Instruction request exceeds its bounded code range")
    address, section_start, section_end = checked_code(target, start, expected_uuid)
    if start < section_start or start + 4 * count > section_end:
        raise ValueError("Instruction request crosses a code section")
    instructions = target.ReadInstructions(address, count)
    if instructions.GetSize() != count:
        raise ValueError("LLDB returned an incomplete instruction list")
    result = []
    for index in range(count):
        instruction = instructions.GetInstructionAtIndex(index)
        value = loaded(target, instruction.GetAddress())
        if not instruction.IsValid() or value != start + index * 4 or instruction.GetByteSize() != 4:
            raise ValueError("LLDB returned a noncontiguous ARM64 instruction")
        checked_code(target, value, expected_uuid)
        data = instruction.GetData(target)
        if not data.IsValid() or data.GetByteSize() != 4:
            raise ValueError("LLDB instruction opcode is unavailable")
        opcode = []
        for byte in range(4):
            error = lldb.SBError()
            opcode.append(data.GetUnsignedInt8(error, byte))
            if not error.Success():
                raise ValueError("LLDB instruction opcode read failed")
        result.append({
            "address": hex(value), "opcode": bytes(opcode).hex(),
            "mnemonic": text(instruction.GetMnemonic(target), 64),
            "operands": text(instruction.GetOperands(target)),
            "comment": text(instruction.GetComment(target)),
        })
    return result


def code_range(target, address, point):
    for kind, owner in (("function", address.GetFunction()), ("symbol", address.GetSymbol())):
        if not owner.IsValid():
            continue
        try:
            start = loaded(target, owner.GetStartAddress())
            end = loaded(target, owner.GetEndAddress())
        except ValueError:
            continue
        if start % 4 == 0 and end % 4 == 0 and start <= point < end:
            return {"kind": kind, "name": text(owner.GetName()), "start": hex(start), "end": hex(end)}
    raise ValueError("Resolved code has no containing function or symbol range")


def collect(target, process, request, report):
    expected_uuid = uuid_key(request.get("uuid"))
    report["expectedUUID"] = expected_uuid
    if not target.GetTriple().split("-")[0].startswith("arm64"):
        raise ValueError("Code inspection requires an ARM64 target")
    modules = []
    for index in range(target.GetNumModules()):
        module = target.GetModuleAtIndex(index)
        spec = module.GetFileSpec()
        if spec.GetFilename() == "JavaScriptCore":
            modules.append(module)
    report["loadedJSCUUIDs"] = [text(module.GetUUIDString(), 36) for module in modules]
    if len(modules) != 1:
        raise ValueError("Exactly one loaded JavaScriptCore module is required")
    module = modules[0]
    spec = module.GetFileSpec()
    actual_path = posixpath.join(spec.GetDirectory(), spec.GetFilename())
    report["modulePath"] = actual_path
    report["moduleUUID"] = text(module.GetUUIDString(), 36)
    report["moduleTriple"] = text(module.GetTriple(), 100)
    if actual_path != JSC_PATH or uuid_key(module.GetUUIDString()) != expected_uuid:
        raise ValueError("Loaded official JavaScriptCore identity does not match captured frames")
    report["uuidMatched"] = True
    base = loaded(target, module.GetObjectFileHeaderAddress())
    report["loadBase"] = hex(base)
    report["triple"] = text(target.GetTriple(), 100)
    report["byteOrder"] = process.GetByteOrder()
    # Reserve every requested 17-instruction window before reading prefixes.
    # Even if all windows belong to one function, its total request stays <=512.
    prefix_limit = MAX_INSTRUCTIONS - len(request["points"]) * 17
    functions = {}
    for point in request["points"]:
        item = {"offset": point["offset"], "sources": point["sources"], "status": "error"}
        report["points"].append(item)
        try:
            value = base + int(point["offset"], 16)
            if value > U64_MAX:
                raise ValueError("Code point overflows its loaded image")
            address, section_start, section_end = checked_code(target, value, expected_uuid)
            bounds = code_range(target, address, value)
            start, end = int(bounds["start"], 16), int(bounds["end"], 16)
            if not section_start <= start < end <= section_end:
                raise ValueError("Function range is outside its code section")
            key = bounds["start"] + ":" + bounds["end"]
            if key not in functions:
                if len(functions) >= MAX_FUNCTIONS:
                    raise ValueError("Selected function count exceeds its diagnostic bound")
                function = dict(bounds, truncated=end - start > prefix_limit * 4,
                                instructionCap=MAX_INSTRUCTIONS, prefixLimit=prefix_limit)
                functions[key] = function
                report["functions"].append(function)
                count = min((end - start) // 4, prefix_limit)
                function["instructions"] = read_code(target, start, end, count, expected_uuid)
                function["readEnd"] = hex(start + count * 4)
            item["address"] = hex(value)
            item["function"] = key
            window_start, window_end = max(start, value - 8 * 4), min(end, value + 9 * 4)
            item["windowStart"], item["windowEnd"] = hex(window_start), hex(window_end)
            item["instructions"] = read_code(
                target, window_start, window_end, (window_end - window_start) // 4, expected_uuid
            )
            if not any(int(instruction["address"], 16) == value for instruction in item["instructions"]):
                raise ValueError("Exact captured code point is missing from its window")
            item["status"] = "complete"
        except Exception as error:
            item["error"] = text(error, 240)
    report["status"] = "complete" if all(point["status"] == "complete" for point in report["points"]) else "partial"


def inspect_code(debugger, command, _context, _result, _internal):
    report = {"pid": None, "nonce": None, "status": "error", "error": None,
              "uuidMatched": False, "functions": [], "points": [],
              "detachRequestedKeepStopped": False, "detachSuccess": None, "detachError": None,
              "lldbVersion": text(lldb.SBDebugger.GetVersionString(), 240)}
    process = None
    attached = False
    try:
        arguments = shlex.split(command)
        if len(arguments) != 1 or not Path(arguments[0]).is_absolute():
            raise ValueError("Pass exactly one absolute request JSON path")
        request_path = Path(arguments[0])
        if request_path.stat().st_size > 32768:
            raise ValueError("Code request exceeds its diagnostic bound")
        request = json.loads(request_path.read_text(encoding="utf-8"))
        pid, nonce, points = request.get("pid"), request.get("nonce"), request.get("points")
        if isinstance(pid, bool) or not isinstance(pid, int) or not 0 < pid <= 0x7fffffff:
            raise ValueError("Expected a positive owned fixture PID")
        if not isinstance(nonce, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", nonce):
            raise ValueError("Expected a bounded nonce")
        if not isinstance(points, list) or not 0 < len(points) <= MAX_POINTS:
            raise ValueError("Expected bounded captured code points")
        for point in points:
            if not isinstance(point, dict) or not re.fullmatch(r"0x[0-9a-fA-F]{1,16}", point.get("offset", "")):
                raise ValueError("Expected hexadecimal image offsets")
            if int(point["offset"], 16) % 4 or not isinstance(point.get("sources"), list) or not 0 < len(point["sources"]) <= 64:
                raise ValueError("Expected aligned offsets with bounded source evidence")
        report["pid"], report["nonce"] = pid, nonce
        uuid_key(request.get("uuid"))
        debugger.SetAsync(False)
        target = debugger.CreateTarget("")
        error = lldb.SBError()
        process = target.AttachToProcessWithID(lldb.SBListener("openlr-code-inspection"), pid, error)
        attached = process.IsValid()
        if not error.Success() or not attached or process.GetProcessID() != pid:
            report["attachError"] = native_error(error)
            raise ValueError("Could not attach to the owned waiting fixture")
        if process.GetState() != lldb.eStateStopped:
            raise ValueError("Owned fixture did not stop for code inspection")
        collect(target, process, request, report)
    except Exception as error:
        report["status"], report["error"] = "error", text(error, 240)
    finally:
        if attached:
            try:
                error = process.Detach(False)
                report["detachSuccess"] = error.Success()
                if not error.Success():
                    report["detachError"] = native_error(error)
            except Exception as error:
                report["detachSuccess"] = False
                report["detachError"] = {"message": text(error, 240)}
        print(PREFIX + json.dumps(report), flush=True)


def __lldb_init_module(debugger, _):
    debugger.HandleCommand("command script add -f signal_code_trace.inspect_code openlr-inspect-signal-code")
