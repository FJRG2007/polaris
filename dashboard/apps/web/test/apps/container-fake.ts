/**
 * How a fake game server answers the commands a stretch of a file is read with
 * (`readContainerRange` in the game servers' `container-files`): its size, then
 * pieces of it as base64. Shared by the tests that fake a server's log.
 */

/** The answer to `stat -c %s -- <path>` or to one piece, or null for anything else. */
export function fileAnswer(
    argv: readonly string[],
    text: string
): { code: number; output: string } | null {
    const bytes = Buffer.from(text, "utf8");
    if (argv[0] === "stat") return { code: 0, output: `${bytes.length}\n` };
    const piece = /^tail -c \+(\d+) -- \S+ \| head -c (\d+) \| base64$/.exec(argv[2] ?? "");
    if (argv[0] !== "sh" || !piece) return null;
    const start = Number(piece[1]) - 1;
    const chunk = bytes.subarray(start, start + Number(piece[2]));
    return { code: 0, output: `${chunk.toString("base64")}\n` };
}
