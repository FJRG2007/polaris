/**
 * Whether a form holds anything worth saving.
 *
 * A form is dirty when what it holds now differs from what it was loaded with,
 * compared by value - never because a field was touched. A name edited and put
 * back, a number typed as "8" over the 8 it was, a blank field over a value that
 * was never set: each saves exactly what is already stored, so Save stays off.
 *
 * The comparison forgives what a save would forgive anyway: strings are compared
 * trimmed, an empty string is the same as no value, and a numeric string is the
 * same as its number. A `Set` is compared without regard to order; an array is
 * compared in order, since a reorder is a change - pass a `normalize` that sorts
 * a list whose order means nothing. Anything else a save does to a value
 * (lowercasing an email, say) belongs in `normalize`, the same one the save uses.
 */

function blank(value: unknown): boolean {
    return (
        value === null || value === undefined || (typeof value === "string" && value.trim() === "")
    );
}

function numeric(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string" || value.trim() === "") return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
}

/** Whether two form values would save the same thing. */
export function sameValue(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (blank(a) || blank(b)) return blank(a) && blank(b);
    const na = numeric(a);
    const nb = numeric(b);
    if (na !== null && nb !== null && (typeof a === "number" || typeof b === "number"))
        return na === nb;
    if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
    if (typeof a !== "object" || typeof b !== "object") return false;
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (a instanceof Set && b instanceof Set) {
        if (a.size !== b.size) return false;
        for (const item of a) if (![...b].some((other) => sameValue(item, other))) return false;
        return true;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((item, index) => sameValue(item, b[index]));
    }
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) if (!sameValue(left[key], right[key])) return false;
    return true;
}

/**
 * True once `current` would save something other than `initial`. After a save,
 * the saved values become the new `initial`.
 */
export function isDirty<T>(initial: T, current: T, normalize?: (value: T) => unknown): boolean {
    return normalize
        ? !sameValue(normalize(initial), normalize(current))
        : !sameValue(initial, current);
}
