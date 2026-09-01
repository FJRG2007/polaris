"use client";

/**
 * How many follow somebody, and who they are.
 *
 * The two numbers are on the page and the names are one press away, because that
 * is the shape of the question: "how many" is glanced at, "who" is asked
 * occasionally, and a list of four hundred names drawn under every profile is a
 * page nobody scrolls past.
 *
 * The counts are always drawn and the names are the setting, and they are not
 * the same disclosure. A number says how many people are interested in somebody,
 * which is a fact about them and belongs on their page the way the day they
 * joined does; a list says WHO, which is a fact about several other people who
 * never chose to appear on this page. Hiding the number along with the names took
 * away the one part a profile is expected to carry and left a page that read as
 * broken rather than as private.
 *
 * Who somebody follows says exactly as much about them as who follows them, so
 * one setting decides both lists. The server checks it again when a page of names
 * is asked for, because this screen is not what enforces anything.
 *
 * The list is built for the account that has thousands: it loads as it is
 * scrolled rather than behind a button, and the search reaches the whole list
 * rather than the page on screen - somebody looking for one name in four hundred
 * is precisely the person who will never scroll to it. What is typed narrows the
 * stream at the database and is then ranked here, so a near miss or a transposed
 * letter still lands where it should.
 */

import Fuse from "fuse.js";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { Loader2, Search } from "lucide-react";
import { loadFollowListAction } from "./actions";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, DialogContent, DialogTitle, Input } from "@polaris/ui";

interface Person {
    id: string;
    name: string;
    username: string;
}

type Which = "followers" | "following";

export function FollowLists({
    personId,
    name,
    followers,
    following,
    showsNames
}: {
    personId: string;
    name: string;
    followers: number;
    following: number;
    /** Whether the names behind the numbers may be opened by this reader. */
    showsNames: boolean;
}) {
    const [open, setOpen] = useState<Which | null>(null);

    return (
        <>
            <div className="flex flex-wrap items-center gap-4 border-t border-border pt-4 text-sm">
                <Count
                    label="followers"
                    value={followers}
                    onOpen={showsNames ? () => setOpen("followers") : null}
                />
                <Count
                    label="following"
                    value={following}
                    onOpen={showsNames ? () => setOpen("following") : null}
                />
            </div>
            {open ? (
                <PeopleDialog which={open} personId={personId} name={name} onClose={() => setOpen(null)} />
            ) : null}
        </>
    );
}

/**
 * A number and what it counts.
 *
 * Not pressable at zero - a list nobody is on is a dialog that opens on an empty
 * box - and not pressable where the names are not this reader's to see. Both are
 * drawn as plain text rather than as a disabled button: a control that visibly
 * refuses is an invitation to work out why, and the answer here is somebody's
 * privacy setting, which is not this reader's business either.
 */
function Count({ label, value, onOpen }: { label: string; value: number; onOpen: (() => void) | null }) {
    const text = (
        <>
            <span className="font-medium tabular-nums text-foreground">{value}</span>{" "}
            <span className="text-muted-foreground">{label}</span>
        </>
    );
    if (value === 0 || !onOpen) return <span>{text}</span>;
    return (
        <button type="button" onClick={onOpen} className="hover:underline">
            {text}
        </button>
    );
}

/** How long a keystroke waits before it becomes a request. Long enough that
 *  typing a name is one query rather than eight, short enough to read as live. */
const SEARCH_DEBOUNCE_MS = 220;

/** One of the two lists: searched, and loaded as it is scrolled. */
function PeopleDialog({
    which,
    personId,
    name,
    onClose
}: {
    which: Which;
    personId: string;
    name: string;
    onClose: () => void;
}) {
    const [typed, setTyped] = useState("");
    const [query, setQuery] = useState("");
    const [people, setPeople] = useState<Person[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    // What is typed becomes what is asked for, once the typing stops. Held in two
    // pieces so the field itself never waits on anything: the letters appear as
    // they are pressed and the list catches up.
    useEffect(() => {
        const timer = setTimeout(() => setQuery(typed.trim()), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [typed]);

    // Which request an answer belongs to. A search typed quickly leaves two in
    // flight, and without this the slower one lands last and puts the previous
    // query's names under the current one.
    const asked = useRef(0);

    const load = useCallback(
        async (before: string | null, term: string) => {
            const ticket = before === null ? (asked.current += 1) : asked.current;
            setBusy(true);
            setError("");
            const result = await runAction(
                () => loadFollowListAction({ personId, which, before, query: term || null }),
                setError
            );
            if (ticket !== asked.current) return;
            setBusy(false);
            setLoaded(true);
            if (!result || result.error) {
                if (result?.error) setError(result.error);
                return;
            }
            const items = result.items ?? [];
            setPeople((current) => (before === null ? items : [...current, ...items]));
            setCursor(result.cursor ?? null);
        },
        [personId, which]
    );

    // The first page on the way in, and a fresh first page whenever the search
    // changes. In an effect rather than from the render: a request started while
    // rendering sets state during the render that started it.
    useEffect(() => {
        setPeople([]);
        setCursor(null);
        setLoaded(false);
        void load(null, query);
    }, [load, query]);

    /**
     * The end of the list, watched.
     *
     * A sentinel rather than a scroll handler: a handler fires on every pixel and
     * has to work out where the bottom is, which is the calculation that breaks
     * the day the row height changes. The observer's root is the scrolling box
     * rather than the window, because the list scrolls inside a dialog.
     *
     * Guarded on `busy` as well as on the cursor: the sentinel stays visible
     * while a short page is being appended, and without the guard that is the
     * same page asked for three times.
     */
    const sentinel = useRef<HTMLDivElement | null>(null);
    const listBox = useRef<HTMLUListElement | null>(null);
    useEffect(() => {
        const mark = sentinel.current;
        if (!mark || !cursor || busy) return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) void load(cursor, query);
            },
            { root: listBox.current, rootMargin: "120px" }
        );
        observer.observe(mark);
        return () => observer.disconnect();
    }, [cursor, busy, load, query]);

    /**
     * The names, ranked against what was typed.
     *
     * The database already narrowed the stream to the ones that contain the term,
     * so this is about order rather than about membership - and nothing it fails
     * to rank is dropped. A transposed letter still puts the right person at the
     * top, and the rest keep the order they arrived in, which is the order the
     * list has when nothing is typed.
     */
    const shown = useMemo(() => {
        const term = query.trim();
        if (!term || people.length === 0) return people;
        const ranked = new Fuse(people, {
            threshold: 0.35,
            ignoreLocation: true,
            keys: [
                { name: "name", weight: 3 },
                { name: "username", weight: 2 }
            ]
        })
            .search(term)
            .map((hit) => hit.item);
        const seen = new Set(ranked.map((person) => person.id));
        return [...ranked, ...people.filter((person) => !seen.has(person.id))];
    }, [people, query]);

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="max-w-sm">
                <DialogTitle>
                    {which === "followers" ? `People following ${name}` : `Who ${name} follows`}
                </DialogTitle>

                <div className="relative">
                    <Search className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2" />
                    <Input
                        autoFocus
                        value={typed}
                        onChange={(event) => setTyped(event.target.value)}
                        placeholder="Search by name or username"
                        aria-label="Search these people"
                        className="pl-8"
                    />
                </div>

                <ul ref={listBox} className="flex max-h-80 flex-col gap-1 overflow-y-auto">
                    {shown.map((person) => (
                        <li key={person.id}>
                            <Link
                                href={`/u/${person.username}`}
                                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
                            >
                                <Avatar person={person} size={24} status={false} />
                                <span className="min-w-0 flex-1 truncate" title={person.name}>{person.name}</span>
                                <span className="text-muted-foreground shrink-0 text-xs">
                                    @{person.username}
                                </span>
                            </Link>
                        </li>
                    ))}
                    {shown.length === 0 && loaded && !busy && !error ? (
                        <li className="text-muted-foreground px-2 py-6 text-center text-sm">
                            {query ? "Nobody here matches that." : "Nobody here."}
                        </li>
                    ) : null}
                    {/* The end of what has been loaded. Only drawn while there is
                        more, so an exhausted list has nothing left to trip. */}
                    {cursor ? <div ref={sentinel} aria-hidden className="h-px shrink-0" /> : null}
                </ul>

                {error ? <p className="text-danger text-sm">{error}</p> : null}
                {busy ? <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" /> : null}
                {/* The way down for anybody the observer cannot serve - a browser
                    with it switched off, and a keyboard, which never scrolls a
                    box it has not been given a reason to enter. */}
                {cursor && !busy ? (
                    <Button size="sm" variant="ghost" onClick={() => void load(cursor, query)}>
                        Show more
                    </Button>
                ) : null}
            </DialogContent>
        </Dialog>
    );
}
