"use client";

/**
 * The shelf switch, next to the app switcher.
 *
 * In the chrome rather than on a page because it applies to every screen at once,
 * and because somebody who has just deployed to the wrong shelf needs to be able
 * to see which one is open without going looking for it.
 *
 * It renders nothing at all for an account that belongs to no organization. A
 * switch with one position is furniture: it takes room in a bar that has little
 * of it and teaches nothing, and the moment they join something it appears.
 */

import Link from "next/link";
import { useState } from "react";
import { OrgAvatar } from "@/components/avatar";
import { PERSONAL_SCOPE, formatScope } from "@polaris/core";
import { setWorkspaceScopeAction } from "@/app/(app)/scope-actions";
import { Check, ChevronsUpDown, Settings2, UserRound } from "lucide-react";
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
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState(false);

    if (organizations.length === 0) return null;

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
        void setWorkspaceScopeAction(value)
            .then((outcome) => {
                if (outcome.error) toast.show({ title: outcome.error });
            })
            .catch(() => toast.show({ title: "That could not be switched. Try again." }))
            .finally(() => setPending(false));
    };

    return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    aria-label={`Working in ${current?.name ?? personalName}`}
                    className="max-w-40 gap-1.5 px-2"
                >
                    {current ? (
                        <OrgAvatar org={current} size={18} />
                    ) : (
                        <UserRound className="text-muted-foreground size-4 shrink-0" />
                    )}
                    <span className="truncate text-sm" title={current?.name ?? personalName}>
                        {current?.name ?? personalName}
                    </span>
                    <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-56">
                <DropdownMenuLabel>Working in</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => choose(PERSONAL_SCOPE)}>
                    <UserRound className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate" title={personalName}>{personalName}</span>
                    {current === null && <Check className="size-4 shrink-0" />}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {organizations.map((org) => (
                    <DropdownMenuItem key={org.id} onSelect={() => choose(formatScope({ kind: "org", orgId: org.id }))}>
                        <OrgAvatar org={org} size={18} />
                        <span className="min-w-0 flex-1 truncate" title={org.name}>{org.name}</span>
                        {current?.id === org.id && <Check className="size-4 shrink-0" />}
                    </DropdownMenuItem>
                ))}
                {current && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild>
                            <Link href={`/account/organizations/${current.slug}`}>
                                <Settings2 className="size-4 shrink-0" />
                                Manage {current.name}
                            </Link>
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
