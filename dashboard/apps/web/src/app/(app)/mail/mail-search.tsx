"use client";

/**
 * The search box above the list.
 *
 * It searches what Polaris holds - the window it keeps of each folder - which is
 * the newest few hundred messages of each and covers nearly every search anybody
 * actually performs. It says so when it comes back with nothing rather than
 * implying the message does not exist, because the message very often does and
 * is simply older than the window.
 *
 * The query goes into the address, so a search is a page somebody can go back
 * to, bookmark, or open in a second tab beside the first. Typing is debounced,
 * because every keystroke is a database query and a router navigation.
 */

import { Input } from "@polaris/ui";
import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** How long typing settles before the address changes. Long enough that a
 *  sentence is one navigation, short enough that it feels immediate. */
const SETTLE_MS = 300;

export function MailSearch() {
    const router = useRouter();
    const pathname = usePathname();
    const search = useSearchParams();
    const applied = search.get("q") ?? "";
    const [typed, setTyped] = useState(applied);

    // The address changed under the box: a back button, or another screen
    // linking here with a query already on it.
    useEffect(() => {
        setTyped(applied);
    }, [applied]);

    useEffect(() => {
        if (typed === applied) return;
        const timer = setTimeout(() => {
            const next = new URLSearchParams(search.toString());
            if (typed.trim()) next.set("q", typed.trim());
            else next.delete("q");
            // A new search starts at the top: the cursor belongs to the previous
            // one and would skip the first page of this one.
            next.delete("before");
            next.delete("open");
            router.replace(`${pathname}?${next.toString()}`);
        }, SETTLE_MS);
        return () => clearTimeout(timer);
    }, [typed, applied, pathname, router, search]);

    return (
        <div className="relative">
            <Search
                className="pointer-events-none absolute left-2 top-1/2 size-3.5 shrink-0 -translate-y-1/2 text-foreground-subtle"
                aria-hidden
            />
            <Input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder="Search mail"
                aria-label="Search mail"
                className="h-8 pl-7 pr-7 text-[13px]"
            />
            {typed ? (
                <button
                    type="button"
                    aria-label="Clear the search"
                    title="Clear the search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground-subtle hover:text-foreground"
                    onClick={() => setTyped("")}
                >
                    <X className="size-3.5 shrink-0" aria-hidden />
                </button>
            ) : null}
        </div>
    );
}
