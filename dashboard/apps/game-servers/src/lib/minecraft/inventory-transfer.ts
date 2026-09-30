/**
 * A player's bag as a file: exported to keep or to move, imported back into the
 * same player or another, on this server or another that speaks the same syntax.
 *
 * Lossless or nothing. A stack travels as the server wrote it - its slot, id,
 * count and the raw compound of everything else - and goes back through the same
 * `itemArgument` every other write uses, so an enchanted, renamed, damaged sword
 * comes back byte for byte or is refused by name. It is never rebuilt from its id
 * and count.
 *
 * The syntax is the file's own: a stack read on a server that answered with
 * `components` can only be written back to one that takes them, and one read with
 * `tag` only to one that takes braces. A file whose stacks carry no data at all
 * reads the same everywhere.
 *
 * CSV is the same file as rows a spreadsheet opens: one per stack, with a column
 * that reads the stack in words and one that carries its raw data, so it imports
 * back exactly like the JSON. Its first line names the format, the syntax and the
 * server, because a spreadsheet has nowhere else to keep them.
 *
 * Pure and browser-safe: the screen previews an import with the same functions
 * the server applies it with.
 */

import { z } from "zod";
import type { InventoryItem } from "./inventory";
import {
    itemArgument,
    replaceSlot,
    writableSlots,
    type ItemArgumentRefusal
} from "./item-argument";

export const TRANSFER_FORMAT = "polaris.minecraft.inventory";
export const TRANSFER_VERSION = 1;

/** The syntax a stack's data is written in. */
export type Era = "components" | "tag";
/** A file's: `plain` when none of its stacks carries data, which any server reads. */
export type FileEra = Era | "plain";

/** How an import lands: the whole bag becomes the file's, or only empty slots are filled. */
export const IMPORT_MODES = ["replace", "fill"] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

/** The most players one file carries: a server's worth. */
export const MOST_PLAYERS = 500;

/** The biggest file read, in characters: 500 full bags of long stacks. */
export const MOST_FILE_CHARS = 12_000_000;

const itemId = z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/);
const playerName = z.string().regex(/^[A-Za-z0-9_]{1,16}$/);

export const transferStackSchema = z.object({
    slot: z.number().int().min(-128).max(127),
    id: itemId,
    count: z.number().int().min(1).max(127),
    data: z
        .object({
            era: z.enum(["components", "tag"]),
            snbt: z.string().min(2).max(8192).startsWith("{").endsWith("}")
        })
        .nullable()
});

const playerSchema = z
    .object({
        name: playerName,
        /** When the bag was read, ISO 8601. */
        takenAt: z.string().max(40),
        /** Read live off the server, or the last copy Polaris kept. */
        live: z.boolean(),
        items: z.array(transferStackSchema).max(64)
    })
    .refine(
        (player) => new Set(player.items.map((item) => item.slot)).size === player.items.length,
        {
            params: { problem: "duplicateSlot" }
        }
    );

/** The file, as exported and as an import checks it. Shared by the screen and the server. */
export const transferSchema = z
    .object({
        format: z.literal(TRANSFER_FORMAT),
        version: z.literal(TRANSFER_VERSION),
        era: z.enum(["components", "tag", "plain"]),
        /** The server's version when it said, for a reader; the era decides. */
        serverVersion: z.string().max(40).nullable(),
        exportedAt: z.string().max(40),
        players: z.array(playerSchema).min(1).max(MOST_PLAYERS)
    })
    .refine(
        (file) =>
            file.players.every((player) =>
                player.items.every((item) => item.data === null || item.data.era === file.era)
            ),
        { params: { problem: "mixedEra" } }
    )
    .refine(
        (file) =>
            new Set(file.players.map((player) => player.name.toLowerCase())).size ===
            file.players.length,
        { params: { problem: "duplicatePlayer" } }
    );

export type TransferFile = z.infer<typeof transferSchema>;
export type TransferPlayer = TransferFile["players"][number];

/** Why a file cannot be read, in the words the screen uses. */
export type TransferProblem =
    | "notJson"
    | "tooBig"
    | "notInventory"
    | "csv"
    | "mixedEra"
    | "duplicateSlot"
    | "duplicatePlayer";

/** The era a set of stacks was read in: the era of any that carries data. */
export function eraOf(items: readonly InventoryItem[]): FileEra {
    return items.find((item) => item.data !== null)?.data?.era ?? "plain";
}

/** One era for many bags: the first that carries data decides; they all came off one server. */
function fileEra(players: readonly { readonly items: readonly InventoryItem[] }[]): FileEra {
    for (const player of players) {
        const era = eraOf(player.items);
        if (era !== "plain") return era;
    }
    return "plain";
}

/** Bags as a file. Stacks are copied as read - slot, id, count and the raw data span. */
export function exportFile(
    players: readonly {
        readonly name: string;
        readonly takenAt: string;
        readonly live: boolean;
        readonly items: readonly InventoryItem[];
    }[],
    serverVersion: string | null,
    now: Date = new Date()
): TransferFile {
    return {
        format: TRANSFER_FORMAT,
        version: TRANSFER_VERSION,
        era: fileEra(players),
        serverVersion,
        exportedAt: now.toISOString(),
        players: players.map((player) => ({
            name: player.name,
            takenAt: player.takenAt,
            live: player.live,
            items: [...player.items]
                .sort((left, right) => left.slot - right.slot)
                .map((item) => ({
                    slot: item.slot,
                    id: item.id,
                    count: item.count,
                    data: item.data ? { era: item.data.era, snbt: item.data.snbt } : null
                }))
        }))
    };
}

export function toJson(file: TransferFile): string {
    return `${JSON.stringify(file, null, 2)}\n`;
}

/** A file read back, or why it cannot be. */
export function parseTransfer(
    text: string
): { ok: true; file: TransferFile } | { ok: false; problem: TransferProblem } {
    if (text.length > MOST_FILE_CHARS) return { ok: false, problem: "tooBig" };
    const trimmed = text.trim();
    if (trimmed.startsWith(READ_ONLY_CSV_MARK)) return { ok: false, problem: "csv" };
    let raw: unknown;
    if (trimmed.startsWith(CSV_MARK)) {
        raw = fromCsv(trimmed);
        if (raw === null) return { ok: false, problem: "notInventory" };
        return checked(raw);
    }
    try {
        raw = JSON.parse(trimmed);
    } catch {
        return { ok: false, problem: "notJson" };
    }
    return checked(raw);
}

function checked(
    raw: unknown
): { ok: true; file: TransferFile } | { ok: false; problem: TransferProblem } {
    const parsed = transferSchema.safeParse(raw);
    if (parsed.success) return { ok: true, file: parsed.data };
    const said = parsed.error.issues.map(
        (issue) => (issue as { params?: { problem?: string } }).params?.problem
    );
    for (const problem of ["mixedEra", "duplicateSlot", "duplicatePlayer"] as const)
        if (said.includes(problem)) return { ok: false, problem };
    return { ok: false, problem: "notInventory" };
}

/** Whether a server speaking `server` can take a file read in `file`. */
export function eraFits(file: FileEra, server: Era): boolean {
    return file === "plain" || file === server;
}

// ------------------------------------------------------------------ what an import changes

/** What an import does to one slot. */
export type SlotChange = "add" | "replace" | "remove" | "keep" | "refused";

export interface PlannedSlot {
    readonly slot: number;
    /** What is there now, as last read. */
    readonly before: InventoryItem | null;
    /** What will be there. Null for an empty slot. */
    readonly after: InventoryItem | null;
    readonly change: SlotChange;
    /** Why a stack of the file cannot be written: its data would not come back
     *  whole, it does not fit a command, or the slot is one only a mod knows. */
    readonly refused?: ItemArgumentRefusal | "slot";
    /** The file's stack a refused slot would have taken, to name it. */
    readonly wanted?: InventoryItem;
}

function sameStack(left: InventoryItem | null, right: InventoryItem | null): boolean {
    if (left === null || right === null) return left === right;
    return (
        left.id === right.id &&
        left.count === right.count &&
        (left.data?.snbt ?? null) === (right.data?.snbt ?? null)
    );
}

/**
 * Slot by slot, what an import does to a bag. `replace` makes every slot the
 * grid draws what the file says, emptying the ones the file leaves empty; `fill`
 * only puts the file's stacks into slots that are empty now. A stack that cannot
 * be written is `refused`, its slot left as it is, and named on the screen.
 */
export function planImport(
    current: readonly InventoryItem[],
    incoming: readonly InventoryItem[],
    mode: ImportMode
): PlannedSlot[] {
    const now = new Map(current.map((item) => [item.slot, item]));
    const next = new Map(incoming.map((item) => [item.slot, item]));
    const slots = new Set<number>([
        ...incoming.map((item) => item.slot),
        ...(mode === "replace" ? writableSlots() : [])
    ]);
    const planned: PlannedSlot[] = [];
    for (const slot of [...slots].sort((left, right) => left - right)) {
        const before = now.get(slot) ?? null;
        const wanted = next.get(slot) ?? null;
        if (wanted !== null) {
            const argument = itemArgument(wanted);
            const refused =
                replaceSlot(slot) === null ? ("slot" as const) : argument.ok ? null : argument.why;
            if (refused) {
                planned.push({ slot, before, after: before, change: "refused", refused, wanted });
                continue;
            }
            if (mode === "fill" && before !== null) {
                planned.push({ slot, before, after: before, change: "keep" });
                continue;
            }
            planned.push({
                slot,
                before,
                after: wanted,
                change: sameStack(before, wanted) ? "keep" : before === null ? "add" : "replace"
            });
            continue;
        }
        // Only `replace` reaches a slot the file leaves empty.
        planned.push({ slot, before, after: null, change: before === null ? "keep" : "remove" });
    }
    return planned;
}

/** The slots an import writes, in the order they are written. */
export function writesOf(plan: readonly PlannedSlot[]): PlannedSlot[] {
    return plan.filter(
        (one) => one.change === "add" || one.change === "replace" || one.change === "remove"
    );
}

// ------------------------------------------------------------------ CSV, for people

/** The first line of a CSV export, followed by what the rows need to be read back. */
export const CSV_MARK = "# Polaris inventory export";

/** How the first CSV exports began: they carried no raw data, so they cannot be imported. */
export const READ_ONLY_CSV_MARK = "# Polaris inventory export - for reading only";

/** How a text cell may not start as it is: what a spreadsheet would run, or the quote that marks it. */
const FORMULA_START = /^[=+\-@\t\r']/;

/** A cell as CSV writes it: quoted when it has to be, and never read as a formula. */
export function csvCell(value: string | number): string {
    let text = String(value);
    // A cell a spreadsheet would run: =, +, - or @ first, or a tab or return. A number is only a number.
    if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** What a stack's data says in words: its name, its enchantments, its damage. */
export function summarize(item: InventoryItem): string {
    const snbt = item.data?.snbt;
    if (!snbt) return "";
    const parts: string[] = [];
    const name = nameIn(snbt);
    if (name) parts.push(`"${name}"`);
    const enchantments = enchantmentsIn(snbt);
    if (enchantments.length > 0) parts.push(enchantments.join(", "));
    const damage = /(?:"minecraft:damage"|\bDamage)\s*:\s*(\d+)/.exec(snbt)?.[1];
    if (damage && damage !== "0") parts.push(`damage ${damage}`);
    return parts.join("; ");
}

function nameIn(snbt: string): string | null {
    const component = /"minecraft:custom_name"\s*:\s*(\{[^{}]*\}|'[^']*'|"(?:[^"\\]|\\.)*")/.exec(
        snbt
    )?.[1];
    const legacy = /\bName\s*:\s*('[^']*'|"(?:[^"\\]|\\.)*")/.exec(snbt)?.[1];
    const raw = component ?? legacy;
    if (!raw) return null;
    const text =
        /text\s*:\s*"((?:[^"\\]|\\.)*)"|"text"\s*:\s*"((?:[^"\\]|\\.)*)"|\\"text\\"\s*:\s*\\"((?:[^"\\]|\\.)*?)\\"/.exec(
            raw
        );
    const found = text?.[1] ?? text?.[2] ?? text?.[3];
    if (found !== undefined) return found;
    return raw.replace(/^['"]|['"]$/g, "").replace(/^"|"$/g, "") || null;
}

function enchantmentsIn(snbt: string): string[] {
    const found: string[] = [];
    // Components: {"minecraft:enchantments": {levels: {"minecraft:sharpness": 5}}}, or without `levels` from 1.21.5.
    const component = /"minecraft:enchantments"\s*:\s*\{(?:levels\s*:\s*)?\{?([^{}]*)\}/.exec(
        snbt
    )?.[1];
    if (component)
        for (const match of component.matchAll(/"(?:minecraft:)?([a-z_]+)"\s*:\s*(\d+)/g))
            found.push(`${match[1]} ${match[2]}`);
    // Before: Enchantments: [{id: "minecraft:sharpness", lvl: 5s}].
    for (const match of snbt.matchAll(
        /\{\s*(?:id\s*:\s*"(?:minecraft:)?([a-z_]+)"\s*,\s*lvl\s*:\s*(\d+)s?|lvl\s*:\s*(\d+)s?\s*,\s*id\s*:\s*"(?:minecraft:)?([a-z_]+)")\s*\}/g
    )) {
        const id = match[1] ?? match[4];
        const level = match[2] ?? match[3];
        if (id && level) found.push(`${id} ${level}`);
    }
    return found;
}

/**
 * Bags as rows: one per stack, and one with no item for a bag that is empty, so
 * an import can empty it too. The first six columns are for reading, named in
 * the reader's words; the last three are what an import reads back. `slotName`
 * names a slot in the reader's words.
 */
export function toCsv(
    file: TransferFile,
    header: readonly string[],
    slotName: (slot: number) => string
): string {
    const mark = `${CSV_MARK} v${file.version} era=${file.era} server=${file.serverVersion ?? ""} exported=${file.exportedAt}`;
    const lines = [mark, header.map(csvCell).join(",")];
    for (const player of file.players) {
        const tail = (data: string) => [data, player.takenAt, player.live ? "live" : "kept"];
        if (player.items.length === 0)
            lines.push([player.name, "", "", "", "", "", ...tail("")].map(csvCell).join(","));
        for (const item of player.items)
            lines.push(
                [
                    player.name,
                    item.slot,
                    slotName(item.slot),
                    item.id,
                    item.count,
                    summarize(item),
                    ...tail(item.data?.snbt ?? "")
                ]
                    .map(csvCell)
                    .join(",")
            );
    }
    return `${lines.join("\r\n")}\r\n`;
}

/** Rows as RFC 4180 reads them: quoted cells may hold commas, quotes and line breaks. */
function csvRows(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < text.length; index++) {
        const char = text[index]!;
        if (quoted) {
            if (char === '"' && text[index + 1] === '"') {
                cell += '"';
                index++;
            } else if (char === '"') quoted = false;
            else cell += char;
        } else if (char === '"') quoted = true;
        else if (char === ",") {
            row.push(cell);
            cell = "";
        } else if (char === "\n" || char === "\r") {
            if (char === "\r" && text[index + 1] === "\n") index++;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
        } else cell += char;
    }
    if (cell !== "" || row.length > 0) {
        row.push(cell);
        rows.push(row);
    }
    return rows;
}

/** A text cell as it was before `csvCell` kept it from being read as a formula. */
function textCell(cell: string): string {
    return cell.startsWith("'") && FORMULA_START.test(cell.slice(1)) ? cell.slice(1) : cell;
}

/** A whole number as `toCsv` writes it; anything else, a blank cell included, is not one. */
function wholeCell(cell: string): number {
    return /^-?\d+$/.test(cell) ? Number(cell) : Number.NaN;
}

/**
 * A CSV export read back into the shape the JSON has, for the same schema to
 * check. Null when it is not one: no mark line, or a row of the wrong width.
 */
function fromCsv(text: string): unknown {
    const [first, , ...rows] = csvRows(text);
    const mark = first?.join(",") ?? "";
    const meta = /^# Polaris inventory export v(\d+) era=(\w+) server=(.*) exported=(\S+)$/.exec(
        mark
    );
    if (!meta) return null;
    const era = meta[2]!;
    const players = new Map<
        string,
        { name: string; takenAt: string; live: boolean; items: unknown[] }
    >();
    for (const cells of rows) {
        if (cells.length === 1 && cells[0] === "") continue;
        if (cells.length !== 9) return null;
        const [name, slot, , id, count, , data, takenAt, live] = cells.map(textCell) as [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string
        ];
        const player = players.get(name) ?? {
            name,
            takenAt,
            live: live === "live",
            items: [] as unknown[]
        };
        players.set(name, player);
        if (id === "") continue;
        player.items.push({
            slot: wholeCell(slot),
            id,
            count: wholeCell(count),
            data: data === "" ? null : { era, snbt: data }
        });
    }
    return {
        format: TRANSFER_FORMAT,
        version: Number(meta[1]),
        era,
        serverVersion: meta[3] === "" ? null : meta[3],
        exportedAt: meta[4],
        players: [...players.values()]
    };
}
