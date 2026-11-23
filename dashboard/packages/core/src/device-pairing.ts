/**
 * Proving that the browser extension and Polaris Desktop run on the same
 * computer, so the sessions screen can group them by evidence instead of by
 * the address they connect from.
 *
 * The extension asks the server for a short-lived, single-use nonce bound to
 * its own connection, hands it to Polaris Desktop through the browser's native
 * messaging, and the desktop presents it over its own signed-in session - which
 * carries its device key. The server then binds the extension's connection to
 * that key. Nothing about the machine leaves the desktop: the nonce travels
 * from the server, through the extension, back to the server.
 *
 * Only constants and patterns live here, with no validation library, because
 * three builds with different ones (the dashboard, the extension and the
 * desktop app) read this file. Each side wraps them in its own schema.
 *
 * Shared by server and client code.
 */

/** The native messaging host's name, as every browser's manifest names it. */
export const NATIVE_HOST_NAME = "local.polaris.desktop";

/** The Firefox build's add-on id (`apps/extension/wxt.config.ts`): fixed, so
 *  the host manifest can name it before the extension ever reports itself. */
export const FIREFOX_EXTENSION_ID = "vault@polaris.local";

/** How long a nonce may be presented before it is refused. */
export const PAIRING_NONCE_TTL_MS = 2 * 60 * 1000;

/** A nonce as it travels: base64url, the shape `generateToken` makes. */
export const PAIRING_NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/** A Chromium extension id: 32 letters from a to p. */
export const CHROMIUM_EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

/** The largest native message either side accepts, in bytes. A pairing
 *  message is under 300; Chrome caps host replies at 1 MB. */
export const NATIVE_MESSAGE_MAX_BYTES = 4096;

/** What the extension sends the native host. */
export interface NativePairRequest {
    readonly type: "pair";
    /** The Polaris server's origin the nonce was issued by. */
    readonly server: string;
    readonly nonce: string;
}

/** Why the desktop did not present a nonce, in words the extension can act on. */
export type NativePairFailure = "no-desktop" | "other-server" | "signed-out" | "refused" | "unreachable" | "bad-request";

/** What the native host answers. */
export type NativePairReply = { readonly ok: true } | { readonly ok: false; readonly reason: NativePairFailure };
