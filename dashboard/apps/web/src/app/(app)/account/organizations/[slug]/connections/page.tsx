/**
 * The organization's connections: the outside accounts its apps connected for
 * the organization rather than for one person, drawn by the same hub as
 * Profile > Connections.
 *
 * Everybody on the roster may open it and see what is connected; only whoever
 * manages the organization's connections is offered Connect and Remove, from
 * the same check the actions behind them make.
 */

import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { requireOrgPage } from "@/lib/orgs/page-access";
import { managesOrgConnections } from "@/lib/connections/org-scope";
import { ConnectionsView } from "@/app/(app)/account/connections/connections-view";
import { hubAppSections, hubSearch } from "@/app/(app)/account/connections/app-sections";

export const dynamic = "force-dynamic";

export default async function OrganizationConnectionsPage({
    params,
    searchParams
}: {
    params: Promise<{ slug: string }>;
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { slug } = await params;
    const { org, user } = await requireOrgPage(slug);
    const search = hubSearch((await searchParams) ?? {});
    const canManage = await managesOrgConnections(user, org.id);
    const [apps, t] = await Promise.all([
        hubAppSections(
            user.id,
            { kind: "org", orgId: org.id, orgSlug: org.slug, orgName: org.name, canManage },
            search
        ),
        getTranslations("accountOrgs")
    ]);

    return (
        <div className="flex flex-col gap-4">
            <div>
                <h2 className="text-base font-semibold">{t("connections.title")}</h2>
                <p className="text-sm text-muted-foreground">
                    {canManage ? t("connections.intro") : t("connections.readOnly")}
                </p>
            </div>
            {apps.node ? (
                <Messages namespaces={["account"]}>
                    <ConnectionsView
                        providers={[]}
                        initialSearch={search}
                        appSections={apps.node}
                        appSectionIds={apps.ids}
                    />
                </Messages>
            ) : (
                <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                    {t("connections.empty")}
                </p>
            )}
        </div>
    );
}
