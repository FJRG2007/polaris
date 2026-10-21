import Link from "next/link";
import { Suspense } from "react";
import { requirePermission } from "@/lib/session";
import { PageHeader, Skeleton } from "@polaris/ui";
import { getTranslations } from "@/lib/i18n/request";
import * as machines from "@/lib/machines/machines-service";
import { WatchCardList } from "@/app/(app)/watch/watch-cards";

export const dynamic = "force-dynamic";

/**
 * Servers, containers and domains as devices in Places. The heading and the
 * groups paint at once; each group reads behind its own skeleton, so a server
 * that is slow to answer over SSH holds back only the containers.
 */
export default async function MachinesPage() {
    const [user, t] = await Promise.all([requirePermission("deploy.read"), getTranslations("servers")]);
    return (
        <div className="flex flex-col gap-6">
            <PageHeader title={t("machines.heading")} description={t("machines.intro")} />
            <Group title={t("machines.servers")}>
                <Servers ownerId={user.id} />
            </Group>
            <Group title={t("machines.containers")}>
                <Containers ownerId={user.id} />
            </Group>
            <Group title={t("machines.domains")}>
                <Domains ownerId={user.id} />
            </Group>
        </div>
    );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">{title}</h2>
            <Suspense fallback={<Skeleton className="h-28 w-full rounded-xl" />}>{children}</Suspense>
        </section>
    );
}

async function Servers({ ownerId }: { ownerId: string }) {
    const [t, cards] = await Promise.all([getTranslations("servers"), machines.machineServers(ownerId)]);
    return <WatchCardList cards={cards} empty={t("machines.noServers")} label={t("machines.servers")} />;
}

async function Containers({ ownerId }: { ownerId: string }) {
    const [t, cards] = await Promise.all([getTranslations("servers"), machines.machineContainers(ownerId)]);
    return <WatchCardList cards={cards} empty={t("machines.noContainers")} label={t("machines.containers")} />;
}

async function Domains({ ownerId }: { ownerId: string }) {
    const [t, rows] = await Promise.all([getTranslations("servers"), machines.machineDomains(ownerId)]);
    if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t("machines.noDomains")}</p>;
    return (
        <ul className="flex flex-col divide-y rounded-md border">
            {rows.map((row) => (
                <li key={row.id} className="min-w-0">
                    <Link
                        href={machines.machineHref("domain", row.id)}
                        className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm hover:bg-muted"
                    >
                        <span
                            aria-hidden
                            className={`size-2 shrink-0 rounded-full ${
                                row.status === "up" ? "bg-success" : row.status === "down" ? "bg-danger" : "bg-muted-foreground"
                            }`}
                        />
                        <span className="min-w-0 flex-1 truncate" title={row.hostname}>
                            {row.hostname}
                        </span>
                        <span className="min-w-0 max-w-[40%] truncate text-xs text-muted-foreground" title={row.service}>
                            {row.service}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                            {t(`machines.${row.status ?? "unknown"}`)}
                        </span>
                    </Link>
                </li>
            ))}
        </ul>
    );
}
