"use client";

/**
 * The shelf Mail's list is drawn for, and what moving it does to the screen.
 *
 * The server's shelf, or the one the header is switching to while the server
 * renders it (see `shelf-announce`). The list asks for its shelf by name and
 * keeps its copies under it, so it can draw the other shelf from this device at
 * once rather than after the slower shelf's counts. The rail stays the server's
 * until its frame lands.
 *
 * The list and the open conversation are the browser's, and neither had any
 * reason to ask again - so the list kept the other shelf's mail and the
 * conversation stayed open on a mailbox that is not on this shelf. The list is
 * asked for again, and a conversation that was open is closed: it belongs to
 * the shelf that was left. A switch the server refuses puts the list back, and
 * the conversation it closed with it, unless something else was opened since.
 */

import { useEffect, useRef } from "react";
import { shelfAhead, useAnnouncedShelf } from "@/lib/shelf-announce";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** Mail set to show every mailbox, whichever shelf is open: the header's
 *  switch does not move its list. The value of `EVERY_SHELF`, which lives in a
 *  server module. */
export const EVERY_SHELF_KEY = "*";

const LIST_PATH = "/mail";

export function useListShelf(serverShelf: string, reloadLists: () => void): string {
    const switching = useAnnouncedShelf();
    const shelf = shelfAhead(serverShelf, switching, serverShelf !== EVERY_SHELF_KEY);
    const router = useRouter();
    const pathname = usePathname();
    const search = useSearchParams();

    const shownShelf = useRef(shelf);
    // The conversation a switch still on its way closed, and the shelf it was on.
    const closed = useRef<{ shelf: string; href: string } | null>(null);
    useEffect(() => {
        const left = shownShelf.current;
        const back = closed.current;
        if (shelf === serverShelf) closed.current = null;
        if (left === shelf) return;
        shownShelf.current = shelf;
        reloadLists();
        const conversationOpen = search.get("open") !== null || pathname.startsWith("/mail/t/");
        if (back?.shelf === shelf && shelf === serverShelf && !conversationOpen) {
            if (pathname === LIST_PATH) router.replace(back.href, { scroll: false });
            return;
        }
        if (conversationOpen) {
            const query = search.toString();
            if (shelf !== serverShelf) {
                closed.current = { shelf: left, href: query ? `${pathname}?${query}` : pathname };
            }
            router.replace(LIST_PATH, { scroll: false });
        }
    }, [shelf, serverShelf, reloadLists, router, search, pathname]);

    return shelf;
}
