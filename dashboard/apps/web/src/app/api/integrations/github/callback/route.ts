/**
 * GitHub App manifest/install callback. GitHub redirects here twice:
 *  1. After the app is created (manifest flow) with `?code=&state=`. We verify the
 *     CSRF state cookie, exchange the code for the app credentials, store them, and
 *     send the user on to install the app.
 *  2. After the app is installed with `?installation_id=&setup_action=install`. We
 *     refresh the stored installation list and return to Integrations.
 */

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { exchangeManifestCode, refreshInstallations } from "@/lib/github-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Back to the dashboard without naming a host: the browser resolves it against the
 * address it is already on, which is the one it got here on. Building an absolute URL
 * would mean choosing a hostname - and behind a proxy this process sees its own
 * internal one, which is how a working round trip ended on a page that 404s.
 */
function backToIntegrations(outcome?: string): NextResponse {
    const target = outcome ? `/admin/integrations?github=${outcome}` : "/admin/integrations";
    return new NextResponse(null, { status: 303, headers: { location: target } });
}

export async function GET(request: Request): Promise<Response> {
    await requireAdmin();

    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const installationId = url.searchParams.get("installation_id");

    // Step 2: the app was installed. Capture its installations.
    if (installationId) {
        try {
            await refreshInstallations();
        } catch {
            // Non-fatal: the user can refresh from the dialog.
        }
        return backToIntegrations("installed");
    }

    // Step 1: the app was just created. Verify state, exchange the code, install.
    if (code) {
        const expected = request.headers
            .get("cookie")
            ?.split(";")
            .map((part) => part.trim())
            .find((part) => part.startsWith("gh_manifest_state="))
            ?.slice("gh_manifest_state=".length);
        if (!expected || !state || expected !== state) return backToIntegrations("state_error");
        try {
            const { htmlUrl } = await exchangeManifestCode(code);
            const response = NextResponse.redirect(new URL(`${htmlUrl}/installations/new`));
            response.cookies.delete("gh_manifest_state");
            return response;
        } catch {
            return backToIntegrations("error");
        }
    }

    return backToIntegrations();
}
