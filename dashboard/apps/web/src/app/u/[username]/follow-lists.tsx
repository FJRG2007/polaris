"use client";

/**
 * How many follow somebody, and who they are.
 *
 * The two numbers are on the page and the names are one press away, because that
 * is the shape of the question: "how many" is glanced at, "who" is asked
 * occasionally, and a list of four hundred names drawn under every profile is a
 * page nobody scrolls past.
 *
 * Both are one disclosure and one setting. Who somebody follows says exactly as
 * much about them as who follows them, and a product that hid one and published
 * the other would be publishing the same fact from the other end. The setting's
 * default is the operator's - see `defaultFollowerAudience` - and the server
 * checks it again when a page of names is asked for, because this screen is not
 * what enforces anything.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { loadFollowListAction } from "./actions";
import { Loader2 } from "lucide-react";
import { Button, Dialog, DialogContent, DialogTitle } from "@polaris/ui";

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
    following
}: {
    personId: string;
    name: string;
    followers: number;
    following: number;
}) {
    const [open, setOpen] = useState<Which | null>(null);

    return (
        <>
            <div className="flex flex-wrap items-center gap-4 border-t border-border pt-4 text-sm">
                <Count label="followers" value={followers} onOpen={() => setOpen("followers")} />
                <Count label="following" value={following} onOpen={() => setOpen("following")} />
            </div>
            {open ? (
                <PeopleDialog which={open} personId={personId} name={name} onClose={() => setOpen(null)} />
            ) : null}
        </>
    );
}

/** A number and what it counts. Not pressable at zero: a list nobody is on is a
 *  dialog that opens on an empty box. */
function Count({ label, value, onOpen }: { label: string; value: number; onOpen: () => void }) {
    const text = (
        <>
            <span className="font-medium tabular-nums text-foreground">{value}</span>{" "}
            <span className="text-muted-foreground">{label}</span>
        </>
    );
    if (value === 0) return <span>{text}</span>;
    return (
        <button type="button" onClick={onOpen} className="hover:underline">
            {text}
        </button>
    );
}

/** One of the two lists, a page at a time. */
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
    const [people, setPeople] = useState<Person[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const load = async (before: string | null) => {
        setBusy(true);
        setError("");
        const result = await runAction(
            () => loadFollowListAction({ personId, which, before }),
            setError
        );
        setBusy(false);
        setLoaded(true);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        setPeople((current) => [...current, ...(result.items ?? [])]);
        setCursor(result.cursor ?? null);
    };

    // The first page on the way in. In an effect and guarded by a ref, never
    // from the render: a request started while rendering sets state during the
    // render that started it, and the strict double-mount would ask twice.
    const asked = useRef(false);
    useEffect(() => {
        if (asked.current) return;
        asked.current = true;
        void load(null);
        // Once, on the way in. `load` closes over nothing that changes before it
        // has run.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent className="max-w-sm">
                <DialogTitle>
                    {which === "followers" ? `People following ${name}` : `Who ${name} follows`}
                </DialogTitle>
                <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
                    {people.map((person) => (
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
                    {people.length === 0 && loaded && !error ? (
                        <li className="text-muted-foreground px-2 py-6 text-center text-sm">
                            Nobody here.
                        </li>
                    ) : null}
                </ul>
                {error ? <p className="text-danger text-sm">{error}</p> : null}
                {cursor ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load(cursor)}>
                        Show more
                    </Button>
                ) : null}
                {busy ? <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" /> : null}
            </DialogContent>
        </Dialog>
    );
}
