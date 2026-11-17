"use client";

/**
 * A file's diff with a comment on any line, the way a pull request review is
 * left. Comments are held by the changes view until they are sent to the agent
 * together as one prompt.
 */

import { useMemo, useState } from "react";
import { Button, Input, Textarea, cn } from "@polaris/ui";
import { MessageSquarePlus, Send, X } from "lucide-react";
import { TOUCH_TARGET } from "@/components/use-phone";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    parseUnifiedDiff,
    selectionOf,
    selectionRange,
    type DiffLine,
    type DiffSelection,
    type LineComment
} from "@/lib/agents/session-review-loop";

/** A comment's identity: one per line and side of a file. */
export function commentKey(comment: Pick<LineComment, "path" | "side" | "line">): string {
    return `${comment.path}\u0000${comment.side}\u0000${comment.line}`;
}

/** Where a line of the diff can be commented on, or null for a header. */
function anchorOf(line: DiffLine): { side: "new" | "old"; line: number } | null {
    if (line.kind === "remove" && line.oldLine !== null) return { side: "old", line: line.oldLine };
    if ((line.kind === "add" || line.kind === "context") && line.newLine !== null)
        return { side: "new", line: line.newLine };
    return null;
}

// A Polar Code theme tints added and removed lines its own way
// (`[data-code-theme]` in globals.css); anywhere else these are the tokens.
const LINE_TONE: Record<DiffLine["kind"], string> = {
    add: "bg-[var(--code-diff-add,var(--success-soft))]",
    remove: "bg-[var(--code-diff-remove,var(--danger-soft))]",
    context: "",
    hunk: "bg-muted text-muted-foreground",
    meta: "text-muted-foreground"
};

/** Whether the screen is pressed rather than pointed at. */
const coarsePointer = () => typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

export function DiffReview({
    path,
    text,
    comments,
    onAdd,
    onRemove,
    onSendSelection
}: {
    path: string;
    text: string;
    comments: readonly LineComment[];
    onAdd: (comment: LineComment) => void;
    onRemove: (key: string) => void;
    /** Sends the selected lines to the agent; true once it took them. Without
     *  it, lines cannot be selected. */
    onSendSelection?: (selection: DiffSelection, note: string) => Promise<boolean>;
}) {
    const t = useTranslations("agents");
    const tcommon = useTranslations("common");
    const lines = useMemo(() => parseUnifiedDiff(text), [text]);
    const byKey = useMemo(() => new Map(comments.map((c) => [commentKey(c), c])), [comments]);
    const [open, setOpen] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    // The row a selection started on and the row it reaches, by index.
    const [picked, setPicked] = useState<{ from: number; to: number } | null>(null);
    const [note, setNote] = useState("");
    const [sending, setSending] = useState(false);
    const selection = picked ? selectionOf(path, lines, picked.from, picked.to) : null;
    const low = picked ? Math.min(picked.from, picked.to) : -1;
    const high = picked ? Math.max(picked.from, picked.to) : -1;
    const pick = (index: number, extend: boolean) =>
        setPicked((current) => (extend && current ? { from: current.from, to: index } : { from: index, to: index }));
    const send = async () => {
        if (!selection || !onSendSelection) return;
        setSending(true);
        const sent = await onSendSelection(selection, note);
        setSending(false);
        if (sent) {
            setPicked(null);
            setNote("");
        }
    };

    return (
        <div
            className="min-w-0 flex-1 overflow-auto overscroll-contain font-mono text-xs"
            role="region"
            aria-label={t("session.changes.diffOf", { path })}
        >
            {selection && onSendSelection ? (
                <div className="sticky top-0 z-10 flex min-w-0 flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2 font-sans text-sm">
                    <span className="min-w-0 truncate" title={selection.path}>
                        {t("session.selection.picked", { range: selectionRange(selection) })}
                    </span>
                    <Input
                        value={note}
                        maxLength={4000}
                        aria-label={t("session.selection.note")}
                        placeholder={t("session.selection.note")}
                        className="h-8 min-w-0 flex-1 basis-40"
                        onChange={(event) => setNote(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") void send();
                            if (event.key === "Escape") setPicked(null);
                        }}
                    />
                    <Button size="sm" onClick={() => void send()} disabled={sending}>
                        <Send className="size-4 shrink-0" />
                        {t("session.selection.send")}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t("session.selection.clear")}
                        title={t("session.selection.clear")}
                        onClick={() => setPicked(null)}
                    >
                        <X className="size-4 shrink-0" />
                    </Button>
                </div>
            ) : null}
            {lines.map((line, index) => {
                const anchor = anchorOf(line);
                const key = anchor ? commentKey({ path, ...anchor }) : null;
                const left = key ? byKey.get(key) : undefined;
                const comment = () => {
                    if (!key) return;
                    setOpen(key);
                    setDraft(left?.body ?? "");
                };
                return (
                    <div key={index}>
                        {/* On a phone the line wraps instead of running off the
                            screen, and the whole line is what a finger presses
                            to comment: the gutter's button is too small to aim at. */}
                        <div
                            className={cn(
                                "group flex min-w-max items-start max-sm:min-w-0 [@media(pointer:coarse)]:leading-6",
                                LINE_TONE[line.kind],
                                index >= low && index <= high && "bg-primary/15"
                            )}
                            onClick={(event) => {
                                if (!anchor || open === key || !coarsePointer()) return;
                                if ((event.target as HTMLElement).closest("button")) return;
                                comment();
                            }}
                        >
                            {anchor && onSendSelection ? (
                                <button
                                    type="button"
                                    className="flex shrink-0 select-none text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    aria-label={t("session.selection.pick", { line: anchor.line })}
                                    title={t("session.selection.pickHint")}
                                    onClick={(event) => pick(index, event.shiftKey)}
                                >
                                    <span className="w-10 px-1 text-end max-sm:w-8">{line.oldLine ?? ""}</span>
                                    <span className="w-10 px-1 text-end max-sm:w-8">{line.newLine ?? ""}</span>
                                </button>
                            ) : (
                                <>
                                    <span className="w-10 shrink-0 select-none px-1 text-end text-muted-foreground max-sm:w-8">
                                        {line.oldLine ?? ""}
                                    </span>
                                    <span className="w-10 shrink-0 select-none px-1 text-end text-muted-foreground max-sm:w-8">
                                        {line.newLine ?? ""}
                                    </span>
                                </>
                            )}
                            <span className="flex w-6 shrink-0 justify-center [@media(pointer:coarse)]:w-2">
                                {anchor && key ? (
                                    <button
                                        type="button"
                                        className="rounded text-primary opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:sr-only"
                                        aria-label={t("session.review.add", { line: anchor.line })}
                                        title={t("session.review.add", { line: anchor.line })}
                                        onClick={comment}
                                    >
                                        <MessageSquarePlus className="size-4 shrink-0" />
                                    </button>
                                ) : null}
                            </span>
                            <span className="whitespace-pre pe-4 max-sm:min-w-0 max-sm:flex-1 max-sm:whitespace-pre-wrap max-sm:break-all max-sm:pe-2">
                                {line.text || " "}
                            </span>
                        </div>
                        {left && open !== key ? (
                            <div className="flex min-w-0 items-start gap-2 border-y border-border bg-card px-3 py-2 font-sans text-sm">
                                <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{left.body}</p>
                                <Button
                                    size="sm"
                                    className={TOUCH_TARGET}
                                    variant="ghost"
                                    onClick={() => {
                                        setOpen(key);
                                        setDraft(left.body);
                                    }}
                                >
                                    {t("session.review.edit")}
                                </Button>
                                <Button
                                    size="sm"
                                    className={TOUCH_TARGET}
                                    variant="ghost"
                                    aria-label={t("session.review.remove")}
                                    title={t("session.review.remove")}
                                    onClick={() => key && onRemove(key)}
                                >
                                    <X className="size-4 shrink-0" />
                                </Button>
                            </div>
                        ) : null}
                        {anchor && open === key ? (
                            <div className="space-y-2 border-y border-border bg-card px-3 py-2 font-sans">
                                <Textarea
                                    autoFocus
                                    rows={3}
                                    maxLength={4000}
                                    value={draft}
                                    placeholder={t("session.review.placeholder")}
                                    onChange={(event) => setDraft(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Escape") setOpen(null);
                                    }}
                                />
                                <div className="flex justify-end gap-2">
                                    <Button size="sm" variant="ghost" className={TOUCH_TARGET} onClick={() => setOpen(null)}>
                                        {tcommon("actions.cancel")}
                                    </Button>
                                    <Button
                                        size="sm"
                                        className={TOUCH_TARGET}
                                        disabled={!draft.trim()}
                                        onClick={() => {
                                            onAdd({
                                                path,
                                                ...anchor,
                                                code: line.text.slice(0, 2000),
                                                body: draft.trim()
                                            });
                                            setOpen(null);
                                            setDraft("");
                                        }}
                                    >
                                        {t("session.review.save")}
                                    </Button>
                                </div>
                            </div>
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}
