/**
 * The rows of a sessions screen gathered under the computer they run on.
 *
 * Only by evidence a client reported about its own computer, never by where it
 * connected from. Three kinds of it join two rows:
 *
 * - **The same device key.** Polaris Desktop on every request, and the command
 *   line and the Stream Deck plugin at sign-in, send a hashed machine id (see
 *   `@polaris/core` `device-identity`) that the server turned into a per-account
 *   key.
 * - **The same computer name on the same system.** The desktop app, the command
 *   line and the Stream Deck plugin report the computer's own hostname, and did
 *   so before the device key existed - which is what places a terminal or a deck
 *   signed in by an older release beside the desktop app on the same machine.
 *   Two computers of one account that share a name and a system read as one; the
 *   device panel says so.
 * - **The extension and the browser that let it in.** The extension opens the
 *   approval page in a tab of its own browser, so the session that approved it
 *   is that browser - when it is still signed in and reads as the same browser
 *   on the same system. An approval made somewhere else (a phone) never matches.
 *
 * An address never groups anything, alone or with a system: two people behind
 * one router would land on one "device", and a "sign out this device" press
 * would reach the other person's rows. That reading is `./machines`' badge.
 * A row with none of the above stays on its own.
 *
 * Shared by server and client code.
 */

/** What a row says about the device it runs on. */
export interface DeviceMember {
    readonly id: string;
    readonly deviceKey: string | null;
    /** The computer's name, where the client reported one. Never a browser's
     *  or a user's label: only a hostname a native client read itself. */
    readonly name: string | null;
    readonly os: string;
    /** The browser it is, for a browser session or an extension. */
    readonly browser?: string | null;
    /** The row this one is known to share a browser with: the session that
     *  approved an extension. Joins only when both read as the same browser
     *  on the same system. */
    readonly sameBrowserAs?: string | null;
    /** The last time it was used, when known. */
    readonly lastSeenAt: string | null;
    /** The reader's own session. */
    readonly current?: boolean;
}

/** One device and the rows on it. */
export interface DeviceGroup {
    /** A device key of the group where it has one, otherwise `row:` and the id
     *  of its first member - what a press hands back to name the group. */
    readonly key: string;
    readonly name: string | null;
    readonly os: string | null;
    readonly lastSeenAt: string | null;
    /** Whether the reader is using this device right now. */
    readonly here: boolean;
    /** Row ids, in the order they were given. */
    readonly memberIds: readonly string[];
    /** Every device key its rows claimed. Empty when nothing on it can be
     *  blocked: a block is held against a key. */
    readonly deviceKeys: readonly string[];
}

/** A group key, as a press hands it back. */
export const DEVICE_GROUP_KEY_PATTERN = /^(?:[a-f0-9]{64}|row:[A-Za-z0-9_-]{1,80})$/;

/** The parser's word for a system it could not read; never a device's name. */
const UNKNOWN_OS = "Unknown OS"; // i18n-ignore the parser's own word for it

/** The first word, lowercased - "Windows 11" and "Windows" are one system,
 *  "Brave 158" and "Brave" one browser. Empty for an unknown one. */
function family(value: string | null | undefined): string {
    if (!value || value === UNKNOWN_OS) return "";
    return value.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** Every device with a row on it, most recently active first. A device with a
 *  single row is listed only when that row claimed a device key. */
export function groupByDevice(members: readonly DeviceMember[]): DeviceGroup[] {
    const parent = members.map((_, index) => index);
    const root = (index: number): number => {
        let at = index;
        while (parent[at] !== at) at = parent[at] = parent[parent[at]!]!;
        return at;
    };
    const join = (a: number, b: number) => {
        const [ra, rb] = [root(a), root(b)];
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    };

    const firstBy = new Map<string, number>();
    const index = new Map(members.map((member, at) => [member.id, at]));
    members.forEach((member, at) => {
        const os = family(member.os);
        const claims = [
            member.deviceKey ? `key ${member.deviceKey}` : null,
            member.name?.trim() && os ? `name ${os} ${member.name.trim().toLowerCase()}` : null
        ];
        for (const claim of claims) {
            if (!claim) continue;
            const seen = firstBy.get(claim);
            if (seen === undefined) firstBy.set(claim, at);
            else join(seen, at);
        }
        const other = member.sameBrowserAs ? index.get(member.sameBrowserAs) : undefined;
        if (other === undefined) return;
        const peer = members[other]!;
        const sameSystem = os !== "" && os === family(peer.os);
        const browser = family(member.browser);
        if (sameSystem && browser !== "" && browser === family(peer.browser)) join(at, other);
    });

    const byRoot = new Map<number, DeviceMember[]>();
    members.forEach((member, at) => {
        const key = root(at);
        byRoot.set(key, [...(byRoot.get(key) ?? []), member]);
    });

    const groups: DeviceGroup[] = [];
    for (const rows of byRoot.values()) {
        const deviceKeys = [
            ...new Set(rows.map((row) => row.deviceKey).filter((key): key is string => !!key))
        ];
        if (rows.length < 2 && deviceKeys.length === 0) continue;
        const lastSeenAt =
            rows
                .map((row) => row.lastSeenAt)
                .filter((value): value is string => value !== null)
                .sort()
                .at(-1) ?? null;
        groups.push({
            key: deviceKeys[0] ?? `row:${rows[0]!.id}`,
            name: rows.find((row) => row.name?.trim())?.name?.trim() ?? null,
            os: rows.find((row) => row.os && row.os !== UNKNOWN_OS)?.os ?? null,
            lastSeenAt,
            here: rows.some((row) => row.current === true),
            memberIds: rows.map((row) => row.id),
            deviceKeys
        });
    }
    return groups.sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""));
}

/** The three lists a sessions screen holds, as far as grouping reads them. */
export interface DeviceRowLists {
    readonly sessions: readonly {
        readonly id: string;
        readonly deviceKey: string | null;
        readonly deviceName: string | null;
        readonly os: string;
        readonly browser: string;
        readonly lastSeenAt: string;
        readonly current: boolean;
    }[];
    readonly deviceSessions?: readonly {
        readonly id: string;
        readonly deviceKey: string | null;
        readonly hostname: string | null;
        readonly os: string;
        readonly lastUsedAt: string | null;
        readonly createdAt: string;
    }[];
    readonly extensions?: readonly {
        readonly id: string;
        readonly os: string;
        readonly browser: string;
        readonly lastSeenAt: string;
        readonly approvedBySessionId?: string | null;
    }[];
}

/** Every row of a sessions screen as a device member - one mapping, so the
 *  screen and the server action that ends a group read the same groups. */
export function deviceMembers(lists: DeviceRowLists): DeviceMember[] {
    return [
        ...lists.sessions.map((session) => ({
            id: session.id,
            deviceKey: session.deviceKey,
            name: session.deviceName,
            os: session.os,
            browser: session.browser,
            lastSeenAt: session.lastSeenAt,
            current: session.current
        })),
        ...(lists.deviceSessions ?? []).map((device) => ({
            id: device.id,
            deviceKey: device.deviceKey,
            name: device.hostname,
            os: device.os,
            lastSeenAt: device.lastUsedAt ?? device.createdAt
        })),
        ...(lists.extensions ?? []).map((extension) => ({
            id: extension.id,
            deviceKey: null,
            name: null,
            os: extension.os,
            browser: extension.browser,
            sameBrowserAs: extension.approvedBySessionId ?? null,
            lastSeenAt: extension.lastSeenAt
        }))
    ];
}
