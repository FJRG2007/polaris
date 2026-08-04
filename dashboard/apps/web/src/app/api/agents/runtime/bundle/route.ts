/**
 * The agent runtime, served to whatever is about to run it.
 *
 * A dispatched workflow fetches this file and runs it with node. Serving it from
 * the instance rather than publishing it means the bundle a run executes is always
 * the one this Polaris was built with, there is no registry or third party in the
 * path, and an instance nobody can reach from the internet is not asked to be.
 *
 * Unauthenticated on purpose. It is the same public artefact for every caller,
 * carries no secret, and the runner that needs it has not authenticated yet: it
 * has nothing to authenticate with until the bundle it is fetching runs and mints
 * an OIDC assertion. Integrity is the property that matters here, not secrecy,
 * which is what the digest below is for.
 */

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which file to serve. `post` is the always-run step that persists state a
 *  cancelled or timed-out run would otherwise lose. */
const FILES: Record<string, string> = { main: "runtime.mjs", post: "post.mjs" };

function bundlePath(name: string): string {
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(require.resolve("@polaris/agent-runtime/package.json"));
    return join(packageRoot, "dist", name);
}

export async function GET(request: Request): Promise<Response> {
    const part = new URL(request.url).searchParams.get("part") ?? "main";
    const file = FILES[part];
    if (!file) return new Response("unknown bundle", { status: 404 });

    let contents: Buffer;
    try {
        contents = await readFile(bundlePath(file));
    } catch {
        // The package was not built, or the build did not reach the image. Say so:
        // the alternative is a runner that downloads an error page and runs it.
        return new Response("the agent runtime has not been built on this instance", { status: 503 });
    }

    return new Response(new Uint8Array(contents), {
        headers: {
            "content-type": "application/javascript; charset=utf-8",
            // The workflow verifies this before running what it downloaded, so a
            // truncated transfer or anything rewriting the response in flight
            // fails the job instead of executing.
            "x-content-sha256": createHash("sha256").update(contents).digest("hex"),
            "content-length": String(contents.byteLength),
            "cache-control": "no-store"
        }
    });
}
