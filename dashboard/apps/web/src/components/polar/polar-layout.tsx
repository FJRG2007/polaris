"use client";

/**
 * The frame both sides of Polar are drawn in, so Chat and Code read as one
 * chat: the welcome a new conversation opens on (on Polar's own page), and the
 * scrolling thread with the composer docked under it (everywhere else, and once
 * there is something to read).
 */

import type { ReactNode } from "react";
import { cn } from "@polaris/ui";
import { Conversation, ConversationContent } from "@/components/polar/elements/conversation";

/** A new conversation on Polar's own page: the avatar, a heading, then the
 *  composer and whatever goes with it. */
export function PolarWelcome({
    avatar,
    title,
    description,
    children
}: {
    avatar: ReactNode;
    title: ReactNode;
    description?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto overscroll-contain px-4 py-6">
            <div className="flex w-full min-w-0 max-w-3xl flex-col gap-4">
                <div className="flex flex-col items-center gap-3 text-center">
                    {avatar}
                    <h1 className="text-xl font-semibold text-foreground">{title}</h1>
                    {description ? (
                        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
                    ) : null}
                </div>
                {children}
            </div>
        </div>
    );
}

/** The thread, kept to its newest line, with `dock` (the composer) under it. */
export function PolarThreadFrame({
    fullPage,
    dock,
    children
}: {
    fullPage: boolean;
    dock: ReactNode;
    children: ReactNode;
}) {
    return (
        <>
            <Conversation>
                <ConversationContent
                    className={fullPage ? "mx-auto w-full max-w-3xl px-4 py-6" : undefined}
                >
                    {children}
                </ConversationContent>
            </Conversation>
            <div
                className={cn(
                    "shrink-0",
                    fullPage ? "mx-auto w-full min-w-0 max-w-3xl px-4 pb-3" : "min-w-0 p-3"
                )}
            >
                {dock}
            </div>
        </>
    );
}
