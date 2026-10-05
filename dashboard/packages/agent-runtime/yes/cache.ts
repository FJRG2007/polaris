import { createHash } from "node:crypto";

/**
 * A stable key for a cache lookup: equal for values that hold the same data,
 * whatever order an object's keys were written in or an array's items arrive in
 * (an op's input is a request, and `["a", "b"]` asks the same as `["b", "a"]`).
 *
 * Covers what an op takes as input: plain objects, arrays, primitives, Dates,
 * Maps and Sets. Anything else - a function, a symbol, a class instance with
 * hidden state, a cycle - has no meaning as a key and throws, rather than
 * hashing to something two different calls could share.
 */
export function hashKey(value: unknown): string {
    return createHash("sha256").update(canonical(value, new Set())).digest("hex");
}

function canonical(value: unknown, path: Set<object>): string {
    switch (typeof value) {
        case "string":
            return `s${JSON.stringify(value)}`;
        case "number":
            return `n${Object.is(value, -0) ? "-0" : String(value)}`;
        case "bigint":
            return `b${value}`;
        case "boolean":
            return `t${value}`;
        case "undefined":
            return "u";
        case "function":
        case "symbol":
            throw new Error(`a ${typeof value} cannot be part of a cache key`);
    }
    if (value === null) return "null";
    const object = value as object;
    if (path.has(object)) throw new Error("a circular value cannot be a cache key");
    path.add(object);
    try {
        if (Array.isArray(object))
            return `[${object
                .map((item) => canonical(item, path))
                .sort()
                .join(",")}]`;
        if (object instanceof Date)
            return `d${Number.isNaN(object.getTime()) ? "invalid" : object.toISOString()}`;
        if (object instanceof Set)
            return `S[${[...object]
                .map((item) => canonical(item, path))
                .sort()
                .join(",")}]`;
        if (object instanceof Map) {
            const entries = [...object].map(
                ([k, v]) => `${canonical(k, path)}:${canonical(v, path)}`
            );
            return `M{${entries.sort().join(",")}}`;
        }
        const prototype = Object.getPrototypeOf(object);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error(
                `a ${prototype?.constructor?.name ?? "class"} instance cannot be a cache key`
            );
        }
        const entries = Object.keys(object)
            .sort()
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${canonical((object as Record<string, unknown>)[key], path)}`
            );
        return `{${entries.join(",")}}`;
    } finally {
        path.delete(object);
    }
}

/**
 * A least-recently-used map whose entries also expire `ttl` milliseconds after
 * they were set. Reading an entry makes it recent but does not extend its life,
 * and `has` does neither - the behaviour lru-cache had with `max` and `ttl`.
 */
export class TtlLru<K, V> {
    private readonly entries = new Map<K, { value: V; expires: number }>();

    constructor(
        private readonly max: number,
        private readonly ttl: number,
        private readonly now: () => number = () => performance.now()
    ) {
        if (!(max >= 1) || !(ttl > 0)) throw new Error("TtlLru needs max >= 1 and ttl > 0");
    }

    get(key: K): V | undefined {
        const entry = this.live(key);
        if (!entry) return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    has(key: K): boolean {
        return this.live(key) !== undefined;
    }

    set(key: K, value: V): this {
        this.entries.delete(key);
        this.entries.set(key, { value, expires: this.now() + this.ttl });
        while (this.entries.size > this.max)
            this.entries.delete(this.entries.keys().next().value as K);
        return this;
    }

    delete(key: K): boolean {
        return this.entries.delete(key);
    }

    clear(): void {
        this.entries.clear();
    }

    *[Symbol.iterator](): IterableIterator<[K, V]> {
        for (const [key, entry] of [...this.entries]) {
            if (this.live(key)) yield [key, entry.value];
        }
    }

    private live(key: K): { value: V; expires: number } | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expires <= this.now()) {
            this.entries.delete(key);
            return undefined;
        }
        return entry;
    }
}
