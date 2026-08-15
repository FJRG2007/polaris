"use client";

/**
 * Picking people, wherever Chat needs some.
 *
 * The same search the @ picker uses, so who can be found here is the same set as
 * everywhere else in Polaris and scoped by the same rule - somebody who cannot
 * be mentioned cannot be quietly added to a room either.
 *
 * Chosen people become chips above the field rather than checkmarks in a list,
 * because the question at the end is "who did I pick", and answering it by
 * scrolling a list looking for ticks is the failure this shape avoids.
 */

import { cn } from "@polaris/ui";
import { Avatar } from "@/components/avatar";
import { Loader2, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export interface PickedPerson {
    readonly id: string;
    readonly name: string;
}

/** How long the field sits still before it asks. Long enough that typing a name
 *  is one request rather than eight. */
const SEARCH_AFTER = 220;

export function PeoplePicker({
    picked,
    onChange,
    exclude = [],
    max,
    label = "Add people",
    search
}: {
    picked: readonly PickedPerson[];
    onChange: (picked: readonly PickedPerson[]) => void;
    /** Ids that are already in whatever this is picking for, so they are not
     *  offered as if adding them would do something. */
    exclude?: readonly string[];
    max?: number;
    label?: string;
    /** Who may be offered. Chat passes its own, which leaves out anybody whose
     *  chat is switched off - they have no screen a message could arrive on -
     *  and says how many it left out, so the list can explain itself. */
    search: (
        query: string
    ) => Promise<{ results?: { id: string; name: string }[]; withheld?: number }>;
}) {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<readonly PickedPerson[]>([]);
    const [withheld, setWithheld] = useState(0);
    const [searching, setSearching] = useState(false);
    // Answers can come back out of order; only the newest one may win.
    const asked = useRef(0);

    useEffect(() => {
        const term = query.trim();
        const mine = ++asked.current;
        setSearching(true);
        const timer = setTimeout(async () => {
            const result = await search(term);
            if (mine !== asked.current) return;
            setResults(result.results ?? []);
            setWithheld(result.withheld ?? 0);
            setSearching(false);
        }, SEARCH_AFTER);
        return () => clearTimeout(timer);
    }, [query, search]);

    const taken = new Set([...exclude, ...picked.map((person) => person.id)]);
    const offered = results.filter((person) => !taken.has(person.id));
    const full = max !== undefined && picked.length >= max;

    return (
        <div className="flex flex-col gap-2">
            {picked.length > 0 && (
                <ul className="flex flex-wrap gap-1">
                    {picked.map((person) => (
                        <li key={person.id}>
                            <span className="flex items-center gap-1 rounded-full bg-muted py-0.5 pl-0.5 pr-1.5 text-xs">
                                <Avatar person={person} size={18} />
                                <span className="max-w-[10rem] truncate" title={person.name}>
                                    {person.name}
                                </span>
                                <button
                                    type="button"
                                    aria-label={`Remove ${person.name}`}
                                    onClick={() =>
                                        onChange(picked.filter((entry) => entry.id !== person.id))
                                    }
                                    className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                                >
                                    <X className="size-3" />
                                </button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                    value={query}
                    disabled={full}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={full ? "That is as many as this holds" : "Search by name or email"}
                    aria-label={label}
                    className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-7 text-sm hover:border-border-strong focus:border-border-strong disabled:opacity-60"
                />
                {searching && (
                    <Loader2 className="absolute right-2 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
                )}
            </div>

            {/* Why the list is short, when it is short for a reason. Somebody
                who has just typed a colleague's name and been told "nobody"
                reads it as a broken search; the account is real, it simply
                cannot receive a message. */}
            {!searching && withheld > 0 && (
                <p className="px-2 text-xs text-muted-foreground">
                    {withheld === 1
                        ? "One account matches but does not have Chat."
                        : `${withheld} accounts match but do not have Chat.`}{" "}
                    An administrator can turn it on for them under People.
                </p>
            )}

            <ul className="max-h-48 overflow-y-auto">
                {offered.length === 0 ? (
                    <li className="px-2 py-2 text-xs text-muted-foreground">
                        {searching ? "Looking" : "Nobody else to add."}
                    </li>
                ) : (
                    offered.map((person) => (
                        <li key={person.id}>
                            <button
                                type="button"
                                disabled={full}
                                onClick={() => onChange([...picked, person])}
                                className={cn(
                                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted disabled:opacity-60"
                                )}
                            >
                                <Avatar person={person} size={20} />
                                <span className="truncate" title={person.name}>
                                    {person.name}
                                </span>
                            </button>
                        </li>
                    ))
                )}
            </ul>
        </div>
    );
}
