/**
 * Several game commands, and each one's own answer, over one RCON connection.
 *
 * Every connection is a line pair in the server's log - `RCON Client ...
 * started`, `... shutting down` - and every read used to be its own: a survey
 * for a seasonal build asked a hundred-odd questions one connection at a time,
 * and an idle server's log filled with them. Here the commands go one per line
 * into the console tool's input, which answers them over a single connection,
 * in order.
 *
 * What the tool prints there is fixed by its source (itzg/rcon-cli 1.7.8, the
 * one the itzg/minecraft-server image ships, `cli/entry.go`, with
 * peterh/liner's `promptUnsupported`): with neither its input nor its output a
 * terminal, it prints the prompt `> `, reads a line, and prints the answer with
 * a newline after it - and the next prompt, and once the input runs out one
 * last prompt with nothing after it. Its colouring puts a reset (`ESC[0m`) after
 * every newline inside an answer, so a line of an answer never starts with the
 * prompt, and an answer reads exactly as `rcon-cli <command>` prints it alone.
 * Anything else on a line of its own - the tool's own complaint about a command
 * it could not send or read, or a reply that came back for another request - is
 * a session nobody can line up with its commands any more, and every answer of
 * it is reported missing.
 *
 * What one trip can hand back is cut at 16 KiB, silently and from the end (see
 * `container-files`). An answer whose next prompt did not arrive is therefore
 * reported as missing rather than as whatever part of it came back, and the
 * caller asks it again on its own.
 *
 * Pure: the input and the reading of its output. `service.ts` runs it.
 */

const PROMPT = "> ";
/** What the tool's colouring puts after every newline inside an answer. */
const RESET = "\u001b[0m";
/** The line the tool takes as the end of its session rather than as a command. */
const EXIT = "exit";

/** The console tool's input: one command a line. Null when one of them is the
 *  word that would end the session instead - those are asked one by one. */
export function sayEachInput(commands: readonly (readonly string[])[]): string | null {
    const lines = commands.map((argv) => argv.join(" "));
    if (lines.some((line) => line === EXIT || /[\r\n]/.test(line))) return null;
    return `${lines.join("\n")}\n`;
}

/**
 * Each command's answer, in order, from what the tool printed. Null for one
 * whose next prompt never arrived - the output ran out of room before it, or
 * the connection dropped - and for every one of a session that printed
 * something that is not an answer, which the caller asks again rather than
 * trusting, so a refused command raises the error asking it alone does.
 */
export function sayEachReplies(output: string, count: number): (string | null)[] {
    const replies: (string | null)[] = Array.from({ length: count }, () => null);
    const answers: string[] = [];
    let current: string | null = null;
    const lines = output.split("\n");
    for (const [index, line] of lines.entries()) {
        if (line.startsWith(PROMPT)) {
            if (current !== null) answers.push(current);
            current = line.slice(PROMPT.length);
        } else if (current !== null && line.startsWith(RESET)) {
            current += `\n${line}`;
        } else if (current !== null && index === lines.length - 1) {
            // Cut off part way through a line: what came before it still stands.
            break;
        } else {
            return replies;
        }
    }
    // The last prompt is only its end; past `count` is one too many to line up.
    if (answers.length > count) return replies;
    answers.forEach((answer, index) => {
        replies[index] = answer.replace(/\n+$/, "");
    });
    return replies;
}
