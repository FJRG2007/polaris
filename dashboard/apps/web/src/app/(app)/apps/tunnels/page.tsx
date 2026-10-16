import { Suspense } from "react";
import { TunnelsView } from "./tunnels-view";
import { requirePermission } from "@/lib/session";
import { PageHeader, Skeleton } from "@polaris/ui";
import { getTranslations } from "@/lib/i18n/request";
import { listTunnels, tunnelOptions } from "@/lib/deploy/wireguard/tunnel-service";

export const dynamic = "force-dynamic";

/**
 * The header is on screen at once; the list waits on the database and, for a
 * tunnel through this machine, on its public address - so only the list region
 * is held behind a skeleton. Each card then reads its live state on its own.
 */
export default async function TunnelsPage() {
    await requirePermission("deploy.manage");
    const t = await getTranslations("tunnels");
    return (
        <>
            <PageHeader title={t("page.title")} description={t("page.description")} />
            <Suspense fallback={<ListSkeleton />}>
                <TunnelList />
            </Suspense>
        </>
    );
}

async function TunnelList() {
    const user = await requirePermission("deploy.manage");
    const [tunnels, options] = await Promise.all([listTunnels(user.id), tunnelOptions(user.id)]);
    return <TunnelsView tunnels={tunnels} options={options} />;
}

function ListSkeleton() {
    return (
        <div className="flex flex-col gap-3" aria-hidden>
            <Skeleton className="ml-auto h-7 w-28" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
        </div>
    );
}
