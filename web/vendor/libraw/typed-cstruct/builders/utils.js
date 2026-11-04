import { readU32 } from "../utils.js";
export function defineBuilder(builder) {
    return builder;
}
export function skip(size) {
    return {
        size,
        read() {
            return undefined;
        },
    };
}
export function convert(builder, convert) {
    return {
        size: builder.size,
        read(opts, ctx) {
            return convert(builder.read(opts, ctx));
        },
    };
}
export function ptr(builder) {
    const read = (opts) => {
        const p = readU32(opts);
        if (p === 0)
            return null;
        return builder.read({ ...opts, offset: p }, {});
    };
    const write = builder.write
        ? (value, opts) => {
            if (value === null)
                throw new Error("Cannot write null pointer");
            const p = readU32(opts);
            if (p === 0)
                throw new Error("Cannot write to null pointer");
            builder.write?.(value, { ...opts, offset: p }, {});
        }
        : undefined;
    const proxy = builder.proxy
        ? (opts) => {
            const p = readU32(opts);
            if (p === 0)
                return null;
            return builder.proxy?.({ ...opts, offset: p }, {}) ?? null;
        }
        : undefined;
    return { size: 4, read, write, proxy };
}
