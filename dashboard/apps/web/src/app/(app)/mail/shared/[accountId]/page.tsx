/**
 * One mailbox somebody let this person read (/mail/shared/<id>): its inbox,
 * newest first, and one message opened as plain text beside it (`?m=<id>`).
 *
 * Read only, on purpose - see `lib/mailbox/delegate.ts`. Nothing on this screen
 * replies, sends, moves or marks a message read, so the holder's mailbox looks
 * exactly as it did before the delegate opened it.
 */

import Link from "next/link";
import { Badge, cn } from "@polaris/ui";
import { Paperclip } from "lucide-react";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { MailAccessError } from "@/lib/mailbox/access";
import { RelativeTime } from "@/components/relative-time";
import { delegatedInbox, delegatedMessage } from "@/lib/mailbox/delegate";

export const dynamic = "force-dynamic";

/** The page's own query: a message to open and where the list resumes. */
function readQuery(query: Record<string, string | string[] | undefined>) {
    const one = (value: string | string[] | undefined) =>
        typeof value === "string" ? value.trim() : "";
    const uuid = (value: string) => (/^[0-9a-f-]{36}$/i.test(value) ? value : null);
    const before = new Date(one(query.before));
    const afterId = uuid(one(query.after));
    return {
        messageId: uuid(one(query.m)),
        after:
            Number.isNaN(before.getTime()) || !afterId ? undefined : { sentAt: before, id: afterId }
    };
}

/** The query that resumes the list after one row. */
function resume(row: { sentAt: Date; id: string }): string {
    return `before=${encodeURIComponent(row.sentAt.toISOString())}&after=${row.id}`;
}

export default async function SharedMailboxPage({
    params,
    searchParams
}: {
    params: Promise<{ accountId: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const user = await requirePermission("mail.use");
    const { accountId } = await params;
    const { messageId, after } = readQuery(await searchParams);
    const t = await getTranslations("mail");

    const read = async () => {
        try {
            const inbox = await delegatedInbox(user.id, accountId, after);
            const open = messageId
                ? await delegatedMessage(user.id, accountId, messageId).catch((caught) => {
                      if (caught instanceof MailAccessError) return null;
                      throw caught;
                  })
                : null;
            return { ...inbox, open };
        } catch (caught) {
            if (caught instanceof MailAccessError) return null;
            throw caught;
        }
    };
    const found = await read();
    if (!found) notFound();
    const { mailbox, rows, more, open } = found;
    const base = `/mail/shared/${mailbox.id}`;
    const keep = after ? `&${resume(after)}` : "";
    const older = rows.at(-1);

    return (
        <div className="mx-auto w-full max-w-6xl px-4 py-6">
            <div className="mb-4 flex min-w-0 flex-wrap items-center gap-3">
                <h1
                    className="min-w-0 truncate text-[17px] font-semibold tracking-tight"
                    title={mailbox.address}
                >
                    {mailbox.label || mailbox.address}
                </h1>
                <Badge variant="neutral">{t("delegate.sharedWithYou")}</Badge>
                <Badge variant="neutral">{t("delegate.readOnly")}</Badge>
                <Link
                    href="/mail/shared"
                    className="text-[12px] text-muted-foreground hover:text-foreground"
                >
                    {t("delegate.allShared")}
                </Link>
            </div>
            <p className="mb-4 text-xs text-muted-foreground">{t("delegate.note")}</p>

            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <section aria-label={t("delegate.inbox")} className="min-w-0">
                    {rows.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("delegate.empty")}</p>
                    ) : (
                        <ul className="divide-y divide-border rounded-md border border-border">
                            {rows.map((row) => (
                                <li key={row.id}>
                                    <Link
                                        href={`${base}?m=${row.id}${keep}`}
                                        aria-current={open?.id === row.id ? "true" : undefined}
                                        className={cn(
                                            "block min-w-0 px-3 py-2 hover:bg-muted/50",
                                            open?.id === row.id && "bg-muted"
                                        )}
                                    >
                                        <span className="flex min-w-0 items-baseline gap-2">
                                            <span className="min-w-0 flex-1 truncate text-sm font-medium">
                                                {row.from || t("delegate.unknownSender")}
                                            </span>
                                            {row.hasAttachments ? (
                                                <Paperclip
                                                    className="size-3.5 shrink-0 text-muted-foreground"
                                                    aria-label={t("delegate.attachments")}
                                                />
                                            ) : null}
                                            <span className="shrink-0 text-xs text-muted-foreground">
                                                <RelativeTime iso={row.sentAt.toISOString()} />
                                            </span>
                                        </span>
                                        <span className="block truncate text-sm">
                                            {row.subject || t("delegate.noSubject")}
                                        </span>
                                        <span className="block truncate text-xs text-muted-foreground">
                                            {row.snippet}
                                        </span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                    {more && older ? (
                        <Link
                            href={`${base}?${resume(older)}`}
                            className="mt-3 inline-block text-sm text-muted-foreground hover:text-foreground"
                        >
                            {t("delegate.older")}
                        </Link>
                    ) : null}
                </section>

                <section aria-label={t("delegate.message")} className="min-w-0">
                    {open ? (
                        <article className="min-w-0 rounded-md border border-border p-4">
                            <h2 className="mb-2 break-words text-base font-semibold">
                                {open.subject || t("delegate.noSubject")}
                            </h2>
                            <dl className="mb-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                                <dt className="text-muted-foreground">{t("delegate.from")}</dt>
                                <dd className="break-words">{open.from}</dd>
                                <dt className="text-muted-foreground">{t("delegate.to")}</dt>
                                <dd className="break-words">{open.to.join(", ")}</dd>
                                {open.cc.length > 0 ? (
                                    <>
                                        <dt className="text-muted-foreground">{t("delegate.cc")}</dt>
                                        <dd className="break-words">{open.cc.join(", ")}</dd>
                                    </>
                                ) : null}
                                <dt className="text-muted-foreground">{t("delegate.date")}</dt>
                                <dd>
                                    <RelativeTime iso={open.sentAt.toISOString()} />
                                </dd>
                            </dl>
                            <div className="whitespace-pre-wrap break-words text-sm">
                                {open.bodyText ?? open.snippet}
                            </div>
                            {open.bodyText === null ? (
                                <p className="mt-3 text-xs text-muted-foreground">
                                    {t("delegate.bodyPending")}
                                </p>
                            ) : null}
                        </article>
                    ) : (
                        <p className="text-sm text-muted-foreground">{t("delegate.pick")}</p>
                    )}
                </section>
            </div>
        </div>
    );
}
