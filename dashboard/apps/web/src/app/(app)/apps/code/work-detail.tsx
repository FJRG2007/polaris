"use client";

/**
 * One pull request or issue, opened.
 *
 * Everything a reader needs to decide something, and the three verbs they would
 * otherwise leave Polaris for: say something, close or reopen it, and - for a
 * pull request - merge it.
 *
 * Merging asks first, and asks in the shape of the decision rather than as a
 * yes/no: which of the three ways, because picking the wrong one is the mistake
 * people actually make and a confirmation dialog that only says "are you sure"
 * does not prevent it.
 */

import Link from "next/link";
import * as actions from "./actions";
import { StateIcon } from "./code-view";
import { runAction } from "@/lib/run-action";
import { useCallback, useEffect, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { RichText } from "@/components/rich-text/rich-text";
import type { CodeComment, CodeDetail } from "@/lib/code/code-service";
import { ArrowLeft, Check, ExternalLink, GitMerge, Loader2, X } from "lucide-react";
import {
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    SegmentedControl,
    Skeleton,
    Textarea,
    cn
} from "@polaris/ui";

export function WorkDetail({
    owner,
    repo,
    number
}: {
    owner: string;
    repo: string;
    number: number;
}) {
    const [item, setItem] = useState<CodeDetail | null>(null);
    const [comments, setComments] = useState<readonly CodeComment[] | null>(null);
    const [body, setBody] = useState("");
    const [busy, setBusy] = useState(false);
    const [merging, setMerging] = useState(false);
    const [method, setMethod] = useState("squash");
    const [error, setError] = useState("");

    const target = { owner, repo, number };

    const load = useCallback(async () => {
        const result = await actions.readWorkAction(target);
        if (result.error || !result.item) {
            setError(result.error ?? "That could not be opened");
            return;
        }
        setItem(result.item);
        const thread = await actions.readConversationAction({ ...target, kind: result.item.kind });
        setComments(thread.comments ?? []);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- target is three primitives, listed individually
    }, [owner, repo, number]);

    useEffect(() => {
        void load();
    }, [load]);

    if (error && !item) {
        return (
            <div className="flex flex-col gap-3">
                <BackLink />
                <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                </p>
            </div>
        );
    }

    if (!item) {
        return (
            <div className="flex flex-col gap-3" aria-hidden="true">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-7 w-2/3" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-16 w-full" />
            </div>
        );
    }

    const open = item.state === "open" || item.state === "draft";

    return (
        <div className="flex flex-col gap-4">
            <BackLink />

            <div className="flex flex-wrap items-start gap-3">
                <StateIcon state={item.state} kind={item.kind} />
                <div className="min-w-0 flex-1">
                    <h1 className="text-[17px] font-semibold leading-tight tracking-tight">
                        {item.title} <span className="text-muted-foreground">#{item.number}</span>
                    </h1>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                        {item.repo} - opened by {item.authorLogin}{" "}
                        <RelativeTime iso={item.createdAt} />
                        {item.branches && (
                            <>
                                {" "}
                                - <code className="text-xs">{item.branches.head}</code> into{" "}
                                <code className="text-xs">{item.branches.base}</code>
                            </>
                        )}
                    </p>
                </div>
                <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <ExternalLink className="size-3.5" />
                    GitHub
                </a>
            </div>

            {error && (
                <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                </p>
            )}

            {item.body.trim() && (
                <Card>
                    <CardBody>
                        <p className="mb-2 text-xs text-muted-foreground">{item.authorLogin}</p>
                        <RichText value={item.body} />
                    </CardBody>
                </Card>
            )}

            {comments === null ? (
                <Skeleton className="h-16 w-full" />
            ) : (
                comments.map((comment) => (
                    <Card key={`${comment.review ?? "comment"}:${comment.id}`}>
                        <CardBody>
                            <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                                <span className="font-medium text-foreground">
                                    {comment.authorLogin}
                                </span>
                                <RelativeTime iso={comment.createdAt} />
                                {comment.review && comment.review !== "commented" && (
                                    <span
                                        className={cn(
                                            "rounded px-1.5 py-px text-[10px] font-medium",
                                            comment.review === "approved"
                                                ? "bg-[#3fb950]/15 text-[#3fb950]"
                                                : "bg-[#f85149]/15 text-[#f85149]"
                                        )}
                                    >
                                        {comment.review === "approved"
                                            ? "Approved"
                                            : "Changes requested"}
                                    </span>
                                )}
                            </p>
                            <RichText value={comment.body} />
                        </CardBody>
                    </Card>
                ))
            )}

            <div className="flex flex-col gap-2">
                <Textarea
                    value={body}
                    rows={4}
                    aria-label="Say something"
                    placeholder="Say something. Markdown, the same as on GitHub."
                    onChange={(event) => setBody(event.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                    <Button
                        size="sm"
                        disabled={busy || !body.trim()}
                        onClick={async () => {
                            setBusy(true);
                            const result = await runAction(
                                () => actions.commentAction({ ...target, body }),
                                setError
                            );
                            setBusy(false);
                            if (result?.error) return;
                            setBody("");
                            await load();
                        }}
                    >
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        Comment
                    </Button>

                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={async () => {
                            setBusy(true);
                            await runAction(
                                () =>
                                    actions.setStateAction({
                                        ...target,
                                        state: open ? "closed" : "open"
                                    }),
                                setError
                            );
                            setBusy(false);
                            await load();
                        }}
                    >
                        {open ? <X className="size-4" /> : <Check className="size-4" />}
                        {open ? "Close" : "Reopen"}
                    </Button>

                    {item.kind === "pr" && open && !item.merged && (
                        <Button size="sm" variant="secondary" onClick={() => setMerging(true)}>
                            <GitMerge className="size-4" />
                            Merge
                        </Button>
                    )}
                </div>
                {item.kind === "pr" && item.mergeable === false && (
                    <p className="text-xs text-muted-foreground">
                        GitHub reports conflicts on this branch. Merging will be refused until they
                        are resolved.
                    </p>
                )}
            </div>

            <Dialog open={merging} onOpenChange={setMerging}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Merge this pull request</DialogTitle>
                        <DialogDescription>
                            Into <code>{item.branches?.base ?? "the base branch"}</code>. This
                            cannot be undone from here.
                        </DialogDescription>
                    </DialogHeader>

                    <SegmentedControl
                        value={method}
                        onValueChange={setMethod}
                        aria-label="How to merge"
                        options={[
                            { value: "squash", label: "Squash" },
                            { value: "merge", label: "Merge commit" },
                            { value: "rebase", label: "Rebase" }
                        ]}
                    />

                    <DialogFooter>
                        <Button variant="ghost" size="sm" onClick={() => setMerging(false)}>
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            disabled={busy}
                            onClick={async () => {
                                setBusy(true);
                                const result = await runAction(
                                    () => actions.mergeAction({ ...target, method }),
                                    setError
                                );
                                setBusy(false);
                                setMerging(false);
                                if (!result?.error) await load();
                            }}
                        >
                            {busy && <Loader2 className="size-4 animate-spin" />}
                            Merge
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function BackLink() {
    return (
        <Link
            href="/apps/code"
            className="flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
            <ArrowLeft className="size-3.5" />
            Code
        </Link>
    );
}
