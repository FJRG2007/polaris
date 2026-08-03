"use client";

import { useRouter } from "next/navigation";
import { signOut } from "@/lib/auth-client";
import { Avatar } from "@/components/avatar";
import { Bell, Link2, LogOut, UserCog } from "lucide-react";
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
export function AccountMenu({ id, name, email }: { id: string; name: string; email: string }) {
    const router = useRouter();

    async function onSignOut() {
        await signOut();
        router.push("/oauth/login");
        router.refresh();
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                aria-label="Your account"
                className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                <Avatar person={{ id, name }} size={32} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuLabel>
                    <span className="block text-sm font-medium text-foreground">{name}</span>
                    <span className="block truncate">{email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                    <a href="/account">
                        <UserCog className="size-4" />
                        My account
                    </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                    <a href="/account/notifications">
                        <Bell className="size-4" />
                        Notifications
                    </a>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                    <a href="/drive/shared-links">
                        <Link2 className="size-4" />
                        Shared links
                    </a>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onSignOut}>
                    <LogOut className="size-4" />
                    Sign out
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
