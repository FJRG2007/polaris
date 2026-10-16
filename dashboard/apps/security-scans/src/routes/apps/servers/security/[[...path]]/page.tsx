/**
 * Security scans: `/apps/servers/security`, a section of Servers. The server
 * hands over the frame only; the screen reads the servers and their scans in
 * the browser.
 */

import { PAGE_FILL } from "@polaris/ui";
import { notFound } from "next/navigation";
import { requireSecurityUser } from "../../../../../lib/access";
import { SecurityView } from "../../../../../screens/security-view";

export const dynamic = "force-dynamic";

export default async function SecurityPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    await requireSecurityUser();
    const raw = (await params).path;
    if (raw && (Array.isArray(raw) ? raw.length > 0 : true)) notFound();
    return (
        <div className={PAGE_FILL}>
            <SecurityView />
        </div>
    );
}
