"use client";

/**
 * The button on a row that opens its step-by-step instructions.
 *
 * The steps are long and are followed in another window, so they open over the
 * page rather than in it: the card stays a short list of choices, and the steps
 * keep all the room they had when they were the card.
 */

import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../components/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger
} from "../components/dialog";

export function StepsDialog({
    label,
    title,
    description,
    children
}: {
    /** What the button says. */
    label: string;
    /** The dialog's title, which also names the button for a screen reader. */
    title: string;
    description?: string;
    children: ReactNode;
}) {
    return (
        <Dialog>
            <DialogTrigger asChild>
                <Button variant="secondary" size="sm" aria-label={title} title={title}>
                    {label}
                    <ArrowRight className="size-4" />
                </Button>
            </DialogTrigger>
            <DialogContent className="w-[calc(100%-2rem)] max-w-2xl">
                <DialogHeader className="pr-8">
                    <DialogTitle>{title}</DialogTitle>
                    {description ? <DialogDescription>{description}</DialogDescription> : null}
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-4 text-sm">{children}</div>
            </DialogContent>
        </Dialog>
    );
}
