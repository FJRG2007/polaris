/**
 * How long one command to a Minecraft server may be.
 *
 * Java takes commands over RCON, through the console tool the server image
 * ships, and that tool is the tighter of the two limits: it sends 1014 bytes and
 * refuses anything longer without a word - it exits as if it had worked, prints
 * nothing, and the game never hears of it. Measured against a running server on
 * 2026-09-27 (1014 bytes arrive, 1015 do not). The game itself would read 1446.
 * So the limit is in bytes rather than characters - an accented letter is two, a
 * section sign is two - and it is the tool's.
 *
 * It used to be 1400, the game's packet less its framing, which let a command
 * between the two lengths vanish: a richly formatted announcement, or a rainbow
 * on the side panel, went nowhere and said nothing.
 *
 * What keeps a command from carrying a second one is not its length but the
 * newline check beside every use of this: one line is one command.
 *
 * Pure, so the editor can measure exactly what the server will refuse.
 */

export const COMMAND_BYTES_MAX = 1014;

const encoder = new TextEncoder();

export function commandBytes(line: string): number {
    return encoder.encode(line).length;
}
