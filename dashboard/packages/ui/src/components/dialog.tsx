"use client";

/** Modal dialog built on Radix, used for connection/share/request forms. */

import { cn } from "../lib/cn";
import { X } from "lucide-react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export const DialogContent = forwardRef<
    ElementRef<typeof RadixDialog.Content>,
    /** `showClose` drops the corner X for dialogs whose own content reaches into
     *  that corner (the search palette); Escape still closes them. */
    ComponentPropsWithoutRef<typeof RadixDialog.Content> & { showClose?: boolean }
>(({ className, children, showClose = true, ...props }, ref) => (
    <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <RadixDialog.Content
            ref={ref}
            className={cn(
                // Centred, so a dialog taller than the window would hang off both
                // ends of it with no way to reach either - including the buttons.
                // Capping it and letting the content scroll is what keeps a long
                // one (a confirmation that explains itself, a form with options)
                // usable on a laptop in a small window and on a phone.
                "fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border-strong bg-elevated p-5 shadow-modal data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]",
                className
            )}
            {...props}
        >
            {children}
            {showClose ? (
                <RadixDialog.Close className="absolute right-4 top-4 rounded-sm text-muted-foreground transition-colors hover:text-foreground ">
                    <X className="size-4" />
                    <span className="sr-only">Close</span>
                </RadixDialog.Close>
            ) : null}
        </RadixDialog.Content>
    </RadixDialog.Portal>
));
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...props }: ComponentPropsWithoutRef<"div">) {
    return <div className={cn("mb-4 flex flex-col gap-1", className)} {...props} />;
}

/**
 * The row a dialog's buttons live in.
 *
 * `DialogContent` is a plain block, so a footer written as a bare div sits flush
 * against whatever came before it - which reads as part of the form rather than
 * as the decision about it, and puts Save one stray click away from the last
 * field. The top margin here is the separation; it belongs to the footer because
 * the alternative is every dialog remembering to add it.
 */
export function DialogFooter({ className, ...props }: ComponentPropsWithoutRef<"div">) {
    return (
        <div
            className={cn("mt-5 flex flex-wrap items-center justify-end gap-2", className)}
            {...props}
        />
    );
}

export function DialogTitle({
    className,
    ...props
}: ComponentPropsWithoutRef<typeof RadixDialog.Title>) {
    return (
        <RadixDialog.Title
            className={cn("text-[0.9375rem] font-semibold tracking-tight", className)}
            {...props}
        />
    );
}

export function DialogDescription({
    className,
    ...props
}: ComponentPropsWithoutRef<typeof RadixDialog.Description>) {
    return (
        <RadixDialog.Description
            className={cn("text-[0.8125rem] leading-relaxed text-muted-foreground", className)}
            {...props}
        />
    );
}
