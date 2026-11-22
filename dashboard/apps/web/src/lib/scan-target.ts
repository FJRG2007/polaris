/**
 * Where a scanned code is answered.
 *
 * Account > Scan a code reads more than the sign-in screen's QR: Polaris TV shows
 * one too, and it encodes its own approval page (`/account/tv?code=...`), not
 * this one. Only the path and the code are taken from the link - the TV may have
 * been pointed at another address of this same Polaris (a LAN name, a public
 * hostname), and following an arbitrary origin out of a QR would be an open
 * redirect anyway.
 *
 * Client-safe: the scan screen imports it.
 */

import { QR_SIGN_IN_PATH } from "@polaris/core";

/** Pages that answer a code of their own, by the path their QR encodes. */
const APPROVAL_PATHS: readonly string[] = ["/account/tv"];

/** The QR sign-in's key commitment fragment (`@polaris/chat-crypto/qr-approval`). */
const KEY_FRAGMENT = /^#k=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{22}$/;

/** The in-app path a scanned or typed payload opens, or null when it holds no code. */
export function scanTarget(text: string): string | null {
    const trimmed = text.trim();
    try {
        const link = new URL(trimmed);
        const code = link.searchParams.get("code")?.trim();
        if (code) {
            const path = link.pathname.replace(/\/+$/, "");
            const page = APPROVAL_PATHS.includes(path) ? path : QR_SIGN_IN_PATH;
            // A sign-in screen with chat encryption on (internal flag) adds a
            // key commitment in the fragment; carried only in its exact shape.
            const fragment = page === QR_SIGN_IN_PATH && KEY_FRAGMENT.test(link.hash) ? link.hash : "";
            return `${page}?code=${encodeURIComponent(code)}${fragment}`;
        }
    } catch {
        // Not a URL; fall through to treating the payload as the code itself.
    }
    return /^[A-Za-z0-9-]{6,13}$/.test(trimmed)
        ? `${QR_SIGN_IN_PATH}?code=${encodeURIComponent(trimmed)}`
        : null;
}
