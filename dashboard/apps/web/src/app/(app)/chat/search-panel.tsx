"use client";

/**
 * Looking for something somebody said, beside the conversation.
 *
 * A panel rather than a dialog, for the same reason threads are one: a search is
 * something you read *against* the room you are in, and a modal over it hides
 * the thing you are comparing to.
 *
 * It opens narrowed to the conversation you are in, because that is where nearly
 * every search starts - "where did they post that link" is almost always about
 * the room already on screen. One switch widens it to everywhere.
 *
 * The search runs when it is asked to rather than on every keystroke: a term of
 * one letter matches most of the archive, and running that against every
 * conversation somebody can reach is a query nobody wanted.
 */

import * as core from "@polaris/core";
import { useChat } from "./chat-context";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import { searchMessagesAction, searchPeopleAction } from "./actions";
import { useEffect, useMemo, useState } from "react";
import type { ChatSearchHit } from "@/lib/chat/search";
import { RelativeTime } from "@/components/relative-time";
import { referenced } from "./message-references";
import { RichText } from "@/components/rich-text/rich-text";
import { Hash, Loader2, Search, Users, X } from "lucide-react";
import { Button, Input, SegmentedControl, cn } from "@polaris/ui";

export function SearchPanel({
    channelId,
    channelName,
    onClose,
    onOpen
}: {
    /** The conversation the panel opened over, which is what it narrows to
     *  first. */
    channelId: string;
    channelName: string;
    onClose: () => void;
    /** Go to a hit. The panel stays open: somebody working through results
     *  wants the next one to still be there. */
    onOpen: (hit: ChatSearchHit) => void;
}) {
    const { viewerId } = useChat();
    const [term, setTerm] = useState("");
    const [here, setHere] = useState(true);
    const [author, setAuthor] = useState<PickedPerson | null>(null);
    const [has, setHas] = useState<core.ChatSearchAttachment>("any");
    const [after, setAfter] = useState("");
    const [before, setBefore] = useState("");
    const [hits, setHits] = useState<readonly ChatSearchHit[] | null>(null);
    const [busy, setBusy] = useState(false);

    const query = useMemo(
        () => ({
            term,
            channelId: here ? channelId : null,
            authorId: author?.id ?? null,
            has,
            after: after || null,
            before: before || null
        }),
        [after, author, before, channelId, has, here, term]
    );

    // Nothing is narrowed and nothing is asked for. Searching then would fetch
    // the newest fifty messages of everything, which is the rail's job.
    const empty = core.chatSearchIsEmpty(core.chatSearchSchema.parse(query));

    const run = async () => {
        if (empty) return;
        setBusy(true);
        const result = await searchMessagesAction(query);
        setBusy(false);
        setHits(result.hits);
    };

    // A filter changed while results are on screen: they are now answering a
    // question nobody asked. Cleared rather than silently stale.
    useEffect(() => {
        setHits(null);
    }, [query]);

    return (
        <aside className="flex w-80 min-w-0 shrink-0 flex-col border-l border-border">
            <div className="flex h-header shrink-0 items-center gap-2 border-b border-border px-3">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm font-semibold">Search</span>
                <button
                    type="button"
                    aria-label="Close search"
                    onClick={onClose}
                    className="ml-auto rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <X className="size-4" />
                </button>
            </div>

            <div className="flex flex-col gap-2 border-b border-border p-3">
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        void run();
                    }}
                >
                    <Input
                        value={term}
                        autoFocus
                        placeholder="What was said"
                        aria-label="What was said"
                        onChange={(event) => setTerm(event.target.value)}
                    />
                </form>

                <SegmentedControl
                    size="sm"
                    aria-label="Where to look"
                    value={here ? "here" : "everywhere"}
                    onValueChange={(value) => setHere(value === "here")}
                    options={[
                        { value: "here", label: "This conversation", title: channelName },
                        { value: "everywhere", label: "Everywhere" }
                    ]}
                />

                {/* One person at most: "from either of these two" is a
                    question nobody asks a chat search. */}
                <PeoplePicker
                    label="From somebody in particular"
                    max={1}
                    picked={author ? [author] : []}
                    onChange={(picked) => setAuthor(picked.at(-1) ?? null)}
                    search={searchPeopleAction}
                />

                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Carrying
                    <SegmentedControl
                        size="sm"
                        aria-label="What the message carries"
                        value={has}
                        onValueChange={setHas}
                        options={core.CHAT_SEARCH_ATTACHMENTS.map((value) => ({
                            value,
                            label: core.CHAT_SEARCH_ATTACHMENT_LABELS[value]
                        }))}
                    />
                </label>

                <div className="flex items-center gap-2">
                    <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                        After
                        <Input
                            type="date"
                            value={after}
                            aria-label="On or after"
                            onChange={(event) => setAfter(event.target.value)}
                        />
                    </label>
                    <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                        Before
                        <Input
                            type="date"
                            value={before}
                            aria-label="On or before"
                            onChange={(event) => setBefore(event.target.value)}
                        />
                    </label>
                </div>

                <Button size="sm" disabled={empty || busy} onClick={() => void run()}>
                    {busy && <Loader2 className="size-4 animate-spin" />}
                    Search
                </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
                {hits === null ? (
                    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                        {empty
                            ? "Type something, or pick who said it."
                            : "Press Search when the filters are right."}
                    </p>
                ) : hits.length === 0 ? (
                    <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                        Nothing matches that.
                    </p>
                ) : (
                    <ol className="flex flex-col">
                        {hits.map((hit) => (
                            <li key={hit.message.id}>
                                <button
                                    type="button"
                                    onClick={() => onOpen(hit)}
                                    className="flex w-full flex-col gap-0.5 border-b border-border px-3 py-2 text-left transition-colors hover:bg-card-hover"
                                >
                                    <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                                        {hit.inSpace ? (
                                            <Hash className="size-3 shrink-0" />
                                        ) : (
                                            <Users className="size-3 shrink-0" />
                                        )}
                                        <span className="min-w-0 truncate" title={hit.channelName}>
                                            {hit.channelName}
                                        </span>
                                        <RelativeTime iso={hit.message.createdAt} />
                                    </span>
                                    <span
                                        className={cn(
                                            "text-xs font-medium",
                                            hit.message.authorId === viewerId && "text-primary"
                                        )}
                                    >
                                        {hit.message.authorName ?? "Somebody who has left"}
                                    </span>
                                    {/* Clamped rather than truncated: a hit is
                                        usually a paragraph, and one line of it
                                        is rarely the line that matched. */}
                                    <span className="line-clamp-3 text-xs text-muted-foreground">
                                        <RichText
                                            value={hit.message.body}
                                            references={referenced(hit.message)}
                                        />
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ol>
                )}
            </div>
        </aside>
    );
}
