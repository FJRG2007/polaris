/**
 * GET /cli/polaris.mjs, /cli/install.sh, /cli/install.ps1 - the command-line
 * client and the scripts that install it (see `lib/cli/distribution`).
 *
 * Unauthenticated on purpose: the same public artefact for every caller, no
 * secret in it, and the person fetching it has not signed in to anything yet -
 * the CLI they are installing is how they will. Integrity is what matters, so
 * every file carries its SHA-256, which the install scripts and `plr update`
 * check before they replace anything.
 */

import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { appBaseUrl } from "@/lib/domain-service";
import {
    CLI_FILES,
    cliPackageDir,
    fillScript,
    isCliFile,
    requestOrigin
} from "@/lib/cli/distribution";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The address to write into a script: the one this request came in on, or the
 *  deployment's configured one when the headers do not give a clean answer. */
async function originFor(request: Request): Promise<string | null> {
    const seen = requestOrigin(request.headers);
    if (seen) return seen;
    try {
        const configured = new URL(await appBaseUrl());
        return requestOrigin(
            new Headers({
                host: configured.host,
                "x-forwarded-proto": configured.protocol.replace(":", "")
            })
        );
    } catch {
        return null;
    }
}

export async function GET(
    request: Request,
    segment: { params: Promise<{ file: string }> }
): Promise<Response> {
    const { file } = await segment.params;
    if (!isCliFile(file)) return new Response("Not found\n", { status: 404 });
    const spec = CLI_FILES[file];

    const dir = cliPackageDir();
    let contents: Buffer | null = null;
    try {
        if (dir) contents = await readFile(join(dir, ...spec.source));
    } catch {
        contents = null;
    }
    if (!contents) {
        // Not built, or the build did not reach the image. Said plainly: the
        // alternative is an install line that downloads an error page and runs it.
        return new Response(
            "The command-line client is not available on this Polaris. Update Polaris from Settings.\n",
            {
                status: 503,
                headers: {
                    "content-type": "text/plain; charset=utf-8",
                    "cache-control": "no-store"
                }
            }
        );
    }

    let body: Uint8Array = new Uint8Array(contents);
    if (spec.template) {
        const origin = await originFor(request);
        if (!origin) {
            return new Response("Open this address from the Polaris you want the CLI for.\n", {
                status: 400,
                headers: {
                    "content-type": "text/plain; charset=utf-8",
                    "cache-control": "no-store"
                }
            });
        }
        body = new TextEncoder().encode(fillScript(contents.toString("utf8"), origin));
    }

    return new Response(body, {
        headers: {
            "content-type": spec.type,
            "x-content-sha256": createHash("sha256").update(body).digest("hex"),
            "content-length": String(body.byteLength),
            "cache-control": "no-store",
            "x-content-type-options": "nosniff"
        }
    });
}
