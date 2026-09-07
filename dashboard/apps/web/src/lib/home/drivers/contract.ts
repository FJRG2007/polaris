/**
 * What a driver is, and the only vocabulary one is allowed to speak.
 *
 * Everything above a driver - the service, the actions, every screen - knows
 * `device-kinds` and nothing else. A driver's whole job is to turn one make's
 * numbering, naming and quirks into these words, once, in one file. That is what
 * makes a second make a file and a registry entry rather than a change to a
 * screen, and it is what stops "Nuki" appearing in a component three releases
 * from now.
 *
 * Server-only: a driver holds somebody's credentials and talks to their house.
 */

import type { DeviceAction, DeviceKind, DeviceState, DoorState } from "@/lib/home/device-kinds";

/** The fields a connection asked for, by the key the registry gave them. Opaque
 *  to everything except the driver that named them. */
export type Credentials = Readonly<Record<string, string>>;

/**
 * What went wrong, in a sentence a reader can act on, plus which sort of wrong.
 *
 * The sort is the reason this is not a plain Error. A refused credential has to
 * mark the account and offer the one button that fixes it; a device that would
 * not answer has to leave everything exactly where it was and be tried again in
 * half a minute. Telling a house those are the same thing is how a network blip
 * disconnects somebody's front door.
 */
export class DriverError extends Error {
    readonly kind: "unauthorized" | "unreachable" | "refused";

    constructor(message: string, kind: DriverError["kind"]) {
        super(message);
        this.name = "DriverError";
        this.kind = kind;
    }
}

/** One device as its account describes it now. Nothing here is the vendor's own
 *  vocabulary: that was translated on the way out of the driver. */
export interface DeviceSnapshot {
    readonly externalId: string;
    readonly kind: DeviceKind;
    readonly name: string;
    readonly model: string | null;
    readonly firmware: string | null;
    readonly state: DeviceState;
    readonly doorState: DoorState;
    readonly batteryPercent: number | null;
    readonly batteryCritical: boolean;
    /** Whether the account could reach it when asked. A device nobody can reach
     *  still draws, saying so, rather than disappearing off a screen. */
    readonly online: boolean;
    /** What it last read, for a device that measures rather than does - a
     *  contact, a temperature, a movement detector. Null for everything that has
     *  a state instead, which is most of them. */
    readonly value?: string | null;
    /** What that reading is in, as its own maker wrote it. */
    readonly unit?: string | null;
}

/** One thing that happened, as the vendor's own record of it. */
export interface DeviceHistoryEntry {
    /** The vendor's id for this entry, which is what makes re-reading their log
     *  idempotent rather than duplicating a month of it. */
    readonly externalId: string;
    readonly deviceExternalId: string;
    readonly action: string;
    readonly actor: string | null;
    readonly via: string;
    readonly outcome: string;
    readonly note: string | null;
    readonly at: Date;
}

/**
 * One way of reaching one make's devices.
 *
 * `verify` is separate from `list` on purpose even where they are the same call:
 * a credential is proved before it is stored, never after, because a token that
 * is refused must not become the connection - the screen after it would show a
 * house with no doors and no reason given.
 *
 * `history` and `probe` are optional because they are genuinely optional. Not
 * every make keeps a log worth reading, and not every make can be told to go and
 * ask a device to speak up. A driver that cannot do either is a driver, not a
 * broken one.
 */
export interface DeviceDriver {
    /** The connection id from the registry this implements. */
    readonly connection: string;
    verify(credentials: Credentials): Promise<void>;
    list(credentials: Credentials): Promise<DeviceSnapshot[]>;
    history?(credentials: Credentials, limit: number): Promise<DeviceHistoryEntry[]>;
    /**
     * Ask the devices to report where they are, rather than reading what was last
     * heard from them.
     *
     * Only ever called because somebody pressed something. On a lock this means
     * waking it over its radio, which is what empties its battery - a driver that
     * let a timer do this would flatten a door in a month.
     */
    probe?(credentials: Credentials, externalIds: readonly string[]): Promise<void>;
    act(
        credentials: Credentials,
        device: { readonly externalId: string; readonly kind: string },
        action: DeviceAction
    ): Promise<void>;
}
