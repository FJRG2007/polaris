/**
 * One mailbox lent to this person (/mail/shared/<id>): its inbox, newest
 * first, one message opened as plain text beside it (`?m=<id>`), and what the
 * grant's level lets them do there - see `lib/mailbox/delegate.ts`. Opening a
 * message never marks it read; only pressing Mark read does, at `manage`.
 */

import Link from "next/link";
import { Badge } from "@polaris/ui";
import { DelegateInbox } from "./delegate-inbox";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { mailRefusalText } from "@/lib/mailbox/refusal-text";
import { MailAccessError } from "@/lib/mailbox/access";
import { delegateDrafts } from "@/lib/mailbox/delegate-act";
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
            const [inbox, drafts] = await Promise.all([
                delegatedInbox(user.id, accountId, after),
                delegateDrafts(user.id, accountId)
            ]);
            const open = messageId
                ? await delegatedMessage(user.id, accountId, messageId).catch((caught) => {
                      if (caught instanceof MailAccessError) return null;
                      throw caught;
                  })
                : null;
            return { ...inbox, drafts, open };
        } catch (caught) {
            if (caught instanceof MailAccessError) return null;
            throw caught;
        }
    };
    const found = await read();
    if (!found) notFound();
    const { mailbox, rows, more, open, drafts } = found;
    const base = `/mail/shared/${mailbox.id}`;
    const keep = after ? `&${resume(after)}` : "";
    const older = rows.at(-1);

    return (
        <div className="mx-auto w-full max-w-6xl px-4 py-6">
            <div className="mb-2 flex min-w-0 flex-wrap items-center gap-3">
                <h1
                    className="min-w-0 truncate text-[17px] font-semibold tracking-tight"
                    title={mailbox.address}
                >
                    {mailbox.label || mailbox.address}
                </h1>
                <Badge variant="neutral">{t("delegate.sharedWithYou")}</Badge>
                <Badge variant="neutral">{t(`delegate.level.${mailbox.level}`)}</Badge>
                <Link
                    href="/mail/shared"
                    className="text-[12px] text-muted-foreground hover:text-foreground"
                >
                    {t("delegate.allShared")}
                </Link>
            </div>
            <DelegateInbox
                accountId={mailbox.id}
                address={mailbox.address}
                level={mailbox.level}
                sendAs={mailbox.delegateSendAs}
                base={base}
                keep={keep}
                rows={rows.map((row) => ({ ...row, sentAt: row.sentAt.toISOString() }))}
                open={
                    open
                        ? {
                              ...open,
                              fromLine: open.from,
                              sentAt: open.sentAt.toISOString()
                          }
                        : null
                }
                olderHref={more && older ? `${base}?${resume(older)}` : null}
                drafts={drafts.map((one) => ({
                    id: one.id,
                    subject: one.subject,
                    to: one.to,
                    state: one.state,
                    failure: one.failure ? mailRefusalText(t, one.failure) : "",
                    permanent: one.permanent
                }))}
            />
        </div>
    );
}
