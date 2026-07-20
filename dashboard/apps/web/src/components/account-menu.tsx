"use client";

import { Bell, Link2, LogOut, UserCog } from "lucide-react";
import { useRouter } from "next/navigation";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@polaris/ui";
import { signOut } from "@/lib/auth-client";

/**
 * The personal account dropdown. Only per-user items live here; administration
 * (users, policies, domains, integrations, updates, ...) moved to the dedicated
 * Management app in the switcher, so this menu stays about "you", not the system.
 */
export function AccountMenu({ name, email }: { name: string; email: string }) {
    const router = useRouter();
    const initial = name.trim().charAt(0).toUpperCase() || "?";

    async function onSignOut() {
        await signOut();
        router.push("/oauth/login");
        router.refresh();
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger className="grid size-8 place-items-center rounded-full bg-primary/15 text-sm font-medium text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {initial}
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
                    <a href="/notifications">
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
