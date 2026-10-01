"use client";

/**
 * A message with files in it, from the moment it is sent until it has landed.
 *
 * The box empties when somebody presses send, because the next thing they do is
 * usually write the next line. The files in that message, though, take as long as
 * the storage takes - and when the storage is not there, they used to simply
 * vanish from the composer: a bar in the corner stopped at "0 seconds left", no
 * message arrived, and nothing anywhere said the picture had not been sent.
 *
 * So the message waits here, under the box, saying how far it has got. If it
 * fails it stays, with the reason and the two things anybody would do next: try
 * again, or give up on it - and giving up puts the words back in the box rather
 * than throwing them away with the file.
 */

import { cn } from "@polaris/ui";
import { useEffect, useState } from "react";
import type { RecordedSound } from "./voice-recorder";
import { Paperclip, RotateCcw, X } from "lucide-react";
import type { KeptPick } from "@/components/file-picker/as-files";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";

/** How far one message's files have got, as the sender reports it. */
export interface SendProgress {
    /** Which file is going, from 0. */
    readonly file: number;
    readonly files: number;
    /** Bytes of that file sent so far, and what it weighs. */
    readonly moved: number;
    readonly total: number;
}

/** What a send answers: nothing when it landed, the reason when it did not. */
export type SendOutcome = void | { readonly error?: string };

export interface Outgoing {
    readonly id: string;
    /** Which box it was sent from - a conversation, a thread - so it is drawn
     *  under that box and retried into it, and nowhere else. */
    readonly scope: string;
    readonly body: string;
    readonly files: readonly File[];
    readonly kept: readonly KeptPick[];
    readonly sounds?: readonly RecordedSound[];
    /** Which of them arrive covered, by position - see `Composer`. */
    readonly hidden: readonly number[];
    readonly phase: "sending" | "failed";
    readonly error?: string;
    readonly progress?: SendProgress;
}

/**
 * Every message on its way, in this tab.
 *
 * Held outside the composer on purpose: walking to another conversation while a
 * picture is still going unmounts the box it was sent from, and a failure that
 * landed in a component nobody is looking at any more was exactly the silence
 * this exists to end. Coming back to the conversation finds it waiting.
 */
let pending: readonly Outgoing[] = [];
const listeners = new Set<() => void>();

function announce(): void {
    for (const listener of listeners) listener();
}

/** Start one, or start it again: whatever it said last is replaced. False, and
 *  nothing changed, when that one is already on its way - a second press of "Try
 *  again" must not send the message twice. */
export function putOutgoing(one: Outgoing): boolean {
    if (pending.some((entry) => entry.id === one.id && entry.phase === "sending")) return false;
    pending = [...pending.filter((entry) => entry.id !== one.id), one];
    announce();
    return true;
}

/** Change one, or take it away by answering null. */
export function patchOutgoing(id: string, change: (was: Outgoing) => Outgoing | null): void {
    pending = pending.flatMap((entry) => {
        if (entry.id !== id) return [entry];
        const next = change(entry);
        return next ? [next] : [];
    });
    announce();
}

/** The ones sent from one box. */
export function useOutgoing(scope: string): readonly Outgoing[] {
    const pick = () => pending.filter((entry) => entry.scope === scope);
    const [shown, setShown] = useState<readonly Outgoing[]>(pick);
    useEffect(() => {
        const listener = () => setShown(pending.filter((entry) => entry.scope === scope));
        listeners.add(listener);
        listener();
        return () => {
            listeners.delete(listener);
        };
    }, [scope]);
    return shown;
}

export function OutgoingList({
    outgoing,
    onRetry,
    onRemove
}: {
    outgoing: readonly Outgoing[];
    onRetry: (one: Outgoing) => void;
    onRemove: (one: Outgoing) => void;
}) {
    const t = useTranslations("chat");
    if (outgoing.length === 0) return null;
    return (
        <ul className="mb-2 flex flex-col gap-1.5">
            {outgoing.map((one) => {
                const failed = one.phase === "failed";
                const names = [
                    ...one.files.map((file) => file.name),
                    ...one.kept.map((kept) => kept.name)
                ];
                const label = names.join(", ");
                return (
                    <li
                        key={one.id}
                        className={cn(
                            "flex min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 text-xs",
                            failed ? "bg-danger-soft" : "bg-muted"
                        )}
                    >
                        <div className="flex min-w-0 items-center gap-1.5">
                            <Paperclip
                                className="size-3 shrink-0 text-muted-foreground"
                                aria-hidden
                            />
                            <span className="min-w-0 flex-1 truncate" title={label}>
                                {label}
                            </span>
                            {failed && (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => onRetry(one)}
                                        aria-label={t("composer.outgoing.retryNamed", {
                                            name: label
                                        })}
                                        title={t("composer.outgoing.retry")}
                                        className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-background"
                                    >
                                        <RotateCcw className="size-3" aria-hidden />
                                        {t("composer.outgoing.retry")}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => onRemove(one)}
                                        aria-label={t("composer.outgoing.removeNamed", {
                                            name: label
                                        })}
                                        title={t("composer.outgoing.remove")}
                                        className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                                    >
                                        <X className="size-3" aria-hidden />
                                        {t("composer.outgoing.remove")}
                                    </button>
                                </>
                            )}
                        </div>
                        {one.body && (
                            <p className="truncate text-muted-foreground" title={one.body}>
                                {one.body}
                            </p>
                        )}
                        {failed ? (
                            <p role="alert" className="text-danger">
                                {one.error || t("composer.outgoing.notSent")}
                            </p>
                        ) : (
                            <p role="status" className="text-muted-foreground">
                                {progressSaid(one.progress, t)}
                            </p>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

type Words = NamespaceTranslator<"chat">;

/** What the line under a message on its way says. */
export function progressSaid(progress: SendProgress | undefined, t: Words): string {
    if (!progress) return t("composer.outgoing.starting");
    // Every byte gone and no answer yet: the server is putting it away. A
    // percentage of 100 under that reads as a hang, which this is not.
    if (progress.total > 0 && progress.moved >= progress.total)
        return t("composer.outgoing.processing");
    const percent = progress.total > 0 ? Math.floor((progress.moved / progress.total) * 100) : 0;
    return progress.files > 1
        ? t("composer.outgoing.sendingOf", {
              file: progress.file + 1,
              files: progress.files,
              percent
          })
        : t("composer.outgoing.sending", { percent });
}
