/**
 * This browser's MLS device (docs/chat-e2ee-mls.md): the WebAssembly member
 * from public/core-rs/mls (staged by scripts/copy-core-rs-assets.mjs), its
 * state in IndexedDB, small public notes in localStorage and the delivery route
 * as transport. Nothing is fetched until `openBrowserDevice` is called, and no
 * screen calls it while `chatE2eeEnabled()` is off.
 */

import { IndexedDbMlsStore } from "@polaris/core-rs/mls-store";
import { fetchTransport, MlsDevice, type MlsMemberClass } from "./mls-client";

const BASE = "/core-rs/mls/";
const DEVICE_NOTE = "polaris-mls/device/";

let loading: Promise<MlsMemberClass> | null = null;

/** The WebAssembly `MlsMember`, loaded once per page. */
export function loadMlsMember(): Promise<MlsMemberClass> {
    loading ??= (async () => {
        const response = await fetch(`${BASE}manifest.json`, { cache: "no-cache" });
        if (!response.ok) throw new Error("this build ships without the MLS WebAssembly binding");
        const manifest = (await response.json()) as { glue: string; wasm: string };
        const glue = (await import(/* webpackIgnore: true */ /* @vite-ignore */ `${BASE}${manifest.glue}`)) as {
            default(input: { module_or_path: string }): Promise<unknown>;
            MlsMember: MlsMemberClass;
        };
        await glue.default({ module_or_path: `${BASE}${manifest.wasm}` });
        return glue.MlsMember;
    })().catch((caught: unknown) => {
        loading = null;
        throw caught;
    });
    return loading;
}

/** This browser's device id for the account: made once, kept beside its store. */
export function browserDeviceId(userId: string): string {
    const key = DEVICE_NOTE + userId;
    const known = localStorage.getItem(key);
    if (known) return known;
    const made = crypto.randomUUID().replaceAll("-", "");
    localStorage.setItem(key, made);
    return made;
}

/** Open (and register) this browser's device for the signed-in account. */
export async function openBrowserDevice(userId: string): Promise<MlsDevice> {
    const device = browserDeviceId(userId);
    const [MlsMember, store] = await Promise.all([loadMlsMember(), IndexedDbMlsStore.open(device)]);
    const opened = await MlsDevice.open({ userId, device, MlsMember, store, notes: localStorage, transport: fetchTransport() });
    await opened.register();
    return opened;
}
