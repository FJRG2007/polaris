"use client";

/**
 * Right-click context menu built on Radix. Mirrors the dropdown-menu styling so
 * row actions look the same whether reached by a trigger button or a right-click.
 * The file browser uses it for per-entry actions (open, rename, share, delete).
 */

import { cn } from "../lib/cn";
import { ChevronRight } from "lucide-react";
import { ignoreOpeningPress } from "../lib/menu-press";
import * as RadixMenu from "@radix-ui/react-context-menu";
import {
    createContext,
    forwardRef,
    useContext,
    useEffect,
    useRef,
    useState,
    type ComponentPropsWithoutRef,
    type ElementRef
} from "react";

/**
 * How long to wait before a submenu that should have opened is asked again.
 *
 * A menu ignores a hover that arrives while the pointer still looks like it is
 * heading for the submenu it just left - the courtesy that lets somebody cut the
 * corner into a submenu without it closing under them. It lasts 300ms, and only
 * a pointer that MOVES afterwards opens anything. So a hand that runs down the
 * options and stops on one inside that window gets nothing at all, and has to
 * jiggle the mouse to be noticed, which is what makes a quick scan feel broken.
 */
const SETTLED_MS = 350;

export const ContextMenu = RadixMenu.Root;
export const ContextMenuTrigger = RadixMenu.Trigger;
export const ContextMenuGroup = RadixMenu.Group;

/** Whether this submenu has been open before, and so is being kept rather than
 *  rebuilt. Read by its content; nothing outside this file needs it. */
const SubmenuKept = createContext(false);

/**
 * A submenu that is built once and then kept.
 *
 * A menu drops a submenu's contents the instant the pointer leaves it, so
 * stepping along a row of them - status, then priority, then people - builds
 * each list from scratch every single time, including on the way back to one
 * that was open a second ago. On a list of any size that reads as the menu
 * stopping to load something, when there was nothing to load.
 *
 * So the first time one opens it stays mounted and is hidden while closed:
 * coming back to it is a class change rather than a rebuild. It lasts as long as
 * the menu is open, which is the span somebody is moving between the options.
 */
export function ContextMenuSub({ onOpenChange, ...props }: ComponentPropsWithoutRef<typeof RadixMenu.Sub>) {
    const [kept, setKept] = useState(false);
    return (
        <SubmenuKept.Provider value={kept}>
            <RadixMenu.Sub
                {...props}
                onOpenChange={(open) => {
                    // Only once it has actually been opened, so a menu nobody
                    // steps into still costs nothing to put on screen.
                    if (open) setKept(true);
                    onOpenChange?.(open);
                }}
            />
        </SubmenuKept.Provider>
    );
}

export const ContextMenuContent = forwardRef<
    ElementRef<typeof RadixMenu.Content>,
    ComponentPropsWithoutRef<typeof RadixMenu.Content>
>(({ className, ...props }, ref) => (
    <RadixMenu.Portal>
        <RadixMenu.Content
            ref={ref}
            className={cn(
                "z-50 min-w-[11rem] overflow-hidden rounded-lg border border-border-strong bg-elevated p-1 text-foreground shadow-popover data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                className
            )}
            {...props}
            // After the spread: the menu must never commit an option on the
            // release of the press that opened it.
            onPointerUpCapture={ignoreOpeningPress}
        />
    </RadixMenu.Portal>
));
ContextMenuContent.displayName = "ContextMenuContent";

export const ContextMenuItem = forwardRef<
    ElementRef<typeof RadixMenu.Item>,
    ComponentPropsWithoutRef<typeof RadixMenu.Item> & { variant?: "default" | "danger" }
>(({ className, variant = "default", ...props }, ref) => (
    <RadixMenu.Item
        ref={ref}
        className={cn(
            "relative flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-[13px] outline-none transition-colors duration-fast focus:bg-card-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
            variant === "danger" && "text-danger focus:bg-danger/10",
            className
        )}
        {...props}
    />
));
ContextMenuItem.displayName = "ContextMenuItem";

export const ContextMenuSubTrigger = forwardRef<
    ElementRef<typeof RadixMenu.SubTrigger>,
    ComponentPropsWithoutRef<typeof RadixMenu.SubTrigger>
>(({ className, children, onPointerMove, onPointerLeave, ...props }, ref) => {
    const settled = useRef<number | undefined>(undefined);
    const cancel = () => {
        if (settled.current !== undefined) window.clearTimeout(settled.current);
        settled.current = undefined;
    };
    useEffect(() => cancel, []);

    return (
        <RadixMenu.SubTrigger
            ref={ref}
            className={cn(
                "relative flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-[13px] outline-none transition-colors duration-fast focus:bg-card-hover data-[state=open]:bg-card-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                className
            )}
            {...props}
            // After the spread, so nothing a caller passes loses the nudge.
            onPointerMove={(event) => {
                onPointerMove?.(event);
                if (event.pointerType !== "mouse" || settled.current !== undefined) return;
                const trigger = event.currentTarget;
                const { clientX, clientY } = event;
                // The pointer has arrived. If it is still here once the menu has
                // stopped being courteous and this is still shut, move for it -
                // the jiggle somebody would otherwise have to do themselves.
                settled.current = window.setTimeout(() => {
                    settled.current = undefined;
                    if (!trigger.isConnected || trigger.dataset.state === "open") return;
                    if (!trigger.matches(":hover")) return;
                    trigger.dispatchEvent(
                        new PointerEvent("pointermove", { bubbles: true, clientX, clientY, pointerType: "mouse" })
                    );
                }, SETTLED_MS);
            }}
            onPointerLeave={(event) => {
                onPointerLeave?.(event);
                cancel();
            }}
        >
            {children}
            <ChevronRight className="ml-auto size-4" />
        </RadixMenu.SubTrigger>
    );
});
ContextMenuSubTrigger.displayName = "ContextMenuSubTrigger";

export const ContextMenuSubContent = forwardRef<
    ElementRef<typeof RadixMenu.SubContent>,
    ComponentPropsWithoutRef<typeof RadixMenu.SubContent>
>(({ className, ...props }, ref) => {
    // Kept mounted once it has been opened - see ContextMenuSub. Hidden rather
    // than faded while closed, since there is nothing to animate out of a
    // submenu that is only being stepped past.
    const kept = useContext(SubmenuKept);
    return (
        <RadixMenu.Portal forceMount={kept || undefined}>
            <RadixMenu.SubContent
                ref={ref}
                forceMount={kept || undefined}
                className={cn(
                    "z-50 min-w-[11rem] overflow-hidden rounded-lg border border-border-strong bg-elevated p-1 text-foreground shadow-popover data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
                    className,
                    kept && "data-[state=closed]:hidden"
                )}
                {...props}
                // After the spread: the menu must never commit an option on the
                // release of the press that opened it.
                onPointerUpCapture={ignoreOpeningPress}
            />
        </RadixMenu.Portal>
    );
});
ContextMenuSubContent.displayName = "ContextMenuSubContent";

export function ContextMenuSeparator({ className }: { className?: string }) {
    return <RadixMenu.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} />;
}

export function ContextMenuLabel({ className, ...props }: ComponentPropsWithoutRef<typeof RadixMenu.Label>) {
    return (
        <RadixMenu.Label
            className={cn("truncate px-2 py-1.5 text-xs font-medium text-muted-foreground", className)}
            {...props}
        />
    );
}
