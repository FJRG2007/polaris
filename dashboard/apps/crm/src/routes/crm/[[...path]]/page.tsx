/**
 * The CRM: `/crm`, `/crm/<companies|people|opportunities>`, one record's
 * page, `/crm/<object>/<id>`, and the dashboards, `/crm/dashboards`.
 *
 * The server hands over the frame and nothing else - no record, view or total
 * is read here. The list reads them in the browser, painting what it kept from
 * the last visit first, so the header and the table's outline are on screen
 * before any request has left.
 */

import { crmT } from "../../../lib/i18n";
import { PAGE_FILL } from "@polaris/ui";
import { notFound, redirect } from "next/navigation";
import { requireCrmUser } from "../../../lib/access";
import { isCrmObject } from "../../../model/objects";
import { ListShell } from "../../../screens/list-shell";
import { ListScreen } from "../../../screens/list-screen";
import { RecordScreen } from "../../../screens/record-screen";
import { DashboardsScreen } from "../../../screens/dashboards-screen";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CrmPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    await requireCrmUser();
    const raw = (await params).path;
    const path = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (path.length === 0) redirect("/crm/companies");
    const [object, ...rest] = path;
    if (object === "dashboards" && rest.length === 0) {
        return (
            <div className={PAGE_FILL}>
                <DashboardsScreen />
            </div>
        );
    }
    if (!object || !isCrmObject(object) || rest.length > 1) notFound();
    const [id] = rest;
    if (id !== undefined) {
        if (!UUID.test(id)) notFound();
        return (
            <div className={PAGE_FILL}>
                <RecordScreen key={id} object={object} id={id} />
            </div>
        );
    }
    const t = await crmT();
    const title = t(`objects.${object}.plural`);
    return (
        <div className={`${PAGE_FILL} [&:has([data-crm-ready])>[data-crm-fallback]]:hidden`}>
            <div data-crm-fallback className="h-full">
                <ListShell
                    words={{
                        title,
                        newRecord: t(`objects.${object}.new`),
                        loading: t("list.loading")
                    }}
                />
            </div>
            <ListScreen key={object} object={object} />
        </div>
    );
}
