/**
 * Where this device is, asked of the browser (or the phone app's web view) only
 * when somebody does something that needs it - sharing a location, or seeing
 * how far a shared one is.
 *
 * Client-only.
 */

import type * as core from "@polaris/core";

export type Fix =
    | { readonly state: "locating" }
    | { readonly state: "ready"; readonly point: core.GeoPoint }
    | { readonly state: "denied" | "dismissed" | "unavailable" | "unsupported" | "insecure" };

/**
 * What the browser says about location for this page without asking anybody:
 * "prompt" when nobody has answered yet. Null where it cannot say (Safari before
 * 16, some WebViews), which is read as "ask and see".
 */
async function permissionState(): Promise<PermissionState | null> {
    try {
        const status = await navigator.permissions?.query({ name: "geolocation" });
        return status?.state ?? null;
    } catch {
        return null;
    }
}

/**
 * Ask the device where it is, once. Asking is what raises the browser's (or
 * the phone's) permission prompt the first time, so this is also how location
 * is asked for. A "no" is told apart from a prompt closed without an answer:
 * a browser reports both as PERMISSION_DENIED, but only the first is blocked -
 * the second just needs asking again.
 */
export function locate(): Promise<Fix> {
    if (typeof window !== "undefined" && window.isSecureContext === false) {
        return Promise.resolve({ state: "insecure" });
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve({ state: "unsupported" });
    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            (position) =>
                resolve({
                    state: "ready",
                    point: {
                        latitude: position.coords.latitude,
                        longitude: position.coords.longitude,
                        accuracy: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null
                    }
                }),
            (error) => {
                if (error.code !== error.PERMISSION_DENIED) return resolve({ state: "unavailable" });
                void permissionState().then((state) => resolve({ state: state === "prompt" ? "dismissed" : "denied" }));
            },
            { enableHighAccuracy: true, timeout: 20_000, maximumAge: 15_000 }
        );
    });
}
