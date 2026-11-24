"use client";

/**
 * Mail written while Polaris could not be reached, above whatever mailbox is
 * open: each kept send and each kept draft with a clock until Polaris takes it,
 * or with why it was not taken and the things to do about it. A kept draft can
 * be opened again at any time and goes on being written from there.
 */

import { useState } from "react";
import { AlertCircle, Clock, Pencil } from "lucide-react";
import { Button, ConfirmDeleteDialog } from "@polaris/ui";
import { useMail } from "./mail-shell";
import { MAIL_SEND, useKeptMail, type KeptSend } from "./offline-sends";
import { MAIL_DRAFT, type KeptDraft } from "./offline-drafts";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { appWrites, type AppWrite } from "@/lib/offline/app-writes";

const KINDS = [MAIL_SEND, MAIL_DRAFT];

type Kept = KeptSend | KeptDraft;

/** Who it goes to, as one line: the first name or address, and how many more. */
function recipients(kept: Kept): { first: string; more: number } {
    const all = [...kept.to, ...kept.cc, ...kept.bcc];
    const first = all[0];
    return { first: first ? first.name || first.address : "", more: Math.max(0, all.length - 1) };
}

export function KeptSends() {
    const t = useTranslations("mailCompose");
    const { openComposer } = useMail();
    const entries = useKeptMail(KINDS);
    const [discarding, setDiscarding] = useState<AppWrite | null>(null);
    if (entries.length === 0) return null;

    const subjectOf = (entry: AppWrite) => (entry.payload as Kept).subject || t("offline.noSubject");

    /** Back into the composer, which saves it from there; the kept copy goes,
     *  so an older one never lands over what is written next. */
    const reopen = (entry: AppWrite) => {
        const draft = entry.payload as KeptDraft;
        openComposer({
            accountId: draft.accountId,
            to: draft.to,
            cc: draft.cc,
            bcc: draft.bcc,
            subject: draft.subject,
            body: draft.body,
            inReplyToId: draft.inReplyToId ?? null,
            forward: draft.forward ?? false,
            draftId: draft.id,
            kept: { draftKey: draft.draftKey, identityId: draft.identityId, files: draft.files }
        });
        void appWrites.discard(entry.key);
    };

    return (
        <section aria-label={t("offline.title")} className="flex flex-col border-b border-border">
            <ul className="flex flex-col">
                {entries.map((entry) => {
                    const kept = entry.payload as Kept;
                    const draft = entry.kind === MAIL_DRAFT;
                    const to = recipients(kept);
                    const failed = entry.state === "failed";
                    const waiting = draft ? t("offline.draftWaiting") : t("offline.waiting");
                    const notTaken = draft ? t("offline.draftNotSaved") : t("offline.notSent");
                    return (
                        <li key={entry.key} className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm">
                            {failed ? (
                                <AlertCircle className="size-4 shrink-0 text-danger" aria-hidden />
                            ) : draft ? (
                                <Pencil className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                            ) : (
                                <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                            )}
                            <span className="min-w-0 flex-1 truncate" title={subjectOf(entry)}>
                                <span className="font-medium">{subjectOf(entry)}</span>
                                {to.first ? (
                                    <span className="text-muted-foreground">
                                        {" - "}
                                        {to.more > 0
                                            ? t("offline.toMany", { name: to.first, count: to.more })
                                            : t("offline.to", { name: to.first })}
                                    </span>
                                ) : null}
                            </span>
                            <span
                                className={failed ? "min-w-0 max-w-[40%] truncate text-xs text-danger" : "shrink-0 text-xs text-muted-foreground"}
                                title={failed ? entry.reason || notTaken : undefined}
                            >
                                {failed ? entry.reason || notTaken : waiting}
                            </span>
                            {draft ? (
                                <Button size="xs" variant="ghost" onClick={() => reopen(entry)}>
                                    {t("offline.open")}
                                </Button>
                            ) : null}
                            {failed ? (
                                <Button size="xs" variant="ghost" onClick={() => void appWrites.retry(entry)}>
                                    {t("offline.retry")}
                                </Button>
                            ) : null}
                            {failed || draft ? (
                                <Button size="xs" variant="ghost" onClick={() => setDiscarding(entry)}>
                                    {t("offline.discard")}
                                </Button>
                            ) : null}
                        </li>
                    );
                })}
            </ul>
            <ConfirmDeleteDialog
                open={discarding !== null}
                onOpenChange={(open) => !open && setDiscarding(null)}
                name={discarding ? subjectOf(discarding) : ""}
                kind="message"
                requireTyping={false}
                title={discarding?.kind === MAIL_DRAFT ? t("offline.discardDraftTitle") : t("offline.discardTitle")}
                question={t(discarding?.kind === MAIL_DRAFT ? "offline.discardDraftQuestion" : "offline.discardQuestion", {
                    subject: discarding ? subjectOf(discarding) : ""
                })}
                description={discarding?.kind === MAIL_DRAFT ? t("offline.discardDraftBody") : t("offline.discardBody")}
                confirmLabel={t("offline.discard")}
                onConfirm={async () => {
                    if (discarding) await appWrites.discard(discarding.key);
                    setDiscarding(null);
                }}
            />
        </section>
    );
}
