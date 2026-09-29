import { PageHeader } from "@polaris/ui";
import { loadEnv } from "@polaris/config";
import { requirePermission } from "@/lib/session";
import { ContainersView } from "./containers-view";
import { containerHosts, selectConnection } from "./connections";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

function pick(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

/**
 * The Containers shell. Only what the page needs to draw itself is resolved
 * here - which hosts exist, which one is selected, whether the caller may manage
 * them - so the navigation paints immediately. The engine itself (an overview, a
 * container list and a stats sample each) is fetched by the view from
 * /api/containers, because that round trip can cross a network and must not sit
 * in front of the first paint.
 */
export default async function ContainersPage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const user = await requirePermission("deploy.read");
    const params = await searchParams;
    const hosts = await containerHosts(user);
    const selected = selectConnection(hosts, pick(params.c));
    const t = await getTranslations("containers");

    return (
        <>
            <PageHeader
                title={t("overview.containers")}
                description={t("page.description")}
            />
            <ContainersView
                connections={hosts.connections}
                connectionId={selected?.id ?? null}
                sshEnabled={loadEnv().POLARIS_SSH_ENABLED}
                canManage={hosts.canManage}
                localDiagnostic={hosts.localDiagnostic}
            />
        </>
    );
}
