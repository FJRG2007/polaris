/**
 * What the encoder needs to know about one printer.
 *
 * Columns follow the paper and Font A (12 dots a character): a 58 mm roll prints
 * 384 dots, so 32 columns; an 80 mm roll prints 576 (48) on an Epson TM-T20/T88
 * and 512 (42) on many compatibles; a 76 mm impact roll on a TM-U220 gives 40.
 * The default for each paper is the common one and the printer's own setting can
 * say otherwise.
 */

import { z } from "zod";
import * as codepage from "./codepage.js";

export const PAPER_WIDTHS = ["58", "76", "80"] as const;

export type PaperWidth = (typeof PAPER_WIDTHS)[number];

export const COLUMN_CHOICES = [32, 40, 42, 48] as const;

export const DEFAULT_COLUMNS: Readonly<Record<PaperWidth, number>> = { "58": 32, "76": 40, "80": 48 };

/** Printable width in dots, which caps a logo. */
export const PRINT_DOTS: Readonly<Record<PaperWidth, number>> = { "58": 384, "76": 400, "80": 576 };

export const printerProfileSchema = z
    .object({
        paper: z.enum(PAPER_WIDTHS),
        columns: z.number().int().min(16).max(64).optional(),
        codepage: z.enum(["cp858", "cp1252", "cp850", "cp437"]),
        /** `ESC t` number when this printer does not use Epson's numbering. */
        codepageNumber: z.number().int().min(0).max(255).optional(),
        /** Impact printers (TM-U220) have no QR, no raster image and no buzzer. */
        impact: z.boolean().optional()
    })
    .strict();

export type PrinterProfile = z.infer<typeof printerProfileSchema>;

export function columnsOf(profile: PrinterProfile): number {
    return profile.columns ?? DEFAULT_COLUMNS[profile.paper];
}

export function codepageNumberOf(profile: PrinterProfile): number {
    return profile.codepageNumber ?? codepage.ESC_T_NUMBER[profile.codepage];
}
