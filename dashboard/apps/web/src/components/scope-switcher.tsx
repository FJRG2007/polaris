"use client";

/**
 * The shelf switch, next to the app switcher.
 *
 * In the chrome rather than on a page because it applies to every screen at once,
 * and because somebody who has just deployed to the wrong shelf needs to be able
 * to see which one is open without going looking for it.
 *
 * It is also where another account signed in on this browser is picked: which
 * account and which shelf are the same question - who am I working as - so they
 * are answered in one place. That is why it is drawn for an account in no
 * organization too: the shelf has one position, but the accounts do not.
 */

import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { OrgAvatar } from "@/components/avatar";
import { shelfKey } from "@/lib/shelf";
import { announceShelf, announcedShelf } from "@/lib/shelf-announce";
import { PERSONAL_SCOPE, formatScope, parseScope, scopeOrgId } from "@polaris/core";
import { setWorkspaceScopeAction } from "@/app/(app)/scope-actions";
import { AccountSwitcherDialog } from "@/components/device-accounts";
import { Check, ChevronsUpDown, Settings2, UserRound, Users } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    useToast
} from "@polaris/ui";

export interface ScopeOption {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
}

/** How long a switch that went through stays announced. Only a backstop: the
 *  announcement stops counting as soon as the server's frame shows the new
 *  shelf. */
const ANNOUNCED_FOR_MS = 10_000;

export function ScopeSwitcher({
    personalName,
    organizations,
    current
}: {
    /** What the personal shelf is called: the account's own name. */
    personalName: string;
    organizations: ScopeOption[];
    /** The organization currently open, or null for the personal shelf. */
    current: ScopeOption | null;
}) {
    const toast = useToast();
    const t = useTranslations("components");
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState(false);
    const [switching, setSwitching] = useState(false);

    /**
     * Move to another shelf.
     *
     * Not a transition, and no refresh after it. An async transition holds every
     * other transition until it ends, and every navigation is one - so while the
     * server rendered the new shelf, nothing on screen could be pressed or left.
     * And the action already answers with that render: it revalidates every
     * layout, the router applies what comes back, and asking the router to
     * refresh after it rendered the whole signed-in frame a second time for
     * nothing.
     */
    const choose = (value: string) => {
        setOpen(false);
        setPending(true);
        // Said before the server is asked, so a screen that can draw the other
        // shelf from what it kept does so now - see `shelf-announce`. Withdrawn
        // if the switch is refused, which puts that screen back.
        const switching = {
            from: shelfKey(current?.id ?? null),
            to: shelfKey(scopeOrgId(parseScope(value)))
        };
        announceShelf(switching);
        const withdraw = () => {
            if (announcedShelf() === switching) announceShelf(null);
        };
        void setWorkspaceScopeAction(value)
            .then((outcome) => {
                if (outcome.error) {
                    withdraw();
                    toast.show({ title: outcome.error });
                    return;
                }
                // The new frame is on its way with the answer; the announcement
                // stops counting once it lands, and is cleared well after.
                setTimeout(withdraw, ANNOUNCED_FOR_MS);
            })
            .catch(() => {
                withdraw();
                toast.show({ title: t("scope.failed") });
            })
            .finally(() => setPending(false));
    };

    return (
        <>
            <DropdownMenu open={open} onOpenChange={setOpen}>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        aria-label={t("scope.workingIn", { name: current?.name ?? personalName })}
                        className="max-w-40 gap-1.5 px-2"
                    >
                        {current ? (
                            <OrgAvatar org={current} size={18} />
                        ) : (
                            <UserRound className="text-muted-foreground size-4 shrink-0" />
                        )}
                        <span
                            className="hidden truncate text-sm sm:inline"
                            title={current?.name ?? personalName}
                        >
                            {current?.name ?? personalName}
                        </span>
                        <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-56">
                    <DropdownMenuLabel>{t("scope.heading")}</DropdownMenuLabel>
                    <DropdownMenuItem onSelect={() => choose(PERSONAL_SCOPE)}>
                        <UserRound className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate" title={personalName}>
                            {personalName}
                        </span>
                        {current === null && <Check className="size-4 shrink-0" />}
                    </DropdownMenuItem>
                    {organizations.length > 0 && <DropdownMenuSeparator />}
                    {organizations.map((org) => (
                        <DropdownMenuItem
                            key={org.id}
                            onSelect={() => choose(formatScope({ kind: "org", orgId: org.id }))}
                        >
                            <OrgAvatar org={org} size={18} />
                            <span className="min-w-0 flex-1 truncate" title={org.name}>
                                {org.name}
                            </span>
                            {current?.id === org.id && <Check className="size-4 shrink-0" />}
                        </DropdownMenuItem>
                    ))}
                    {current && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem asChild>
                                <Link href={`/account/organizations/${current.slug}`}>
                                    <Settings2 className="size-4 shrink-0" />
                                    {t("scope.manage", { name: current.name })}
                                </Link>
                            </DropdownMenuItem>
                        </>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setSwitching(true)}>
                        <Users className="size-4 shrink-0" />
                        {t("scope.switchAccounts")}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <AccountSwitcherDialog open={switching} onOpenChange={setSwitching} />
        </>
    );
}
