"use client";

/**
 * "Add calendar": every way a calendar gets here, in one menu - from a Google
 * or Microsoft account, from a CalDAV server, by subscribing to an address, a
 * holiday calendar, a file, or a new one of one's own.
 *
 * The accounts are read when the menu first opens (and kept, so the accounts
 * screen paints from the same answer). Google and Microsoft go straight to
 * their consent screen when that can work; when the operator has not set them
 * up the item says so, and for an administrator it leads to the setup.
 */

import Link from "next/link";
import { useCalendarT } from "../i18n";
import { useState, type ReactNode } from "react";
import { hostUi } from "@polaris/app-host/client";
import { CalendarPlus, FileUp, Globe, Link2, ListTodo, Loader2, Server } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@polaris/ui";
import {
    PROVIDER_NAMES,
    linkTarget,
    setupHref,
    useAccounts,
    type LinkProvider
} from "./provider-link";

export interface AddCalendarMenuProps {
    /** The button that opens it. */
    readonly children: ReactNode;
    readonly align?: "start" | "end";
    /** A calendar of one's own, with or without tasks. */
    readonly onCreate: (withTasks: boolean) => void;
    /** The subscribe and holidays dialog, on that tab. */
    readonly onAddFrom: ((tab: "subscribe" | "holidays") => void) | null;
}

/** An item and the line under it saying why it is the way it is. */
function TwoLines({ label, hint }: { label: string; hint: string }) {
    return (
        <span className="flex min-w-0 flex-col">
            <span className="truncate" title={label}>{label}</span>
            <span className="whitespace-normal text-xs text-foreground-subtle">{hint}</span>
        </span>
    );
}

function ProviderItem({
    provider,
    label,
    accounts
}: {
    provider: LinkProvider;
    label: string;
    accounts: ReturnType<typeof useAccounts>;
}) {
    const t = useCalendarT();
    const Logo = hostUi.logos.IntegrationLogo;
    const data = accounts.data;
    const name = PROVIDER_NAMES[provider];
    if (!data) {
        return (
            <DropdownMenuItem disabled>
                {accounts.error ? (
                    <Logo slug={provider} className="size-4" />
                ) : (
                    <Loader2 className="animate-spin" aria-hidden />
                )}
                {accounts.error ? (
                    <TwoLines label={label} hint={t("addMenu.unreadable")} />
                ) : (
                    label
                )}
            </DropdownMenuItem>
        );
    }
    if (data.linkAvailable[provider]) {
        const href = linkTarget(data, provider);
        return (
            <DropdownMenuItem asChild>
                {href.startsWith("/api/") ? (
                    // A route that redirects to the provider: a real navigation.
                    <a href={href}>
                        <Logo slug={provider} className="size-4" />
                        {label}
                    </a>
                ) : (
                    <Link href={href}>
                        <Logo slug={provider} className="size-4" />
                        {label}
                    </Link>
                )}
            </DropdownMenuItem>
        );
    }
    if (data.canManage) {
        return (
            <DropdownMenuItem asChild>
                <Link href={setupHref(provider)}>
                    <Logo slug={provider} className="size-4" />
                    <TwoLines
                        label={label}
                        hint={t("addMenu.setUpFirst", { provider: name })}
                    />
                </Link>
            </DropdownMenuItem>
        );
    }
    return (
        <DropdownMenuItem disabled className="data-[disabled]:opacity-100">
            <Logo slug={provider} className="size-4 opacity-50" />
            <span className="opacity-60">
                <TwoLines label={label} hint={t("addMenu.askAdmin", { provider: name })} />
            </span>
        </DropdownMenuItem>
    );
}

export function AddCalendarMenu({ children, align = "start", onCreate, onAddFrom }: AddCalendarMenuProps) {
    const t = useCalendarT();
    const [opened, setOpened] = useState(false);
    const accounts = useAccounts(opened);

    return (
        <DropdownMenu onOpenChange={(open) => open && setOpened(true)}>
            <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
            <DropdownMenuContent align={align} className="w-72">
                <ProviderItem provider="google" label={t("addMenu.google")} accounts={accounts} />
                <ProviderItem
                    provider="microsoft"
                    label={t("addMenu.microsoft")}
                    accounts={accounts}
                />
                <DropdownMenuItem asChild>
                    <Link href="/calendar/settings/accounts#caldav">
                        <Server />
                        <TwoLines label={t("addMenu.caldav")} hint={t("addMenu.caldavHint")} />
                    </Link>
                </DropdownMenuItem>
                {onAddFrom ? (
                    <>
                        <DropdownMenuItem onSelect={() => onAddFrom("subscribe")}>
                            <Link2 />
                            {t("addMenu.subscribe")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onAddFrom("holidays")}>
                            <Globe />
                            {t("addMenu.holidays")}
                        </DropdownMenuItem>
                    </>
                ) : null}
                <DropdownMenuItem asChild>
                    <Link href="/calendar/settings#transfer">
                        <FileUp />
                        {t("addMenu.import")}
                    </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onCreate(false)}>
                    <CalendarPlus />
                    {t("sidebar.newCalendar")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onCreate(true)}>
                    <ListTodo />
                    {t("sidebar.newWithTasks")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
