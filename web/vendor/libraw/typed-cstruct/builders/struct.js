class Struct {
    fields;
    #size;
    constructor(fields) {
        this.fields = fields;
        this.#size = this.fields.reduce((acc, f) => acc + f.builder.size, 0);
    }
    get size() {
        return this.#size;
    }
    field(name, builder) {
        return new Struct([...this.fields, { name, builder, offset: this.#size }]);
    }
    override(name, builder) {
        const fields = this.fields.reduce((acc, f) => {
            const prev = acc.at(-1);
            const offset = prev ? prev.offset + prev.builder.size : 0;
            acc.push(f.name === name ? { name, builder, offset } : { ...f, offset });
            return acc;
        }, []);
        return new Struct(fields);
    }
    #proxy(opts, useProxy = false) {
        const { buf, offset = 0, endian = "little" } = opts;
        const self = this;
        const base = Object.fromEntries(self.fields.map((f) => [f.name, true]));
        const ret = new Proxy(base, {
            get(_, prop) {
                if (typeof prop !== "string")
                    return undefined;
                const field = self.fields.find((f) => f.name === prop);
                if (!field)
                    return undefined;
                if (useProxy && typeof field.builder.proxy === "function") {
                    return field.builder.proxy({ buf, offset: offset + field.offset, endian }, ret);
                }
                return field.builder.read({ buf, offset: offset + field.offset, endian }, ret);
            },
            set(_, prop, value) {
                if (typeof prop !== "string")
                    return false;
                const field = self.fields.find((f) => f.name === prop);
                if (!field)
                    return false;
                if (typeof field.builder.write !== "function")
                    return false;
                field.builder.write(value, { buf, offset: offset + field.offset, endian }, ret);
                return true;
            },
        });
        return ret;
    }
    proxy(opts) {
        return this.#proxy(opts, true);
    }
    read(opts) {
        const proxy = this.#proxy(opts);
        const ret = Object.fromEntries(Object.entries(proxy));
        return ret;
    }
    write(value, opts) {
        const proxy = this.#proxy(opts);
        for (const key of this.fields.map((f) => f.name)) {
            // @ts-expect-error
            proxy[key] = value[key];
        }
    }
}
export { Struct as StructBase };
