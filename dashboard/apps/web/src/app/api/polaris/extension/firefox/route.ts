/**
 * The newest signed Firefox package of the extension, served so Firefox offers
 * to install it (`lib/extension-package.ts`).
 *
 * Unauthenticated for the same reason as the version beside it: it is a public
 * release of a public repository. 404 is the ordinary answer while a release
 * carries no signed package.
 */

import { loadEnv } from "@polaris/config";
import { extensionDownload } from "@/lib/app-releases";
import { signedFirefoxFile } from "@polaris/ui/account-downloads/extension-install";
import { isReleaseAsset, packageBytes, XPI_CONTENT_TYPE } from "@/lib/extension-package";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const repo = loadEnv().POLARIS_REPO;
    const found = await extensionDownload(repo);
    const file = found ? signedFirefoxFile(found.files) : null;
    if (!file || !isReleaseAsset(file.url, repo)) return new Response(null, { status: 404 });

    const body = await packageBytes(file.url);
    if (!body) return new Response(null, { status: 502 });
    return new Response(body, {
        headers: {
            "content-type": XPI_CONTENT_TYPE,
            "content-length": String(body.byteLength),
            "cache-control": "public, max-age=600"
        }
    });
}
