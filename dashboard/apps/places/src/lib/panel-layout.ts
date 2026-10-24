/**
 * A wall panel's cards and where each one sits.
 *
 * The grid is Home Assistant's sections view in spirit - a fixed number of
 * columns, cards placed by cell and spanning whole cells, dragged and resized
 * by the cell (https://www.home-assistant.io/dashboards/sections/) - kept to
 * the cards Places can draw from what it already reads.
 *
 * Pure and client-safe: the editor, the full-screen page and the service all
 * read the same rules, so a card the editor lets through is one the service
 * stores and the wall draws.
 */

import { z } from "zod";

/** Columns on a wide screen. A phone stacks the cards in one (`stackOrder`). */
export const PANEL_COLUMNS = 12;
/** Rows a card may reach down to: a panel taller than this is two panels. */
export const PANEL_ROWS = 48;
/** Cards on one panel. A wall with more than this is not read at a glance. */
export const PANEL_CARDS = 48;
/** Panels at one place. */
export const PANELS_PER_PLACE = 20;
export const PANEL_NAME_MAX = 60;

export const PANEL_CARD_TYPES = ["device", "room", "clock", "camera", "action", "sensor"] as const;
export type PanelCardType = (typeof PANEL_CARD_TYPES)[number];

/** Smallest and default size of each kind of card, in cells. */
export const CARD_SIZES: Readonly<
    Record<PanelCardType, { minW: number; minH: number; w: number; h: number }>
> = {
    device: { minW: 2, minH: 2, w: 3, h: 2 },
    room: { minW: 3, minH: 2, w: 4, h: 3 },
    clock: { minW: 2, minH: 1, w: 3, h: 2 },
    camera: { minW: 3, minH: 2, w: 4, h: 3 },
    action: { minW: 2, minH: 1, w: 3, h: 1 },
    sensor: { minW: 2, minH: 2, w: 3, h: 2 }
};

const cell = z.number().int();
const box = {
    id: z.string().min(1).max(40),
    x: cell.min(0).max(PANEL_COLUMNS - 1),
    y: cell.min(0).max(PANEL_ROWS - 1),
    w: cell.min(1).max(PANEL_COLUMNS),
    h: cell.min(1).max(PANEL_ROWS)
};

export const panelCardSchema = z
    .discriminatedUnion("type", [
        z.object({ ...box, type: z.literal("device"), deviceId: z.string().uuid() }),
        z.object({ ...box, type: z.literal("room"), roomId: z.string().uuid() }),
        z.object({ ...box, type: z.literal("clock") }),
        z.object({ ...box, type: z.literal("camera"), cameraId: z.string().uuid() }),
        // Runs an automation. `confirm` asks first, for one that should not
        // fire on a brush of the screen ("Everything off", "Lock up").
        z.object({
            ...box,
            type: z.literal("action"),
            automationId: z.string().uuid(),
            confirm: z.boolean().default(false)
        }),
        // One device's reading, large. A device card shows it too, smaller and
        // among its controls.
        z.object({ ...box, type: z.literal("sensor"), deviceId: z.string().uuid() })
    ])
    .refine((card) => card.x + card.w <= PANEL_COLUMNS, "A card runs past the panel's edge")
    .refine((card) => card.y + card.h <= PANEL_ROWS, "A card runs past the panel's edge")
    .refine(
        (card) => card.w >= CARD_SIZES[card.type].minW && card.h >= CARD_SIZES[card.type].minH,
        "That card is smaller than it can be drawn"
    );

export type PanelCard = z.infer<typeof panelCardSchema>;

/** Two cards overlap when their boxes share any cell. */
export function overlaps(a: PanelCard, b: PanelCard): boolean {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export const panelCardsSchema = z
    .array(panelCardSchema)
    .max(PANEL_CARDS, "A panel holds up to 48 cards")
    .refine(
        (cards) => new Set(cards.map((card) => card.id)).size === cards.length,
        "Two cards on that panel are the same card"
    )
    .refine(
        (cards) => cards.every((card, i) => cards.slice(i + 1).every((o) => !overlaps(card, o))),
        "Two cards on that panel overlap"
    );

/** A panel's name, trimmed before it is checked. */
export const panelNameSchema = z
    .string()
    .trim()
    .min(1, "Give the panel a name")
    .max(PANEL_NAME_MAX, "That name is too long");

export function normalizePanelName(value: unknown): string {
    return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

/** Stored cards, read back. A row written by a newer build that this one does
 *  not understand reads as an empty panel rather than breaking the page. */
export function storedCards(value: unknown): PanelCard[] {
    const parsed = panelCardsSchema.safeParse(value);
    return parsed.success ? parsed.data : [];
}

/** A panel as a screen sees it. */
export interface PanelView {
    readonly id: string;
    readonly placeId: string;
    readonly name: string;
    readonly cards: readonly PanelCard[];
}

/** The devices a panel shows: its device cards, and every device in its rooms.
 *  This, and nothing wider, is what the panel's link reaches. */
export function panelDeviceIds(
    cards: readonly PanelCard[],
    roomDevices: ReadonlyMap<string, readonly string[]>
): Set<string> {
    const ids = new Set<string>();
    for (const card of cards) {
        if (card.type === "device" || card.type === "sensor") ids.add(card.deviceId);
        if (card.type === "room") for (const id of roomDevices.get(card.roomId) ?? []) ids.add(id);
    }
    return ids;
}

/** The devices a panel's cards name directly (device and sensor cards), not
 *  through a room. */
export function panelDirectDeviceIds(cards: readonly PanelCard[]): string[] {
    return [
        ...new Set(
            cards.flatMap((card) =>
                card.type === "device" || card.type === "sensor" ? [card.deviceId] : []
            )
        )
    ];
}

/** The cameras a panel shows. This, and nothing wider, is what its link may watch. */
export function panelCameraIds(cards: readonly PanelCard[]): string[] {
    return [...new Set(cards.flatMap((card) => (card.type === "camera" ? [card.cameraId] : [])))];
}

/** The automations a panel's buttons run. This is all its link may start. */
export function panelAutomationIds(cards: readonly PanelCard[]): string[] {
    return [
        ...new Set(cards.flatMap((card) => (card.type === "action" ? [card.automationId] : [])))
    ];
}

/** The rooms a panel's cards name. */
export function panelRoomIds(cards: readonly PanelCard[]): string[] {
    return [...new Set(cards.flatMap((card) => (card.type === "room" ? [card.roomId] : [])))];
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/** Whether a card can sit at this box without leaving the grid or covering
 *  another card. */
function fits(cards: readonly PanelCard[], card: PanelCard): boolean {
    if (card.x < 0 || card.y < 0) return false;
    if (card.x + card.w > PANEL_COLUMNS || card.y + card.h > PANEL_ROWS) return false;
    return cards.every((other) => other.id === card.id || !overlaps(card, other));
}

/**
 * A card moved to a cell. Kept inside the grid; refused (the cards come back
 * unchanged) when it would cover another card, so a drag never stacks two.
 */
export function moveCard(
    cards: readonly PanelCard[],
    id: string,
    x: number,
    y: number
): PanelCard[] {
    const card = cards.find((entry) => entry.id === id);
    if (!card) return [...cards];
    const next = {
        ...card,
        x: clamp(Math.round(x), 0, PANEL_COLUMNS - card.w),
        y: clamp(Math.round(y), 0, PANEL_ROWS - card.h)
    };
    return fits(cards, next) ? cards.map((entry) => (entry.id === id ? next : entry)) : [...cards];
}

/** A card resized, never below what it can be drawn at nor past the grid, and
 *  refused when it would cover another card. */
export function resizeCard(
    cards: readonly PanelCard[],
    id: string,
    w: number,
    h: number
): PanelCard[] {
    const card = cards.find((entry) => entry.id === id);
    if (!card) return [...cards];
    const size = CARD_SIZES[card.type];
    const next = {
        ...card,
        w: clamp(Math.round(w), size.minW, PANEL_COLUMNS - card.x),
        h: clamp(Math.round(h), size.minH, PANEL_ROWS - card.y)
    };
    return fits(cards, next) ? cards.map((entry) => (entry.id === id ? next : entry)) : [...cards];
}

/** The first free box a new card of this size fits in, reading the grid left
 *  to right and top to bottom; null when the panel is full. */
export function firstFree(
    cards: readonly PanelCard[],
    w: number,
    h: number
): { x: number; y: number } | null {
    for (let y = 0; y + h <= PANEL_ROWS; y++) {
        for (let x = 0; x + w <= PANEL_COLUMNS; x++) {
            const probe = { id: "\u0000", type: "clock", x, y, w, h } as PanelCard;
            if (cards.every((other) => !overlaps(probe, other))) return { x, y };
        }
    }
    return null;
}

/** What a new card is, before it has a place on the grid. */
export type NewCard =
    | { readonly type: "device"; readonly deviceId: string }
    | { readonly type: "room"; readonly roomId: string }
    | { readonly type: "clock" }
    | { readonly type: "camera"; readonly cameraId: string }
    | { readonly type: "action"; readonly automationId: string; readonly confirm: boolean }
    | { readonly type: "sensor"; readonly deviceId: string };

/** A card added at its default size in the first free box, or the cards
 *  unchanged when the panel has no room left. */
export function addCard(cards: readonly PanelCard[], card: NewCard, id: string): PanelCard[] {
    if (cards.length >= PANEL_CARDS) return [...cards];
    const size = CARD_SIZES[card.type];
    const at = firstFree(cards, size.w, size.h);
    if (!at) return [...cards];
    return [...cards, { ...card, id, ...at, w: size.w, h: size.h } as PanelCard];
}

/** The order cards stack in on a narrow screen: the way the wide grid reads,
 *  row by row and left to right. */
export function stackOrder(cards: readonly PanelCard[]): PanelCard[] {
    return [...cards].sort((a, b) => a.y - b.y || a.x - b.x);
}

/** How many rows the panel's cards reach down to. */
export function panelHeight(cards: readonly PanelCard[]): number {
    return cards.reduce((rows, card) => Math.max(rows, card.y + card.h), 0);
}
