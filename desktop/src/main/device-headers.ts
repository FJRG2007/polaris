/**
 * Tells the Polaris this app is connected to which computer it runs on, so
 * Account > Sessions can show the desktop's session under the same device as
 * the command line and the Stream Deck plugin on this machine, and so its owner
 * can sign that device out or block it.
 *
 * The value is the hashed machine id (`@polaris/core` `device-identity-node`),
 * never the id itself, and it goes only to the server the window is showing:
 * every other site the app loads gets nothing.
 */

import type { Session } from "electron";
import { DEVICE_ID_HEADER, DEVICE_NAME_HEADER } from "../../../dashboard/packages/core/src/device-identity";
import { deviceIdentity, type DeviceIdentity } from "../../../dashboard/packages/core/src/device-identity-node";

/** The headers a request to `url` carries, or null when it is not to the server. */
export function deviceHeadersFor(url: string, serverOrigin: string | null, identity: DeviceIdentity | null): Record<string, string> | null {
    if (!serverOrigin || !identity?.id) return null;
    let origin: string;
    try {
        origin = new URL(url).origin;
    } catch {
        return null;
    }
    if (origin !== serverOrigin) return null;
    const headers: Record<string, string> = { [DEVICE_ID_HEADER]: identity.id };
    if (identity.name) headers[DEVICE_NAME_HEADER] = encodeURIComponent(identity.name);
    return headers;
}

/** Adds the headers to every request the session sends to the active server. */
export function installDeviceHeaders(target: Session, server: () => string | null): void {
    let identity: DeviceIdentity | null = null;
    void deviceIdentity().then((read) => {
        identity = read;
    });
    target.webRequest.onBeforeSendHeaders((details, callback) => {
        const extra = deviceHeadersFor(details.url, server(), identity);
        callback({ requestHeaders: extra ? { ...details.requestHeaders, ...extra } : details.requestHeaders });
    });
}
