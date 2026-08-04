/**
 * GitHub App creation entrypoint (manifest flow). Renders a self-submitting form
 * that POSTs an app manifest to GitHub; GitHub creates the app under the user's
 * account and redirects back to the callback with a temporary code. A CSRF state
 * is stored in an httpOnly cookie and echoed back for the callback to verify.
 *
 * The browser-facing URLs are taken from the incoming request origin, so this works
 * on a LAN hostname or a public domain alike (the redirect happens in the user's
 * browser, and that origin is where the state cookie was set). The webhook is not
 * one of those: GitHub calls it from its own network and validates it before it
 * creates anything, so it is resolved separately below.
 */

import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { publicHostname } from "@/lib/domain-edge";
import { publicAppUrl } from "@/lib/domain-service";
import { GITHUB_APP_NEW_URL, buildAppManifest } from "@/lib/github-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function escapeAttr(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * The address GitHub's own servers can reach this instance at, or null when there is
 * none. The configured/reachable app address first, then the one the browser is on -
 * which is a public name when the dashboard was reached through it, and a LAN name,
 * `localhost` or the bind address `0.0.0.0` otherwise. Any of those last three in a
 * manifest is what GitHub rejects, so they resolve to null and the app is created
 * without a webhook instead of not being created at all.
 */
async function reachableFromGithub(origin: string): Promise<string | null> {
    const configured = await publicAppUrl();
    if (configured) return configured;
    return publicHostname(origin) ? origin : null;
}

export async function GET(request: Request): Promise<Response> {
    await requireAdmin();

    const origin = new URL(request.url).origin;
    // App names are globally unique on GitHub; suffix with entropy to avoid clashes.
    const name = `Polaris ${randomBytes(4).toString("hex")}`;
    const state = randomBytes(16).toString("hex");
    const manifest = JSON.stringify(buildAppManifest({ name, origin, publicUrl: await reachableFromGithub(origin) }));

    const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Connecting to GitHub...</title></head>
  <body style="font-family:system-ui,sans-serif;background:#0b0e14;color:#c9d1d9">
    <form id="f" method="post" action="${GITHUB_APP_NEW_URL}?state=${state}">
      <input type="hidden" name="manifest" value="${escapeAttr(manifest)}">
      <noscript><button type="submit">Continue to GitHub</button></noscript>
    </form>
    <p style="padding:2rem">Redirecting to GitHub...</p>
    <script>document.getElementById("f").submit();</script>
  </body>
</html>`;

    const response = new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    response.cookies.set("gh_manifest_state", state, {
        httpOnly: true,
        sameSite: "lax",
        secure: origin.startsWith("https:"),
        path: "/",
        maxAge: 600
    });
    return response;
}
