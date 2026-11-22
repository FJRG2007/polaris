"use client";

/**
 * A picker's menu that opens as a sheet from the bottom of a phone's screen.
 *
 * Code's composer pickers (the model, the tool that runs it, the effort, the
 * permission mode, the machine) are menus hanging off a small chip. On a phone
 * that menu is a narrow box over the keyboard with rows a finger misses, so
 * there the same rows open in a sheet docked to the bottom edge, full width,
 * every row at least 44px tall, the way a phone's own pickers open.
 *
 * Drop-in for the Dropdown parts: above `sm` every part is the Dropdown one, so
 * the desktop menu is unchanged. An item's `onSelect` gets a cancelable event
 * on both, and preventing it keeps the sheet open as it keeps the menu open.
 */

import {
    Children,
    cloneElement,
    createContext,
    isValidElement,
    useContext,
    useState,
    type ReactElement,
    type ReactNode
} from "react";
import {
    cn,
    Dialog,
    DialogClose,
    DialogContent,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    useUiStrings
} from "@polaris/ui";
import { X } from "lucide-react";
import { usePhone } from "@/components/use-phone";

interface Sheet {
    readonly open: boolean;
    readonly setOpen: (open: boolean) => void;
}

/** Set inside a menu drawn as a sheet; absent inside a Dropdown. */
const SheetContext = createContext<Sheet | null>(null);

/** The row of a sheet: a finger's height, the whole width. */
export const SHEET_ITEM =
    "flex min-h-11 w-full min-w-0 cursor-pointer select-none items-center gap-2 rounded-md px-3 py-2 text-start text-sm outline-none transition-colors hover:bg-option-hover focus-visible:bg-option-hover disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0";

/** What an item's `onSelect` is handed on a phone: cancelable, as the menu's is. */
export function selectEvent(): Event {
    return new Event("select", { cancelable: true });
}

export function SheetMenu({
    open,
    onOpenChange,
    children
}: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children: ReactNode;
}) {
    const phone = usePhone();
    const [own, setOwn] = useState(false);
    const shown = open ?? own;
    const setOpen = (next: boolean) => {
        if (open === undefined) setOwn(next);
        onOpenChange?.(next);
    };
    if (!phone)
        return (
            <DropdownMenu open={open} onOpenChange={onOpenChange}>
                {children}
            </DropdownMenu>
        );
    return <SheetContext.Provider value={{ open: shown, setOpen }}>{children}</SheetContext.Provider>;
}

/** The chip that opens it: always one element, handed through as the Dropdown's. */
export function SheetMenuTrigger({ disabled, children }: { disabled?: boolean; children: ReactElement }) {
    const sheet = useContext(SheetContext);
    if (!sheet)
        return (
            <DropdownMenuTrigger asChild disabled={disabled}>
                {children}
            </DropdownMenuTrigger>
        );
    const child = Children.only(children) as ReactElement<Record<string, unknown>>;
    return cloneElement(child, {
        disabled: disabled || child.props.disabled,
        "aria-haspopup": "dialog",
        "aria-expanded": sheet.open,
        onClick: () => sheet.setOpen(true)
    });
}

export function SheetMenuContent({
    title,
    align,
    className,
    onEscapeKeyDown,
    children
}: {
    /** The sheet's heading; the menu is named by its button instead. */
    title: string;
    align?: "start" | "center" | "end";
    className?: string;
    onEscapeKeyDown?: (event: KeyboardEvent) => void;
    children: ReactNode;
}) {
    const sheet = useContext(SheetContext);
    const words = useUiStrings();
    if (!sheet)
        return (
            <DropdownMenuContent align={align} className={className} onEscapeKeyDown={onEscapeKeyDown}>
                {children}
            </DropdownMenuContent>
        );
    return (
        <Dialog open={sheet.open} onOpenChange={sheet.setOpen}>
            <DialogContent
                aria-describedby={undefined}
                swipeToClose
                showClose={false}
                onEscapeKeyDown={onEscapeKeyDown}
                className="bottom-0 left-0 top-auto flex max-h-[85dvh] w-full max-w-full translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-b-none p-0 pb-[var(--safe-bottom)] data-[state=open]:slide-in-from-bottom-8 data-[state=closed]:slide-out-to-bottom-8"
            >
                <div className="flex min-h-14 min-w-0 shrink-0 items-center gap-2 border-b border-border ps-4 pe-1.5">
                    <DialogTitle className="min-w-0 flex-1 truncate text-base">{title}</DialogTitle>
                    <DialogClose
                        aria-label={words.close}
                        className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground"
                    >
                        <X className="size-4" />
                    </DialogClose>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">{children}</div>
            </DialogContent>
        </Dialog>
    );
}

export function SheetMenuItem({
    onSelect,
    asChild,
    disabled,
    className,
    variant,
    role,
    "aria-checked": checked,
    children
}: {
    onSelect?: (event: Event) => void;
    /** A radio row (`menuitemradio`) says which one is picked. */
    role?: "menuitemradio";
    "aria-checked"?: boolean;
    asChild?: boolean;
    disabled?: boolean;
    className?: string;
    variant?: "default" | "danger";
    children: ReactNode;
}) {
    const sheet = useContext(SheetContext);
    if (!sheet)
        return (
            <DropdownMenuItem
                onSelect={onSelect}
                asChild={asChild}
                disabled={disabled}
                className={className}
                variant={variant}
                // Radix names the row a menuitem; an absent role must not clear that.
                {...(role ? { role, "aria-checked": checked } : {})}
            >
                {children}
            </DropdownMenuItem>
        );
    const choose = () => {
        const event = selectEvent();
        onSelect?.(event);
        if (!event.defaultPrevented) sheet.setOpen(false);
    };
    const tone = cn(SHEET_ITEM, variant === "danger" && "text-danger", className);
    if (asChild && isValidElement(children)) {
        const child = children as ReactElement<{ className?: string; onClick?: () => void }>;
        return cloneElement(child, { className: cn(tone, child.props.className), onClick: choose });
    }
    return (
        <button
            type="button"
            disabled={disabled}
            aria-pressed={role ? checked : undefined}
            className={tone}
            onClick={choose}
        >
            {children}
        </button>
    );
}

export function SheetMenuLabel({ className, children }: { className?: string; children: ReactNode }) {
    const sheet = useContext(SheetContext);
    if (!sheet) return <DropdownMenuLabel className={className}>{children}</DropdownMenuLabel>;
    return (
        <div className={cn("px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground", className)}>{children}</div>
    );
}

export function SheetMenuSeparator() {
    const sheet = useContext(SheetContext);
    if (!sheet) return <DropdownMenuSeparator />;
    return <div role="separator" className="my-1 h-px bg-border" />;
}
