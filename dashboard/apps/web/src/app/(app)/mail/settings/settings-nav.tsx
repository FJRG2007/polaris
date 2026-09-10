"use client";

/** The settings sub-rail. Horizontal, because there are several of them and a
 *  vertical rail beside a vertical rail is a maze. */

import Link from "next/link";
import { cn } from "@polaris/ui";
import { usePathname } from "next/navigation";

const SCREENS = [
    // First, because it is the only one about the person rather than about one
    // of their mailboxes - and the only one worth opening before there is a
    // mailbox at all.
    { label: "General", href: "/mail/settings/general" },
    { label: "Shortcuts", href: "/mail/settings/shortcuts" },
    { label: "Mailboxes", href: "/mail/settings/accounts" },
    { label: "Send-as", href: "/mail/settings/identities" },
    { label: "Labels", href: "/mail/settings/labels" },
    { label: "Filters", href: "/mail/settings/rules" },
    { label: "Signature", href: "/mail/settings/signature" },
    { label: "Privacy", href: "/mail/settings/privacy" },
    { label: "Junk", href: "/mail/settings/junk" },
    { label: "Blocked", href: "/mail/settings/blocked" },
    { label: "Away", href: "/mail/settings/away" },
    { label: "Import and export", href: "/mail/settings/archive" }
];

export function SettingsNav() {
    const pathname = usePathname();
    return (
        <nav
            className="flex flex-wrap gap-1 border-b border-border pb-2"
            aria-label="Mail settings"
        >
            {SCREENS.map((screen) => (
                <Link
                    key={screen.href}
                    href={screen.href}
                    aria-current={pathname === screen.href ? "page" : undefined}
                    className={cn(
                        "rounded-md px-2.5 py-1 text-[13px]",
                        pathname === screen.href
                            ? "bg-card font-medium text-foreground"
                            : "text-muted-foreground hover:bg-card hover:text-foreground"
                    )}
                >
                    {screen.label}
                </Link>
            ))}
        </nav>
    );
}
