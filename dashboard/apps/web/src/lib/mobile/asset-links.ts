/**
 * Digital Asset Links for the Polaris phone app.
 *
 * A passkey made or used inside the app's WebView is only accepted when this
 * instance says the app may act for it: Android reads `/.well-known/assetlinks.json`
 * here and checks the app id and the certificate it was signed with. Without it
 * the WebView refuses WebAuthn for this host, and the page falls back to the
 * other ways in.
 */

import { loadEnv } from "@polaris/config";

export const ANDROID_PACKAGE = "app.polaris.mobile";

/** The official release key (mobile.yml signs every published APK with it). A
 *  certificate fingerprint is public: anybody can read it out of the APK. */
const RELEASE_CERT_SHA256 = "0D:82:CA:45:65:24:46:89:10:B0:FE:00:11:83:C4:5A:FA:E1:C6:8A:14:EC:4A:6C:FB:FC:79:6A:D1:EA:3C:8F";

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** Every certificate the app may be signed with: the release key and any listed in the setting. */
export function androidCertFingerprints(extra: string | undefined = loadEnv().POLARIS_ANDROID_CERT_SHA256): string[] {
    const listed = (extra ?? "")
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter((value) => FINGERPRINT.test(value));
    return [...new Set([RELEASE_CERT_SHA256, ...listed])];
}

/**
 * The origin Android reports for a passkey the app makes or uses, one per
 * certificate: `android:apk-key-hash:` and the certificate's SHA-256 in base64url.
 */
export function androidAppOrigins(fingerprints: readonly string[] = androidCertFingerprints()): string[] {
    return fingerprints.map(
        (fingerprint) => `android:apk-key-hash:${Buffer.from(fingerprint.replace(/:/g, ""), "hex").toString("base64url")}`
    );
}

/** The statement list Android reads: the app may sign in with this host's credentials. */
export function assetLinks(fingerprints: readonly string[]) {
    return [
        {
            relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
            target: { namespace: "android_app", package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: fingerprints }
        }
    ];
}
