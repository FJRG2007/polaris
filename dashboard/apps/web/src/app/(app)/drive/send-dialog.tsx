"use client";

/**
 * Sending a file or a folder to somebody.
 *
 * The two things this screen has to get right are both about not surprising
 * anybody. A copy is the default, and the other option says what it does in
 * words rather than in a verb - "send the file itself" beside a line saying it
 * leaves your Drive, because "move" reads as a filing operation right up until
 * the file is gone. And a name that cannot receive is shown, greyed, rather than
 * hidden: a person missing from a list learns nothing, while a person who is
 * there and not offered is a question with an answer.
 */

import { runAction } from "@/lib/run-action";
import { Building2, Send, User } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import {
    findTransferPeopleAction,
    sendTransferAction,
    transferOrgsAction
} from "./transfer-actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input,
    Switch,
    Textarea
} from "@polaris/ui";

interface Candidate {
    readonly id: string;
    readonly name: string;
    readonly allowed: boolean;
    readonly isOrg?: boolean;
}

export function SendDialog({
    open,
    onOpenChange,
    connectionId,
    path,
    name,
    onSent
}: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly connectionId: string;
    readonly path: string;
    readonly name: string;
    readonly onSent?: (count: number) => void;
}) {
    const [query, setQuery] = useState("");
    const [found, setFound] = useState<Candidate[]>([]);
    const [orgs, setOrgs] = useState<Candidate[]>([]);
    const [chosen, setChosen] = useState<Candidate[]>([]);
    const [note, setNote] = useState("");
    const [giveUp, setGiveUp] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();

    useEffect(() => {
        if (!open) return;
        setQuery("");
        setFound([]);
        setChosen([]);
        setNote("");
        setGiveUp(false);
        setError(null);
        void transferOrgsAction()
            .then((rows) =>
                setOrgs(rows.map((org) => ({ ...org, allowed: true, isOrg: true })))
            )
            .catch(() => setOrgs([]));
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const text = query.trim();
        if (text.length < 2) {
            setFound([]);
            return;
        }
        // Typed into, so the search waits for a pause rather than asking on
        // every letter.
        const timer = setTimeout(() => {
            void findTransferPeopleAction(text)
                .then((result) => setFound(result.results))
                .catch(() => setFound([]));
        }, 250);
        return () => clearTimeout(timer);
    }, [open, query]);

    // Sending the file itself has one recipient, because "move it to all of
    // them" has no meaning. Choosing a second is what turns it back into a copy.
    const canGiveUp = chosen.length <= 1;
    const mode = giveUp && canGiveUp ? "move" : "copy";

    const pick = (candidate: Candidate) => {
        if (!candidate.allowed) return;
        setChosen((current) =>
            current.some((one) => one.id === candidate.id)
                ? current.filter((one) => one.id !== candidate.id)
                : [...current, candidate]
        );
    };

    const send = () => {
        if (chosen.length === 0) return;
        startTransition(() => {
            void runAction(
                () =>
                    sendTransferAction({
                        connectionId,
                        path,
                        mode,
                        note: note.trim() || undefined,
                        to: chosen.map((one) =>
                            one.isOrg ? { orgId: one.id } : { userId: one.id }
                        )
                    }),
                setError
            ).then((result) => {
                if (result?.error) {
                    setError(result.error);
                    return;
                }
                onSent?.(result?.sent ?? chosen.length);
                onOpenChange(false);
            });
        });
    };

    const rows = [...orgs, ...found.filter((person) => !orgs.some((org) => org.id === person.id))];

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>Send {name}</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                    {error ? <p className="text-sm text-red-400">{error}</p> : null}

                    <Input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search for a person"
                        aria-label="Search for a person"
                    />

                    <div className="max-h-56 space-y-1 overflow-y-auto">
                        {rows.map((candidate) => {
                            const picked = chosen.some((one) => one.id === candidate.id);
                            return (
                                <button
                                    key={candidate.id}
                                    type="button"
                                    onClick={() => pick(candidate)}
                                    disabled={!candidate.allowed}
                                    aria-pressed={picked}
                                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                                        picked ? "bg-primary/10" : "hover:bg-surface-sunken"
                                    } ${candidate.allowed ? "" : "opacity-50"}`}
                                >
                                    {candidate.isOrg ? (
                                        <Building2 className="size-4 shrink-0 text-muted-foreground" />
                                    ) : (
                                        <User className="size-4 shrink-0 text-muted-foreground" />
                                    )}
                                    <span className="min-w-0 flex-1 truncate" title={candidate.name}>{candidate.name}</span>
                                    {candidate.allowed ? null : (
                                        <span className="shrink-0 text-xs text-muted-foreground">
                                            Not accepting files
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                        {rows.length === 0 && query.trim().length >= 2 ? (
                            <p className="px-2 py-1.5 text-sm text-muted-foreground">
                                Nobody by that name.
                            </p>
                        ) : null}
                    </div>

                    <Textarea
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="Say something about it (optional)"
                        aria-label="Say something about it"
                        rows={2}
                    />

                    <div className="flex items-start gap-3">
                        <Switch
                            checked={mode === "move"}
                            disabled={!canGiveUp}
                            onChange={setGiveUp}
                            aria-label="Send the file itself"
                        />
                        <div className="text-sm">
                            <p>Send the file itself</p>
                            <p className="text-xs text-muted-foreground">
                                {canGiveUp
                                    ? "It leaves your Drive once they accept it. Off, they get a copy and you keep yours."
                                    : "Only when you are sending to one person. Everybody else gets a copy."}
                            </p>
                        </div>
                    </div>

                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button onClick={send} disabled={busy || chosen.length === 0}>
                            <Send className="size-4 shrink-0" />
                            {chosen.length > 1 ? `Send to ${chosen.length}` : "Send"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
