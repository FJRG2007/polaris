/**
 * How long one command to a Minecraft server may be.
 *
 * Java takes commands over RCON, and one RCON request is one packet: the game
 * reads 1446 bytes of it and no more. So the limit is in bytes rather than
 * characters - an accented letter is two, a section sign is two - and it sits
 * a little under the packet so the framing always fits.
 *
 * It used to be 512 characters, a limit chosen for a ban reason. A formatted
 * announcement is JSON with a run per colour change, and a chat line with ten
 * colours went past 512 while being nowhere near what the game takes - refused
 * with a message that did not say which part was too long.
 *
 * What keeps a command from carrying a second one is not its length but the
 * newline check beside every use of this: one line is one command.
 *
 * Pure, so the editor can measure exactly what the server will refuse.
 */

export const COMMAND_BYTES_MAX = 1400;

const encoder = new TextEncoder();

export function commandBytes(line: string): number {
    return encoder.encode(line).length;
}
