/**
 * What a page hosting the search outside the dashboard's frame hands the
 * palette: Polaris Desktop's Alt+Space window draws the very same
 * `CommandPalette` on `/launcher` and gives it this.
 *
 * The palette keeps every row of its own - recents, pages, the index, commands,
 * the calculator - and only asks the host for what a browser cannot see
 * (installed programs, the clipboard history, the web search), drawn as extra
 * groups after its own. Opening a Polaris result is the host's too: the
 * desktop shows it in its main window instead of navigating the search window.
 */

import { z } from "zod";
import { SYSTEM_COMMAND_IDS } from "@polaris/core";

/** The kinds of row a host may add, each drawn with its own icon and words. */
export const HOST_ROW_KINDS = ["url", "answer", "system", "app", "polar", "web", "clip"] as const;

export type HostRowKind = (typeof HOST_ROW_KINDS)[number];

/** What a host row can do besides opening it (Raycast's action panel, Ctrl+K), drawn here in the reader's language. */
export const HOST_ROW_ACTIONS = ["treat-as-game", "treat-as-app"] as const;

export type HostRowAction = (typeof HOST_ROW_ACTIONS)[number];

function isHostRowAction(value: string): value is HostRowAction {
    return (HOST_ROW_ACTIONS as readonly string[]).includes(value);
}

/** One row the host found. Validated: it crosses a process boundary. */
export const hostRowSchema = z.object({
    id: z.string().min(1).max(40),
    kind: z.enum(HOST_ROW_KINDS),
    title: z.string().max(400),
    subtitle: z.string().max(400),
    /** A program's own icon, as a PNG data URL, when the host has one. */
    icon: z
        .string()
        .max(200_000)
        .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
        .nullish(),
    /** A system command's id, drawn by its name here in the reader's language. */
    command: z.enum(SYSTEM_COMMAND_IDS).nullish(),
    /** A program that is a game, with the store it comes from (a brand name). */
    game: z.boolean().nullish(),
    store: z.string().max(60).nullish(),
    /** Its actions by id; one a newer host adds and this page cannot name is left out, never the row. */
    actions: z
        .array(z.string().max(40))
        .max(8)
        .nullish()
        .transform((actions) => actions?.filter(isHostRowAction))
});

export type HostRow = z.infer<typeof hostRowSchema>;

/** The host's answer, read without trusting it: anything malformed is dropped. */
export function readHostRows(raw: unknown): HostRow[] {
    const rows = z.object({ rows: z.array(z.unknown()).max(200) }).safeParse(raw);
    if (!rows.success) return [];
    return rows.data.rows.flatMap((row) => {
        const parsed = hostRowSchema.safeParse(row);
        return parsed.success ? [parsed.data] : [];
    });
}

/** The host's answer number, which an action on one of its rows names; null from a host too old to number them. */
export function readHostVersion(raw: unknown): number | null {
    const answer = z.object({ version: z.number().int().positive() }).safeParse(raw);
    return answer.success ? answer.data.version : null;
}

export interface SearchHost {
    /** Rows only the host can find, for what is typed. */
    readonly query: (text: string) => Promise<unknown>;
    /** Run one of those rows. */
    readonly run: (id: string) => void;
    /** Do one of a row's `actions`, naming the answer (`readHostVersion`) the row came from; absent from a host too old to have any. */
    readonly act?: (id: string, action: HostRowAction, version: number) => Promise<boolean>;
    /** Open a Polaris address (a path of this instance). */
    readonly navigate: (href: string) => void;
    /** Put the search away. */
    readonly close: () => void;
    /** Called each time the host brings the search back up, with the text it
     *  opens with (empty, or nothing from a host too old to pass one, for none). */
    readonly onOpened: (listener: (query?: string) => void) => void;
    /** Called when the host puts the search away by itself (its window lost
     *  focus); absent from a host too old to say. */
    readonly onHidden?: (listener: () => void) => void;
    /** The device plugins the host's computer has, as the desktop app's
     *  snapshot (`@polaris/core/device-plugins`); absent from a host too old to say. */
    readonly plugins?: () => Promise<unknown>;
    /** Put the search away and paste the text into the app that was in front
     *  (Raycast's "Paste to active app"); false when it could not. Absent from
     *  a host too old to do it, where an answer is copied instead. */
    readonly paste?: (text: string) => Promise<boolean>;
}

/** A path of this instance, and nothing that leaves it. */
export function isInstancePath(href: string): boolean {
    return /^\/(?!\/)/.test(href) && !href.includes("\\");
}
