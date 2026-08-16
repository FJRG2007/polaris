"use client";

import Link from "next/link";
import { useState } from "react";
import { cn } from "@polaris/ui";
import { useRouter } from "next/navigation";
import { PRESENCE_CHOICES, PRESENCE_LABELS, type PresenceChoice } from "@polaris/core";
import { setPresenceAction } from "@/app/(app)/account/preferences/actions";
import { signOut } from "@/lib/auth-client";
import { Avatar } from "@/components/avatar";
import { Bell, Check, Link2, LogOut, UserCog } from "lucide-react";
import { noteSignOutAction } from "@/app/(app)/account/sessions/actions";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@polaris/ui";

/**
 * The personal account dropdown. Only per-user items live here; administration
 * (users, policies, domains, integrations, updates, ...) moved to the dedicated
 * Management app in the switcher, so this menu stays about "you", not the system.
 */
export function AccountMenu({
    id,
    name,
    email,
    presence
}: {
    id: string;
    name: string;
    email: string;
    /** What this account has chosen to appear as. */
    presence: PresenceChoice;
}) {
    const router = useRouter();
    const [chosen, setChosen] = useState(presence);

    async function onSignOut() {
        // While the session still exists, so the account's own history and its
        // other devices record that this one left. Never a reason to refuse the
        // sign-out itself.
        await noteSignOutAction().catch(() => undefined);
        await signOut();
        router.push("/oauth/login");
        router.refresh();
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                aria-label="Your account"
                className="rounded-full "
            >
                <Avatar person={{ id, name }} size={32} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuLabel>
                    <span className="block text-sm font-medium text-foreground">{name}</span>
                    <span className="block truncate">{email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {/* Where the status lives in every application that has one: on
                    your own face, one press from anywhere. A settings page would
                    be the right place for a preference and the wrong one for
                    something people change three times a day. */}
                {PRESENCE_CHOICES.map((choice) => (
                    <DropdownMenuItem
                        key={choice}
                        onSelect={async () => {
                            setChosen(choice);
                            await setPresenceAction(choice);
                            // The dots on screen are the store's, and it asks
                            // again on its own - but not for another minute, and
                            // your own face is the one you are looking at.
                            router.refresh();
                        }}
                    >
                        <span
                            aria-hidden="true"
                            className={cn("size-2 shrink-0 rounded-full", PRESENCE_DOTS[choice])}
                        />
                        <span className="flex-1">{PRESENCE_LABELS[choice]}</span>
                        {chosen === choice && <Check className="size-3.5 text-primary" />}
                    </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                    <Link href="/account">
                        <UserCog className="size-4" />
                        My account
                    </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                    <Link href="/account/notifications">
                        <Bell className="size-4" />
                        Notifications
                    </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                    <Link href="/drive/shared-links">
                        <Link2 className="size-4" />
                        Shared links
                    </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onSignOut}>
                    <LogOut className="size-4" />
                    Sign out
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** The colour beside each choice, so the menu says what the dot will look like
 *  rather than only what it is called. */
const PRESENCE_DOTS: Record<PresenceChoice, string> = {
    auto: "bg-success",
    busy: "bg-danger",
    away: "bg-warning",
    invisible: "bg-border-strong"
};
