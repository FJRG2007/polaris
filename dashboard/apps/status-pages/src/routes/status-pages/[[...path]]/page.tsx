/**
 * Status pages management: `/status-pages` lists the pages, and
 * `/status-pages/<id>` is one page's components, checks, incidents and
 * maintenance. For whoever holds `status.manage`, and for somebody given single
 * pages to edit (`lib/page-access`), who sees those and nothing else.
 *
 * The server hands over the frame and nothing else; the screen reads its data
 * in the browser, so the header is on screen before any request has left.
 */

import { PAGE_FILL } from "@polaris/ui";
import { notFound } from "next/navigation";
import { host } from "@polaris/app-host";
import * as access from "../../../lib/page-access";
import { StatusPagesScreen } from "../../../screens/manager";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function StatusPagesPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    const [user, raw] = await Promise.all([
        host.session.requireUser(),
        params.then((all) => all.path)
    ]);
    const path = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (path.length > 1) notFound();
    const [id] = path;
    if (id !== undefined && !UUID.test(id)) notFound();
    const manager = await access.isStatusManager(user);
    if (!manager) {
        const reaches = id
            ? await access.editsPage(user.id, id)
            : await access.reachesAnyPage(user.id);
        // Nobody shared anything: the same refusal as before.
        if (!reaches) await host.session.requirePermission("status.manage");
    }
    return (
        <div className={PAGE_FILL}>
            <StatusPagesScreen key={id ?? "list"} pageId={id ?? null} manager={manager} />
        </div>
    );
}
