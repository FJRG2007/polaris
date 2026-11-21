/**
 * The rows of a sessions screen gathered under the computer they run on.
 *
 * Only by evidence: a row joins a device when its client reported a device id
 * (Polaris Desktop on every request, the command line and the Stream Deck plugin
 * at sign-in - see `@polaris/core` `device-identity`), which the server turned
 * into a per-account key. Two rows with the same key are one device. A name, an
 * address or a system that happen to match never group anything: those are what
 * `./machines` reads for its badge, and a guess must not decide which rows a
 * "sign out this device" press reaches.
 *
 * A row with no key - every browser, the extension, an app from before the key
 * existed - stays on its own, as it always did.
 *
 * Shared by server and client code.
 */

/** What a row says about the device it runs on. */
export interface DeviceMember {
    readonly id: string;
    readonly deviceKey: string | null;
    /** The computer's name, where the client reported one. */
    readonly name: string | null;
    readonly os: string;
    /** The last time it was used, when known. */
    readonly lastSeenAt: string | null;
    /** The reader's own session. */
    readonly current?: boolean;
}

/** One device and the rows on it. */
export interface DeviceGroup {
    readonly key: string;
    readonly name: string | null;
    readonly os: string | null;
    readonly lastSeenAt: string | null;
    /** Whether the reader is using this device right now. */
    readonly here: boolean;
    /** Row ids, in the order they were given. */
    readonly memberIds: readonly string[];
}

/** The parser's word for a system it could not read; never a device's name. */
const UNKNOWN_OS = "Unknown OS"; // i18n-ignore the parser's own word for it

/** Every device with at least one row, most recently active first. */
export function groupByDevice(members: readonly DeviceMember[]): DeviceGroup[] {
    const byKey = new Map<string, DeviceMember[]>();
    for (const member of members) {
        if (!member.deviceKey) continue;
        byKey.set(member.deviceKey, [...(byKey.get(member.deviceKey) ?? []), member]);
    }
    const groups: DeviceGroup[] = [];
    for (const [key, rows] of byKey) {
        const lastSeenAt =
            rows
                .map((row) => row.lastSeenAt)
                .filter((value): value is string => value !== null)
                .sort()
                .at(-1) ?? null;
        groups.push({
            key,
            name: rows.find((row) => row.name)?.name ?? null,
            os: rows.find((row) => row.os && row.os !== UNKNOWN_OS)?.os ?? null,
            lastSeenAt,
            here: rows.some((row) => row.current === true),
            memberIds: rows.map((row) => row.id)
        });
    }
    return groups.sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""));
}
