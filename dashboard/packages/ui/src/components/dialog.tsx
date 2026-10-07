"use client";

/** Modal dialog built on Radix, used for connection/share/request forms. */

import { cn } from "../lib/cn";
import { X } from "lucide-react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { useUiStrings } from "../lib/ui-strings";

/** The page dimmed behind anything modal. It fades out as well as in, so a
 *  dialog closing does not leave the page snapping back to full light under it. */
const OVERLAY =
    "fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=closed]:duration-fast";

/**
 * How a centred dialog arrives and leaves.
 *
 * It is centred with a -50% translate, and the enter and exit keyframes write
 * `transform` as well - which on their own replace the centring, so the first
 * frame of an opening dialog sat half its size down and to the right and swept
 * into place. Composing the animation onto the transform the element already
 * has keeps the centring (and any caller's own placement, such as a dialog
 * docked to an edge with `translate-x-0`) and animates only the small scale on
 * top of it.
 */
const CENTRED_MOTION =
    "[animation-composition:add] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-[0.98] data-[state=closed]:zoom-out-[0.98] data-[state=closed]:duration-fast";

/** The corner close button every dialog and sheet carries. */
const CLOSE =
    "absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors duration-fast hover:bg-card-hover hover:text-foreground active:bg-muted";

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
        <RadixDialog.Overlay className={OVERLAY} />
        <RadixDialog.Content
            ref={ref}
            className={cn(
                // Centred, so a dialog taller than the window would hang off both
                // ends of it with no way to reach either - including the buttons.
                // Capping it and letting the content scroll is what keeps a long
                // one (a confirmation that explains itself, a form with options)
                // usable on a laptop in a small window and on a phone.
                "fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-xl border border-border-strong bg-elevated p-5 shadow-modal",
                CENTRED_MOTION,
                className
            )}
            {...props}
        >
            {children}
            {showClose ? (
                <RadixDialog.Close className={CLOSE}>
                    <X className="size-4" />
                    <span className="sr-only">
                        <CloseWord />
                    </span>
                </RadixDialog.Close>
            ) : null}
        </RadixDialog.Content>
    </RadixDialog.Portal>
));
DialogContent.displayName = "DialogContent";

/**
 * A dialog docked to the right edge: the detail of something on a page that
 * stays in view beside it.
 *
 * It slides in from the edge it is docked to and back out to it, which is what
 * says where it went - a panel that faded away in place reads as closed for
 * good rather than put aside. Full screen on a phone, where there is no page
 * beside it to keep; inset from the edges above that, so it reads as a surface
 * over the page rather than a second page. The width is the caller's, and a
 * change to it is animated, so a panel that widens grows rather than jumps.
 */
export const SheetContent = forwardRef<
    ElementRef<typeof RadixDialog.Content>,
    ComponentPropsWithoutRef<typeof RadixDialog.Content> & { showClose?: boolean }
>(({ className, children, showClose = true, ...props }, ref) => (
    <RadixDialog.Portal>
        <RadixDialog.Overlay className={OVERLAY} />
        <RadixDialog.Content
            ref={ref}
            className={cn(
                "fixed inset-y-0 right-0 z-50 flex h-dvh w-full max-w-full flex-col overflow-hidden border-l border-border-strong bg-elevated shadow-modal outline-none transition-[width,max-width] duration sm:inset-y-2 sm:right-2 sm:h-[calc(100dvh-1rem)] sm:max-w-[calc(100vw-1rem)] sm:rounded-xl sm:border",
                "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:slide-in-from-right-8 data-[state=closed]:slide-out-to-right-8 data-[state=closed]:duration-fast",
                className
            )}
            {...props}
        >
            {children}
            {showClose ? (
                <RadixDialog.Close className={CLOSE}>
                    <X className="size-4" />
                    <span className="sr-only">
                        <CloseWord />
                    </span>
                </RadixDialog.Close>
            ) : null}
        </RadixDialog.Content>
    </RadixDialog.Portal>
));
SheetContent.displayName = "SheetContent";

/** The close button's name, in the reader's words. */
function CloseWord() {
    return <>{useUiStrings().close}</>;
}

/**
 * A dialog that opens beside something rather than over everything.
 *
 * For a card that belongs to what was pressed - a person's name, say - where a
 * centred dialog behind a dimmed page would be the wrong weight. No overlay and
 * no centring: the caller places it (`style`) and opens the root with
 * `modal={false}`, so the page stays live and a press anywhere else closes it.
 * Escape closes it too, and it is still a dialog to anybody reading the page
 * with a screen reader.
 */
export const DialogFloating = forwardRef<
    ElementRef<typeof RadixDialog.Content>,
    ComponentPropsWithoutRef<typeof RadixDialog.Content>
>(({ className, children, ...props }, ref) => (
    <RadixDialog.Portal>
        <RadixDialog.Content
            ref={ref}
            className={cn(
                "fixed z-50 overflow-y-auto overscroll-contain rounded-xl border border-border-strong bg-elevated shadow-modal outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-[0.98] data-[state=closed]:duration-fast",
                className
            )}
            {...props}
        >
            {children}
        </RadixDialog.Content>
    </RadixDialog.Portal>
));
DialogFloating.displayName = "DialogFloating";

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
