/**
 * The newest published build of the browser extension, for the extension itself.
 *
 * The extension cannot ask GitHub. Its manifest declares no host permission at
 * all - the one origin it may reach is the Polaris somebody pointed it at, asked
 * for at runtime - and adding `api.github.com` to it would mean every install
 * standing on a permission it needs once a day, in a password manager, for a
 * version number. So it asks its own server, which already looks this up for the
 * downloads page and already caches the answer for ten minutes.
 *
 * Unauthenticated on purpose. What it reports is a public release of a public
 * repository and nothing whatever about this deployment - and the extension holds
 * no Polaris session to present: its token is for the vault surface, which is a
 * different thing entirely. Requiring one would mean a locked vault could not
 * find out it was out of date, which is exactly when somebody should be told.
 *
 * `null` is the ordinary answer, not a failure: it is what a deployment whose
 * repository has published no extension release says, and what it says while
 * GitHub is unreachable.
 */

import { loadEnv } from "@polaris/config";
import { extensionDownload } from "@/lib/app-releases";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Matches the lookup's own cache, so a browser that asks again inside the window
 *  is answered without waking this route at all. */
const CACHE_SECONDS = 600;

export async function GET(): Promise<Response> {
    const found = await extensionDownload(loadEnv().POLARIS_REPO);
    return Response.json(
        { version: found?.version ?? null, url: found?.url ?? null },
        { headers: { "cache-control": `public, max-age=${CACHE_SECONDS}` } }
    );
}
