/**
 * The makes Polaris can talk to, and the ways in that each of them has.
 *
 * A make is not enough to connect anything, for the same reason a make is not
 * enough to add a camera. "Nuki" is a web account reachable from another country,
 * a box on the same network that answers in a few milliseconds, and a lock that
 * speaks to a broker on its own LAN - three different credentials, three
 * different failure modes, and a choice their owner is the only one who can make.
 * Anything that picked one for them would be right for some houses and silently
 * wrong for the rest.
 *
 * So a connection is what is chosen, not a brand: what it is called, what it
 * reaches, what it costs, and exactly which fields it needs. The screen draws the
 * fields from here, the schema validates them from here, and the driver is handed
 * them by name - so a fourth way in is an entry and a driver, and no form.
 *
 * Ordered best first within a brand, and "best" is stated rather than implied:
 * what reaches the device from anywhere, what keeps working when somebody else's
 * server is down, and what does not cost battery are not the same thing, and the
 * note on each says which of those it is trading away. More than one at once is
 * the normal case rather than the exception - a lock on the web account and on
 * its own bridge is a lock that still answers when either is out.
 *
 * Pure and client-safe: the picker and the server read the same list.
 */

import type { DeviceKind } from "@/lib/home/device-kinds";

/** One thing a connection has to be told. */
export interface ConnectionField {
    /** Stored under this name and handed to the driver under it. */
    readonly key: string;
    readonly label: string;
    /** What it is and where it comes from, in one line under the field. */
    readonly hint?: string;
    readonly placeholder?: string;
    /**
     * Whether it is a credential.
     *
     * A secret field is typed into a password box, is never read back to any
     * screen, and is the reason the whole set is encrypted at rest. An address is
     * not a secret and is shown, because "which bridge is this pointed at" is a
     * question somebody has to be able to answer without disconnecting it.
     */
    readonly secret?: boolean;
    readonly optional?: boolean;
    readonly minLength?: number;
    readonly maxLength?: number;
    /** A fixed set to pick from, where there is one. */
    readonly choices?: readonly { readonly value: string; readonly label: string }[];
    readonly defaultValue?: string;
}

/** Where a connection reaches from, which is the first thing anybody wants to
 *  know and the thing that decides whether it is any use to them. */
export type ConnectionReach = "anywhere" | "same-network";

export const REACH_LABELS: Readonly<Record<ConnectionReach, string>> = {
    anywhere: "From anywhere",
    "same-network": "On the same network"
};

/** One way of reaching one make's devices. */
export interface DeviceConnection {
    /** Stored on the account row. Never shown. */
    readonly id: string;
    /** Who makes the devices, as their owner would say it. */
    readonly brand: string;
    /** What this way in is called, in the maker's own words where they have one -
     *  somebody looking for it in their documentation has to find the same name. */
    readonly label: string;
    readonly reach: ConnectionReach;
    /** One sentence in the picker: what it is and what it costs. */
    readonly summary: string;
    /** What its owner has to know before choosing it, where that is more than a
     *  sentence. */
    readonly note?: string;
    /** How to get what it asks for, where that part is genuinely not Polaris' to
     *  do - a token made in somebody else's console. */
    readonly steps?: readonly string[];
    readonly link?: { readonly label: string; readonly href: string };
    readonly fields: readonly ConnectionField[];
    /** What it can bring in, so a screen can say so before anything is typed. */
    readonly kinds: readonly DeviceKind[];
    /** Other words somebody might search for - the product it is part of, the
     *  name on the box, the way it is written in a forum. */
    readonly search?: readonly string[];
}

const NUKI_TOKEN_PAGE = "https://web.nuki.io/#/admin/web-api";

/**
 * Every way in, best first within each brand.
 *
 * A method is listed here when Polaris can actually use it. A picker that offered
 * something unbuilt would be a screen sending somebody to fetch a credential for
 * a connection that cannot be made.
 */
export const DEVICE_CONNECTIONS: readonly DeviceConnection[] = [
    {
        id: "nuki-web",
        brand: "Nuki",
        label: "Nuki Web account",
        reach: "anywhere",
        summary:
            "One token for every lock on the account, and it answers from another country as readily as from the next room.",
        note: "Everything goes through Nuki's own servers, so it is as reachable as they are and the state it reports is as recent as the last time a lock spoke to them. Checking again asks the locks themselves, which is why that is a button rather than a timer.",
        steps: [
            "Open Nuki Web and sign in with the account the locks are on.",
            "Under API, create a token that may see and operate your Smart Locks.",
            "Paste it here. Nuki shows it once."
        ],
        link: { label: "Nuki Web", href: NUKI_TOKEN_PAGE },
        fields: [
            {
                key: "token",
                label: "API token",
                placeholder: "Paste the token",
                secret: true,
                minLength: 20,
                maxLength: 500
            }
        ],
        kinds: ["lock", "opener"],
        search: ["smart lock", "opener", "smart door", "web api"]
    }
];

export function deviceConnection(id: string): DeviceConnection | null {
    return DEVICE_CONNECTIONS.find((connection) => connection.id === id) ?? null;
}

/** The brands, in the order their first connection appears, with how many ways in
 *  each has. A brand with two is worth saying so before it is opened. */
export function deviceBrands(): readonly { readonly brand: string; readonly count: number }[] {
    const counts = new Map<string, number>();
    for (const connection of DEVICE_CONNECTIONS) {
        counts.set(connection.brand, (counts.get(connection.brand) ?? 0) + 1);
    }
    return [...counts].map(([brand, count]) => ({ brand, count }));
}

export function connectionsOfBrand(brand: string): readonly DeviceConnection[] {
    return DEVICE_CONNECTIONS.filter((connection) => connection.brand === brand);
}

/**
 * What somebody typed, against everything worth matching.
 *
 * The brand, the name of the method, and the words its owner would use for it -
 * "smart lock" has to find Nuki, because nobody thinks of what they bought by the
 * name of its API.
 */
export function searchConnections(query: string): readonly DeviceConnection[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return DEVICE_CONNECTIONS;
    return DEVICE_CONNECTIONS.filter((connection) =>
        [connection.brand, connection.label, ...(connection.search ?? [])]
            .join(" ")
            .toLowerCase()
            .includes(needle)
    );
}

/** The fields of a connection that may be shown again once it is stored. What is
 *  left is the credential, and there is no screen anywhere that reads one back. */
export function shownFields(connection: DeviceConnection): readonly ConnectionField[] {
    return connection.fields.filter((field) => field.secret !== true);
}

/**
 * What is wrong with one field, or nothing.
 *
 * An empty required field is not "invalid" - it is unfinished, and saying "that
 * does not look like a token" over a box nobody has typed in yet is telling
 * somebody off for not having finished. So emptiness is left to the submit button
 * being unavailable, and this only ever complains about something actually typed.
 */
export function fieldIssue(field: ConnectionField, value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (field.minLength !== undefined && trimmed.length < field.minLength) {
        return `That looks too short to be the ${field.label.toLowerCase()}`;
    }
    if (field.maxLength !== undefined && trimmed.length > field.maxLength) {
        return `That is longer than the ${field.label.toLowerCase()} can be`;
    }
    if (field.choices && !field.choices.some((choice) => choice.value === trimmed)) {
        return "Pick one of the listed options";
    }
    return null;
}

/** Whether everything a connection needs has been given, and given validly. The
 *  same answer on the client, where it decides whether the button is available,
 *  and on the server, where it decides whether anything is stored. */
export function fieldsComplete(
    connection: DeviceConnection,
    fields: Readonly<Record<string, string>>
): boolean {
    return connection.fields.every((field) => {
        const value = (fields[field.key] ?? field.defaultValue ?? "").trim();
        if (!value) return field.optional === true;
        return fieldIssue(field, value) === null;
    });
}

/**
 * The fields as they should be stored: trimmed, defaults filled in, and nothing
 * the connection did not ask for.
 *
 * The last part is the one that matters. What arrives is somebody else's object,
 * and a driver reads what it is handed by name - so anything not on the
 * connection's own list is dropped here rather than encrypted and kept forever.
 */
export function normalizeFields(
    connection: DeviceConnection,
    fields: Readonly<Record<string, unknown>>
): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const field of connection.fields) {
        const raw = fields[field.key];
        const value = (typeof raw === "string" ? raw : "").trim() || field.defaultValue || "";
        if (value) clean[field.key] = value;
    }
    return clean;
}
