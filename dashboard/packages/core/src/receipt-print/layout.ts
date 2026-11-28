/**
 * Plain-text layout for a fixed number of columns: wrapping, alignment and the
 * left-label/right-amount row every receipt is made of. Pure string work, so a
 * test can read the result as text before it is ever bytes.
 */

/**
 * Words onto lines of at most `width` characters; a word longer than a line is
 * cut. A paragraph's leading spaces are kept on its first line, so an indented
 * modifier under its dish stays indented.
 */
export function wrap(text: string, width: number): string[] {
    const size = Math.max(1, width);
    const lines: string[] = [];
    for (const paragraph of text.split("\n")) {
        const indent = (/^ */.exec(paragraph)?.[0] ?? "").slice(0, size - 1);
        let line = indent;
        for (const word of paragraph.split(" ").filter((part) => part.length > 0)) {
            let rest = word;
            while (rest.length > 0) {
                const empty = line.trim().length === 0;
                const gap = empty ? 0 : 1;
                if (line.length + gap + rest.length <= size) {
                    line += (gap ? " " : "") + rest;
                    rest = "";
                } else if (empty) {
                    const room = size - line.length;
                    lines.push(line + rest.slice(0, room));
                    rest = rest.slice(room);
                    line = "";
                } else {
                    lines.push(line);
                    line = "";
                }
            }
        }
        lines.push(line.trim().length === 0 ? "" : line);
    }
    return lines;
}

export function align(line: string, width: number, where: "left" | "center" | "right"): string {
    const room = Math.max(0, width - line.length);
    if (where === "right") return " ".repeat(room) + line;
    if (where === "center") return " ".repeat(Math.floor(room / 2)) + line;
    return line;
}

/**
 * A label on the left and an amount flush right on its last line. The label
 * wraps in the space the amount leaves, so "2 x Tortilla de patatas con cebolla"
 * never pushes "12,50" off the paper; an amount wider than the line gets a line
 * of its own.
 */
export function row(left: string, right: string, width: number): string[] {
    const amount = right.slice(0, width);
    if (amount.length === 0) return wrap(left, width);
    const labelWidth = width - amount.length - 1;
    if (labelWidth < 1) return [...wrap(left, width), align(amount, width, "right")];
    const lines = wrap(left, labelWidth);
    const last = lines.pop() ?? "";
    return [...lines, last + " ".repeat(width - last.length - amount.length) + amount];
}
