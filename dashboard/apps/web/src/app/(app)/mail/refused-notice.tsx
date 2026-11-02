"use client";

/**
 * The notice a mailbox gets when its server stops accepting it.
 *
 * It says what is most likely wrong, because "your password" over a server's bad
 * morning sends somebody to change a password that was fine. Mailboxes refused
 * together are one notice about the server. Only a credential is shown as something
 * to fix; the rest are Polaris waiting, with a button to try now. Drawn in the rail,
 * which is narrow, and at the top of the list.
 */

import Link from "next/link";
import { Button, cn } from "@polaris/ui";
import { useState } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { syncAccountAction } from "./actions";
import { runAction } from "@/lib/run-action";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { MailAccountView } from "@/lib/mailbox/accounts";
import { refusalCause, refusedMailboxHref } from "@/lib/mailbox/refusals";

type NoticeAccount = Pick<
    MailAccountView,
    "id" | "address" | "auth" | "state" | "imapHost" | "lastOkAt" | "refusedSince" | "lastRefusedAt"
>;

/** One thing to say about the refused mailboxes, in rail order. */
export interface RefusedNotice {
    readonly key: string;
    readonly cause: "authorization" | "server" | "recent" | "password";
    /** The mailbox, or for `server` the mail server. */
    readonly subject: string;
    readonly accountIds: readonly string[];
    readonly href: string;
}

/** What to say about the refused mailboxes, with those a server refused together as
 *  one notice about that server. */
export function refusedNotices(
    accounts: readonly NoticeAccount[],
    now = Date.now()
): RefusedNotice[] {
    const refused = accounts.filter((account) => account.state === "auth");
    const notices: RefusedNotice[] = [];
    const servers = new Map<string, { ids: string[] }>();
    for (const account of refused) {
        const cause = refusalCause(account, refused, now);
        if (cause === "server") {
            const known = servers.get(account.imapHost);
            if (known) {
                known.ids.push(account.id);
                continue;
            }
            const ids = [account.id];
            servers.set(account.imapHost, { ids });
            notices.push({
                key: `server:${account.imapHost}`,
                cause,
                subject: account.imapHost,
                accountIds: ids,
                href: "/mail/settings/accounts"
            });
            continue;
        }
        notices.push({
            key: account.id,
            cause,
            subject: account.address,
            accountIds: [account.id],
            href: refusedMailboxHref(account.id)
        });
    }
    return notices;
}

function Notice({ notice, onNavigate }: { notice: RefusedNotice; onNavigate?: () => void }) {
    const t = useTranslations("mail");
    const [pending, setPending] = useState(false);
    const [retried, setRetried] = useState(false);
    const [error, setError] = useState("");
    const fix = notice.cause === "password" || notice.cause === "authorization";
    const Icon = fix ? AlertTriangle : Info;

    async function retry(): Promise<void> {
        setPending(true);
        setError("");
        const results = await runAction<{ error?: string }[]>(
            () => Promise.all(notice.accountIds.map((id) => syncAccountAction(id))),
            setError
        );
        setPending(false);
        if (!results) return;
        setRetried(true);
        const refused = results.find((result) => result.error);
        if (refused?.error) setError(refused.error);
    }

    return (
        <li
            role="status"
            className={cn(
                "flex min-w-0 flex-col gap-1.5 rounded-md border px-2.5 py-2 text-[12px]",
                fix ? "border-warning-edge bg-warning-soft" : "border-border bg-card"
            )}
        >
            <div className="flex min-w-0 items-start gap-2">
                <Icon
                    className={cn(
                        "mt-0.5 size-3.5 shrink-0",
                        fix ? "text-warning" : "text-muted-foreground"
                    )}
                    aria-hidden
                />
                <div className="min-w-0 flex-1">
                    <p className="font-medium text-foreground">{t(`refused.${notice.cause}Title`)}</p>
                    <p className="truncate text-muted-foreground" title={notice.subject}>
                        {notice.subject}
                    </p>
                </div>
            </div>
            <p className="text-muted-foreground">
                {t(`refused.${notice.cause}Body`, { count: notice.accountIds.length })}
            </p>
            {error ? <p className="text-danger">{error}</p> : null}
            <div className="flex flex-wrap gap-1.5">
                {notice.cause === "server" || notice.cause === "recent" ? (
                    <Button size="xs" variant="outline" disabled={pending} onClick={retry}>
                        {retried && !pending ? t("refused.stillRefused") : t("refused.retry")}
                    </Button>
                ) : null}
                {notice.cause === "server" ? null : (
                    <Button asChild size="xs" variant={fix ? "outline" : "ghost"}>
                        <Link href={notice.href} onClick={onNavigate}>
                            {notice.cause === "authorization"
                                ? t("refused.reconnect")
                                : t("refused.updatePassword")}
                        </Link>
                    </Button>
                )}
            </div>
        </li>
    );
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
    const t = useTranslations("mail");
    const notices = refusedNotices(accounts);
    if (notices.length === 0) return null;
    return (
        <ul className={cn("min-w-0 space-y-1.5", className)} aria-label={t("refused.label")}>
            {notices.map((notice) => (
                <Notice key={notice.key} notice={notice} onNavigate={onNavigate} />
            ))}
        </ul>
    );
}
