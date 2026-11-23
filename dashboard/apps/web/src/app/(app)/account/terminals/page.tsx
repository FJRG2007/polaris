/**
 * Your terminals (/account/terminals): every Polaris Terminal this account
 * signed in and every one shared with it, each opened from here through the
 * relay.
 */

import { Suspense } from "react";
import { Skeleton } from "@polaris/ui";
import { TerminalsView } from "./terminals-view";
import { getTranslations } from "@/lib/i18n/request";
import { requireUser, sessionCan } from "@/lib/session";
import { listTerminals } from "@/lib/terminal/instances";

export const dynamic = "force-dynamic";

async function TerminalList({ userId, open }: { userId: string; open: string | null }) {
    return <TerminalsView initial={await listTerminals(userId)} openId={open} />;
}

export default async function TerminalsPage({ searchParams }: { searchParams: Promise<{ open?: string }> }) {
    const user = await requireUser();
    const t = await getTranslations("account");
    const allowed = await sessionCan(user, "terminal.control");
    const { open } = await searchParams;
    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
            <div className="min-w-0">
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("terminals.page.title")}</h1>
                <p className="text-sm text-muted-foreground">{t("terminals.page.intro")}</p>
            </div>
            {allowed ? (
                <Suspense
                    fallback={
                        <div className="flex flex-col gap-2" aria-hidden>
                            <Skeleton className="h-16 w-full" />
                            <Skeleton className="h-16 w-full" />
                        </div>
                    }
                >
                    <TerminalList userId={user.id} open={typeof open === "string" ? open : null} />
                </Suspense>
            ) : (
                <p className="rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
                    {t("terminals.page.noAccess")}
                </p>
            )}
        </div>
    );
}
