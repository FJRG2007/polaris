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
import { isReleaseAsset, XPI_CONTENT_TYPE, XPI_MAX_BYTES } from "@/lib/extension-package";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FETCH_TIMEOUT_MS = 30_000;

export async function GET(): Promise<Response> {
    const repo = loadEnv().POLARIS_REPO;
    const found = await extensionDownload(repo);
    const file = found ? signedFirefoxFile(found.files) : null;
    if (!file || !isReleaseAsset(file.url, repo)) return new Response(null, { status: 404 });

    const upstream = await fetch(file.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    }).catch(() => null);
    if (!upstream?.ok) return new Response(null, { status: 502 });
    // Refused before reading, when GitHub says up front that it is too big.
    if (Number(upstream.headers.get("content-length") ?? 0) > XPI_MAX_BYTES) {
        return new Response(null, { status: 502 });
    }
    const body = await upstream.arrayBuffer().catch(() => null);
    if (!body || body.byteLength === 0 || body.byteLength > XPI_MAX_BYTES) {
        return new Response(null, { status: 502 });
    }
    return new Response(body, {
        headers: {
            "content-type": XPI_CONTENT_TYPE,
            "content-length": String(body.byteLength),
            "cache-control": "public, max-age=600"
        }
    });
}
