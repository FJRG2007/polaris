/**
 * Apps that are part of every Polaris rather than something to install.
 *
 * Security scans and Cloud servers shipped as marketplace apps and are now
 * sections of Servers. They are still built and loaded as app bundles - core
 * never imports their code - but nothing installs them: each one is present on
 * every instance, is not offered in the marketplace, and cannot be uninstalled.
 * An install row left from when they were installable is harmless; it is read
 * as present like any other and is hidden from the lists of installed apps.
 *
 * Neither starts anything costly by being here: scans run on demand or on a
 * schedule somebody set, and the cloud refresh only reads servers created at an
 * account somebody connected.
 *
 * Pure and safe in the browser.
 */

/** Each native app's catalog id and the screen it answers at. */
export const NATIVE_APPS: Readonly<Record<string, string>> = {
    "security-scans": "/apps/servers/security",
    "cloud-servers": "/apps/servers/cloud"
};

/** The catalog ids of every native app. */
export const NATIVE_APP_IDS: readonly string[] = Object.keys(NATIVE_APPS);

/** Whether an app is part of every Polaris and never installed. */
export function isNativeApp(catalogId: string): boolean {
    return Object.hasOwn(NATIVE_APPS, catalogId);
}
