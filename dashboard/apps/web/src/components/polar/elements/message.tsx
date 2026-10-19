"use client";

/**
 * Message: one turn of the conversation, its actions, and the switcher between
 * the versions an edit or a regenerate left behind.
 *
 * Ported from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/message.tsx at ca8be60), Apache-2.0 - see the LICENSE
 * beside this file. Changed: Tailwind 3 and Polaris tokens; the response is
 * drawn by Polaris's own Markdown renderer (`RichText`, which never reaches
 * `innerHTML`) instead of Streamdown; and the branch selector is controlled
 * (current, total, previous, next) because Polar's versions are a stored tree
 * of messages, not sibling elements already on the page.
 */

import { memo, type HTMLAttributes } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, cn, type ButtonProps } from "@polaris/ui";
import { RichText } from "@/components/rich-text/rich-text";
import { useTranslations } from "@/components/i18n/i18n-provider";

export type MessageProps = HTMLAttributes<HTMLDivElement> & { from: "user" | "assistant" | "system" };

export function Message({ className, from, ...props }: MessageProps) {
    return (
        <div
            data-from={from}
            className={cn(
                "group flex w-full min-w-0 flex-col gap-1.5",
                from === "user" ? "items-end" : "items-start",
                className
            )}
            {...props}
        />
    );
}

export type MessageContentProps = HTMLAttributes<HTMLDivElement> & { from: "user" | "assistant" | "system" };

export function MessageContent({ className, from, ...props }: MessageContentProps) {
    return (
        <div
            className={cn(
                "flex min-w-0 max-w-full flex-col gap-2 overflow-hidden break-words text-sm text-foreground",
                from === "user" && "w-fit rounded-lg bg-muted px-3 py-2",
                className
            )}
            {...props}
        />
    );
}

/** The model's Markdown, drawn the way every other text in Polaris is read. */
export const MessageResponse = memo(function MessageResponse({ children }: { children: string }) {
    return <RichText value={children} className="min-w-0 text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />;
});

export function MessageActions({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("flex items-center gap-0.5", className)} {...props} />;
}

export type MessageActionProps = ButtonProps & { label: string };

/** An icon action under a message: the label is its name and its tooltip. */
export function MessageAction({ label, children, ...props }: MessageActionProps) {
    return (
        <Button type="button" variant="ghost" size="icon-xs" aria-label={label} title={label} {...props}>
            {children}
        </Button>
    );
}

/** "< 2 of 3 >" over the versions of one turn. Nothing when there is one. */
export function MessageBranchSelector({
    current,
    total,
    onPrevious,
    onNext,
    className
}: {
    current: number;
    total: number;
    onPrevious: () => void;
    onNext: () => void;
    className?: string;
}) {
    const t = useTranslations("polar");
    if (total <= 1) return null;
    return (
        <div className={cn("flex items-center gap-0.5 text-xs text-muted-foreground", className)}>
            <MessageAction label={t("elements.previousVersion")} disabled={current <= 1} onClick={onPrevious}>
                <ChevronLeft />
            </MessageAction>
            <span className="tabular-nums">{t("elements.versionOf", { current, total })}</span>
            <MessageAction label={t("elements.nextVersion")} disabled={current >= total} onClick={onNext}>
                <ChevronRight />
            </MessageAction>
        </div>
    );
}
