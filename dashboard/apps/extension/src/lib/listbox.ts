/**
 * Which option a key moves the popup's listbox to.
 *
 * Pure, so the keyboard contract of the picker (arrows, Home/End, type-ahead) can
 * be asserted without a browser. Disabled options are skipped by every move.
 */

export interface ListboxOption {
    label: string;
    disabled?: boolean;
}

/** The next enabled index from `from` in `step` direction, or `from` when there is none. */
export function stepIndex(options: readonly ListboxOption[], from: number, step: 1 | -1): number {
    for (let index = from + step; index >= 0 && index < options.length; index += step) {
        if (!options[index]?.disabled) return index;
    }
    return from;
}

/** The first (or last) enabled index, or -1 when every option is disabled. */
export function edgeIndex(options: readonly ListboxOption[], end: "first" | "last"): number {
    if (end === "first") return stepIndex(options, -1, 1);
    const last = stepIndex(options, options.length, -1);
    return last === options.length ? -1 : last;
}

/**
 * The option a typed prefix lands on: searching from the one after `from`, so
 * typing the same letter again cycles through every option that starts with it.
 */
export function matchIndex(options: readonly ListboxOption[], from: number, typed: string): number {
    const prefix = typed.toLocaleLowerCase();
    if (!prefix) return from;
    const repeated = [...prefix].every((letter) => letter === prefix[0]);
    const start = repeated ? from + 1 : from;
    for (let offset = 0; offset < options.length; offset++) {
        const index = (start + offset + options.length) % options.length;
        const option = options[index];
        if (!option || option.disabled) continue;
        const label = option.label.toLocaleLowerCase();
        if (label.startsWith(prefix) || (repeated && label.startsWith(prefix[0] ?? ""))) return index;
    }
    return from;
}
