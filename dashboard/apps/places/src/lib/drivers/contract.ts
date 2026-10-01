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

import type {
    AirSettings,
    ApplianceView,
    ClimateSettings,
    DeviceCommand,
    DeviceAction,
    DeviceKind,
    DeviceState,
    DoorState
} from "../device-kinds";

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
    /** How an air conditioner is set and what it can be set to. Its room
     *  temperature is `value`, in `unit`, like any other thermometer's. */
    readonly climate?: ClimateSettings | null;
    /** How a purifier or humidifier is set, what it can be set to and what it
     *  measures. Its headline figure is also `value`, in `unit`. */
    readonly air?: AirSettings | null;
    /** What a kitchen appliance is doing, as far as it says. */
    readonly appliance?: ApplianceView | null;
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
 * One attempt at pairing, as it was started.
 *
 * `state` travels to the browser and comes back with every poll, so the server
 * keeps nothing between the two and a restart in the middle loses nothing. The
 * price is the rule: it is shown to whoever is pairing, so it never holds a
 * secret - a token for a code on the screen, an address, never a credential.
 */
export interface PairingStart {
    readonly state: Readonly<Record<string, string>>;
    /** What the code on the screen says, for a pairing that is scanned. */
    readonly qr?: string;
}

/**
 * A step a pairing needs before it can finish, beyond the one it started with:
 * a file somebody has to upload. `state` replaces what the dialog sends back on
 * the next poll; `summary` is what the attempt saw so far, in words with
 * nothing private in them; `skippable` says the attempt can also finish
 * without the step.
 */
export interface PairingNext {
    readonly step: "file";
    readonly state: Readonly<Record<string, string>>;
    readonly summary: string;
    readonly skippable: boolean;
}

/** Whether the other side has said yes yet. Not yet is the normal answer, asked
 *  again a few seconds later until the attempt runs out - or a step of its own
 *  that the dialog draws before asking again. */
export type PairingPoll =
    | { readonly done: false; readonly next?: PairingNext }
    | {
          readonly done: true;
          readonly credentials: Credentials;
          /** Model codes found that are listed but cannot be fully operated
           *  yet, for the dialog to name rather than leave to be discovered. */
          readonly unsupported?: readonly string[];
      };

/**
 * Connecting by something somebody does rather than something they type: a code
 * scanned with an app, a button pressed on a bridge.
 *
 * `start` is handed the connection's typed fields (a user code, a bridge's
 * address) and begins the attempt; `poll` asks whether it has been accepted and,
 * once it has, returns the credentials to store - which are then proved with
 * `verify` exactly like typed ones, so nothing is stored that does not work.
 */
export interface DevicePairing {
    start(fields: Credentials): Promise<PairingStart>;
    poll(fields: Credentials, state: Readonly<Record<string, string>>): Promise<PairingPoll>;
    /**
     * Read a file uploaded at a `file` step (`PairingNext`), from the path it
     * was saved to, and answer what to add to the state for the next poll.
     * What it reads stays on the server and comes back as a handle
     * (`pairing-vault.ts`): the state is shown to the browser.
     * The file is deleted by the caller as soon as this returns.
     */
    file?(path: string): Promise<Readonly<Record<string, string>>>;
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
    /**
     * Prove the credentials, and hand back what to store where proving them
     * produced something new.
     *
     * Most drivers return nothing and what was typed is what is kept. A bridge
     * paired with a button is the exception: what was typed is an address, and
     * what the bridge handed back once its button was pressed - a key, the
     * certificate it answered with - is what every later call needs. Pairing
     * lives here, inside the driver, so the form stays a list of fields.
     */
    verify(credentials: Credentials): Promise<Credentials | void>;
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
        action: DeviceAction,
        /** What to set, for the actions that set something - a mode, a
         *  temperature. Already checked against the unit's own settings, and
         *  always the device's own kind's. */
        command?: DeviceCommand
    ): Promise<void>;
    /** Present on a connection made by pairing rather than by typing. */
    readonly pair?: DevicePairing;
    /**
     * Credentials that age: a sign-in whose token lapses and is traded for a new
     * one. Handed what is stored before every use; answers the replacement once
     * the old one is close to its end, and null while it is still good. The
     * account layer stores what comes back, so a driver never writes anything.
     */
    renew?(credentials: Credentials): Promise<Credentials | null>;
    /** Tell the other side this connection is gone, where it keeps a sign-in of
     *  its own. Best effort: the account is removed whether or not it answers. */
    forget?(credentials: Credentials): Promise<void>;
}
