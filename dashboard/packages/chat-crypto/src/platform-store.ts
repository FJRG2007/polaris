/**
 * The device lock under the platform's own key store (docs/chat-e2ee-phase1.md,
 * "Native key stores"; proposal 3.1 and 12).
 *
 * A non-extractable WebCrypto key only stops script from exporting it: the
 * browser still writes its bytes into the profile on disk, so a copied profile
 * opens the device lock. Where the page runs inside a Polaris app, the app
 * offers a second wrap held by the operating system - DPAPI, the macOS
 * Keychain or the Linux secret service through Electron's `safeStorage` on
 * the desktop, an Android Keystore key in the Android app, the Keychain in the
 * iOS app - and the envelope is stored only under it. A copied profile then
 * opens nothing without the operating system account that sealed it.
 *
 * Plain browsers have no such store and keep the IndexedDB device lock as it
 * was (the web fallback the proposal defines). Nothing here can make a key
 * unreachable for good: a platform wrap that no longer opens (a reinstalled
 * system, a reset keychain) reads as "no device copy", and the account key
 * comes back from the password, a passkey or another device.
 */

import type { DeviceLockRecord, DeviceLockStore } from "./device-lock";

/** The most an app's wrap is ever asked to seal: one lock envelope. */
export const PLATFORM_WRAP_MAX_BYTES = 1024;

/**
 * What a Polaris app hands the page. Both calls answer null for anything they
 * cannot do - a store that is locked, a sealed value from another install - and
 * never throw at the caller on purpose.
 */
export interface PlatformKeyWrap {
    /** A short name for the store, for the record and the tests. */
    readonly name: string;
    seal(plain: Uint8Array): Promise<Uint8Array | null>;
    open(sealed: Uint8Array): Promise<Uint8Array | null>;
}

/** A record as kept: the envelope sealed by the platform, and which one. */
interface SealedRecord extends DeviceLockRecord {
    readonly platform?: string;
}

/**
 * A device lock store whose envelopes are sealed by the platform's wrap before
 * they reach the inner store.
 *
 * A record the inner store kept before the app offered a wrap is read as it
 * is and immediately re-written under the wrap, so existing installs move on
 * their next read with nothing to do. A record sealed by another wrap than the
 * one offered now, or that the wrap refuses, is no device copy at all.
 */
export function platformSealedStore(inner: DeviceLockStore, wrap: PlatformKeyWrap): DeviceLockStore {
    async function sealed(record: DeviceLockRecord): Promise<SealedRecord> {
        if (record.envelope.length > PLATFORM_WRAP_MAX_BYTES) throw new RangeError("A device lock envelope is too large");
        const envelope = await wrap.seal(record.envelope);
        if (!envelope || envelope.length === 0) throw new Error("The platform key store refused to seal");
        return { key: record.key, akVersion: record.akVersion, envelope: Uint8Array.from(envelope), platform: wrap.name };
    }

    return {
        async read(userId) {
            const record = (await inner.read(userId)) as SealedRecord | null;
            if (!record) return null;
            if (record.platform === undefined) {
                // Kept before this app offered a wrap: move it under the wrap now.
                // A failed move leaves the old record readable, never a lost key.
                try {
                    await inner.write(userId, await sealed(record));
                } catch {
                    // Still the plain record: read it as it is, move it next time.
                }
                return { key: record.key, envelope: record.envelope, akVersion: record.akVersion };
            }
            if (record.platform !== wrap.name) return null;
            const envelope = await wrap.open(record.envelope).catch(() => null);
            if (!envelope || envelope.length === 0) return null;
            return { key: record.key, envelope: Uint8Array.from(envelope), akVersion: record.akVersion };
        },
        async write(userId, record) {
            await inner.write(userId, await sealed(record));
        },
        forget(userId) {
            return inner.forget(userId);
        }
    };
}
