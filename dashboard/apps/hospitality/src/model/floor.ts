/**
 * What the floor plan draws for a table: its state at a glance, how long since
 * anything happened on it, and where its chairs go. Pure, so the plan stays a
 * function of the order and the table and can be asserted in a test.
 *
 * Table geometry is in grid units (one unit = one chair's width).
 */

export const TABLE_STATES = ["free", "seated", "pending", "kitchen", "served", "billed", "paying"] as const;
export type TableState = (typeof TABLE_STATES)[number];

/** Just the parts of an order the plan reads. */
export interface FloorOrder {
    readonly status: string;
    readonly openedAt: string;
    readonly paid: number;
    readonly totals: { readonly total: number };
    readonly lines: ReadonlyArray<{ readonly status: string; readonly sentAt: string | null }>;
}

/**
 * Free, seated (open, nothing ordered), not sent, waiting on the kitchen,
 * served, bill asked, paying (part paid). The most urgent wins: money first,
 * then what the waiter still has to do.
 */
export function tableState(order: FloorOrder | undefined): TableState {
    if (!order) return "free";
    const lines = order.lines.filter((l) => l.status !== "void");
    if (order.paid > 0 && order.paid < order.totals.total) return "paying";
    if (order.status === "billed") return "billed";
    if (lines.some((l) => l.status === "pending")) return "pending";
    if (lines.length === 0) return "seated";
    if (lines.some((l) => l.status === "sent")) return "kitchen";
    return "served";
}

/** The last thing that happened on the order: opened, or a round fired. */
export function lastActivity(order: FloorOrder): number {
    let last = Date.parse(order.openedAt);
    for (const line of order.lines) {
        const at = line.sentAt ? Date.parse(line.sentAt) : NaN;
        if (Number.isFinite(at) && at > last) last = at;
    }
    return last;
}

/** Whole minutes since `since`, never negative (a device clock behind the server's). */
export function minutesSince(since: number, now: number): number {
    return Math.max(0, Math.floor((now - since) / 60_000));
}

export interface Chair {
    readonly cx: number;
    readonly cy: number;
}

interface TableBox {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly shape: string;
    readonly seats: number;
}

/** Chairs drawn per table at most: past that the plan writes the number instead. */
export const MAX_DRAWN_CHAIRS = 24;

/** Spread `count` points along a side of `length`, centred in equal slots. */
function along(count: number, length: number): number[] {
    return Array.from({ length: count }, (_, i) => ((i + 0.5) * length) / count);
}

/**
 * Where each chair sits around a table, in grid units, just outside its edge:
 * round tables on a circle, the rest shared between the long sides first and
 * the ends when the sides are full (one chair per unit of side).
 */
export function chairsOf(table: TableBox, gap = 0.35): Chair[] {
    const seats = Math.min(Math.max(Math.round(table.seats), 0), MAX_DRAWN_CHAIRS);
    if (seats === 0) return [];
    const cx = table.x + table.width / 2;
    const cy = table.y + table.height / 2;
    if (table.shape === "round") {
        const rx = table.width / 2 + gap;
        const ry = table.height / 2 + gap;
        return Array.from({ length: seats }, (_, i) => {
            const angle = -Math.PI / 2 + (i * 2 * Math.PI) / seats;
            return { cx: cx + rx * Math.cos(angle), cy: cy + ry * Math.sin(angle) };
        });
    }
    const horizontal = table.width >= table.height;
    const side = horizontal ? table.width : table.height;
    const perSide = Math.max(1, Math.floor(side));
    // Ends take a chair only once both long sides are full, or for a single guest.
    const ends = seats <= perSide * 2 ? 0 : Math.min(2, seats - perSide * 2);
    const onSides = seats - ends;
    const first = Math.ceil(onSides / 2);
    const second = onSides - first;
    const chairs: Chair[] = [];
    const place = (count: number, near: boolean) => {
        for (const offset of along(count, side)) {
            chairs.push(
                horizontal
                    ? { cx: table.x + offset, cy: near ? table.y - gap : table.y + table.height + gap }
                    : { cx: near ? table.x - gap : table.x + table.width + gap, cy: table.y + offset }
            );
        }
    };
    place(first, true);
    place(second, false);
    if (ends >= 1) chairs.push(horizontal ? { cx: table.x - gap, cy } : { cx, cy: table.y - gap });
    if (ends >= 2) chairs.push(horizontal ? { cx: table.x + table.width + gap, cy } : { cx, cy: table.y + table.height + gap });
    return chairs;
}

/** Snap a dragged position to the grid: whole units, or halves for a finer step. */
export function snap(value: number, step = 0.5): number {
    return Math.max(0, Math.round(value / step) * step);
}

/** The box every table (with its chairs) fits in, with a margin, never empty. */
export function planBounds(tables: readonly TableBox[], margin = 1): { x: number; y: number; width: number; height: number } {
    if (tables.length === 0) return { x: 0, y: 0, width: 12, height: 8 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of tables) {
        minX = Math.min(minX, t.x);
        minY = Math.min(minY, t.y);
        maxX = Math.max(maxX, t.x + t.width);
        maxY = Math.max(maxY, t.y + t.height);
    }
    return { x: minX - margin, y: minY - margin, width: maxX - minX + margin * 2, height: maxY - minY + margin * 2 };
}
