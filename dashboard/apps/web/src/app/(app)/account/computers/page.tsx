/**
 * Your computers (/account/computers): the computers this account paired so
 * Polar Code can run agents on them, and the button that pairs another.
 */

import { Suspense } from "react";
import { Skeleton } from "@polaris/ui";
import { requireUser, sessionCan } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { listComputers } from "@/lib/computers/computer-service";
import { ComputersView } from "./computers-view";

export const dynamic = "force-dynamic";

async function ComputerList({ userId }: { userId: string }) {
    return <ComputersView initial={await listComputers(userId)} />;
}

export default async function ComputersPage() {
    const user = await requireUser();
    const t = await getTranslations("account");
    const allowed = await sessionCan(user, "agents.manage");
    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
            <div className="min-w-0">
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("computers.page.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("computers.page.intro")}</p>
            </div>
            {allowed ? (
                <Suspense
                    fallback={
                        <div className="flex flex-col gap-2" aria-hidden>
                            <Skeleton className="h-9 w-36" />
                            <Skeleton className="h-16 w-full" />
                        </div>
                    }
                >
                    <ComputerList userId={user.id} />
                </Suspense>
            ) : (
                <p className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
                    {t("computers.page.noAccess")}
                </p>
            )}
        </div>
    );
}
