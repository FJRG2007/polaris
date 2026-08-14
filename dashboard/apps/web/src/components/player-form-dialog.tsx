"use client";

/**
 * The frame every "ask about one player" form is drawn in.
 *
 * Each game has its own fields - a Minecraft username and the address it may
 * arrive from, a Steam id and what to call the person behind it - but the form
 * around them is the same one every time: a title naming who it is about, the
 * fields, and a cancel and a confirm in that order. Written per game, they drifted
 * within one screen of each other: different button order, different places for
 * the error, one that closed while a request was still in flight.
 *
 * Presentational on purpose. It submits and reports; what a field means and what
 * the confirm does belong to the game that opened it.
 */

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

export function PlayerFormDialog({
    title,
    description,
    children,
    onClose,
    onConfirm,
    confirmLabel,
    ready,
    pending,
    error,
    danger
}: {
    title: string;
    description: string;
    children: ReactNode;
    onClose: () => void;
    onConfirm: () => void;
    confirmLabel: string;
    /** Whether the form may be submitted at all. */
    ready: boolean;
    pending: boolean;
    /** What the server refused it with, shown above the buttons rather than in a
     *  toast that outlives the dialog. */
    error?: string | null;
    danger?: boolean;
}) {
    return (
        <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (ready && !pending) onConfirm();
                    }}
                >
                    {children}
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            variant={danger ? "danger" : "primary"}
                            disabled={!ready || pending}
                        >
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            {confirmLabel}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** One labelled field, with the reason it is refused underneath it rather than
 *  somewhere else on the screen. */
export function PlayerFormField({
    label,
    error,
    hint,
    children
}: {
    label: string;
    error?: string | null;
    /** What the field is for, when the label alone does not say it. */
    hint?: string;
    children: ReactNode;
}) {
    return (
        <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-xs text-muted-foreground">{label}</span>
            {children}
            {(error || hint) && (
                <span className={error ? "text-xs text-danger" : "text-xs text-muted-foreground"}>
                    {error ?? hint}
                </span>
            )}
        </label>
    );
}
