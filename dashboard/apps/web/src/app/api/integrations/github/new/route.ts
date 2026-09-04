/**
 * GitHub App creation entrypoint (manifest flow). Renders a self-submitting form
 * that POSTs an app manifest to GitHub; GitHub creates the app under the user's
 * account and redirects back to the callback with a temporary code. A CSRF state
 * is stored in an httpOnly cookie and echoed back for the callback to verify.
 *
 * Every URL the app is registered with comes from one address, and choosing it is
 * most of what this file does: an app created from `http://0.0.0.0:3000` gets a
 * webhook GitHub refuses and a callback no browser will open, while one created from
 * a domain the edge does not route yet gets a callback that 404s. The flow moves onto
 * the address it settles on before anything else, so the state cookie and the session
 * are on the host GitHub returns to.
 */

import { randomBytes } from "node:crypto";
import { apiAdmin } from "@/lib/api-session";
import { NextResponse } from "next/server";

import { probeEdge } from "@/lib/network-advice";
import { publicHostname } from "@/lib/domain-edge";
import { connectionFlowOrigin } from "@/lib/connections/oauth";
import { browserOrigin, publicAppUrl } from "@/lib/domain-service";
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

/** Marks the pass that already ran on the address below, so the move happens once. */
const MOVED = "moved";

/**
 * The address this flow runs on, and every URL the app is registered with.
 *
 * The one Polaris hands out wins over the tab's own hostname, which is whatever that
 * person typed to get here: an app registered on `0.0.0.0` sends whoever comes back
 * to the socket the server binds rather than to an address a browser will open.
 *
 * But only when that address answers as this dashboard. A domain saved in settings is
 * an intention until the edge serves it, and a name it does not route answers 404 -
 * moving there would cost an app created with a callback nobody can reach, which is
 * the failure this whole path exists to avoid. Unproven, the flow stays where it
 * demonstrably works: the browser is loading this page on it.
 */
async function flowOrigin(requestOrigin: string): Promise<string> {
    const canonical = await publicAppUrl();
    if (!canonical || canonical === requestOrigin) return browserOrigin(requestOrigin);
    const probe = await probeEdge(new URL(canonical).hostname);
    return probe.answer === "polaris" ? canonical : browserOrigin(requestOrigin);
}

export async function GET(request: Request): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;

    const requested = new URL(request.url);
    const origin = await flowOrigin(requested.origin);
    // Start the flow over on that address when this one is not it. The state cookie
    // set below and the session that authorized this both belong to a single host,
    // and it has to be the host GitHub returns to. The marker is what stops a second
    // move: behind a proxy that does not pass the browser's host through, this route
    // keeps seeing the internal address however it was reached, and comparing the two
    // again would loop.
    if (origin !== requested.origin && requested.searchParams.get(MOVED) !== "1") {
        const target = new URL(requested.pathname, origin);
        target.searchParams.set(MOVED, "1");
        return NextResponse.redirect(target);
    }

    // App names are globally unique on GitHub; suffix with entropy to avoid clashes.
    const name = `Polaris ${randomBytes(4).toString("hex")}`;
    const state = randomBytes(16).toString("hex");
    // GitHub calls the webhook from its own network and validates it before it creates
    // anything, so it is declared only when this address is one the internet can reach.
    const publicUrl = publicHostname(origin) ? origin : null;
    // And the address account linking runs on, which is this deployment's own and
    // need not be either of those: an app created from a LAN name would otherwise
    // register a callback that linking never uses, and GitHub would refuse it.
    const linkOrigin = await connectionFlowOrigin();
    const manifest = JSON.stringify(buildAppManifest({ name, origin, publicUrl, linkOrigin }));

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
        // The scheme this request arrived on, not the canonical one: a proxy that
        // terminates TLS reaches here over http, and a Secure cookie the browser
        // stores anyway is fine while one it drops loses the round trip.
        secure: requested.protocol === "https:",
        path: "/",
        maxAge: 600
    });
    return response;
}
