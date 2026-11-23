/**
 * The apps that sign in on a device of their own - the command line, a Stream
 * Deck, a TV - and are listed under Account > Sessions rather than API keys.
 *
 * Each signs in through the device-code flow (`lib/cli/sign-in`) and holds an
 * API key of its kind underneath, which is what a request is checked against.
 * This table is the only place that says which kinds those are: the sessions
 * screen, the API keys screen, the address lock and the activity log all read
 * it, so a new client is one entry here and its words in the catalogs.
 *
 * Shared by server and client code; nothing here touches the database.
 */

import type { LucideIcon } from "lucide-react";
import type { ApiKeyKind } from "@polaris/auth";
import { Grid3x3, SquareTerminal, Terminal, Tv } from "lucide-react";

interface DeviceSessionKindEntry {
    /** The mark drawn beside the row. */
    readonly icon: LucideIcon;
    /** The app's name, in the `components` catalog. */
    readonly label: `sessionsTable.appSignIn.kinds.${string}`;
    /** Whether the name it reports at sign-in is the computer's own hostname,
     *  which is what names a machine on the sessions screen (`./machines`). A
     *  TV's is the set's name, which says nothing about the computers beside it. */
    readonly namesMachine: boolean;
}

export const DEVICE_SESSION_KINDS = {
    cli: { icon: Terminal, label: "sessionsTable.appSignIn.kinds.cli", namesMachine: true },
    streamdeck: {
        icon: Grid3x3,
        label: "sessionsTable.appSignIn.kinds.streamdeck",
        namesMachine: true
    },
    tv: { icon: Tv, label: "sessionsTable.appSignIn.kinds.tv", namesMachine: false },
    terminal: {
        icon: SquareTerminal,
        label: "sessionsTable.appSignIn.kinds.terminal",
        namesMachine: true
    }
} as const satisfies Partial<Record<ApiKeyKind, DeviceSessionKindEntry>>;

export type DeviceSessionKind = keyof typeof DEVICE_SESSION_KINDS;

/** Every kind, for a database filter. */
export const DEVICE_KINDS = Object.keys(DEVICE_SESSION_KINDS) as DeviceSessionKind[];

/** Whether a key of this kind is a device's sign-in rather than a key somebody made. */
export function isDeviceSessionKind(kind: string): kind is DeviceSessionKind {
    return Object.hasOwn(DEVICE_SESSION_KINDS, kind);
}

/**
 * What the Companion module's sign-in is stored with. Companion connects
 * through the Stream Deck's own flow and holds a key of the same kind - the
 * deck routes take nothing else - so this description is what tells the
 * sessions screen which of the two it is. A sign-in from before it was written
 * reads as a Stream Deck, which is what it was listed as then.
 */
// i18n-ignore stored with the key; never shown
export const COMPANION_KEY_DESCRIPTION = "Connected from the Companion module.";

/** The app a device sign-in names on the sessions screen: its kind's, or
 *  Companion's for the deck sign-in Companion made. */
export function deviceSessionLabel(session: {
    readonly kind: DeviceSessionKind;
    readonly client?: "companion" | null;
}):
    | (typeof DEVICE_SESSION_KINDS)[DeviceSessionKind]["label"]
    | "sessionsTable.appSignIn.kinds.companion" {
    return session.kind === "streamdeck" && session.client === "companion"
        ? "sessionsTable.appSignIn.kinds.companion"
        : DEVICE_SESSION_KINDS[session.kind].label;
}
