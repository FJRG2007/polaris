"use client";

/**
 * The notice a mailbox gets when its server stops accepting its credential.
 *
 * What a desktop client does when somebody changes their password on the web:
 * it says which mailbox, says what happened in words the person would use, and
 * the button beside it is the fix - not a settings page to go and find it on.
 * Drawn in the rail, which is on every Mail screen, and at the top of the list,
 * which is where somebody looks when mail stops arriving.
 */

import Link from "next/link";
import { Button, cn } from "@polaris/ui";
import { AlertTriangle } from "lucide-react";
import { refusedMailboxHref } from "@/lib/mailbox/refusals";
import type { MailAccountView } from "@/lib/mailbox/accounts";

type NoticeAccount = Pick<MailAccountView, "id" | "address" | "auth" | "state">;

/** One refused mailbox, as the notice says it. */
export interface RefusedNotice {
    readonly id: string;
    readonly sentence: string;
    readonly action: string;
    readonly href: string;
}

/**
 * What to say about each refused mailbox, in rail order.
 *
 * An authorized mailbox has no password to update: what was refused is the
 * token, and the fix is authorizing it again - so it says that instead.
 */
export function refusedNotices(accounts: readonly NoticeAccount[]): RefusedNotice[] {
    return accounts
        .filter((account) => account.state === "auth")
        .map((account) => ({
            id: account.id,
            sentence:
                account.auth === "oauth"
                    ? `${account.address} stopped accepting its authorization`
                    : `${account.address} stopped accepting its password`,
            action: account.auth === "oauth" ? "Reconnect" : "Update password",
            href: refusedMailboxHref(account.id)
        }));
}

export function RefusedMailboxes({
    accounts,
    className,
    onNavigate
}: {
    accounts: readonly NoticeAccount[];
    className?: string;
    onNavigate?: () => void;
}) {
    const notices = refusedNotices(accounts);
    if (notices.length === 0) return null;
    return (
        <ul className={cn("space-y-1.5", className)} aria-label="Mailboxes that need attention">
            {notices.map((notice) => (
                <li
                    key={notice.id}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border border-warning-edge bg-warning-soft px-2.5 py-2 text-[12px]"
                    role="status"
                >
                    <AlertTriangle className="size-3.5 shrink-0 text-warning" aria-hidden />
                    <span className="min-w-0 flex-1 break-words">{notice.sentence}</span>
                    <Button asChild size="xs" variant="outline" className="shrink-0">
                        <Link href={notice.href} onClick={onNavigate}>
                            {notice.action}
                        </Link>
                    </Button>
                </li>
            ))}
        </ul>
    );
}
