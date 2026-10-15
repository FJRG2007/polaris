/**
 * Status pages management: `/status-pages` lists the pages, and
 * `/status-pages/<id>` is one page's components, checks, incidents and
 * maintenance. Only for whoever holds `status.manage`.
 *
 * The server hands over the frame and nothing else; the screen reads its data
 * in the browser, so the header is on screen before any request has left.
 */

import { PAGE_FILL } from "@polaris/ui";
import { notFound } from "next/navigation";
import { requireStatusManager } from "../../../lib/outcome";
import { StatusPagesScreen } from "../../../screens/manager";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function StatusPagesPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    await requireStatusManager();
    const raw = (await params).path;
    const path = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (path.length > 1) notFound();
    const [id] = path;
    if (id !== undefined && !UUID.test(id)) notFound();
    return (
        <div className={PAGE_FILL}>
            <StatusPagesScreen key={id ?? "list"} pageId={id ?? null} />
        </div>
    );
}
