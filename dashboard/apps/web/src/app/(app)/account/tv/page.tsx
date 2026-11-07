/**
 * Connecting Polaris TV (/account/tv), and keeping the connected ones current.
 *
 * The TV shows a code to scan or to type here. The same approval the CLI's
 * sign-in uses, in a TV's words, finding only a TV's requests. Below it, every
 * TV this account has connected, with the version it runs and an Update button.
 */

import { Suspense } from "react";
import { Skeleton } from "@polaris/ui";
import { requireUser } from "@/lib/session";
import { tvUpdatesAction } from "./actions";
import { TvUpdatesView } from "./tv-updates-view";
import { getTranslations } from "@/lib/i18n/request";
import { CliApproveView } from "../cli/cli-approve-view";

export const dynamic = "force-dynamic";

/** The list waits on the release lookup; the rest of the page does not. */
async function TvUpdates() {
    return <TvUpdatesView initial={await tvUpdatesAction()} />;
}

export default async function TvPage() {
    const user = await requireUser();
    const t = await getTranslations("account");
    return (
        <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("tv.page.title")}
                </h1>
                <p className="text-sm text-muted-foreground">{t("tv.page.intro")}</p>
            </div>
            <CliApproveView
                kind="tv"
                account={t("cli.signedInAs", { name: user.name || user.email })}
            />
            <Suspense
                fallback={
                    <div className="flex flex-col gap-2" aria-hidden>
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-14 w-full" />
                    </div>
                }
            >
                <TvUpdates />
            </Suspense>
        </div>
    );
}
