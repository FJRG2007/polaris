/**
 * Which of an app's routes answers a path.
 *
 * An app's routes are named the way Next names them - `/places/cameras`,
 * `/api/home/cameras/[id]/stream`, `/api/minecraft/pack/[id]/[token]/[file]`,
 * with `[...name]` and `[[...name]]` for the rest of a path - because that is
 * where they sit in the app's source. A bundle is served by one catch-all route
 * per surface, so the matching Next did from the file tree is done here, with
 * Next's precedence: a fixed segment before a parameter, a parameter before a
 * catch-all.
 */

export type RouteParams = Record<string, string | string[]>;

export interface RouteMatch {
    readonly pattern: string;
    readonly params: RouteParams;
}

type Segment =
    | { kind: "static"; value: string }
    | { kind: "param"; name: string }
    | { kind: "rest"; name: string; optional: boolean };

function parse(pattern: string): Segment[] {
    return pattern
        .split("/")
        .filter(Boolean)
        .map((part): Segment => {
            const optional = /^\[\[\.\.\.(\w+)\]\]$/.exec(part);
            if (optional) return { kind: "rest", name: optional[1] as string, optional: true };
            const rest = /^\[\.\.\.(\w+)\]$/.exec(part);
            if (rest) return { kind: "rest", name: rest[1] as string, optional: false };
            const param = /^\[(\w+)\]$/.exec(part);
            if (param) return { kind: "param", name: param[1] as string };
            return { kind: "static", value: part };
        });
}

function decode(part: string): string | null {
    try {
        return decodeURIComponent(part);
    } catch {
        return null;
    }
}

function match(segments: readonly Segment[], parts: readonly string[]): RouteParams | null {
    const params: RouteParams = {};
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index] as Segment;
        if (segment.kind === "rest") {
            if (index !== segments.length - 1) return null;
            const rest = parts.slice(index);
            if (rest.length === 0 && !segment.optional) return null;
            const decoded = rest.map(decode);
            if (decoded.some((part) => part === null)) return null;
            if (rest.length > 0) params[segment.name] = decoded as string[];
            return params;
        }
        const part = parts[index];
        if (part === undefined) return null;
        if (segment.kind === "static") {
            if (part !== segment.value) return null;
        } else {
            const decoded = decode(part);
            if (decoded === null) return null;
            params[segment.name] = decoded;
        }
    }
    return parts.length === segments.length ? params : null;
}

/** How specific a pattern is, segment by segment: lower wins. */
function rank(segments: readonly Segment[]): number[] {
    return segments.map((segment) =>
        segment.kind === "static" ? 0 : segment.kind === "param" ? 1 : segment.optional ? 3 : 2
    );
}

function compare(left: number[], right: number[]): number {
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const a = left[index] ?? -1;
        const b = right[index] ?? -1;
        if (a !== b) return a - b;
    }
    return 0;
}

/** The route among `patterns` that answers `path`, or null. */
export function matchRoute(patterns: readonly string[], path: string): RouteMatch | null {
    const parts = path.split("/").filter(Boolean);
    let best: { pattern: string; params: RouteParams; rank: number[] } | null = null;
    for (const pattern of patterns) {
        const segments = parse(pattern);
        const params = match(segments, parts);
        if (!params) continue;
        const order = rank(segments);
        if (!best || compare(order, best.rank) < 0) best = { pattern, params, rank: order };
    }
    return best ? { pattern: best.pattern, params: best.params } : null;
}
