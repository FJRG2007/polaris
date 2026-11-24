"use client";

/**
 * Mail written while Polaris could not be reached, above whatever mailbox is
 * open: each kept send with a clock until Polaris takes it, or with why it was
 * not taken and the two things to do about it.
 */

import { useState } from "react";
import { AlertCircle, Clock } from "lucide-react";
import { Button, ConfirmDeleteDialog } from "@polaris/ui";
import { useKeptSends, type KeptSend } from "./offline-sends";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { appWrites, type AppWrite } from "@/lib/offline/app-writes";

/** Who it goes to, as one line: the first name or address, and how many more. */
function recipients(send: KeptSend): { first: string; more: number } {
    const all = [...send.to, ...send.cc, ...send.bcc];
    const first = all[0];
    return { first: first ? first.name || first.address : "", more: Math.max(0, all.length - 1) };
}

export function KeptSends() {
    const t = useTranslations("mailCompose");
    const entries = useKeptSends();
    const [discarding, setDiscarding] = useState<AppWrite | null>(null);
    if (entries.length === 0) return null;

    const subjectOf = (entry: AppWrite) => (entry.payload as KeptSend).subject || t("offline.noSubject");

    return (
        <section aria-label={t("offline.title")} className="flex flex-col border-b border-border">
            <ul className="flex flex-col">
                {entries.map((entry) => {
                    const send = entry.payload as KeptSend;
                    const to = recipients(send);
                    const failed = entry.state === "failed";
                    return (
                        <li key={entry.key} className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm">
                            {failed ? (
                                <AlertCircle className="size-4 shrink-0 text-danger" aria-hidden />
                            ) : (
                                <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                            )}
                            <span className="min-w-0 flex-1 truncate" title={subjectOf(entry)}>
                                <span className="font-medium">{subjectOf(entry)}</span>
                                <span className="text-muted-foreground">
                                    {" - "}
                                    {to.more > 0
                                        ? t("offline.toMany", { name: to.first, count: to.more })
                                        : t("offline.to", { name: to.first })}
                                </span>
                            </span>
                            <span
                                className={failed ? "min-w-0 max-w-[40%] truncate text-xs text-danger" : "shrink-0 text-xs text-muted-foreground"}
                                title={failed ? entry.reason || t("offline.notSent") : undefined}
                            >
                                {failed ? entry.reason || t("offline.notSent") : t("offline.waiting")}
                            </span>
                            {failed ? (
                                <>
                                    <Button size="xs" variant="ghost" onClick={() => void appWrites.retry(entry)}>
                                        {t("offline.retry")}
                                    </Button>
                                    <Button size="xs" variant="ghost" onClick={() => setDiscarding(entry)}>
                                        {t("offline.discard")}
                                    </Button>
                                </>
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
                title={t("offline.discardTitle")}
                question={t("offline.discardQuestion", { subject: discarding ? subjectOf(discarding) : "" })}
                description={t("offline.discardBody")}
                confirmLabel={t("offline.discard")}
                onConfirm={async () => {
                    if (discarding) await appWrites.discard(discarding.key);
                    setDiscarding(null);
                }}
            />
        </section>
    );
}
