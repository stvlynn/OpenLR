const big = "big";
export function view(buf) {
    return new DataView(buf.buffer);
}
export function readU8(opts) {
    return view(opts.buf).getUint8(opts.offset || 0);
}
export function writeU8(value, opts) {
    view(opts.buf).setUint8(opts.offset || 0, value);
}
export function readI8(opts) {
    return view(opts.buf).getInt8(opts.offset || 0);
}
export function writeI8(value, opts) {
    view(opts.buf).setInt8(opts.offset || 0, value);
}
export function readU16(opts) {
    return view(opts.buf).getUint16(opts.offset || 0, opts.endian !== big);
}
export function writeU16(value, opts) {
    view(opts.buf).setUint16(opts.offset || 0, value, opts.endian !== big);
}
export function readI16(opts) {
    return view(opts.buf).getInt16(opts.offset || 0, opts.endian !== big);
}
export function writeI16(value, opts) {
    view(opts.buf).setInt16(opts.offset || 0, value, opts.endian !== big);
}
export function readU32(opts) {
    return view(opts.buf).getUint32(opts.offset || 0, opts.endian !== big);
}
export function writeU32(value, opts) {
    view(opts.buf).setUint32(opts.offset || 0, value, opts.endian !== big);
}
export function readI32(opts) {
    return view(opts.buf).getInt32(opts.offset || 0, opts.endian !== big);
}
export function writeI32(value, opts) {
    view(opts.buf).setInt32(opts.offset || 0, value, opts.endian !== big);
}
export function readU64(opts) {
    return view(opts.buf).getBigUint64(opts.offset || 0, opts.endian !== big);
}
export function writeU64(value, opts) {
    view(opts.buf).setBigUint64(opts.offset || 0, value, opts.endian !== big);
}
export function readI64(opts) {
    return view(opts.buf).getBigInt64(opts.offset || 0, opts.endian !== big);
}
export function writeI64(value, opts) {
    view(opts.buf).setBigInt64(opts.offset || 0, value, opts.endian !== big);
}
export function readU128(opts) {
    const v = view(opts.buf);
    const offset = opts.offset || 0;
    const littleEndian = opts.endian !== big;
    const lo = v.getBigUint64(offset, littleEndian);
    const hi = v.getBigUint64(offset + 8, littleEndian);
    return littleEndian ? lo | (hi << 64n) : hi | (lo << 64n);
}
export function writeU128(value, opts) {
    const v = view(opts.buf);
    const offset = opts.offset || 0;
    const littleEndian = opts.endian !== big;
    const lo = value & 0xffffffffffffffffn;
    const hi = value >> 64n;
    v.setBigUint64(offset, littleEndian ? lo : hi, littleEndian);
    v.setBigUint64(offset + 8, littleEndian ? hi : lo, littleEndian);
}
export function readI128(opts) {
    const v = view(opts.buf);
    const offset = opts.offset || 0;
    const littleEndian = opts.endian !== big;
    const lo = v.getBigInt64(offset, littleEndian);
    const hi = v.getBigInt64(offset + 8, littleEndian);
    // Combine into a single 128-bit bigint
    const result = littleEndian
        ? (hi << 64n) | lo
        : (lo << 64n) | BigInt.asUintN(64, hi); // Unsigned low combined with signed high
    // Adjust for negative values if the high bit (sign bit) of the high part is set
    return result >= 2n ** 127n ? result - 2n ** 128n : result;
}
export function writeI128(value, opts) {
    const v = view(opts.buf);
    const offset = opts.offset || 0;
    const littleEndian = opts.endian !== big;
    // Adjust for negative values by treating as unsigned if necessary
    const unsignedValue = value < 0n ? value + 2n ** 128n : value;
    const lo = unsignedValue & 0xffffffffffffffffn;
    const hi = BigInt.asIntN(64, unsignedValue >> 64n);
    v.setBigInt64(offset, littleEndian ? lo : hi, littleEndian);
    v.setBigInt64(offset + 8, littleEndian ? hi : lo, littleEndian);
}
export function readF32(opts) {
    return view(opts.buf).getFloat32(opts.offset || 0, opts.endian !== big);
}
export function writeF32(value, opts) {
    view(opts.buf).setFloat32(opts.offset || 0, value, opts.endian !== big);
}
export function readF64(opts) {
    return view(opts.buf).getFloat64(opts.offset || 0, opts.endian !== big);
}
export function writeF64(value, opts) {
    view(opts.buf).setFloat64(opts.offset || 0, value, opts.endian !== big);
}
export function readBool(opts) {
    return !!readU8(opts);
}
export function writeBool(value, opts) {
    writeU8(value ? 1 : 0, opts);
}
export function readChar(opts) {
    return String.fromCharCode(readU8(opts));
}
export function writeChar(value, opts) {
    writeU8(value.charCodeAt(0), opts);
}
