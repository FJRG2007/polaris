"use client";

/**
 * Linking a Google or Microsoft account, wherever it is offered: the accounts
 * screen, the settings, the sidebar's "Add calendar" menu.
 *
 * A provider the operator has not set up has nowhere to send anybody, so it is
 * never a button that bounces: it says so, and an administrator is handed the
 * way to the setup itself while everybody else is told who can do it.
 */

import Link from "next/link";
import { useId } from "react";
import { useCalendarT } from "../i18n";
import { Button, cn } from "@polaris/ui";
import * as sources from "../../actions/sources";
import { hostUi } from "@polaris/app-host/client";
import type { AccountsView } from "../../actions/sources";
import { cacheKey, unwrap, useCachedRead } from "../cached-read";

export type LinkProvider = "google" | "microsoft";

export const PROVIDER_NAMES: Record<LinkProvider, string> = {
    google: "Google",
    microsoft: "Microsoft"
};

/** Where an administrator sets a provider up. */
export function setupHref(provider: LinkProvider): string {
    return `/admin/integrations?configure=${provider}`;
}

/** The linked accounts and what can be linked, read once and kept: the same
 *  answer the accounts screen paints from. `enabled` false reads nothing. */
export function useAccounts(enabled = true) {
    const t = useCalendarT();
    return useCachedRead<AccountsView>(enabled ? cacheKey("accounts") : null, () =>
        unwrap(() => sources.loadAccountsAction(), t("errors.generic")).then(
            (answer) => answer.accounts
        )
    );
}

/** Where linking one more account of this provider starts: the account already
 *  linked for something else and waiting to be used, else the consent screen. */
export function linkTarget(accounts: AccountsView, provider: LinkProvider): string {
    const waiting = accounts.links.some(
        (link) => link.provider === provider && !link.used && link.grantsCalendar
    );
    return waiting ? "/calendar/settings/accounts#linked" : accounts.linkUrls[provider];
}

/** Why a provider cannot be linked here yet, and what to do about it. */
export function ProviderUnavailable({
    provider,
    canManage,
    className
}: {
    provider: LinkProvider;
    canManage: boolean;
    className?: string;
}) {
    const t = useCalendarT();
    const name = PROVIDER_NAMES[provider];
    return (
        <p className={cn("text-xs text-foreground-subtle", className)}>
            {canManage ? (
                <>
                    {t("accounts.notSetUp.admin", { provider: name })}{" "}
                    <Link
                        href={setupHref(provider)}
                        className="text-foreground underline underline-offset-2"
                    >
                        {t("accounts.notSetUp.setUp", { provider: name })}
                    </Link>
                </>
            ) : (
                t("accounts.notSetUp.member", { provider: name })
            )}
        </p>
    );
}

/** "Link a Google account", or why it cannot be done yet. */
export function ProviderLinkButton({
    provider,
    accounts,
    label
}: {
    provider: LinkProvider;
    accounts: AccountsView;
    label: string;
}) {
    const Logo = hostUi.logos.IntegrationLogo;
    const noteId = useId();
    if (accounts.linkAvailable[provider]) {
        return (
            <Button size="sm" variant="secondary" asChild>
                <a href={accounts.linkUrls[provider]}>
                    <Logo slug={provider} className="size-4" />
                    {label}
                </a>
            </Button>
        );
    }
    return (
        <div className="flex min-w-0 flex-col items-start gap-1">
            <Button size="sm" variant="secondary" disabled aria-describedby={noteId}>
                <Logo slug={provider} className="size-4" />
                {label}
            </Button>
            <div id={noteId}>
                <ProviderUnavailable provider={provider} canManage={accounts.canManage} />
            </div>
        </div>
    );
}
