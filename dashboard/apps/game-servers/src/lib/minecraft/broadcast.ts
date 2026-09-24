/**
 * What a message from Polaris looks like to the people playing.
 *
 * `say` prints the name of whoever sent it, and a command sent over RCON is sent
 * by a source the server calls `Rcon` - so "the server restarts in five minutes",
 * scheduled from a panel, reached players as `[Rcon] ...`. That is a piece of
 * plumbing showing through: nobody in the game knows what RCON is, and the thing
 * talking to them is Polaris.
 *
 * `tellraw` writes the line itself instead of quoting a sender, so the tag is
 * ours to choose. It costs one thing worth knowing: `say` expands selectors in
 * the message (`@p` becomes a name) and this does not, so what is typed is what
 * is shown. For a message an operator wrote for people to read, that is the
 * behaviour you want anyway.
 *
 * Pure, so what the server is actually sent can be asserted without a server.
 */

import type { MinecraftEdition } from "./service";

/** Who the message is from, as the people playing see it. */
export const BROADCAST_TAG = "Polaris";

/** The plain form, used when the server will not take the written one. */
export function sayArgv(message: string): string[] {
    return ["say", `[${BROADCAST_TAG}] ${message}`];
}

/**
 * The command that says `message` to everybody, tagged as Polaris.
 *
 * Bedrock takes the same verb with a different body - a `rawtext` list rather
 * than a component - and sending one the other's way is a message nobody in the
 * game ever sees.
 */
export function broadcastArgv(edition: MinecraftEdition, message: string): string[] {
    if (edition === "bedrock") {
        return ["tellraw", "@a", JSON.stringify({ rawtext: [{ text: `[${BROADCAST_TAG}] ${message}` }] })];
    }
    return [
        "tellraw",
        "@a",
        JSON.stringify([
            { text: `[${BROADCAST_TAG}] `, color: "gray" },
            { text: message, color: "white" }
        ])
    ];
}
