/**
 * Dynet, the network Philips Dynalite lighting runs on, as its Ethernet
 * gateways (DDNG, PDEG) carry it over TCP: eight-byte logical messages, the
 * same ones the RS-485 bus carries.
 *
 * Everything here is from python-dynalite-devices (ziv1234, MIT), the library
 * Home Assistant's dynalite integration is built on (`dynet.py`, `opcodes.py`,
 * `inbound.py`), not guessed:
 *
 * - A logical message is `[0x1c, area, data0, opcode, data1, data2, join,
 *   checksum]`, join 0xff, the checksum the two's complement of the sum of the
 *   first seven bytes.
 * - Presets 1-4 are opcodes 0-3 and presets 5-8 opcodes 10-13, in banks of
 *   eight (data2); the fade is data0/data1 in 20 ms steps.
 * - "Request preset" (0x63) is answered by "report preset" (0x62), whose data0
 *   is the preset less one; a preset selected anywhere on the network is
 *   heard as the select itself.
 *
 * Pure: the socket is `dynet-link.ts`.
 */

/** The sync byte of a logical message. */
const LOGICAL = 0x1c;
/** "Every join": the message reaches every channel of the area. */
const ALL_JOINS = 0xff;

export const REPORT_PRESET = 0x62;
export const REQUEST_PRESET = 0x63;

/** One logical message, as its fields. */
export interface DynetMessage {
    readonly area: number;
    readonly opcode: number;
    /** data0, data1, data2 - in the order the library names them. */
    readonly data: readonly [number, number, number];
}

function checksum(bytes: readonly number[]): number {
    const sum = bytes.slice(0, 7).reduce((total, byte) => total + byte, 0);
    return -(sum % 256) & 0xff;
}

function byte(value: number): number {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new RangeError("A Dynet field is one byte");
    }
    return value;
}

/** A message as the eight bytes that go on the wire. */
export function encodeDynet(message: DynetMessage): Buffer {
    const bytes = [
        LOGICAL,
        byte(message.area),
        byte(message.data[0]),
        byte(message.opcode),
        byte(message.data[1]),
        byte(message.data[2]),
        ALL_JOINS
    ];
    return Buffer.from([...bytes, checksum(bytes)]);
}

/**
 * Select a preset (1-64) in an area, with a fade in seconds - the
 * `select_area_preset_packet` of the library.
 */
export function selectPreset(area: number, preset: number, fadeSeconds = 0): Buffer {
    if (!Number.isInteger(preset) || preset < 1 || preset > 64) {
        throw new RangeError("A Dynalite preset is 1 to 64");
    }
    const index = preset - 1;
    const bank = Math.floor(index / 8);
    const inBank = index - bank * 8;
    const opcode = inBank > 3 ? inBank + 6 : inBank;
    const steps = Math.min(Math.max(Math.round(fadeSeconds / 0.02), 0), 0xffff);
    return encodeDynet({ area, opcode, data: [steps & 0xff, steps >> 8, bank] });
}

/** Ask an area which preset it is in. */
export function requestPreset(area: number): Buffer {
    return encodeDynet({ area, opcode: REQUEST_PRESET, data: [0, 0, 0] });
}

/**
 * The logical messages in a run of bytes, and what is left over for the next
 * read. A byte that does not start a message, or a message whose checksum is
 * wrong, is skipped one byte at a time until the stream lines up again.
 */
export function decodeDynet(buffer: Buffer): { messages: DynetMessage[]; rest: Buffer } {
    const messages: DynetMessage[] = [];
    let at = 0;
    while (buffer.length - at >= 8) {
        if (buffer[at] !== LOGICAL) {
            at += 1;
            continue;
        }
        const bytes = [...buffer.subarray(at, at + 8)];
        if (checksum(bytes) !== bytes[7]) {
            at += 1;
            continue;
        }
        messages.push({
            area: bytes[1]!,
            opcode: bytes[3]!,
            data: [bytes[2]!, bytes[4]!, bytes[5]!]
        });
        at += 8;
    }
    return { messages, rest: buffer.subarray(at) };
}

/**
 * The preset a message says its area is in now, or null for a message that
 * says nothing about it: a report answering `requestPreset`, or a preset
 * selected by a panel or another controller.
 */
export function presetOf(message: DynetMessage): number | null {
    if (message.opcode === REPORT_PRESET) return message.data[0] + 1;
    const selected =
        message.opcode <= 3
            ? message.opcode
            : message.opcode >= 10 && message.opcode <= 13
              ? message.opcode - 6
              : null;
    if (selected === null) return null;
    return selected + message.data[2] * 8 + 1;
}
