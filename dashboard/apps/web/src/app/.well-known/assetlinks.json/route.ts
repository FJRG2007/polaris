/**
 * `/.well-known/assetlinks.json`: lets the Polaris phone app use this instance's
 * passkeys (see lib/mobile/asset-links). Public by design - it names an app and
 * a certificate fingerprint, both readable from the APK itself.
 */

import { androidCertFingerprints, assetLinks } from "@/lib/mobile/asset-links";

export const dynamic = "force-dynamic";

export function GET(): Response {
    return Response.json(assetLinks(androidCertFingerprints()), {
        headers: { "Cache-Control": "public, max-age=3600" }
    });
}
