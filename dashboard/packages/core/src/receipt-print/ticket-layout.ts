/**
 * A hospitality ticket laid out as a print document.
 *
 * The ticket says what is on the paper; this decides where. It is the one place
 * a receipt, a bill, a kitchen order and a shift report get their shape, so the
 * till, the kitchen and the test page all print the same way. The few words the
 * ticket does not carry (Total, Change...) come in as `labels`, already in the
 * ticket's language.
 */

import type * as doc from "./document.js";
import type * as ticket from "./ticket.js";

export interface TicketLabels {
    subtotal: string;
    total: string;
    tip: string;
    change: string;
    voided: string;
    /** "{rate} base {base}": the tax line's left side. */
    taxBase: (rate: string, base: string) => string;
}

function moneyFormat(locale: string, currency: string): (cents: number) => string {
    let format: Intl.NumberFormat;
    try {
        format = new Intl.NumberFormat(locale, { style: "currency", currency });
    } catch {
        format = new Intl.NumberFormat("en-US", { style: "currency", currency });
    }
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return (cents) => format.format(cents / 10 ** digits);
}

function quantityFormat(locale: string): (value: number) => string {
    let format: Intl.NumberFormat;
    try {
        format = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
    } catch {
        format = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
    }
    return (value) => format.format(value);
}

function texts(lines: readonly ticket.TicketText[], fallback: "left" | "center"): doc.PrintBlock[] {
    return lines.map((line) => ({
        type: "text",
        text: line.text,
        align: line.align === "left" ? fallback : line.align,
        bold: line.bold,
        size: line.large ? "large" : "normal"
    }));
}

function kitchenLines(lines: readonly ticket.TicketLine[], quantity: (value: number) => string, labels: TicketLabels): doc.PrintBlock[] {
    const out: doc.PrintBlock[] = [];
    let course: string | undefined;
    for (const line of lines) {
        if (line.course && line.course !== course) {
            course = line.course;
            out.push({ type: "text", text: `-- ${line.course} --`, align: "center", bold: true });
        }
        const prefix = line.voided ? `${labels.voided} ` : "";
        out.push({ type: "text", text: `${prefix}${quantity(line.quantity)} x ${line.name}`, bold: true, size: "tall", red: line.voided });
        for (const modifier of line.modifiers) out.push({ type: "text", text: `   - ${modifier.label}`, red: line.voided });
        if (line.note) out.push({ type: "text", text: `   > ${line.note}`, bold: true, red: line.voided });
    }
    return out;
}

function pricedLines(lines: readonly ticket.TicketLine[], money: (cents: number) => string, quantity: (value: number) => string): doc.PrintBlock[] {
    const out: doc.PrintBlock[] = [];
    for (const line of lines) {
        if (line.voided) continue;
        out.push({ type: "row", left: `${quantity(line.quantity)} x ${line.name}`, right: money(line.total) });
        if (line.quantity !== 1) out.push({ type: "text", text: `    ${quantity(line.quantity)} x ${money(line.unitPrice)}` });
        for (const modifier of line.modifiers) {
            out.push(modifier.amount === 0
                ? { type: "text", text: `   ${modifier.label}` }
                : { type: "row", left: `   + ${modifier.label}`, right: money(modifier.amount) });
        }
        if (line.discount) out.push({ type: "row", left: `   ${line.discount.label}`, right: money(-Math.abs(line.discount.amount)) });
        if (line.note) out.push({ type: "text", text: `   ${line.note}` });
    }
    return out;
}

function totals(value: NonNullable<ticket.TicketDocument["totals"]>, payments: ticket.TicketDocument["payments"], money: (cents: number) => string, labels: TicketLabels): doc.PrintBlock[] {
    const out: doc.PrintBlock[] = [{ type: "rule" }];
    if (value.discounts.length > 0 || value.subtotal !== value.total) out.push({ type: "row", left: labels.subtotal, right: money(value.subtotal) });
    for (const discount of value.discounts) out.push({ type: "row", left: discount.label, right: money(-Math.abs(discount.amount)) });
    out.push({ type: "row", left: labels.total, right: money(value.total), bold: true, size: "large" });
    for (const tax of value.taxes) {
        const rate = `${tax.label} ${(tax.rateBp / 100).toString()}%`;
        out.push({ type: "row", left: labels.taxBase(rate, money(tax.base)), right: money(tax.amount) });
    }
    if (value.tip !== undefined && value.tip !== 0) out.push({ type: "row", left: labels.tip, right: money(value.tip) });
    for (const payment of payments) out.push({ type: "row", left: payment.label, right: money(payment.amount) });
    if (value.change !== undefined && value.change !== 0) out.push({ type: "row", left: labels.change, right: money(value.change), bold: true });
    return out;
}

/**
 * The print document for a ticket, every copy cut on its own. `logo` is the
 * ticket's PNG already turned into printer dots by the caller, which has the
 * image decoder; null prints without one.
 */
export function ticketToPrint(
    value: ticket.TicketDocument,
    labels: TicketLabels,
    logo: Extract<doc.PrintBlock, { type: "image" }> | null = null
): doc.PrintDocument {
    const money = moneyFormat(value.locale, value.currency);
    const quantity = quantityFormat(value.locale);
    const copy: doc.PrintBlock[] = [];
    if (logo) copy.push(logo);
    copy.push(...texts(value.header, "center"));
    if (value.meta.length > 0) {
        if (copy.length > 0) copy.push({ type: "rule" });
        for (const meta of value.meta) {
            copy.push(value.kind === "kitchen"
                ? { type: "row", left: meta.label, right: meta.value, bold: true }
                : { type: "row", left: meta.label, right: meta.value });
        }
    }
    if (value.lines.length > 0) {
        copy.push({ type: "rule" });
        copy.push(...(value.kind === "kitchen" ? kitchenLines(value.lines, quantity, labels) : pricedLines(value.lines, money, quantity)));
    }
    if (value.totals && value.kind !== "kitchen") copy.push(...totals(value.totals, value.payments, money, labels));
    if (value.rows.length > 0) {
        copy.push({ type: "rule" });
        for (const row of value.rows) copy.push({ type: "row", left: row.label, right: row.amount === undefined ? "" : money(row.amount), bold: row.bold });
    }
    if (value.footer.length > 0) copy.push({ type: "feed", lines: 1 }, ...texts(value.footer, "center"));
    if (value.qr) copy.push({ type: "feed", lines: 1 }, { type: "qr", data: value.qr.slice(0, 700) });
    copy.push({ type: "feed", lines: 3 }, { type: "cut" });

    const blocks: doc.PrintBlock[] = [];
    if (value.buzz) blocks.push({ type: "beep", times: 2 });
    for (let index = 0; index < value.copies; index++) blocks.push(...copy);
    if (value.openDrawer) blocks.push({ type: "drawer" });
    return { blocks };
}
