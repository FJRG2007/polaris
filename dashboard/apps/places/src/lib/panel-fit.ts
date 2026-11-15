/**
 * How a wall panel's cards fill the screen they are on.
 *
 * The arrangement somebody made in Arrange is the panel's order and emphasis,
 * not a set of pixel boxes: a wall tablet is any size and either way up, and a
 * card drawn smaller than a finger, or one that scrolls inside itself, is the
 * failure this exists to rule out. So the screen decides the grid - as many
 * columns and rows as fit cells no smaller than the panel's card size - and the
 * cards go into it in their arranged order, at a span their kind and their
 * arranged size ask for. Widths are evened out row by row with the Overview's
 * own packing (`packOverviewSpans`), so a row spans the screen instead of
 * ending in a strip of nothing. What does not fit goes onto the next page,
 * swiped to, rather than shrinking every card below a touch.
 *
 * Pure, so it can be read back in a test at every screen size.
 */

import * as kinds from "./device-kinds";
import { packOverviewSpans } from "@polaris/core";
import type { DeviceAction, DeviceView } from "./device-kinds";
import type { PanelCardSize, PanelCardType } from "./panel-layout";

/** The smallest a cell is drawn at, in CSS pixels before the text scale. A
 *  small cell still holds a 64px button and its name. */
export const CELL_MIN: Readonly<Record<PanelCardSize, number>> = {
    small: 148,
    medium: 184,
    large: 232
};

/** The most columns a wall is split into, however wide it is. */
export const FIT_MAX_COLUMNS = 8;

/** A card as the fit reads it: its kind, and how big it was arranged. */
export interface FitCard {
    readonly id: string;
    readonly type: PanelCardType;
    /** The arranged width and height on the 12-column editor grid. */
    readonly w: number;
    readonly h: number;
    /** A device card's device kind, where it is known. */
    readonly kind?: string;
}

export interface FitInput {
    /** The room the board has, in CSS pixels, already divided by the text scale. */
    readonly width: number;
    readonly height: number;
    readonly cards: readonly FitCard[];
    readonly cardSize: PanelCardSize;
    /** The gap between cards, in CSS pixels. */
    readonly gap: number;
}

export interface FitPlacement {
    readonly id: string;
    readonly page: number;
    /** Column and row, from zero, and the cells it spans. */
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

export interface PanelFit {
    readonly columns: number;
    /** Rows on one page. */
    readonly rows: number;
    readonly cellW: number;
    readonly cellH: number;
    readonly pages: number;
    readonly placements: readonly FitPlacement[];
}

/** Device kinds whose card carries a reading beside its state, and wants the
 *  room of two cells across to show both large. */
const WIDE_KINDS = new Set(["climate", "air", "dehumidifier", "litter", "appliance"]);

/** The span a card asks for before the screen has its say. */
export function preferredSpan(card: FitCard): { w: number; h: number } {
    let w = 1;
    let h = 1;
    if (card.type === "clock" || card.type === "weather") w = 2;
    if (card.type === "room" || card.type === "camera") {
        w = 2;
        h = 2;
    }
    if (card.type === "device" && card.kind && WIDE_KINDS.has(kinds.deviceKind(card.kind)))
        w = 2;
    // Made big in Arrange: the owner said it matters, so it stays bigger.
    if (card.w >= 6) w += 1;
    if (card.h >= 4) h = Math.max(h, 2);
    return { w, h };
}

function clamp(value: number, low: number, high: number): number {
    return Math.min(Math.max(value, low), high);
}

/** How many cells of `min` with `gap` between them fit in `room`. */
function cellsIn(room: number, min: number, gap: number): number {
    return Math.max(1, Math.floor((Math.max(0, room) + gap) / (min + gap)));
}

/** The grid for a screen, and where each card goes on which page. */
export function fitPanel(input: FitInput): PanelFit {
    const min = CELL_MIN[input.cardSize];
    const gap = Math.max(0, input.gap);
    const columns = clamp(cellsIn(input.width, min, gap), 1, FIT_MAX_COLUMNS);
    const rows = cellsIn(input.height, min, gap);
    const spans = input.cards.map((card) => {
        const span = preferredSpan(card);
        return { w: clamp(span.w, 1, columns), h: clamp(span.h, 1, rows) };
    });
    // Widen within reason so rows reach the edge; never narrower than asked.
    const widths = packOverviewSpans(
        spans.map((span) => ({
            preferred: span.w,
            min: span.w,
            max: Math.min(columns, span.w + 1)
        })),
        columns
    );

    const placements: FitPlacement[] = [];
    let page = 0;
    let taken: boolean[][] = [];
    const free = (x: number, y: number, w: number, h: number) => {
        for (let row = y; row < y + h; row++)
            for (let col = x; col < x + w; col++) if (taken[row]?.[col]) return false;
        return true;
    };
    const take = (x: number, y: number, w: number, h: number) => {
        for (let row = y; row < y + h; row++) {
            taken[row] ??= [];
            for (let col = x; col < x + w; col++) taken[row]![col] = true;
        }
    };
    const spot = (w: number, h: number): { x: number; y: number } | null => {
        for (let y = 0; y + h <= rows; y++)
            for (let x = 0; x + w <= columns; x++) if (free(x, y, w, h)) return { x, y };
        return null;
    };
    input.cards.forEach((card, index) => {
        const h = spans[index]!.h;
        let w = clamp(widths[index] ?? spans[index]!.w, 1, columns);
        let at = spot(w, h);
        // The widened width may not fit where the asked one would.
        if (!at && w > spans[index]!.w) {
            w = spans[index]!.w;
            at = spot(w, h);
        }
        if (!at) {
            page += 1;
            taken = [];
            at = { x: 0, y: 0 };
        }
        take(at.x, at.y, w, h);
        placements.push({ id: card.id, page, x: at.x, y: at.y, w, h });
    });

    const pages = placements.length ? page + 1 : 1;
    // One page: the rows it uses share the height. Several: every page keeps
    // the same rows, so a swipe does not resize the cards.
    const used =
        pages > 1
            ? rows
            : Math.max(1, ...placements.map((placement) => placement.y + placement.h));
    const cellW = (Math.max(input.width, min) - gap * (columns - 1)) / columns;
    const share = (Math.max(input.height, min) - gap * (used - 1)) / used;
    // Few cards on a big screen: tall enough to fill, never a towering slab.
    const cellH = Math.max(min, Math.min(share, cellW * 1.25));
    return { columns, rows, cellW, cellH, pages, placements };
}

/**
 * The one thing a press on the card does: lock or unlock, open, switch, start
 * a clean. Null where a press has nothing safe to do at once - a sensor, an
 * appliance (stopping it is behind the card, never a brush of the screen).
 */
export function primaryAction(device: DeviceView): DeviceAction | null {
    const kind = kinds.deviceKind(device.kind);
    if (kind === "lock") return device.state === "locked" ? "unlock" : "lock";
    if (kind === "opener") return "unlatch";
    if (kind === "litter") return "clean";
    if (kind === "sensor" || kind === "appliance") return null;
    if (!kinds.actionsFor(kind).includes("turn-on")) return null;
    return device.state === "on" ? "turn-off" : "turn-on";
}

/** The reading a card shows as a big number, or null for none. */
export function wallReading(device: DeviceView): string | null {
    if (!device.online) return null;
    const kind = kinds.deviceKind(device.kind);
    if (kind === "climate" && device.climate?.current != null)
        return `${Math.round(device.climate.current * 10) / 10}°`;
    if (kinds.isAirKind(kind)) {
        const readings = device.air?.readings;
        if (readings?.humidity != null) return `${Math.round(readings.humidity)}%`;
        if (readings?.temperature != null) return `${Math.round(readings.temperature * 10) / 10}°`;
    }
    return null;
}
