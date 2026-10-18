/**
 * Cloud servers: one page, `/apps/servers/cloud`, a section of Servers. The
 * server hands over the frame and nothing else; the screen reads accounts and
 * servers in the browser, painting what it kept from the last visit first.
 */

import { PAGE_FILL } from "@polaris/ui";
import { notFound, redirect } from "next/navigation";
import { requireCloudUser } from "../../../../../lib/service";
import { CloudServersScreen } from "../../../../../screens/cloud-servers-screen";
import { CONNECT_HREF, cloudPathTarget } from "../../../../../lib/cloud-routes";

export const dynamic = "force-dynamic";

export default async function CloudServersPage({
    params,
    searchParams
}: {
    params: Promise<Record<string, string | string[]>>;
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    await requireCloudUser();
    const target = cloudPathTarget((await params).path);
    if (target === null) notFound();
    // Connecting an account moved to the connections hub; an old link to it,
    // `/connect` or `?connect`, lands there and comes back here.
    if (target === "connect" || (await searchParams)?.connect !== undefined) redirect(CONNECT_HREF);
    return (
        <div className={PAGE_FILL}>
            <CloudServersScreen />
        </div>
    );
}
