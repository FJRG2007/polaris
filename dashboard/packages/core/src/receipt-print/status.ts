/**
 * What a printer says about itself, in words a waiter can act on.
 *
 * `DLE EOT n` is answered in real time, even with a job in the buffer, with one
 * byte whose bits 1 and 4 are always set and bits 0 and 7 always clear (Epson
 * ESC/POS reference, "DLE EOT"; python-escpos ships the same masks as RT_MASK_*):
 *   n = 1 printer: bit 3 offline
 *   n = 2 offline cause: bit 2 cover open, bit 5 stopped for lack of paper, bit 6 error
 *   n = 4 roll sensor: bits 2-3 paper near its end, bits 5-6 paper out
 */

export const STATUS_QUERIES = {
    printer: [0x10, 0x04, 0x01],
    offline: [0x10, 0x04, 0x02],
    paper: [0x10, 0x04, 0x04]
} as const;

/** The plain-language reasons a ticket cannot print, most actionable first. */
export const PRINTER_PROBLEMS = ["paper-out", "cover-open", "error", "offline", "unreachable", "not-a-printer"] as const;

export type PrinterProblem = (typeof PRINTER_PROBLEMS)[number];

export interface PrinterStatus {
    problem: PrinterProblem | null;
    paperLow: boolean;
}

/** Whether a byte has the fixed bits every status answer carries. */
export function isStatusByte(value: number | undefined): value is number {
    return value !== undefined && (value & 0x93) === 0x12;
}

/**
 * The three answers read together. A missing or malformed first answer means the
 * device on the port is not speaking ESC/POS status; a printer that answers the
 * first query but not the others is still treated as ready, since some
 * compatibles only implement `n = 1`.
 */
export function readStatus(printer: number | undefined, offline: number | undefined, paper: number | undefined): PrinterStatus {
    if (!isStatusByte(printer)) return { problem: "not-a-printer", paperLow: false };
    const cause = isStatusByte(offline) ? offline : 0;
    const roll = isStatusByte(paper) ? paper : 0;
    const paperLow = (roll & 0x0c) !== 0;
    if ((roll & 0x60) !== 0 || (cause & 0x20) !== 0) return { problem: "paper-out", paperLow };
    if ((cause & 0x04) !== 0) return { problem: "cover-open", paperLow };
    if ((cause & 0x40) !== 0) return { problem: "error", paperLow };
    if ((printer & 0x08) !== 0) return { problem: "offline", paperLow };
    return { problem: null, paperLow };
}
