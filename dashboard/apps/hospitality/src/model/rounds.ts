/**
 * "Otra ronda": the lines fired together last time, ready to be taken again.
 * A round is what one send fired, so its lines share one `sentAt`. Pure, so
 * the screen and the tests agree on what the last round was.
 */

import type { ModifierChoiceGroup } from "./modifiers";

interface FiredLine {
    readonly productId: string | null;
    readonly quantity: number;
    readonly course: number;
    readonly note: string;
    readonly status: string;
    readonly sentAt: string | null;
    readonly modifiers: ReadonlyArray<{ readonly name: string }>;
}

interface Orderable {
    readonly id: string;
    readonly available: boolean;
    readonly modifiers: readonly ModifierChoiceGroup[];
}

export interface RepeatedLine<P> {
    readonly product: P;
    readonly quantity: number;
    readonly course: number;
    readonly note: string;
    readonly modifierIds: string[];
}

/** The lines of the most recent send, voided ones left out. */
export function lastRound<L extends FiredLine>(lines: readonly L[]): L[] {
    const fired = lines.filter((l) => l.sentAt !== null && l.status !== "void");
    const last = fired.reduce<string | null>((at, l) => (at === null || l.sentAt! > at ? l.sentAt : at), null);
    return last === null ? [] : fired.filter((l) => l.sentAt === last);
}

/**
 * The last round as new lines, at today's menu: a product since sold out or
 * removed is left out and counted, so the waiter can say so at the table. The
 * options are found again by name, since a stored line keeps names, not ids.
 */
export function repeatRound<P extends Orderable>(lines: readonly FiredLine[], products: readonly P[]): { lines: RepeatedLine<P>[]; missing: number } {
    const byId = new Map(products.map((p) => [p.id, p]));
    const out: RepeatedLine<P>[] = [];
    let missing = 0;
    for (const line of lastRound(lines)) {
        const product = line.productId ? byId.get(line.productId) : undefined;
        if (!product || !product.available) {
            missing += 1;
            continue;
        }
        const names = new Set(line.modifiers.map((m) => m.name));
        const modifierIds = product.modifiers.flatMap((g) => g.options.filter((o) => names.has(o.name)).map((o) => o.id));
        out.push({ product, quantity: line.quantity, course: line.course, note: line.note, modifierIds });
    }
    return { lines: out, missing };
}
