"use client";

/**
 * Sending a message on to somewhere else.
 *
 * The list is the conversations this person is already in, because that is what
 * forwarding is: moving something you can read into somewhere you can write. It
 * is not a way to reach a room you are not in.
 *
 * Three things about how it is arranged, all of them the same lesson - a flat
 * list of everything is only usable while you have almost nothing.
 *
 * **People come with their faces on.** A row that says a name and nothing else
 * is read letter by letter; a row with a face is recognised. The dot on the face
 * is whether they are there, which is most of what decides whether forwarding
 * something to them is worth doing right now.
 *
 * **Servers are a step, not a section.** Somebody in four servers of thirty
 * channels each was shown a hundred and twenty rows, and the four people they
 * actually talk to were somewhere underneath. So a server is one row, and its
 * channels appear when it is opened. Typing still searches everything at once -
 * the step is for browsing, and nobody browses to something they can name.
 *
 * **Several at a time.** "Look at this" is rarely addressed to one person, and
 * sending the same message four times through four openings of the same dialog
 * is the kind of thing people stop bothering with.
 */

import Fuse from "fuse.js";
import { useChat } from "./chat-context";
import { useEffect, useMemo, useState } from "react";
import { forwardAction } from "./actions";
import { runAction } from "@/lib/run-action";
import { Avatar, AvatarStack } from "@/components/avatar";
import type { ChatMessageView } from "@/lib/chat/messages";
import { listedTargets, type PrivateReply, type Target } from "./forward-targets";
import {
    ChevronLeft,
    ChevronRight,
    CornerUpLeft,
    Forward,
    Hash,
    Loader2,
    Server,
    Volume2
} from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    cn
} from "@polaris/ui";

export type { PrivateReply } from "./forward-targets";

export function ForwardDialog({
    message,
    privately = null,
    onOpenChange,
    onSent
}: {
    /** The message being forwarded. Null closes the dialog - one prop rather
     *  than a boolean beside it, so the two cannot disagree. */
    message: ChatMessageView | null;
    /** Set when this is a private answer to somebody rather than a forward. */
    privately?: PrivateReply | null;
    onOpenChange: (open: boolean) => void;
    onSent: () => void;
}) {
    const { channels, spaces } = useChat();
    const [chosen, setChosen] = useState<readonly string[]>([]);
    /** The server being looked inside, or null at the top level. */
    const [inside, setInside] = useState<string | null>(null);
    const [note, setNote] = useState("");
    const [query, setQuery] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    /**
     * Nothing carried from the last time this was open.
     *
     * The dialog is not unmounted when it closes - `message` is what opens it,
     * and the component stays there holding whatever was typed into it. So the
     * reply meant for one person was still in the box, focused, when the next
     * one opened, one press from being sent to somebody it was not about; and a
     * forward cancelled with three conversations chosen offered to send the next
     * message to those same three.
     *
     * Keyed on the message rather than only on closing, so a dialog reopened
     * straight onto a different message starts clean as well.
     */
    useEffect(() => {
        setChosen([]);
        setNote("");
        setQuery("");
        setInside(null);
        setError("");
    }, [message?.id]);

    const open = useMemo(() => channels.filter((channel) => !channel.archived), [channels]);

    /** Everywhere this message can go, as one flat list. What the search reads,
     *  and what the browse is carved back out of. */
    const targets = useMemo<readonly Target[]>(() => {
        const places = new Map(spaces.map((space) => [space.id, space.name]));
        return open.map((channel) => ({
            id: channel.id,
            name: channel.name,
            kind: channel.kind,
            spaceId: channel.spaceId,
            people: channel.spaceId ? [] : channel.others,
            place: channel.spaceId ? (places.get(channel.spaceId) ?? null) : null
        }));
    }, [open, spaces]);

    /**
     * Ranked rather than filtered.
     *
     * Somebody forwarding a message is typing a room name from memory, into a
     * box, in a hurry - which is exactly where a substring match fails: a
     * transposed letter, a missing accent or two words the other way round and
     * the conversation they meant is simply not in the list. Fuse is already
     * carried for the task search, the data is already here, and the ranking is
     * the point: the best match should be first, not wherever the array put it.
     *
     * It reads the flat list on purpose. Typing is how somebody reaches a
     * channel buried three servers down without opening three servers.
     */
    const index = useMemo(
        () => new Fuse(targets, { keys: ["name", "place"], threshold: 0.3, ignoreLocation: true }),
        [targets]
    );

    const searching = query.trim().length > 0;
    const found = useMemo(
        () => (searching ? index.search(query.trim()).map((hit) => hit.item) : []),
        [index, query, searching]
    );

    /** What is on screen right now, which is one of three things. */
    const listed = listedTargets(targets, { found: searching ? found : null, inside });

    const openServers = !searching && !inside && spaces.length > 0;

    const pick = (id: string) =>
        setChosen((current) =>
            current.includes(id) ? current.filter((one) => one !== id) : [...current, id]
        );

    /** Where it is actually going: what was chosen, or the one conversation that
     *  was decided before this opened. */
    const going = privately ? [privately.channelId] : chosen;

    const send = async () => {
        if (!message || going.length === 0) return;
        setBusy(true);
        setError("");
        // One at a time rather than one request carrying a list: each is asked
        // and answered on its own, so a channel that refuses takes only itself
        // down and the person is told which one it was.
        const refused: string[] = [];
        for (const id of going) {
            const result = await runAction(
                () => forwardAction({ messageId: message.id, channelId: id, note }),
                () => undefined
            );
            if (!result || result.error) refused.push(id);
        }
        setBusy(false);
        const named = refused.map(
            (id) =>
                targets.find((target) => target.id === id)?.name ??
                // A conversation opened a moment ago to answer somebody is not
                // in this browser's list yet, and naming it "a conversation"
                // when the dialog is titled with their name reads as a bug.
                privately?.name ??
                "a conversation"
        );
        if (refused.length === going.length) {
            setError(
                refused.length === 1
                    ? `It could not be sent to ${named[0]}.`
                    : "It could not be sent to any of those."
            );
            return;
        }
        if (refused.length > 0) {
            // Partly through is the case worth being exact about: saying "sent"
            // would leave somebody believing a person heard from them who did
            // not, and saying "failed" would send it twice to everybody else.
            // So the ones that went are dropped from the choice and only the
            // ones that did not are left selected, ready to try again.
            setError(`Sent, except to ${named.join(", ")}.`);
            setChosen(refused);
            return;
        }
        onOpenChange(false);
        onSent();
    };

    const place = spaces.find((space) => space.id === inside);

    return (
        <Dialog open={message !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {privately
                            ? `Reply to ${privately.name} privately`
                            : "Forward this message"}
                    </DialogTitle>
                    <DialogDescription>
                        {privately
                            ? "It goes to them alone, with the original quoted - nobody else in this conversation sees it."
                            : "It arrives quoted, so who said it and when goes with it."}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    {!privately && (
                        <Input
                            value={query}
                            placeholder="Find a person, a group or a channel"
                            aria-label="Find a person, a group or a channel"
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    )}

                    {!privately && inside && !searching && (
                        <button
                            type="button"
                            onClick={() => setInside(null)}
                            className="flex items-center gap-1.5 self-start text-xs text-muted-foreground transition-colors hover:text-foreground"
                        >
                            <ChevronLeft className="size-3.5 shrink-0" />
                            {place?.name ?? "Back"}
                        </button>
                    )}

                    {!privately && (
                        <ul className="max-h-64 overflow-y-auto rounded-md border border-border">
                            {openServers &&
                                spaces
                                    .filter((space) => !space.archived)
                                    .map((space) => (
                                        <li key={space.id}>
                                            <button
                                                type="button"
                                                onClick={() => setInside(space.id)}
                                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                                            >
                                                <Server className="size-3.5 shrink-0 text-muted-foreground" />
                                                <span
                                                    className="min-w-0 flex-1 truncate"
                                                    title={space.name}
                                                >
                                                    {space.name}
                                                </span>
                                                {/* How many of the chosen are in
                                                there, so a server closed over a
                                                choice does not hide it. */}
                                                {targets.some(
                                                    (target) =>
                                                        target.spaceId === space.id &&
                                                        chosen.includes(target.id)
                                                ) && (
                                                    <span className="shrink-0 rounded bg-primary/15 px-1.5 text-[11px] text-primary">
                                                        chosen
                                                    </span>
                                                )}
                                                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                                            </button>
                                        </li>
                                    ))}

                            {listed.length === 0 && !openServers ? (
                                <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                                    {searching
                                        ? "Nothing matches that."
                                        : "Nothing to forward to yet."}
                                </li>
                            ) : (
                                listed.map((target) => (
                                    <li key={target.id}>
                                        <button
                                            type="button"
                                            onClick={() => pick(target.id)}
                                            aria-pressed={chosen.includes(target.id)}
                                            className={cn(
                                                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted",
                                                chosen.includes(target.id) && "bg-card-hover"
                                            )}
                                        >
                                            <Face target={target} />
                                            <span className="flex min-w-0 flex-1 flex-col">
                                                <span className="truncate" title={target.name}>
                                                    {target.name}
                                                </span>
                                                {/* Only while searching: inside a
                                                server every row is in it, and
                                                repeating its name on all thirty
                                                is noise. */}
                                                {searching && target.place && (
                                                    <span className="truncate text-xs text-muted-foreground">
                                                        {target.place}
                                                    </span>
                                                )}
                                            </span>
                                            {chosen.includes(target.id) && (
                                                <span className="shrink-0 text-[11px] text-primary">
                                                    chosen
                                                </span>
                                            )}
                                        </button>
                                    </li>
                                ))
                            )}
                        </ul>
                    )}

                    <Input
                        value={note}
                        autoFocus={privately !== null}
                        placeholder={
                            privately ? "Write your reply" : "Say something about it (optional)"
                        }
                        aria-label={privately ? "Your reply" : "Say something about it"}
                        onChange={(event) => setNote(event.target.value)}
                    />

                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        size="sm"
                        disabled={busy || going.length === 0}
                        onClick={() => void send()}
                    >
                        {busy ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : privately ? (
                            <CornerUpLeft className="size-4" />
                        ) : (
                            <Forward className="size-4" />
                        )}
                        {privately
                            ? "Send"
                            : chosen.length > 1
                              ? `Forward to ${chosen.length}`
                              : "Forward"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** What a row is: somebody's face, several faces, or the mark of a room. */
function Face({ target }: { target: Target }) {
    if (target.people.length > 1) return <AvatarStack people={target.people} size={22} />;
    const person = target.people[0];
    // The dot on the face is drawn by the avatar itself, from the same live
    // presence every other face on screen reads.
    if (person) return <Avatar person={person} size={22} />;
    return target.kind === "voice" ? (
        <Volume2 className="size-3.5 shrink-0 text-muted-foreground" />
    ) : (
        <Hash className="size-3.5 shrink-0 text-muted-foreground" />
    );
}
