/**
 * The device a native client says it runs on, as it travels to Polaris.
 *
 * Polaris Desktop, the command line and the Stream Deck plugin each derive the
 * same identifier from the operating system's own machine id
 * (`./device-identity-node`), so the rows they open on one computer can be shown
 * together under Account > Sessions. The identifier is a one-way hash: the
 * machine id itself never leaves the computer.
 *
 * It is a claim. Any client can send any value, so it groups rows and lets the
 * owner name a device to block; it never admits anything. The server hashes it
 * again with the account id before storing it, so the same computer reads as a
 * different value on every account.
 *
 * Shared by the clients and the server; nothing here touches the network, the
 * file system or Node built-ins.
 */

/** The header Polaris Desktop adds to its own requests to its own server. */
export const DEVICE_ID_HEADER = "x-polaris-device";

/** The computer's name beside it, URI-encoded since a header is ASCII. */
export const DEVICE_NAME_HEADER = "x-polaris-device-name";

/** The longest device name kept, the same ceiling a CLI sign-in has. */
export const DEVICE_NAME_MAX = 80;

/** A claimed identifier: 64 lowercase hex characters, a SHA-256. */
export const DEVICE_ID_PATTERN = /^[a-f0-9]{64}$/;

/** The identifier a request claims, or null for anything not shaped like one. */
export function readDeviceId(raw: string | null | undefined): string | null {
    const value = raw?.trim().toLowerCase() ?? "";
    return DEVICE_ID_PATTERN.test(value) ? value : null;
}

/**
 * A device name a client reported, cleaned for display: decoded when it came
 * URI-encoded, control characters dropped, trimmed and cut to the ceiling. Null
 * when nothing readable is left.
 */
export function readDeviceName(raw: string | null | undefined, encoded = false): string | null {
    if (!raw) return null;
    let value = raw;
    if (encoded) {
        try {
            value = decodeURIComponent(raw);
        } catch {
            return null;
        }
    }
    // eslint-disable-next-line no-control-regex
    const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, DEVICE_NAME_MAX);
    return clean.length > 0 ? clean : null;
}
