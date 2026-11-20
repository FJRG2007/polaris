"use client";

/**
 * The left rail on phones. Below the breakpoint where the rail fits beside the
 * content it is not shown at all, so this is how its sections stay reachable: a
 * header button that slides the same rail in over the page. Picking a section
 * navigates, so the panel closes on any link inside it rather than leaving the
 * page covered by the sheet the user just used.
 *
 * An entry that opens something of its own rather than navigating - the rail's
 * "More apps", which opens the app menu - marks itself `data-closes-nav`. The
 * panel closes for it too, and keeps the focus off the header button it would
 * otherwise go back to, because that move is what would close the menu the
 * entry just asked for.
 *
 * On a phone (`phoneTitle` given, which the caller passes below `sm`) it is a
 * whole screen under a title instead of a narrow drawer, the way the account
 * screen opens there: the caller draws its rows to match.
 */

import { useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "../components/dialog";
import { useUiStrings } from "../lib/ui-strings";

export function MobileNav({ children, phoneTitle }: { children: ReactNode; phoneTitle?: string }) {
    const [open, setOpen] = useState(false);
    const handedOff = useRef(false);
    const words = useUiStrings();

    function onPanelClick(event: MouseEvent<HTMLDivElement>) {
        const target = event.target as HTMLElement;
        if (target.closest("[data-closes-nav]")) {
            handedOff.current = true;
            setOpen(false);
        } else if (target.closest("a")) setOpen(false);
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <button
                type="button"
                data-tour="shell.menu"
                onClick={() => setOpen(true)}
                aria-label={words.openNavigation}
                className="-ms-1 grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
            >
                <Menu className="size-5" />
            </button>
            {phoneTitle ? (
                <DialogContent
                    phone="full"
                    showClose={false}
                    onCloseAutoFocus={(event) => {
                        if (!handedOff.current) return;
                        handedOff.current = false;
                        event.preventDefault();
                    }}
                    className="flex max-w-md flex-col gap-5 bg-background"
                >
                    <div className="flex min-w-0 items-center justify-between gap-2">
                        <DialogTitle className="min-w-0 truncate text-[1.0625rem] font-semibold">
                            {phoneTitle}
                        </DialogTitle>
                        <button
                            type="button"
                            onClick={() => setOpen(false)}
                            aria-label={words.close}
                            className="-me-2 grid size-10 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <X className="size-5 shrink-0" />
                        </button>
                    </div>
                    <div onClick={onPanelClick}>{children}</div>
                </DialogContent>
            ) : (
                <DialogContent
                    showClose={false}
                    onCloseAutoFocus={(event) => {
                        if (!handedOff.current) return;
                        handedOff.current = false;
                        event.preventDefault();
                    }}
                    className="left-0 top-0 h-full max-h-none w-64 max-w-[85vw] translate-x-0 translate-y-0 overflow-y-auto overscroll-contain rounded-none rounded-r-xl border-y-0 border-l-0 p-3 data-[state=open]:zoom-in-100 data-[state=open]:slide-in-from-left-4"
                >
                    <DialogTitle className="sr-only">{words.navigation}</DialogTitle>
                    <div onClick={onPanelClick}>{children}</div>
                </DialogContent>
            )}
        </Dialog>
    );
}
