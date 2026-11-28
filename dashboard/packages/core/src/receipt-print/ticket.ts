/**
 * The one place Hospitality and the ticket printer layer meet.
 *
 * Hospitality builds a `TicketDocument` (what a receipt, a kitchen order or a
 * shift report says) and hands it to a `TicketPrinter`. The printer layer turns
 * it into bytes for the thermal printer in use (ESC/POS on 58 or 80 mm paper,
 * the kind bars and kitchens run) and can kick the cash drawer wired to it.
 *
 * Rules both sides keep:
 * - Every amount is an integer number of cents (minor units) in `currency`.
 *   The printer never computes a total; it prints the ones it is given.
 * - Text is plain UTF-8, already translated. The printer layer maps it to the
 *   printer's code page and replaces what the code page cannot show.
 * - The document is data only. Nothing in it is a command for the printer, so a
 *   product name typed by somebody cannot become one.
 * - Adding an optional field is compatible; renaming or removing one is not.
 *   `TICKET_CONTRACT_VERSION` goes up when a field is added.
 *
 * Pure module: no imports from the server or the browser, so both sides and
 * the tests can read it. It lives in core rather than in the app because the
 * dashboard implements the printer side and cannot import an installable app.
 */

import { z } from "zod";

export const TICKET_CONTRACT_VERSION = 1;

/** What the paper is for. The printer layer may pick a layout per kind. */
export const TICKET_KINDS = [
    // A simplified invoice handed to the customer after payment.
    "receipt",
    // The bill brought to the table before payment ("la cuenta").
    "bill",
    // An order sent to a kitchen or bar station ("comanda").
    "kitchen",
    // A shift report: X (mid-shift, nothing closes) or Z (closes the shift).
    "report",
    // A cash movement slip: money put into or taken out of the drawer.
    "cash-movement"
] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

const text = z.string().max(500);
const cents = z.number().int();

/** A line of free text with how to draw it. */
export const ticketTextSchema = z.object({
    text,
    align: z.enum(["left", "center", "right"]).default("left"),
    bold: z.boolean().default(false),
    /** Double height and width, for a table number on a kitchen order. */
    large: z.boolean().default(false)
});
export type TicketText = z.infer<typeof ticketTextSchema>;

/** A modifier or note printed under its line ("sin cebolla", "punto: poco hecho"). */
export const ticketModifierSchema = z.object({
    label: text,
    /** Extra charge in cents for this modifier, 0 when free. */
    amount: cents.default(0)
});

export const ticketLineSchema = z.object({
    quantity: z.number().positive().max(100_000),
    name: text,
    /** Unit price in cents, tax included. */
    unitPrice: cents,
    /** Line total in cents after its own discount, tax included. */
    total: cents,
    modifiers: z.array(ticketModifierSchema).max(50).default([]),
    /** The line's own discount, already taken off `total`. */
    discount: z.object({ label: text, amount: cents }).optional(),
    /** Course on a kitchen order ("1st", "2nd", "dessert"). */
    course: text.optional(),
    /** Free note from the waiter. */
    note: text.optional(),
    /** True on a kitchen order when the line was voided after it was sent. */
    voided: z.boolean().default(false)
});
export type TicketLine = z.infer<typeof ticketLineSchema>;

/** One tax rate's share of the total (IVA 10 %, IVA 21 %...). */
export const ticketTaxSchema = z.object({
    label: text,
    /** Basis points: 1000 = 10 %. */
    rateBp: z.number().int().min(0).max(10_000),
    base: cents,
    amount: cents
});

export const ticketPaymentSchema = z.object({
    method: z.enum(["cash", "card", "other"]),
    label: text,
    amount: cents
});

export const ticketTotalsSchema = z.object({
    subtotal: cents,
    /** Discounts on the whole order, as printed rows. */
    discounts: z.array(z.object({ label: text, amount: cents })).max(20).default([]),
    total: cents,
    taxes: z.array(ticketTaxSchema).max(20).default([]),
    tip: cents.optional(),
    /** Change handed back on a cash payment. */
    change: cents.optional()
});

export const ticketDocumentSchema = z.object({
    version: z.literal(TICKET_CONTRACT_VERSION),
    kind: z.enum(TICKET_KINDS),
    /** ISO 4217, e.g. "EUR". */
    currency: z.string().regex(/^[A-Z]{3}$/),
    /** BCP 47 locale for numbers and dates, e.g. "es-ES". */
    locale: z.string().min(2).max(35),
    /** Business name, tax id, address: printed centred at the top. */
    header: z.array(ticketTextSchema).max(20).default([]),
    /** Ticket number, table, waiter, date: printed under the header. */
    meta: z.array(z.object({ label: text, value: text })).max(20).default([]),
    /** Optional logo, a PNG as base64, already sized for the paper. */
    logoPng: z.string().max(400_000).optional(),
    lines: z.array(ticketLineSchema).max(500).default([]),
    /** Absent on a kitchen order, which carries no prices. */
    totals: ticketTotalsSchema.optional(),
    payments: z.array(ticketPaymentSchema).max(20).default([]),
    /** Free rows for a report (label left, amount right). */
    rows: z.array(z.object({ label: text, amount: cents.optional(), bold: z.boolean().default(false) }))
        .max(200)
        .default([]),
    footer: z.array(ticketTextSchema).max(20).default([]),
    /** Printed as a QR code under the footer (a fiscal check URL, a review link). */
    qr: z.string().max(1000).optional(),
    /** How many copies to print. */
    copies: z.number().int().min(1).max(5).default(1),
    /** Kick the drawer after printing (a cash payment). */
    openDrawer: z.boolean().default(false),
    /** Beep on a kitchen printer that has a buzzer. */
    buzz: z.boolean().default(false)
});
export type TicketDocument = z.infer<typeof ticketDocumentSchema>;
export type TicketDocumentInput = z.input<typeof ticketDocumentSchema>;

/** Which printer a document goes to: a station's, or the till's own. */
export interface PrintTarget {
    /** The printer id Hospitality stored for a station or a till. */
    readonly printerId: string;
}

export type PrintResult =
    | { readonly ok: true }
    | {
          readonly ok: false;
          /** What went wrong in words a waiter can act on: "out of paper", "offline". */
          readonly reason: "offline" | "paper" | "cover-open" | "unsupported" | "failed";
      };

/**
 * What the printer layer offers Hospitality. Hospitality only ever calls these
 * three; everything about connections (USB, network port 9100, Bluetooth,
 * the printer built into a handheld) is the printer layer's.
 */
export interface PrintOptions {
    /**
     * Idempotency key: a second call with the same id for the same printer
     * answers with the first one's outcome and prints nothing, so a retried
     * request never prints a ticket twice. Absent, every call is a new job.
     */
    readonly jobId?: string;
}

export interface TicketPrinter {
    print(target: PrintTarget, document: TicketDocumentInput, options?: PrintOptions): Promise<PrintResult>;
    openDrawer(target: PrintTarget): Promise<PrintResult>;
    /** Printers the layer can reach, to pick one for a station or a till. */
    list(): Promise<ReadonlyArray<{ readonly id: string; readonly name: string; readonly paperMm: 58 | 80 }>>;
}
