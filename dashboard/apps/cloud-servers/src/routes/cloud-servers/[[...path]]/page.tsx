/**
 * Cloud servers: one page, `/cloud-servers`. The server hands over the frame
 * and nothing else; the screen reads accounts and servers in the browser,
 * painting what it kept from the last visit first.
 */

import { PAGE_FILL } from "@polaris/ui";
import { notFound } from "next/navigation";
import { requireCloudUser } from "../../../lib/service";
import { CloudServersScreen } from "../../../screens/cloud-servers-screen";

export const dynamic = "force-dynamic";

export default async function CloudServersPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    await requireCloudUser();
    const raw = (await params).path;
    if (raw !== undefined && (!Array.isArray(raw) || raw.length > 0)) notFound();
    return (
        <div className={PAGE_FILL}>
            <CloudServersScreen />
        </div>
    );
}
