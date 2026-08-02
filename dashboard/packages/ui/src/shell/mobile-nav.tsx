"use client";

/**
 * The left rail on phones. Below the breakpoint where the rail fits beside the
 * content it is not shown at all, so this is how its sections stay reachable: a
 * header button that slides the same rail in over the page. Picking a section
 * navigates, so the panel closes on any link inside it rather than leaving the
 * page covered by the sheet the user just used.
 */

import { useState } from "react";
import { Menu } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "../components/dialog";

export function MobileNav({ children }: { children: ReactNode }) {
    const [open, setOpen] = useState(false);

    function onPanelClick(event: MouseEvent<HTMLDivElement>) {
        if ((event.target as HTMLElement).closest("a")) setOpen(false);
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <button
                type="button"
                onClick={() => setOpen(true)}
                aria-label="Open navigation"
                className="-ml-1 grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
            >
                <Menu className="size-5" />
            </button>
            <DialogContent
                showClose={false}
                className="left-0 top-0 h-full max-h-none w-64 max-w-[85vw] translate-x-0 translate-y-0 overflow-y-auto rounded-none rounded-r-xl border-y-0 border-l-0 p-3 data-[state=open]:zoom-in-100 data-[state=open]:slide-in-from-left-4"
            >
                <DialogTitle className="sr-only">Navigation</DialogTitle>
                <div onClick={onPanelClick}>{children}</div>
            </DialogContent>
        </Dialog>
    );
}
