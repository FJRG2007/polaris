/**
 * The operating system key store a Polaris app offers the page, when it runs
 * inside one (docs/chat-e2ee-phase1.md, "Native key stores").
 *
 * - Desktop: `window.polarisDesktop.keyWrap`, Electron's `safeStorage` (DPAPI,
 *   the macOS Keychain, the Linux secret service) in the main process.
 * - Android: `window.PolarisKeyStore`, an AES-GCM key held by the Android
 *   Keystore that never leaves it.
 * - iOS: the `polarisKeyStore` script message handler, a key kept in the
 *   Keychain for this device only.
 *
 * Every bridge speaks base64url text and answers null (or "" on Android, whose
 * JavaScript interface cannot return null portably) for anything it cannot do.
 * An app too old to offer one, or a plain browser, yields null here and the
 * device lock stays in IndexedDB as before. The bridge is read once per call
 * and checked for shape; a page cannot be handed a store by anything else.
 */

import * as base64url from "@/lib/chat/e2ee/base64url";
import type { PlatformKeyWrap } from "@polaris/chat-crypto/platform-store";

interface TextWrap {
    seal(data: string): Promise<string | null> | string | null;
    open(sealed: string): Promise<string | null> | string | null;
}

interface PlatformWindow {
    polarisDesktop?: { keyWrap?: TextWrap };
    PolarisKeyStore?: TextWrap;
    webkit?: { messageHandlers?: { polarisKeyStore?: { postMessage(message: unknown): Promise<unknown> } } };
}

const TEXT = /^[A-Za-z0-9_-]{1,4096}$/;

function isTextWrap(value: unknown): value is TextWrap {
    const wrap = value as TextWrap | null | undefined;
    return typeof wrap?.seal === "function" && typeof wrap?.open === "function";
}

function readText(value: unknown): Uint8Array | null {
    if (typeof value !== "string" || !TEXT.test(value)) return null;
    try {
        return base64url.fromText(value);
    } catch {
        return null;
    }
}

function textWrap(name: string, wrap: TextWrap): PlatformKeyWrap {
    return {
        name,
        async seal(plain) {
            try {
                return readText(await wrap.seal(base64url.toText(plain)));
            } catch {
                return null;
            }
        },
        async open(sealed) {
            try {
                return readText(await wrap.open(base64url.toText(sealed)));
            } catch {
                return null;
            }
        }
    };
}

/** The platform key store this page can use, or null in a plain browser. */
export function platformKeyWrap(scope: unknown = globalThis): PlatformKeyWrap | null {
    const host = scope as PlatformWindow;
    const desktop = host.polarisDesktop?.keyWrap;
    if (isTextWrap(desktop)) return textWrap("desktop-safe-storage", desktop);
    const android = host.PolarisKeyStore;
    if (isTextWrap(android)) return textWrap("android-keystore", android);
    const ios = host.webkit?.messageHandlers?.polarisKeyStore;
    if (typeof ios?.postMessage === "function")
        return textWrap("ios-keychain", {
            seal: async (data) => (await ios.postMessage({ op: "seal", data })) as string | null,
            open: async (data) => (await ios.postMessage({ op: "open", data })) as string | null
        });
    return null;
}
