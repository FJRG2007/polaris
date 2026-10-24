/**
 * Mailboxes lent to this person (/mail/shared), each with how far: see
 * `lib/mailbox/delegate.ts`.
 */

import Link from "next/link";
import { Badge } from "@polaris/ui";
import { Inbox } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { delegatedMailboxes } from "@/lib/mailbox/delegate";

export const dynamic = "force-dynamic";

export default async function SharedMailboxesPage() {
    const user = await requirePermission("mail.use");
    const [t, mailboxes] = await Promise.all([
        getTranslations("mail"),
        delegatedMailboxes(user.id)
    ]);
    return (
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
            <div className="mb-4 flex flex-wrap items-baseline gap-3">
                <h1 className="text-[17px] font-semibold tracking-tight">{t("delegate.title")}</h1>
                <Link
                    href="/mail"
                    className="text-[12px] text-muted-foreground hover:text-foreground"
                >
                    {t("delegate.back")}
                </Link>
            </div>
            {mailboxes.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("delegate.none")}</p>
            ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                    {mailboxes.map((mailbox) => (
                        <li key={mailbox.id}>
                            <Link
                                href={`/mail/shared/${mailbox.id}`}
                                className="flex min-w-0 items-center gap-3 px-3 py-2.5 hover:bg-muted/50"
                            >
                                <Inbox
                                    className="size-4 shrink-0 text-muted-foreground"
                                    aria-hidden
                                />
                                <span
                                    className="min-w-0 flex-1 truncate text-sm"
                                    title={mailbox.address}
                                >
                                    {mailbox.label || mailbox.address}
                                </span>
                                <Badge variant="neutral">
                                    {t(`delegate.level.${mailbox.level}`)}
                                </Badge>
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
