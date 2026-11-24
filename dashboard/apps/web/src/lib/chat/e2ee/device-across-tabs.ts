/**
 * One browser's MLS device, shared by every tab of it (docs/chat-e2ee-mls.md,
 * "A device").
 *
 * Every tab of a browser opens the same device: one store in IndexedDB, one
 * leaf in each group. Each tab holds the member in memory, so two tabs that
 * act on it in turn each act on a copy the other has moved past: a tab that
 * missed the other's commit sends into an epoch the group has left, finds
 * itself out of its own group and rejoins, and two at once would both write
 * their copy over the store. So every operation takes the device's Web Lock
 * (one holder across the browser at a time), and a tab that finds the store
 * written by another since its own last operation opens the device again from
 * it before it acts. The store's writes are what move the generation, noted
 * beside the device in localStorage, so reading tabs never make the others
 * reload.
 *
 * Without the Web Locks API (an old browser, or a page served over plain
 * HTTP, where it is not offered) the operations of one tab still run one at a
 * time and each still starts from the newest store; only two tabs acting in
 * the same instant can meet, as before this.
 */

import type { MlsDevice, MlsDeviceStore } from "./mls-client";

const LOCK = "polaris-mls/device/";
const GENERATION = "polaris-mls/generation/";

/**
 * The calls that take no lock: two answer at once from the shared notes, and
 * reading sealed messages touches no group state (only the delivery route and
 * the history keys kept in their own store), so a page's first messages never
 * wait behind another tab's send.
 */
const AT_ONCE = new Set<PropertyKey>(["hasGroup", "groupOf", "readSealed", "openVersions"]);

/** What this needs of the browser: `navigator.locks` and `localStorage`, or stand-ins. */
export interface TabsEnvironment {
    readonly locks?: Pick<LockManager, "request"> | null;
    readonly notes: Pick<Storage, "getItem" | "setItem">;
    readonly token?: () => string;
}

/** The store, with every write noted as a new generation of the device. */
function noting(store: MlsDeviceStore, wrote: () => void): MlsDeviceStore {
    return {
        load: () => store.load(),
        commit: async (changes, messages) => {
            wrote();
            return store.commit(changes, messages);
        },
        sent: async (id) => {
            wrote();
            return store.sent(id);
        }
    };
}

/**
 * Open `device` for this tab, every operation held under the browser-wide lock
 * and run on the newest copy of its store. `open` builds the device over the
 * store it is handed; `prepare` runs once, under the lock, after the first open
 * (registering it).
 */
export async function deviceAcrossTabs(
    device: string,
    store: MlsDeviceStore,
    open: (store: MlsDeviceStore) => Promise<MlsDevice>,
    environment: TabsEnvironment,
    prepare?: (device: MlsDevice) => Promise<void>
): Promise<MlsDevice> {
    const key = GENERATION + device;
    const token = environment.token ?? (() => crypto.randomUUID());
    let wrote = false;
    const tracked = noting(store, () => {
        wrote = true;
    });
    let current: MlsDevice | null = null;
    let seen: string | null = null;
    // One at a time within this tab too: Web Locks queue a tab behind itself,
    // and the fallback is this chain alone.
    let chain: Promise<unknown> = Promise.resolve();

    const held = <T>(work: () => Promise<T>): Promise<T> => {
        const locks = environment.locks;
        if (locks) return locks.request(LOCK + device, { mode: "exclusive" }, work) as Promise<T>;
        const next = chain.then(work, work);
        chain = next.catch(() => undefined);
        return next;
    };

    const turn = <T>(work: (device: MlsDevice) => Promise<T>): Promise<T> =>
        held(async () => {
            wrote = false;
            try {
                const generation = environment.notes.getItem(key);
                // Opening resends what an earlier run left unsent, which writes too.
                if (!current || generation !== seen) {
                    current = await open(tracked);
                    seen = generation;
                }
                return await work(current);
            } finally {
                // Moved only by a write, so a tab that only read leaves the others as they are.
                if (wrote) {
                    seen = token();
                    environment.notes.setItem(key, seen);
                }
            }
        });

    await turn(async (opened) => {
        await prepare?.(opened);
    });

    return new Proxy({} as MlsDevice, {
        get(_target, property) {
            const live = current as MlsDevice;
            const value = Reflect.get(live, property, live) as unknown;
            if (typeof value !== "function") return value;
            if (AT_ONCE.has(property)) return (value as (...args: unknown[]) => unknown).bind(live);
            return (...args: unknown[]) =>
                turn((opened) => (Reflect.get(opened, property, opened) as (...args: unknown[]) => Promise<unknown>).apply(opened, args));
        }
    });
}
