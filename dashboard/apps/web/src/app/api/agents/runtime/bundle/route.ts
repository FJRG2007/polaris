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
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which file to serve. `post` is the always-run step that persists state a
 *  cancelled or timed-out run would otherwise lose. */
const FILES: Record<string, string> = { main: "runtime.mjs", post: "post.mjs" };

/**
 * Where the built runtime is, in a way that survives being packaged.
 *
 * Resolving the package by name is the obvious way and the one that does not
 * work in the image. Next's standalone tracer copies what it can see, and what
 * it can see are the imports it rewrites - it lays the package down under its
 * real path and reproduces no `node_modules/@polaris/agent-runtime` entry, so
 * `require.resolve` throws and every run fails at its first step downloading a
 * 503. In development the resolve works and the deployed instance is the only
 * place it does not, which is exactly the failure nobody catches locally.
 *
 * So: ask the resolver first, because it is right whenever it answers, and fall
 * back to where the standalone layout actually puts it.
 */
function bundleDir(): string | null {
    const candidates: string[] = [];
    try {
        const require = createRequire(import.meta.url);
        candidates.push(join(dirname(require.resolve("@polaris/agent-runtime/package.json")), "dist"));
    } catch {
        // Packaged, not installed. The paths below are the answer.
    }
    // The standalone tree is rooted at the workspace root and the server runs
    // from it, so the package sits beside the app rather than under it.
    candidates.push(join(process.cwd(), "packages", "agent-runtime", "dist"));
    candidates.push(join(process.cwd(), "..", "..", "packages", "agent-runtime", "dist"));
    return candidates.find((dir) => existsSync(join(dir, FILES.main as string))) ?? null;
}

export async function GET(request: Request): Promise<Response> {
    const part = new URL(request.url).searchParams.get("part") ?? "main";
    const file = FILES[part];
    if (!file) return new Response("unknown bundle", { status: 404 });

    const dir = bundleDir();
    let contents: Buffer | null = null;
    try {
        if (dir) contents = await readFile(join(dir, file));
    } catch {
        contents = null;
    }
    if (!contents) {
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
