/**
 * Whether a Java server's answer to a console line is a refusal.
 *
 * The console's transport only fails when the line never reached the game. A
 * line the game would not run still comes back as text - `Unknown or incomplete
 * command`, or the argument it choked on with `<--[HERE]` after it - so a run
 * that only looked at the transport recorded a refused line as one that ran.
 *
 * Java edition only: Bedrock and the other games word their answers their own
 * way, and a reply that is not recognized is never called a refusal.
 *
 * Pure, so the live console, a kept run and the schedule sweep read a reply the
 * same way.
 */

import type { MinecraftEdition } from "./service";

/** Where Brigadier marks the argument it could not read. */
const HERE_MARKER = "<--[HERE]";

/** How Java edition starts the answers it gives a line it did not run. */
const REFUSAL_STARTS = [
    "Unknown or incomplete command",
    "Incorrect argument for command",
    "Invalid or unknown",
    "No entity was found",
    "No player was found",
    "No targets matched selector",
    "Unknown item",
    "Unknown block",
    "Expected whitespace to end one argument"
] as const;

/** Whether an answer from a Java server says the line was not run. */
export function isMinecraftRefusal(output: string): boolean {
    if (output.includes(HERE_MARKER)) return true;
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .some((line) => REFUSAL_STARTS.some((start) => line.startsWith(start)));
}

/** Whether a server's answer to a line is a refusal: only a Java Minecraft
 *  server's is read (`edition` is null for every other game), and every other
 *  answer is taken as it stands. */
export function isRefusedReply(edition: MinecraftEdition | null, output: string): boolean {
    return edition === "java" && isMinecraftRefusal(output);
}
