/**
 * `polaris-agent`, the native session engine, served to the session container
 * and the runner that are about to run it.
 *
 * Served from the instance for the reasons the agent runtime's bundle is
 * (`api/agents/runtime/bundle`): the engine a session runs is always the one
 * this Polaris was built with, and no registry or third party is in the path.
 * Unauthenticated for the same reason: one public artefact, no secret in it;
 * the digest header is what a downloader checks.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { NATIVE_BUNDLE_FILE, nativeBundleDir } from "@/lib/polar/native/bundle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const dir = nativeBundleDir();
    let contents: Buffer | null = null;
    try {
        if (dir) contents = await readFile(join(dir, NATIVE_BUNDLE_FILE));
    } catch {
        contents = null;
    }
    if (!contents) return new Response("the native session engine has not been built on this instance", { status: 503 });
    return new Response(new Uint8Array(contents), {
        headers: {
            "content-type": "application/javascript; charset=utf-8",
            "x-content-sha256": createHash("sha256").update(contents).digest("hex"),
            "content-length": String(contents.byteLength),
            "cache-control": "no-store"
        }
    });
}
