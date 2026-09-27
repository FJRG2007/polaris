/**
 * How a fake game server answers the commands its files are read with (the game
 * servers' `container-files`): a stretch of one file - its size, then pieces of
 * it as base64 - and several files at once. Shared by the tests that fake a
 * server's files.
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

/** The answer to the command several files are read with at once
 *  (`readContainerFiles`), cut at `limit` the way the daemon cuts, or null for
 *  anything else. */
export function filesAnswer(
    argv: readonly string[],
    files: Readonly<Record<string, string>>,
    limit: number
): { code: number; output: string } | null {
    const batch = /^for f in (.+?); do printf '@@%s\\n'/.exec(argv[2] ?? "");
    if (argv[0] !== "sh" || !batch) return null;
    const output = batch[1]!
        .split(" ")
        .map((path) => {
            const file = files[path];
            if (file === undefined) return `@@${path}\n@@!\n`;
            const encoded = Buffer.from(file, "utf8")
                .toString("base64")
                .replace(/(.{76})/g, "$1\n");
            return `@@${path}\n${encoded}\n@@.\n`;
        })
        .join("");
    return { code: 0, output: Buffer.from(output).subarray(0, limit).toString("utf8") };
}
