/**
 * Several game commands, and each one's own answer, from one trip into the
 * container.
 *
 * Every trip is a process started in the container - on a registered machine, an
 * SSH exchange on top - and reading a big bag a stack at a time used to be one
 * trip per stack: forty-odd for a full inventory, times every player an export
 * covered. Here the commands run one after another inside a single shell, each
 * followed by a line of its own that says where its answer ends.
 *
 * What one trip can hand back is cut at 16 KiB, silently and from the end (see
 * `container-files`). An answer whose closing line did not arrive is therefore
 * reported as missing rather than as whatever part of it came back, and the
 * caller asks it again on its own.
 *
 * Pure: the script and the reading of its output. `service.ts` runs it.
 */

/** Written after each answer. Nothing the game says starts a line with it. */
const END = "@@polaris-end";

/** One argument as the shell will pass it on, whatever it holds. */
function quoted(argument: string): string {
    return `'${argument.replaceAll("'", "'\\''")}'`;
}

/** The shell script: each command through the console tool, then its end line
 *  with the tool's exit status. */
export function sayEachScript(commands: readonly (readonly string[])[]): string {
    return commands
        .map((argv, index) => `rcon-cli ${argv.map(quoted).join(" ")}; printf '\\n${END} %d %d\\n' ${index} $?`)
        .join("; ");
}

/**
 * Each command's answer, in order, from the script's output. Null for one whose
 * end line never arrived - the output ran out of room before it, or the shell
 * stopped - or whose console tool failed, which the caller asks again rather
 * than trusting, so a refused command raises the error asking it alone does.
 */
export function sayEachReplies(output: string, count: number): (string | null)[] {
    const replies: (string | null)[] = Array.from({ length: count }, () => null);
    let held: string[] = [];
    for (const raw of output.split("\n")) {
        const line = raw.replace(/\r$/, "");
        const end = new RegExp(`^${END} (\\d+) (\\d+)$`).exec(line);
        if (!end) {
            held.push(line);
            continue;
        }
        const index = Number(end[1]);
        if (index >= 0 && index < count && end[2] === "0") replies[index] = held.join("\n").replace(/\n+$/, "");
        held = [];
    }
    return replies;
}
