"use client";

/**
 * The first thing on the calendar's settings: the accounts calendars come in
 * from, how each is doing, and the ways to link one more - so somebody who
 * opens the settings looking for "where do I link Google" finds it on top.
 *
 * Drawn at once; only the list waits for its answer, in rows shaped like it.
 * The full screen (refresh intervals, passwords, removing) is one click away.
 */

import Link from "next/link";
import { useCalendarT } from "../i18n";
import { StatusNote } from "../public/kit";
import { ProviderLinkButton, useAccounts } from "./provider-link";
import { AlertTriangle, ArrowRight, CheckCircle2, Link2, Server } from "lucide-react";
import { Button, Card, CardBody, CardHeader, CardTitle, cn, Skeleton } from "@polaris/ui";

/** How many sources the summary lists before pointing at the full screen. */
const SHOWN = 6;

export function AccountsSection() {
    const t = useCalendarT();
    const accounts = useAccounts();
    const data = accounts.data;
    const hasGoogle = data?.links.some((link) => link.provider === "google") ?? false;
    const hasMicrosoft = data?.links.some((link) => link.provider === "microsoft") ?? false;

    return (
        <Card id="accounts" className="scroll-mt-4">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
                <CardTitle>
                    <span role="heading" aria-level={2}>
                        {t("settingsPage.accounts")}
                    </span>
                </CardTitle>
                <Button asChild size="sm" variant="ghost">
                    <Link href="/calendar/settings/accounts">
                        {t("settingsPage.accountsManage")}
                        <ArrowRight />
                    </Link>
                </Button>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <p className="text-xs text-foreground-subtle">{t("settingsPage.accountsLead")}</p>
                {accounts.error && !data ? (
                    <div className="flex items-center gap-2">
                        <StatusNote tone="danger" className="flex-1">
                            {t("accounts.loadFailed")}
                        </StatusNote>
                        <Button variant="outline" size="sm" onClick={accounts.refresh}>
                            {t("accounts.retry")}
                        </Button>
                    </div>
                ) : !data ? (
                    <div className="flex flex-col gap-2" aria-hidden>
                        <Skeleton className="h-5 w-64 max-w-full" />
                        <Skeleton className="h-5 w-48 max-w-full" />
                    </div>
                ) : data.sources.length === 0 ? (
                    <p className="text-[0.8125rem] text-muted-foreground">
                        {t("settingsPage.accountsNone")}
                    </p>
                ) : (
                    <ul className="flex flex-col gap-1.5">
                        {data.sources.slice(0, SHOWN).map((source) => {
                            const name = source.label || t(`accounts.kinds.${source.kind}`);
                            const ok = source.status === "ok";
                            return (
                                <li key={source.id} className="flex min-w-0 items-center gap-2">
                                    <span className="min-w-0 flex-1 truncate" title={name}>
                                        {name}
                                    </span>
                                    <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                        {t(`accounts.kinds.${source.kind}`)}
                                    </span>
                                    <span
                                        className={cn(
                                            "inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]",
                                            ok
                                                ? "border-success-edge bg-success-soft text-success-ink"
                                                : "border-warning-edge bg-warning-soft text-warning-ink"
                                        )}
                                    >
                                        {ok ? (
                                            <CheckCircle2 className="size-3" aria-hidden />
                                        ) : (
                                            <AlertTriangle className="size-3" aria-hidden />
                                        )}
                                        {t(`accounts.status.${source.status}`)}
                                    </span>
                                </li>
                            );
                        })}
                        {data.sources.length > SHOWN ? (
                            <li className="text-xs text-foreground-subtle">
                                <Link
                                    href="/calendar/settings/accounts"
                                    className="underline underline-offset-2"
                                >
                                    {t("settingsPage.accountsMore", {
                                        count: data.sources.length - SHOWN
                                    })}
                                </Link>
                            </li>
                        ) : null}
                    </ul>
                )}
                <div className="flex flex-wrap items-start gap-2">
                    {data ? (
                        <>
                            <ProviderLinkButton
                                provider="google"
                                accounts={data}
                                label={
                                    hasGoogle
                                        ? t("accounts.linkAnotherGoogle")
                                        : t("accounts.linkGoogle")
                                }
                            />
                            <ProviderLinkButton
                                provider="microsoft"
                                accounts={data}
                                label={
                                    hasMicrosoft
                                        ? t("accounts.linkAnotherMicrosoft")
                                        : t("accounts.linkMicrosoft")
                                }
                            />
                        </>
                    ) : (
                        <>
                            <Skeleton className="h-7 w-44" />
                            <Skeleton className="h-7 w-48" />
                        </>
                    )}
                    <Button asChild size="sm" variant="outline">
                        <Link href="/calendar/settings/accounts#caldav">
                            <Server />
                            {t("addMenu.caldav")}
                        </Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                        <Link href="/calendar/settings/accounts#feed">
                            <Link2 />
                            {t("addMenu.subscribe")}
                        </Link>
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}
