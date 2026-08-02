"use client";

/**
 * The confirmation for a delete that cannot be taken back.
 *
 * A yes/no prompt is answered the same way whether the reader understood it or
 * not, which is exactly the failure it exists to prevent - so by default this
 * one asks the reader to type the name of the thing being destroyed. Retyping
 * "production" is a second or two; it is also the only step in the flow that a
 * misclick cannot complete on its own.
 *
 * Matching is deliberately forgiving about case and surrounding space and about
 * nothing else: the point is proving the reader knows what they are on, not
 * testing their keyboard.
 *
 * That toll is priced for what it protects. It belongs on the things that hold
 * other people's work - a space, a project, a server, a volume - where being
 * wrong is unrecoverable and irreversible for everyone in it. On a single row
 * somebody deletes several times a day it stops being a safeguard and becomes a
 * tax on the common case, so `requireTyping={false}` asks plainly instead.
 */

import { cn } from "../lib/cn";
import { Input } from "./input";
import { Button } from "./button";
import { Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog";

export interface ConfirmDeleteDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The exact text the reader has to type, normally the thing's own name.
     *  Still shown in the question when `requireTyping` is false. */
    name: string;
    /** False asks for a plain confirmation instead. Use it for one row of many -
     *  a task, a comment, a step - never for something that holds other work. */
    requireTyping?: boolean;
    /** What is being deleted, lowercase, e.g. "project" or "service". */
    kind: string;
    /** What deleting it actually does. Say the part that cannot be undone. */
    description?: ReactNode;
    /** Extra controls shown above the confirmation field, e.g. a "wipe data" switch. */
    children?: ReactNode;
    /** Overrides the button label when the action is not literally a delete. */
    confirmLabel?: string;
    /** Blocks confirmation entirely and explains why (e.g. a volume a service needs). */
    blockedReason?: string | null;
    error?: string | null;
    pending?: boolean;
    onConfirm: () => void;
}

export function ConfirmDeleteDialog({
    open,
    onOpenChange,
    name,
    requireTyping = true,
    kind,
    description,
    children,
    confirmLabel,
    blockedReason,
    error,
    pending = false,
    onConfirm
}: ConfirmDeleteDialogProps) {
    const [typed, setTyped] = useState("");
    const fieldId = useId();

    // Reopening must not inherit the last attempt's text, or the second delete
    // would be one click away from confirmed before it has been read at all.
    useEffect(() => {
        if (open) setTyped("");
    }, [open]);

    const matches = !requireTyping || typed.trim().toLowerCase() === name.trim().toLowerCase();
    const blocked = Boolean(blockedReason);
    const ready = matches && !blocked && !pending;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <TriangleAlert className="size-4 text-danger" />
                        Delete {kind}
                    </DialogTitle>
                    {description ? <DialogDescription>{description}</DialogDescription> : null}
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    {children}

                    {blocked ? (
                        <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-muted-foreground">
                            {blockedReason}
                        </p>
                    ) : !requireTyping ? (
                        <p className="text-sm text-muted-foreground">
                            Delete <span className="font-medium text-foreground">{name}</span>?
                        </p>
                    ) : (
                        <label className="flex flex-col gap-1.5" htmlFor={fieldId}>
                            <span className="text-xs text-muted-foreground">
                                Type <span className="font-medium text-foreground">{name}</span> to confirm.
                            </span>
                            <Input
                                id={fieldId}
                                autoFocus
                                autoComplete="off"
                                spellCheck={false}
                                value={typed}
                                onChange={(event) => setTyped(event.target.value)}
                                onKeyDown={(event) => event.key === "Enter" && ready && onConfirm()}
                                placeholder={name}
                                className={cn(typed.length > 0 && !matches && "border-danger/50")}
                            />
                        </label>
                    )}

                    {error && <p className="text-sm text-danger">{error}</p>}

                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
                            Cancel
                        </Button>
                        <Button variant="danger" onClick={onConfirm} disabled={!ready}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            {confirmLabel ?? `Delete ${kind}`}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
