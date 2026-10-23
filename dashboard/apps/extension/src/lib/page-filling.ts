/**
 * Whether Polaris draws anything inside web pages at all, and the sites it has
 * been shut out of.
 *
 * Two keys in the browser's local area, read here straight from it rather than
 * through WXT's storage items so the settings screen, which a test draws with no
 * WXT, can use them too. The worker defines items under the same names; the
 * names are the contract.
 *
 * Off means the inline script is not registered anywhere: no mark under a login
 * box, no generator on a sign-up form, no offer to save. The popup and the fill
 * shortcut keep working, because those are asked for every time.
 */

/** On unless somebody turned it off. */
export const PAGE_FILLING_KEY = "local:inline.enabled";
/** Hosts somebody said "never on this site" for. */
export const BLOCKED_HOSTS_KEY = "local:blocked.hosts";

interface LocalArea {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
}

const localArea = (api: unknown): LocalArea | undefined =>
    (api as { storage?: { local?: LocalArea } }).storage?.local;

const nameOf = (key: string): string => key.slice("local:".length);

export interface PageFilling {
    readonly on: boolean;
    readonly blocked: readonly string[];
}

/** What is stored, with the defaults for anything missing or malformed. */
export function readPageFillingValues(on: unknown, blocked: unknown): PageFilling {
    return {
        on: on !== false,
        blocked: Array.isArray(blocked)
            ? blocked.filter((host): host is string => typeof host === "string" && host !== "")
            : []
    };
}

export async function readPageFilling(api: unknown): Promise<PageFilling> {
    const area = localArea(api);
    const [on, blocked] = await Promise.all([
        area?.get(nameOf(PAGE_FILLING_KEY)).catch(() => ({})) ?? {},
        area?.get(nameOf(BLOCKED_HOSTS_KEY)).catch(() => ({})) ?? {}
    ]);
    return readPageFillingValues(
        (on as Record<string, unknown>)[nameOf(PAGE_FILLING_KEY)],
        (blocked as Record<string, unknown>)[nameOf(BLOCKED_HOSTS_KEY)]
    );
}

export async function savePageFilling(api: unknown, on: boolean): Promise<void> {
    await localArea(api)?.set({ [nameOf(PAGE_FILLING_KEY)]: on });
}

/** Let one site back in. Returns the list as it now stands. */
export async function unblockHost(api: unknown, host: string): Promise<string[]> {
    const { blocked } = await readPageFilling(api);
    const left = blocked.filter((entry) => entry !== host);
    await localArea(api)?.set({ [nameOf(BLOCKED_HOSTS_KEY)]: left });
    return left;
}
