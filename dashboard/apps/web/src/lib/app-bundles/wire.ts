/**
 * How an installed app's server action travels, both ways.
 *
 * Next carries a server action's arguments and result in its own format, which
 * keeps a `Date` a `Date` and a `Map` a `Map`. An app loaded from a bundle calls
 * its actions through the dashboard instead (`/api/apps/action`), so the values
 * that format would have kept have to survive plain JSON: each one is written as
 * a tagged object and read back as what it was. An object that happens to have
 * the tag's key is wrapped, so nothing the app sends can be mistaken for one.
 */

const TAG = "$polaris";

type Tagged =
    | { [TAG]: "date"; value: string }
    | { [TAG]: "undefined" }
    | { [TAG]: "bigint"; value: string }
    | { [TAG]: "number"; value: "NaN" | "Infinity" | "-Infinity" }
    | { [TAG]: "map"; value: unknown[] }
    | { [TAG]: "set"; value: unknown[] }
    | { [TAG]: "object"; value: Record<string, unknown> };

/** A value, as JSON can carry it. Throws on what cannot travel at all. */
export function toWire(value: unknown, seen = new Set<object>()): unknown {
    if (value === undefined) return { [TAG]: "undefined" };
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (Number.isFinite(value)) return value;
        return {
            [TAG]: "number",
            value: Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity"
        };
    }
    if (typeof value === "bigint") return { [TAG]: "bigint", value: value.toString() };
    if (typeof value !== "object")
        throw new TypeError(`A ${typeof value} cannot be sent to or from a server action`);
    if (seen.has(value))
        throw new TypeError(
            "A value that refers to itself cannot be sent to or from a server action"
        );
    seen.add(value);
    try {
        if (value instanceof Date) return { [TAG]: "date", value: value.toISOString() };
        if (Array.isArray(value)) return value.map((item) => toWire(item, seen));
        if (value instanceof Map)
            return {
                [TAG]: "map",
                value: [...value].map(([key, item]) => [toWire(key, seen), toWire(item, seen)])
            };
        if (value instanceof Set)
            return { [TAG]: "set", value: [...value].map((item) => toWire(item, seen)) };
        const plain: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) plain[key] = toWire(item, seen);
        return TAG in plain ? { [TAG]: "object", value: plain } : plain;
    } finally {
        seen.delete(value);
    }
}

/** What `toWire` wrote, as it was. */
export function fromWire(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(fromWire);
    const record = value as Record<string, unknown>;
    if (!(TAG in record)) {
        const plain: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(record)) {
            const decoded = fromWire(item);
            // What was undefined on the way in is absent on the way out, as a
            // property JSON dropped would have been.
            if (decoded !== undefined) plain[key] = decoded;
        }
        return plain;
    }
    const tagged = record as Tagged;
    switch (tagged[TAG]) {
        case "undefined":
            return undefined;
        case "date":
            return new Date(tagged.value);
        case "bigint":
            return BigInt(tagged.value);
        case "number":
            return Number(tagged.value);
        case "map":
            return new Map(
                (tagged.value as [unknown, unknown][]).map(([key, item]) => [
                    fromWire(key),
                    fromWire(item)
                ])
            );
        case "set":
            return new Set(tagged.value.map(fromWire));
        case "object": {
            const plain: Record<string, unknown> = {};
            for (const [key, item] of Object.entries(tagged.value)) plain[key] = fromWire(item);
            return plain;
        }
        default:
            throw new TypeError("An unknown value arrived from a server action");
    }
}
