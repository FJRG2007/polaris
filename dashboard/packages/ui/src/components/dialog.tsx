"use client";

/** Modal dialog built on Radix, used for connection/share/request forms. */

import { cn } from "../lib/cn";
import { X } from "lucide-react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { attachSheetSwipe } from "../lib/sheet-swipe";
import {
    CENTRED_MOTION,
    DIALOG_CLOSE as CLOSE,
    DIALOG_OVERLAY as OVERLAY,
    DIALOG_SURFACE,
    PHONE_CLASSES,
    type PhoneLayout
} from "./dialog-surface";
import { useUiStrings } from "../lib/ui-strings";
import {
    forwardRef,
    useCallback,
    useEffect,
    useState,
    type ComponentPropsWithoutRef,
    type ElementRef,
    type ForwardedRef
} from "react";

export type { PhoneLayout };

/** A caller that positions the dialog itself, on a phone or everywhere. */
const PLACED = /(?:^|\s)(?:max-sm:)?translate-x-0(?:\s|$)/;
const WIDE = /(?:^|\s)(?:sm:|md:|lg:)?max-w-(?:[2-7]xl|screen(?:-[a-z0-9]+)?)(?:\s|$)/;
/** An arbitrary width, `max-w-[40rem]` or `max-w-[min(48rem,95vw)]`: its first length. */
const ARBITRARY = /(?:^|\s)(?:sm:|md:|lg:)?max-w-\[(?:min\()?(\d+(?:\.\d+)?)(rem|px)/;
/** 42rem, Tailwind's `2xl`: from here up a dialog holds more than a sheet should. */
const WIDE_REM = 42;

/** Which phone layout a dialog takes: the caller's, or read off its width. Pure. */
export function phoneLayout(className: string | undefined, chosen?: PhoneLayout): PhoneLayout {
    if (chosen) return chosen;
    if (!className) return "sheet";
    if (PLACED.test(className)) return "keep";
    if (WIDE.test(className)) return "full";
    const arbitrary = ARBITRARY.exec(className);
    if (!arbitrary) return "sheet";
    const rem = Number(arbitrary[1]) / (arbitrary[2] === "px" ? 16 : 1);
    return rem >= WIDE_REM ? "full" : "sheet";
}

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export const DialogContent = forwardRef<
    ElementRef<typeof RadixDialog.Content>,
    /** `showClose` drops the corner X for dialogs whose own content reaches into
     *  that corner (the search palette); Escape still closes them. `phone` is
     *  how it sits on a phone (`PhoneLayout`). `swipeToClose` is pulling it
     *  down from anywhere to close it (`sheet-swipe`): on by default where it
     *  is a sheet on a phone, `true` for a dialog that is a sheet everywhere. */
    ComponentPropsWithoutRef<typeof RadixDialog.Content> & {
        showClose?: boolean;
        phone?: PhoneLayout;
        swipeToClose?: boolean;
    }
>(({ className, children, showClose = true, phone, swipeToClose, ...props }, ref) => {
    const layout = phoneLayout(className, phone);
    const swipe = swipeToClose ?? (layout === "sheet" ? "phone" : false);
    // The surface in state rather than a ref: this component is mounted while
    // the dialog is closed, and the node only exists while it is open.
    const [surface, setSurface] = useState<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!surface || !swipe) return;
        return attachSheetSwipe(surface, swipe === "phone");
    }, [surface, swipe]);
    const attach = useCallback(
        (node: HTMLDivElement | null) => {
            setSurface(node);
            setRef(ref, node);
        },
        [ref]
    );
    // A dialog that fills a phone is a screen of its own there, and its close
    // is that screen's back: a swipe from the left takes it away (useSwipeBack).
    const screen = layout === "full" ? "" : undefined;
    return (
        <RadixDialog.Portal>
            <RadixDialog.Overlay className={OVERLAY} />
            <RadixDialog.Content
                ref={attach}
                className={cn(
                    DIALOG_SURFACE,
                    CENTRED_MOTION,
                    className,
                    // Last, so it wins over the caller's desktop placement on a phone.
                    PHONE_CLASSES[layout]
                )}
                data-swipe-back-pane={screen}
                {...props}
            >
                {children}
                {showClose ? (
                    <RadixDialog.Close className={CLOSE} data-swipe-back={screen}>
                        <X className="size-4" />
                        <span className="sr-only">
                            <CloseWord />
                        </span>
                    </RadixDialog.Close>
                ) : null}
            </RadixDialog.Content>
        </RadixDialog.Portal>
    );
});
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
                "fixed bottom-0 end-0 top-[var(--window-controls-height)] z-50 flex h-[calc(100dvh-var(--window-controls-height))] w-full max-w-full flex-col overflow-hidden pb-[var(--safe-bottom)] pe-[var(--safe-end)] ps-[var(--safe-start)] pt-[var(--safe-top)] sm:p-0 border-s border-border-strong bg-background shadow-modal outline-none transition-[width,max-width] duration sm:bottom-[calc(0.5rem+var(--safe-bottom))] sm:end-[calc(0.5rem+var(--safe-end))] sm:top-[calc(0.5rem+var(--window-controls-height)+var(--safe-top))] sm:h-[calc(100dvh-1rem-var(--window-controls-height)-var(--safe-top)-var(--safe-bottom))] sm:max-w-[calc(100vw-1rem)] sm:rounded-xl sm:border",
                "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:slide-in-from-right-8 data-[state=closed]:slide-out-to-right-8 data-[state=closed]:duration-fast",
                className
            )}
            // Full screen on a phone, where a swipe from the left puts it back
            // the way a screen goes back (useSwipeBack).
            data-swipe-back-pane=""
            {...props}
        >
            {children}
            {showClose ? (
                <RadixDialog.Close className={CLOSE} data-swipe-back="">
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

function setRef<T>(ref: ForwardedRef<T>, value: T | null): void {
    if (typeof ref === "function") ref(value);
    else if (ref) ref.current = value;
}

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
