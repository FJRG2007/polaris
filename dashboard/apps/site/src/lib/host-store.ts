/**
 * The Polaris addresses a reader keeps for the examples: several, each with an
 * optional name, one of them in use. Stored in this browser in the same file
 * form the desktop app and the extension export, so it is read back through the
 * shared host-list codec and every row is re-checked on the way in.
 */

import { z } from "zod";
import {
    HOST_LIST_MAX,
    HOST_NAME_MAX,
    hostListFile,
    mergeHostLists,
    readHostList,
    type PortableHost
} from "@polaris/core";

export type SavedHost = PortableHost;

export interface HostState {
    readonly hosts: readonly SavedHost[];
    /** The origin the examples use, always one of `hosts`, or null for the placeholder. */
    readonly active: string | null;
}

export const EMPTY_HOSTS: HostState = { hosts: [], active: null };

/** Where the list and the one in use are kept. */
export const HOSTS_KEY = "polaris-site-hosts";
export const ACTIVE_KEY = "polaris-site-host-active";
/** The single address an earlier version of the site kept; read once, then moved into the list. */
export const LEGACY_KEY = "polaris-site-host";

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * An address as typed, normalized and checked: trimmed, https added to a bare
 * host, and only a bare http(s) origin accepted - no path, query, fragment or
 * credentials. The result is the origin (`https://polaris.home.lan`).
 */
export const hostAddressSchema = z
    .string()
    .trim()
    .min(1)
    .max(253)
    .refine((text) => !/\s/.test(text))
    .transform((text, ctx) => {
        let url: URL;
        try {
            url = new URL(SCHEME.test(text) ? text : `https://${text}`);
        } catch {
            ctx.addIssue({ code: "custom", message: "not an address" });
            return z.NEVER;
        }
        const plain =
            (url.protocol === "https:" || url.protocol === "http:") &&
            !url.username &&
            !url.password &&
            url.pathname === "/" &&
            !url.search &&
            !url.hash &&
            /^[a-z0-9.\-[\]:]+$/i.test(url.hostname);
        if (!plain) {
            ctx.addIssue({ code: "custom", message: "not an origin" });
            return z.NEVER;
        }
        return url.origin;
    });

/** A host's name: spaces collapsed and trimmed, empty meaning none. */
export const hostNameSchema = z
    .string()
    .transform((text) => text.replace(/\s+/g, " ").trim())
    .pipe(z.string().max(HOST_NAME_MAX))
    .transform((text) => (text === "" ? null : text));

/** The address as an origin, or null when it is not one. */
export function parseHostAddress(typed: string): string | null {
    const parsed = hostAddressSchema.safeParse(typed);
    return parsed.success ? parsed.data : null;
}

/** What a host is called on screen: its name, or the address without https. */
export function hostLabel(host: SavedHost): string {
    return host.name ?? host.origin.replace(/^https:\/\//, "");
}

/** The subset of `Storage` this reads and writes, so tests can pass their own. */
export type HostStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * The saved hosts. A list from before this version (one address) becomes a
 * list of one, in use. Anything unreadable is treated as nothing saved.
 */
export function loadHosts(storage: HostStorage): HostState {
    const raw = storage.getItem(HOSTS_KEY);
    let hosts: SavedHost[] = raw ? (readHostList(raw) ?? []) : [];
    let active = storage.getItem(ACTIVE_KEY);
    const legacy = storage.getItem(LEGACY_KEY);
    if (legacy !== null) {
        const origin = parseHostAddress(legacy);
        if (origin) {
            hosts = mergeHostLists(hosts, [{ origin, name: null }], HOST_LIST_MAX).hosts;
            active ??= origin;
        }
    }
    if (!hosts.some((host) => host.origin === active)) active = null;
    return { hosts, active };
}

/** Writes the hosts back and retires the old single-address key. */
export function saveHosts(storage: HostStorage, state: HostState): void {
    if (state.hosts.length) storage.setItem(HOSTS_KEY, hostListFile(state.hosts));
    else storage.removeItem(HOSTS_KEY);
    if (state.active) storage.setItem(ACTIVE_KEY, state.active);
    else storage.removeItem(ACTIVE_KEY);
    storage.removeItem(LEGACY_KEY);
}

export type AddResult =
    | { ok: true; state: HostState }
    | { ok: false; reason: "invalid" | "duplicate" | "full" };

/** The list with a new host, which becomes the one in use. */
export function addHost(state: HostState, address: string, name: string): AddResult {
    const origin = parseHostAddress(address);
    if (!origin) return { ok: false, reason: "invalid" };
    if (state.hosts.some((host) => host.origin === origin)) return { ok: false, reason: "duplicate" };
    if (state.hosts.length >= HOST_LIST_MAX) return { ok: false, reason: "full" };
    const named = hostNameSchema.safeParse(name);
    const host = { origin, name: named.success ? named.data : null };
    return { ok: true, state: { hosts: [...state.hosts, host], active: origin } };
}

export function renameHost(state: HostState, origin: string, name: string): HostState {
    const named = hostNameSchema.safeParse(name);
    if (!named.success) return state;
    return {
        ...state,
        hosts: state.hosts.map((host) =>
            host.origin === origin ? { origin, name: named.data } : host
        )
    };
}

/** The list without a host; removing the one in use moves to the next one left, if any. */
export function removeHost(state: HostState, origin: string): HostState {
    const at = state.hosts.findIndex((host) => host.origin === origin);
    if (at < 0) return state;
    const hosts = state.hosts.filter((host) => host.origin !== origin);
    const active =
        state.active === origin
            ? (hosts[Math.min(at, hosts.length - 1)]?.origin ?? null)
            : state.active;
    return { hosts, active };
}

/** Which one the examples use; null goes back to the placeholder. */
export function pickHost(state: HostState, origin: string | null): HostState {
    if (origin !== null && !state.hosts.some((host) => host.origin === origin)) return state;
    return { ...state, active: origin };
}
