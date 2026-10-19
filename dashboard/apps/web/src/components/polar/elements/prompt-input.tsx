"use client";

/**
 * PromptInput: the composer - a growing text box, the chips above it, the
 * tools under it, and a send button that turns into stop while a turn runs.
 *
 * Ported from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/prompt-input.tsx at ca8be60), Apache-2.0 - see the
 * LICENSE beside this file. Changed: Tailwind 3, Polaris tokens and Button; the
 * parts Polar uses only (no provider, no drag-and-drop zone, no speech); and
 * files are handed straight to the caller, which uploads them before sending.
 */

import { ArrowUp, Paperclip, Square } from "lucide-react";
import { Button, cn, type ButtonProps } from "@polaris/ui";
import { forwardRef, useRef, type FormEvent, type HTMLAttributes, type TextareaHTMLAttributes } from "react";

export function PromptInput({
    className,
    onSubmit,
    ...props
}: Omit<HTMLAttributes<HTMLFormElement>, "onSubmit"> & { onSubmit: () => void }) {
    return (
        <form
            className={cn(
                "rounded-lg border border-border bg-field p-2 transition-colors duration-fast focus-within:border-border-strong",
                className
            )}
            onSubmit={(event: FormEvent) => {
                event.preventDefault();
                onSubmit();
            }}
            {...props}
        />
    );
}

export function PromptInputHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("mb-1 flex min-w-0 flex-wrap gap-1 empty:hidden", className)} {...props} />;
}

/** Most lines the box grows to before it scrolls. */
const MAX_ROWS_PX = 200;

export const PromptInputTextarea = forwardRef<
    HTMLTextAreaElement,
    TextareaHTMLAttributes<HTMLTextAreaElement> & { onSubmitKey: () => void }
>(function PromptInputTextarea({ className, onSubmitKey, onKeyDown, onInput, ...props }, ref) {
    return (
        <textarea
            ref={ref}
            rows={2}
            onKeyDown={(event) => {
                onKeyDown?.(event);
                if (event.defaultPrevented) return;
                // Enter sends, Shift+Enter is a new line, and a key held to
                // compose an accented letter is never a send.
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    onSubmitKey();
                }
            }}
            onInput={(event) => {
                const node = event.currentTarget;
                node.style.height = "auto";
                node.style.height = `${Math.min(node.scrollHeight, MAX_ROWS_PX)}px`;
                onInput?.(event);
            }}
            className={cn(
                "w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-foreground-subtle",
                className
            )}
            {...props}
        />
    );
});

export function PromptInputFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("flex min-w-0 items-center gap-1", className)} {...props} />;
}

export function PromptInputTools({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("flex min-w-0 flex-1 items-center gap-1", className)} {...props} />;
}

export function PromptInputButton({ label, ...props }: ButtonProps & { label: string }) {
    return <Button type="button" variant="ghost" size="icon-sm" aria-label={label} title={label} {...props} />;
}

/** Opens the file picker; the chosen files go to `onFiles`. */
export function PromptInputAttach({
    label,
    accept,
    disabled,
    onFiles
}: {
    label: string;
    accept: readonly string[];
    disabled?: boolean;
    onFiles: (files: File[]) => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    return (
        <>
            <input
                ref={input}
                type="file"
                multiple
                hidden
                accept={accept.join(",")}
                onChange={(event) => {
                    onFiles(Array.from(event.target.files ?? []));
                    event.target.value = "";
                }}
            />
            <PromptInputButton label={label} disabled={disabled} onClick={() => input.current?.click()}>
                <Paperclip />
            </PromptInputButton>
        </>
    );
}

export function PromptInputSubmit({
    busy,
    disabled,
    sendLabel,
    stopLabel,
    onStop
}: {
    busy: boolean;
    disabled: boolean;
    sendLabel: string;
    stopLabel: string;
    onStop: () => void;
}) {
    if (busy) {
        return (
            <Button type="button" variant="secondary" size="icon-sm" aria-label={stopLabel} title={stopLabel} onClick={onStop}>
                <Square />
            </Button>
        );
    }
    return (
        <Button type="submit" variant="primary" size="icon-sm" aria-label={sendLabel} title={sendLabel} disabled={disabled}>
            <ArrowUp />
        </Button>
    );
}
