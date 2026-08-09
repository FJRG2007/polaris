/**
 * Domains admin panel (/admin/domains). The guided setup decides how the box is
 * exposed and under which domain; this page also holds Polaris's own addresses (the
 * app domain and the sharing domain used for share links and drop points), the root
 * certificate for `polaris.local`, and - under Advanced - the manual exposure and
 * DuckDNS controls. Admin-only.
 *
 * The page awaits nothing but the admin check. Everything on it reads through the
 * network to answer - the address list dials the tunnel daemon and probes each
 * hostname, the game ports knock on a router, the guided setup checks DNS - and
 * awaiting those here meant the navigation itself stalled until the slowest of
 * them came back, with the previous page still on screen. The panel fetches after
 * the first paint instead.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { DomainsView } from "./domains-view";

export const dynamic = "force-dynamic";

export default async function DomainsPage() {
    await requireAdmin();

    return (
        // Narrow page: centre the column in the content area, header included.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader
                title="Domains"
                description="Choose the domains Polaris uses for the dashboard and for the links it hands out."
            />
            <DomainsView />
        </div>
    );
}
