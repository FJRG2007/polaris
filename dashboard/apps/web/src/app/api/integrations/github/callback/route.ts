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

export async function GET(request: Request): Promise<Response> {
    await requireAdmin();

    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const installationId = url.searchParams.get("installation_id");
    const integrations = new URL("/integrations", url.origin);

    // Step 2: the app was installed. Capture its installations.
    if (installationId) {
        try {
            await refreshInstallations();
        } catch {
            // Non-fatal: the user can refresh from the dialog.
        }
        integrations.searchParams.set("github", "installed");
        return NextResponse.redirect(integrations);
    }

    // Step 1: the app was just created. Verify state, exchange the code, install.
    if (code) {
        const expected = request.headers
            .get("cookie")
            ?.split(";")
            .map((part) => part.trim())
            .find((part) => part.startsWith("gh_manifest_state="))
            ?.slice("gh_manifest_state=".length);
        if (!expected || !state || expected !== state) {
            integrations.searchParams.set("github", "state_error");
            return NextResponse.redirect(integrations);
        }
        try {
            const { htmlUrl } = await exchangeManifestCode(code);
            const response = NextResponse.redirect(new URL(`${htmlUrl}/installations/new`));
            response.cookies.delete("gh_manifest_state");
            return response;
        } catch {
            integrations.searchParams.set("github", "error");
            return NextResponse.redirect(integrations);
        }
    }

    return NextResponse.redirect(integrations);
}
