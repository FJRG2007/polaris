import { Suspense } from "react";
import { grantedSubjects } from "@/lib/access/grants";
import { requireUser, sessionCan } from "@/lib/session";
import { PageHeader, Skeleton } from "@polaris/ui";
import { getTranslations } from "@/lib/i18n/request";
import * as machines from "@/lib/machines/machines-service";
import { MachineCards, MachineDomains } from "./machine-groups";

export const dynamic = "force-dynamic";

/**
 * Servers, containers and domains as devices in Places. The heading and the
 * groups paint at once; each group reads behind its own skeleton, so a server
 * that is slow to answer over SSH holds back only the containers.
 *
 * A reader who was lent a server or a domain sees it beside their own - or, with
 * no machines of their own to read, only what they were lent.
 */
export default async function MachinesPage() {
    const user = await requireUser();
    const [t, owns, lentServers, lentDomains] = await Promise.all([
        getTranslations("servers"),
        sessionCan(user, "deploy.read"),
        grantedSubjects(user.id, "place.server"),
        grantedSubjects(user.id, "place.domain")
    ]);
    const borrows = lentServers.size > 0 || lentDomains.size > 0;
    if (!owns && !borrows) {
        return (
            <div className="flex flex-col gap-6">
                <PageHeader title={t("machines.heading")} description={t("machines.intro")} />
                <p className="text-sm text-muted-foreground">{t("machines.nothing")}</p>
            </div>
        );
    }
    const ownerId = owns ? user.id : null;
    return (
        <div className="flex flex-col gap-6">
            <PageHeader title={t("machines.heading")} description={t("machines.intro")} />
            {owns || lentServers.size > 0 ? (
                <Group title={t("machines.servers")}>
                    <Servers ownerId={ownerId} userId={user.id} borrows={lentServers.size > 0} />
                </Group>
            ) : null}
            {owns ? (
                <Group title={t("machines.containers")}>
                    <Containers ownerId={user.id} />
                </Group>
            ) : null}
            {owns || lentDomains.size > 0 ? (
                <Group title={t("machines.domains")}>
                    <Domains ownerId={ownerId} userId={user.id} borrows={lentDomains.size > 0} />
                </Group>
            ) : null}
        </div>
    );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">{title}</h2>
            <Suspense fallback={<Skeleton className="h-28 w-full rounded-xl" />}>
                {children}
            </Suspense>
        </section>
    );
}

async function Servers({
    ownerId,
    userId,
    borrows
}: {
    ownerId: string | null;
    userId: string;
    borrows: boolean;
}) {
    const t = await getTranslations("servers");
    const [own, lent] = await Promise.all([
        ownerId ? machines.machineServerPage(ownerId, null) : { items: [], next: null },
        borrows ? machines.lentMachineServers(userId, t("machines.lent")) : []
    ]);
    return (
        <MachineCards
            kind="servers"
            cards={[...own.items, ...lent]}
            next={own.next}
            empty={t("machines.noServers")}
            label={t("machines.servers")}
        />
    );
}

async function Containers({ ownerId }: { ownerId: string }) {
    const [t, page] = await Promise.all([
        getTranslations("servers"),
        machines.machineContainerPage(ownerId, null)
    ]);
    return (
        <MachineCards
            kind="containers"
            cards={page.items}
            next={page.next}
            empty={t("machines.noContainers")}
            label={t("machines.containers")}
        />
    );
}

async function Domains({
    ownerId,
    userId,
    borrows
}: {
    ownerId: string | null;
    userId: string;
    borrows: boolean;
}) {
    const [own, lent] = await Promise.all([
        ownerId ? machines.machineDomainPage(ownerId, null) : { items: [], next: null },
        borrows ? machines.lentMachineDomains(userId) : []
    ]);
    return <MachineDomains rows={[...own.items, ...lent]} next={own.next} />;
}
