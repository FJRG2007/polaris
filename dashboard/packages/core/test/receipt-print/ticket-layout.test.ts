/**
 * A hospitality ticket on paper: what the customer and the kitchen actually read.
 */

import { describe, expect, it } from "vitest";
import * as print from "../../src/receipt-print/index.js";

const LABELS: print.TicketLabels = {
    subtotal: "Subtotal",
    total: "TOTAL",
    tip: "Propina",
    change: "Cambio",
    voided: "ANULADO",
    taxBase: (rate, base) => `${rate} base ${base}`
};

function paper(document: print.PrintDocument, profile: print.PrinterProfile): string[] {
    return print.previewText(document, profile);
}

describe("ticketToPrint", () => {
    it("lays a receipt out with totals flush right on 32 columns", () => {
        const ticket = print.ticketDocumentSchema.parse({
            version: 1,
            kind: "receipt",
            currency: "EUR",
            locale: "en-US",
            header: [{ text: "Bar Test" }],
            meta: [{ label: "Table", value: "4" }],
            lines: [
                { quantity: 2, name: "Coffee", unitPrice: 150, total: 300 },
                { quantity: 1, name: "Toast", unitPrice: 250, total: 250, modifiers: [{ label: "Tomato", amount: 50 }] }
            ],
            totals: { subtotal: 600, total: 600, change: 400 },
            payments: [{ method: "cash", label: "Cash", amount: 1000 }]
        });
        const lines = paper(print.ticketToPrint(ticket, LABELS), { paper: "58", codepage: "cp1252" });
        expect(lines).toContain(`${" ".repeat(12)}Bar Test`);
        expect(lines).toContain(`2 x Coffee${" ".repeat(17)}$3.00`);
        expect(lines).toContain(`   + Tomato${" ".repeat(16)}$0.50`);
        expect(lines).toContain(`Cash${" ".repeat(22)}$10.00`);
        // TOTAL at double width: 16 columns.
        expect(lines).toContain(`TOTAL${" ".repeat(6)}$6.00`);
        expect(lines.every((line) => line.length <= 32)).toBe(true);
    });

    it("prints a kitchen order without prices, voided lines marked", () => {
        const ticket = print.ticketDocumentSchema.parse({
            version: 1,
            kind: "kitchen",
            currency: "EUR",
            locale: "es-ES",
            lines: [
                { quantity: 1, name: "Burger", unitPrice: 1000, total: 1000, course: "1", modifiers: [{ label: "no onion" }] },
                { quantity: 1, name: "Salad", unitPrice: 800, total: 800, voided: true }
            ],
            totals: { subtotal: 1800, total: 1800 },
            buzz: true
        });
        const document = print.ticketToPrint(ticket, LABELS);
        expect(document.blocks[0]).toEqual({ type: "beep", times: 2 });
        expect(document.blocks).toContainEqual({ type: "text", text: "ANULADO 1 x Salad", bold: true, size: "tall", red: true });
        const lines = paper(document, { paper: "80", codepage: "cp858" });
        expect(lines).toContain("   - no onion");
        expect(lines.some((line) => line.includes("TOTAL"))).toBe(false);
    });

    it("cuts every copy and opens the drawer once", () => {
        const ticket = print.ticketDocumentSchema.parse({
            version: 1, kind: "bill", currency: "EUR", locale: "es-ES", copies: 2, openDrawer: true,
            lines: [{ quantity: 1, name: "Agua", unitPrice: 100, total: 100 }]
        });
        const blocks = print.ticketToPrint(ticket, LABELS).blocks;
        expect(blocks.filter((block) => block.type === "cut")).toHaveLength(2);
        expect(blocks.filter((block) => block.type === "drawer")).toHaveLength(1);
        expect(blocks.at(-1)).toEqual({ type: "drawer" });
    });
});
