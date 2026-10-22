/**
 * Security scans: `/apps/servers/security`, a section of Servers. The server
 * hands over the frame and what the link asks to open (`?target=&scan=&ids=`,
 * see `model/landing`); the screen reads the servers and their scans in the
 * browser.
 */

import { PAGE_FILL } from "@polaris/ui";
import { notFound } from "next/navigation";
import { parseLanding } from "../../../../../model/landing";
import { requireSecurityUser } from "../../../../../lib/access";
import { SecurityView } from "../../../../../screens/security-view";

export const dynamic = "force-dynamic";

export default async function SecurityPage({
    params,
    searchParams
}: {
    params: Promise<Record<string, string | string[]>>;
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    await requireSecurityUser();
    const raw = (await params).path;
    if (raw && (Array.isArray(raw) ? raw.length > 0 : true)) notFound();
    const landing = parseLanding(searchParams ? await searchParams : null);
    return (
        <div className={PAGE_FILL}>
            <SecurityView landing={landing} />
        </div>
    );
}
