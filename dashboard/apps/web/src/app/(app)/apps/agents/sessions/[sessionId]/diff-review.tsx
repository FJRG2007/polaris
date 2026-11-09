"use client";

/**
 * A file's diff with a comment on any line, the way a pull request review is
 * left. Comments are held by the changes view until they are sent to the agent
 * together as one prompt.
 */

import { useMemo, useState } from "react";
import { Button, Textarea, cn } from "@polaris/ui";
import { MessageSquarePlus, X } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { parseUnifiedDiff, type DiffLine, type LineComment } from "@/lib/agents/session-review-loop";

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

const LINE_TONE: Record<DiffLine["kind"], string> = {
    add: "bg-success-soft",
    remove: "bg-danger-soft",
    context: "",
    hunk: "bg-muted text-muted-foreground",
    meta: "text-muted-foreground"
};

export function DiffReview({
    path,
    text,
    comments,
    onAdd,
    onRemove
}: {
    path: string;
    text: string;
    comments: readonly LineComment[];
    onAdd: (comment: LineComment) => void;
    onRemove: (key: string) => void;
}) {
    const t = useTranslations("agents");
    const tcommon = useTranslations("common");
    const lines = useMemo(() => parseUnifiedDiff(text), [text]);
    const byKey = useMemo(() => new Map(comments.map((c) => [commentKey(c), c])), [comments]);
    const [open, setOpen] = useState<string | null>(null);
    const [draft, setDraft] = useState("");

    return (
        <div
            className="min-w-0 flex-1 overflow-auto overscroll-contain font-mono text-xs"
            role="region"
            aria-label={t("session.changes.diffOf", { path })}
        >
            {lines.map((line, index) => {
                const anchor = anchorOf(line);
                const key = anchor ? commentKey({ path, ...anchor }) : null;
                const left = key ? byKey.get(key) : undefined;
                return (
                    <div key={index}>
                        <div className={cn("group flex min-w-max items-start", LINE_TONE[line.kind])}>
                            <span className="w-10 shrink-0 select-none px-1 text-right text-muted-foreground">
                                {line.oldLine ?? ""}
                            </span>
                            <span className="w-10 shrink-0 select-none px-1 text-right text-muted-foreground">
                                {line.newLine ?? ""}
                            </span>
                            <span className="flex w-6 shrink-0 justify-center">
                                {anchor && key ? (
                                    <button
                                        type="button"
                                        className="rounded text-primary opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                                        aria-label={t("session.review.add", { line: anchor.line })}
                                        title={t("session.review.add", { line: anchor.line })}
                                        onClick={() => {
                                            setOpen(key);
                                            setDraft(left?.body ?? "");
                                        }}
                                    >
                                        <MessageSquarePlus className="size-4 shrink-0" />
                                    </button>
                                ) : null}
                            </span>
                            <span className="whitespace-pre pr-4">{line.text || " "}</span>
                        </div>
                        {left && open !== key ? (
                            <div className="flex min-w-0 items-start gap-2 border-y border-border bg-card px-3 py-2 font-sans text-sm">
                                <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{left.body}</p>
                                <Button
                                    size="sm"
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
                                    <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>
                                        {tcommon("actions.cancel")}
                                    </Button>
                                    <Button
                                        size="sm"
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
