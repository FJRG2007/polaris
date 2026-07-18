"use client";

import { LogOut } from "lucide-react";
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

export function AccountMenu({ name, email }: { name: string; email: string }) {
    const router = useRouter();
    const initial = name.trim().charAt(0).toUpperCase() || "?";

    async function onSignOut() {
        await signOut();
        router.push("/login");
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
                <DropdownMenuItem onSelect={onSignOut}>
                    <LogOut className="size-4" />
                    Sign out
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
