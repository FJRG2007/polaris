"use client";

/**
 * The list of conversations, and whatever is open beside it.
 *
 * Two things about it are worth knowing before changing it.
 *
 * **A row says which mailbox it came from.** In a merged view the colour down
 * the left of each row is the mailbox's own, the same one the rail draws beside
 * that mailbox. Without it a merged inbox is a list where nobody can tell work
 * from personal, which is the reason people keep separate tabs open instead.
 *
 * **Selection is the toolbar.** Nothing is done to a conversation by hovering
 * over it. Picking rows turns the header into what can be done to them, which is
 * one place to look rather than a row of icons that appear under the pointer and
 * cannot be reached from a keyboard.
 *
 * Actions are optimistic and roll back. Every one of them is a round trip to
 * somebody's mail server, which can be slow and can refuse, so the row moves at
 * once and comes back with a message if the server said no.
 */

import Link from "next/link";
import { leavesTheView, runBetween, MAIL_DRAG_TYPE } from "./mail-actions";
import { missingFolderRole, refusalOf } from "./refusal";
import { forwardSeed, replySeed } from "./answering";
import { useMailLayout } from "./use-mail-layout";
import { ThreadContextMenu } from "./thread-menu";
import { MAIL_SHORTCUTS, useMailKeys } from "./use-mail-keys";
import { useMail } from "./mail-shell";
import { ThreadView } from "./thread-view";
import { SenderFace } from "./sender-face";
import { MailSearch } from "./mail-search";
import * as core from "@polaris/core";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { DisplayFormat } from "@polaris/core";
import type { MailAction } from "@/lib/mailbox/messages";
import { RelativeTime } from "@/components/relative-time";
import { useDisplayFormat } from "@/components/display-format";
import {
    actOnAction,
    applyLabelAction,
    blockSenderAction,
    moreThreadsAction,
    openMessageAction,
    warmMessageAction,
    snoozeAction,
    syncAllAction
} from "./actions";
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    useTransition,
    type ComponentPropsWithRef
} from "react";
import {
    Button,
    Checkbox,
    cn,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    EmptyState,
    ScrollRow,
    useToast
} from "@polaris/ui";
import type { MailMessageView, MailThreadView } from "@/lib/mailbox/views";
import {
    Archive,
    BellOff,
    Bug,
    Check,
    Clock,
    Columns2,
    Inbox,
    ListFilter,
    Mail,
    MailOpen,
    Paperclip,
    RefreshCw,
    Rows3,
    Star,
    Trash2
} from "lucide-react";

/**
 * How long the pointer rests on a conversation before its body is fetched.
 *
 * Long enough that running down a list of fifty asks for nothing, short enough
 * that it is already on its way by the time somebody has decided to click. A
 * quarter of a second is roughly how long a person takes to stop moving.
 */
const WARM_AFTER_MS = 250;

/** What list this is, as the scroll asks the server for more of it. The shape
 *  the page schema validates on the way in. */
export interface MailPageNarrow {
    readonly accountId: string | null;
    readonly folderId: string | null;
    readonly role: string | null;
    readonly labelId: string | null;
    readonly unreadOnly: boolean;
    readonly readOnly: boolean;
    readonly starredOnly: boolean;
    readonly snoozedOnly: boolean;
    readonly withAttachments: boolean;
    readonly category: string;
    readonly sort: core.MailSort;
    readonly query: string;
}

/** What the list is showing, so the empty state and the toolbar can say the
 *  right thing: "no mail" in an inbox and "nothing in the trash" are different
 *  sentences and lead somewhere different. */
export interface MailViewContext {
    readonly title: string;
    readonly emptyTitle: string;
    readonly emptyBody: string;
    /** Whether Archive is offered. It is not, in the folder it archives into. */
    readonly canArchive: boolean;
    /** Whether Delete means "for ever" rather than "to the trash". */
    readonly permanentDelete: boolean;
}

export function MailView({
    threads: firstPage,
    context,
    openThread,
    openMessages,
    cursor: firstCursor,
    page,
    categorised,
    category,
    filter,
    sort,
    preferences,
    fixedFilter
}: {
    threads: MailThreadView[];
    context: MailViewContext;
    openThread: MailThreadView | null;
    openMessages: MailMessageView[];
    cursor: string;
    /** What this list is, so the scroll can ask for more of the same one. */
    page: MailPageNarrow;
    /** Whether this list is worth sorting into tabs. An inbox is; Sent is not,
     *  and neither is a search - a search is already a narrowing. */
    categorised: boolean;
    /** Which tab is showing, or "" for all of them. */
    category: string;
    /** Which of the list is showing, or "" for all of it. */
    filter: core.MailFilter | "";
    /** Which way round it is being read. */
    sort: core.MailSort;
    /** How this person reads mail - see `mail-prefs`. Two of the four are
     *  answered on this screen: when an opened message stops being unread, and
     *  where the reader is left after one is filed. */
    preferences: core.MailPreferences;
    /** The narrowing this screen IS, which the buttons then leave alone: the
     *  Starred list does not offer a Starred filter. */
    fixedFilter: core.MailFilter | "";
}) {
    const router = useRouter();
    const { accounts, accountColor, askFolderRole, composing, identities, openComposer, refresh } =
        useMail();
    const toast = useToast();
    const [selected, setSelected] = useState<string[]>([]);
    const [busy, startBusy] = useTransition();
    // Which row the keyboard is on. Separate from the selection on purpose: the
    // pointer and the keyboard are two ways of pointing at a row, and a keyboard
    // walk that ticked every checkbox on the way past would be unusable.
    const [onIndex, setOnIndex] = useState(0);
    /**
     * The last row picked on its own, which is where a run measured with Shift
     * starts from.
     *
     * Held as an id rather than an index because the list is redrawn from the
     * server between clicks - a sync lands, a message arrives - and an index
     * would then be pointing at a different conversation than the one somebody
     * clicked.
     */
    const [anchor, setAnchor] = useState("");
    const [helpOpen, setHelpOpen] = useState(false);
    const [blocking, setBlocking] = useState<{ accountId: string; address: string } | null>(null);
    const [layout, setLayout] = useMailLayout();

    /**
     * What the reader has just done, before the server has said so.
     *
     * Every action here is a round trip to somebody's mail server - a socket, a
     * command, a wait - and waiting for it before the row changes is what made
     * marking a message read feel broken. So the row moves now and the truth
     * arrives after: a refusal puts it back and says why, and a success is
     * simply the server agreeing with a screen that already showed it.
     *
     * Cleared whenever the server's own answer arrives, which is what
     * `threads` becoming a new array means. Keeping a patch past that would
     * mean the screen quietly disagreeing with the server for ever - except
     * for the one an action is still waiting on, which is held in `inFlight`
     * and laid back over the new list, because a list that arrived is not
     * necessarily the answer to what was asked.
     */
    /**
     * The pages fetched below the first one.
     *
     * The first page is the server's, and it is re-rendered whenever anything
     * changes - a sync, an action, a refresh. Everything under it was asked for
     * by scrolling, so it is thrown away the moment the first page is redrawn:
     * keeping it would mean a list whose top is current and whose bottom is a
     * snapshot of some earlier minute, with the same conversation in both.
     */
    const [older, setOlder] = useState<MailThreadView[]>([]);
    const [cursor, setCursor] = useState(firstCursor);
    const [loadingMore, setLoadingMore] = useState(false);
    useEffect(() => {
        setOlder([]);
        setCursor(firstCursor);
    }, [firstPage, firstCursor]);

    const threads = useMemo(() => [...firstPage, ...older], [firstPage, older]);

    const [patched, setPatched] = useState<Record<string, ThreadPatch>>({});
    /**
     * The overlay belonging to an action the mail server has not answered yet.
     *
     * Held apart from `patched` because a new `threads` is not always the
     * server's answer to what was just done. Filing the conversation that is
     * open closes the reading pane first, and closing it is a navigation: these
     * routes are dynamic, so the list comes back in a few tens of milliseconds
     * with the row still in it, seconds before the mail server has moved
     * anything. Clearing everything on that would put the row somebody just
     * archived back on screen until the action landed, which is the one moment
     * the overlay exists for.
     */
    const inFlight = useRef<Record<string, ThreadPatch>>({});
    /** Both together, always: an overlay that outlives the array under it has to
     *  be dropped from both or it comes back on the next list. */
    const clearPatches = useCallback(() => {
        inFlight.current = {};
        setPatched({});
    }, []);
    useEffect(() => {
        setPatched(inFlight.current);
    }, [threads]);

    /**
     * Ask for the next page.
     *
     * Guarded on its own flag rather than on a transition, because the observer
     * below fires again while the request is in the air - a list that is still
     * short after appending is a list whose bottom is still on screen - and
     * without the guard that is the same page asked for four times.
     */
    const loadMore = useCallback(() => {
        if (!cursor || loadingMore) return;
        setLoadingMore(true);
        void (async () => {
            try {
                const outcome = await moreThreadsAction({ ...page, cursor });
                if (refusalOf(outcome) || !("threads" in outcome)) return;
                // Anything already on screen is dropped rather than repeated: a
                // message arriving between two pages shifts everything down by
                // one, and the row on the seam would otherwise appear twice.
                setOlder((held) => {
                    const known = new Set([...firstPage, ...held].map((thread) => thread.id));
                    return [...held, ...outcome.threads.filter((thread) => !known.has(thread.id))];
                });
                setCursor(outcome.cursor);
            } finally {
                setLoadingMore(false);
            }
        })();
    }, [cursor, firstPage, loadingMore, page]);

    const patch = useCallback((ids: readonly string[], change: ThreadPatch) => {
        setPatched((held) => {
            const next = { ...held };
            for (const id of ids) next[id] = { ...next[id], ...change };
            return next;
        });
    }, []);

    /** The same, for a change the mail server has been asked for and has not
     *  answered yet, so it survives a list arriving in between - see
     *  `inFlight`. Only an action uses this: a read mark is the server catching
     *  up with a screen rather than something being waited on. */
    const patchUntilAnswered = useCallback(
        (ids: readonly string[], change: ThreadPatch) => {
            const held = { ...inFlight.current };
            for (const id of ids) held[id] = { ...held[id], ...change };
            inFlight.current = held;
            patch(ids, change);
        },
        [patch]
    );

    /** The row as the reader should see it: what the server sent, with anything
     *  they have just done laid over it. */
    const shown = useCallback(
        (thread: MailThreadView): MailThreadView => {
            const over = patched[thread.id];
            return over ? { ...thread, ...over } : thread;
        },
        [patched]
    );

    /**
     * Stop the address naming a conversation.
     *
     * Archiving, trashing or deleting drops the rows the reading pane was drawn
     * from - a move is re-fetched under the destination's own uids rather than
     * guessed at - so a moment after the action the pane is asking the server for
     * something that is not there. Left alone that took the whole screen away
     * rather than the one message; leaving it open would be a pane that says the
     * conversation is gone next to a list it is no longer in.
     *
     * `/mail/t/<id>` names the conversation in the path instead of the query and
     * has nothing to strip, so the way out of it is the list itself. Replaced
     * rather than pushed: a Back into a conversation that has been filed is a
     * step nobody wants offered.
     */
    const closeOpen = useCallback(() => {
        const url = new URL(window.location.href);
        url.searchParams.delete("open");
        const path = url.pathname.startsWith("/mail/t/") ? "/mail" : url.pathname;
        router.replace(`${path}${url.search}`, { scroll: false });
    }, [router]);

    /**
     * Go and get a conversation's body before anybody asks for it.
     *
     * Opening a message that has never been opened is a round trip to somebody
     * else's IMAP server, and that is the whole of why Polaris felt slower to
     * open mail than a webmail holding everything itself. It is also avoidable:
     * by the time somebody clicks a row they have been pointing at it for a
     * moment, and that moment is enough.
     *
     * Once per message and never again - the answer is kept on the row, so a
     * second ask would be a database read for nothing. Fired on a rest rather
     * than on every crossing, so running the pointer down a list of fifty does
     * not ask for fifty bodies.
     *
     * And one at a time. A body that is not held yet is a whole IMAP session -
     * connect, authenticate, fetch, log out - and nothing about a pointer moving
     * down a list bounds how many of those start at once: a rest every second on
     * cold mail opens one a second, each of which takes several, and the large
     * mail hosts answer a dozen simultaneous logins by locking the account out
     * of its own mailbox. So one runs, and what is waiting is a single slot
     * holding the latest - which is the only one worth having, because whatever
     * the pointer is on now is what is about to be opened.
     */
    const warmed = useRef(new Set<string>());
    const warming = useRef<ReturnType<typeof setTimeout> | null>(null);
    const wanted = useRef("");
    const fetching = useRef(false);
    const onScreen = useRef(true);
    const warmSoon = useCallback((messageId: string) => {
        wanted.current = messageId;
        if (fetching.current) return;
        fetching.current = true;
        void (async () => {
            try {
                while (onScreen.current && wanted.current) {
                    const next = wanted.current;
                    wanted.current = "";
                    if (warmed.current.has(next)) continue;
                    // Marked here rather than where it was asked for, so a row
                    // the pointer passed over and left behind is not remembered
                    // as fetched when it never was.
                    warmed.current.add(next);
                    await warmMessageAction(next).catch(() => undefined);
                }
            } finally {
                fetching.current = false;
            }
        })();
    }, []);
    const warm = useCallback(
        (messageId: string) => {
            if (!messageId || warmed.current.has(messageId)) return;
            if (warming.current) clearTimeout(warming.current);
            warming.current = setTimeout(() => {
                warming.current = null;
                warmSoon(messageId);
            }, WARM_AFTER_MS);
        },
        [warmSoon]
    );

    // Nothing outlives the screen: a timer that fires after this list is gone,
    // or a slot drained after it, asks for a body nobody is waiting for.
    useEffect(() => {
        // Set on the way in as well as cleared on the way out: development
        // mounts every screen twice, and a flag only ever cleared would leave
        // the second mount unable to fetch anything.
        onScreen.current = true;
        return () => {
            onScreen.current = false;
            wanted.current = "";
            if (warming.current) clearTimeout(warming.current);
        };
    }, []);

    /**
     * Put the conversation back on screen after the server refused to move it.
     *
     * The other half of leaving before the answer arrives. Replaced rather than
     * pushed, like the close it undoes: a Back that walks through a conversation
     * closing and reopening is a Back nobody meant.
     */
    const openAgain = useCallback(
        (threadId: string) => {
            const url = new URL(window.location.href);
            url.searchParams.set("open", threadId);
            router.replace(`${url.pathname}${url.search}`, { scroll: false });
        },
        [router]
    );

    /**
     * Open the conversation under the one that is leaving.
     *
     * What somebody clearing four hundred messages actually wants: going back to
     * the list to click the row beneath the one they just archived is the job
     * done twice. Off by default, because the safe answer to "the thing you were
     * reading is gone" is the list - see `MAIL_AFTER_FILING`.
     *
     * "Under" is under the conversation being READ, not under the first row the
     * action happened to name. Filing a scattered selection while the fifth of
     * them is open would otherwise land on the row after the first, which is
     * above where the reader was and on its way out of the view as well.
     *
     * The next one is read off the rows this screen is already showing, skipping
     * everything the same action took with it: archiving a selection of ten must
     * not open the second of the ten. Nothing left below is the end of the list,
     * and the end of the list is the list.
     */
    const openNext = useCallback(
        (leaving: readonly string[]) => {
            const rows = threads.map((thread) => thread.id);
            const from = openThread ? rows.indexOf(openThread.id) : -1;
            const next =
                from < 0 ? undefined : rows.slice(from + 1).find((id) => !leaving.includes(id));
            if (!next) {
                closeOpen();
                return;
            }
            openAgain(next);
        },
        [closeOpen, openAgain, openThread, threads]
    );

    /** The conversations an action was aimed at, from the messages it named. */
    const threadsOf = useCallback(
        (messageIds: readonly string[]) =>
            threads
                .filter((thread) => messageIds.includes(thread.leadMessageId))
                .map((thread) => thread.id),
        [threads]
    );

    // The lead message of each selected conversation. Every action here is
    // against messages rather than conversations, because a conversation lives
    // in two folders at once and archiving "the conversation" would be a promise
    // about mail this view is not showing.
    const selectedMessageIds = useMemo(
        () =>
            threads
                .filter((thread) => selected.includes(thread.id))
                .map((thread) => thread.leadMessageId)
                .filter(Boolean),
        [threads, selected]
    );

    const act = useCallback(
        (action: MailAction, messageIds: readonly string[], announce: string) => {
            if (messageIds.length === 0) return;
            const aimed = threadsOf(messageIds);
            const ahead = optimistically(action);
            // The row moves now. A mail server is slow enough that waiting for it
            // reads as the screen having ignored the click.
            if (ahead) patchUntilAnswered(aimed, ahead);
            // And the conversation being read closes now, for the same reason and
            // more so: the row it came from is already gone from the list behind
            // it, so waiting left somebody looking at a message that had been
            // filed, in a list that no longer had it, for as long as their mail
            // server took to answer.
            const leaving =
                leavesTheView(action) && openThread !== null && aimed.includes(openThread.id);
            const reopen = leaving ? openThread.id : "";
            if (leaving) {
                if (preferences.afterFiling === "next") openNext(aimed);
                else closeOpen();
            }

            startBusy(async () => {
                const outcome = await actOnAction({ messageIds: [...messageIds], action });
                // This mailbox has no folder for what was asked. Ask which one it
                // is and do the action again once it is settled, so the answer
                // costs one question rather than the action being lost.
                const missing = missingFolderRole(outcome);
                if (missing) {
                    clearPatches();
                    if (reopen) openAgain(reopen);
                    askFolderRole(missing, () => act(action, messageIds, announce));
                    return;
                }
                const said = refusalOf(outcome);
                if (said) {
                    // Put it back, both halves of it. A screen that kept showing
                    // the change after the server refused it would be lying about
                    // somebody's mail - and a reader taken out of a conversation
                    // that was never filed has to be put back in it.
                    clearPatches();
                    if (reopen) openAgain(reopen);
                    toast.show({ title: said });
                    return;
                }
                // Done. The overlay stops being something to carry across the
                // next list: what comes back now is the server agreeing with it,
                // and holding it past that is the screen disagreeing with the
                // mailbox for ever.
                inFlight.current = {};
                setSelected([]);
                toast.show({ title: announce });
                // Done from the list, but it may have been aimed at whatever is
                // open beside it - the conversation's own row, or the whole
                // selection with it in.
                //
                // One of the two, never both. Closing the pane is a navigation,
                // and these routes are dynamic, so arriving is already a fresh
                // read of the list; asking the router to refresh in the same
                // breath is a second fetch racing the first, and the one that
                // loses is the navigation - which left the address still naming a
                // conversation that had been deleted, and the next click on
                // another one apparently doing nothing at all.
                if (leaving) return;
                refresh();
            });
        },
        [
            askFolderRole,
            clearPatches,
            closeOpen,
            openAgain,
            openNext,
            openThread,
            patchUntilAnswered,
            preferences.afterFiling,
            refresh,
            threadsOf,
            toast
        ]
    );

    const snooze = useCallback(
        (messageIds: readonly string[], until: Date) => {
            startBusy(async () => {
                const outcome = await snoozeAction({ messageIds: [...messageIds], until });
                const said = refusalOf(outcome);
                if (said) {
                    toast.show({ title: said });
                    return;
                }
                setSelected([]);
                refresh();
            });
        },
        [refresh, toast]
    );

    const onRow = threads[Math.min(onIndex, threads.length - 1)] ?? null;

    // The keyboard's own pointer. Somebody arrowing down a list is deciding what
    // to open exactly as somebody hovering is, and the wait afterwards is the
    // same wait.
    useEffect(() => {
        if (onRow?.leadMessageId) warm(onRow.leadMessageId);
    }, [onRow?.leadMessageId, warm]);
    const rowMessageIds = onRow ? [onRow.leadMessageId].filter(Boolean) : [];

    /**
     * The list's keys stand down entirely while the composer is open.
     *
     * Guarding on "is something being typed into" is not enough: the composer is
     * a surface of its own, and a key pressed anywhere in it - a button, the
     * toolbar, the gap between fields - belongs to it. Enter reaching the list
     * from the recipient box opened whichever conversation the list's cursor
     * happened to be on, in the middle of somebody typing an address.
     */
    useMailKeys(
        composing
            ? {}
            : {
                  compose: () => openComposer({}),
                  next: () =>
                      setOnIndex((held) => Math.min(held + 1, Math.max(0, threads.length - 1))),
                  previous: () => setOnIndex((held) => Math.max(0, held - 1)),
                  open: () => {
                      if (onRow) router.push(`?open=${onRow.id}`, { scroll: false });
                  },
                  back: () => {
                      if (openThread) router.push(window.location.pathname, { scroll: false });
                  },
                  archive: () => {
                      if (context.canArchive) act("archive", rowMessageIds, "Archived.");
                  },
                  trash: () =>
                      act(
                          context.permanentDelete ? "delete" : "trash",
                          rowMessageIds,
                          context.permanentDelete ? "Deleted." : "Moved to the trash."
                      ),
                  junk: () => act("junk", rowMessageIds, "Moved to spam."),
                  star: () => {
                      if (!onRow) return;
                      act(
                          onRow.starred ? "unstar" : "star",
                          rowMessageIds,
                          onRow.starred ? "Unstarred." : "Starred."
                      );
                  },
                  markUnread: () => act("unread", rowMessageIds, "Marked as unread."),
                  search: () => {
                      const box = document.querySelector<HTMLInputElement>(SEARCH_BOX);
                      box?.focus();
                  },
                  refresh: () =>
                      startBusy(async () => {
                          await syncAllAction();
                          refresh();
                      }),
                  selectAll: () => {
                      setSelected(threads.map((thread) => thread.id));
                      setAnchor(threads[0]?.id ?? "");
                  },
                  // Answers whether it had anything to let go of, so Escape falls through
                  // to closing the conversation when nothing is picked.
                  clearSelection: () => {
                      if (selected.length === 0) return false;
                      setSelected([]);
                      setAnchor("");
                      return true;
                  }
              }
    );

    // `?` is bound here rather than in the hook: it is about this screen's own
    // help sheet, and a hook that owned it would have to know the sheet exists.
    useEffect(() => {
        function onKey(event: KeyboardEvent): void {
            if (event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey) return;
            const target = event.target;
            if (
                target instanceof HTMLElement &&
                (target.isContentEditable || EDITABLE.test(target.tagName))
            ) {
                return;
            }
            event.preventDefault();
            setHelpOpen((held) => !held);
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const label = useCallback(
        (labelId: string, messageIds: readonly string[]) => {
            startBusy(async () => {
                const outcome = await applyLabelAction({
                    labelId,
                    messageIds: [...messageIds],
                    applied: true
                });
                const said = refusalOf(outcome);
                if (said) {
                    toast.show({ title: said });
                    return;
                }
                refresh();
            });
        },
        [refresh, toast]
    );

    /**
     * Every address that is the reader's own.
     *
     * A conversation's participants include whoever it was addressed to, and in
     * an inbox that is always the person looking at it. Printing their own name
     * in the sender column of every row is a column of noise: no mail client
     * does it, because the one thing a reader already knows about their inbox is
     * that it is theirs. The mailboxes and every address they may send as, so an
     * alias is recognised as them too.
     */
    const mine = useMemo(() => {
        const held = new Set<string>();
        for (const account of accounts) {
            held.add(account.address.trim().toLowerCase());
            for (const identity of identities[account.id] ?? []) {
                held.add(identity.address.trim().toLowerCase());
            }
        }
        return held;
    }, [accounts, identities]);

    /**
     * Pick a row the way every list of anything is picked.
     *
     * A plain click on the box adds or removes the one row. Shift takes the run
     * between the last one picked on its own and this one, which is the whole
     * reason anybody selects with a keyboard hand on the shift key: fifty
     * newsletters in one gesture rather than fifty clicks. The run is added to
     * what is already picked rather than replacing it, so two runs can be
     * gathered - and it is added rather than toggled, or dragging back over a
     * run would unpick what was just picked.
     */
    const pick = useCallback(
        (threadId: string, wanted: boolean, run: boolean) => {
            if (!run || !anchor) {
                setAnchor(threadId);
                setSelected((held) =>
                    wanted
                        ? [...new Set([...held, threadId])]
                        : held.filter((id) => id !== threadId)
                );
                return;
            }
            const between = runBetween(
                threads.map((thread) => thread.id),
                anchor,
                threadId
            );
            setSelected((held) => [...new Set([...held, ...between])]);
        },
        [anchor, threads]
    );

    /**
     * Reply, reply to everybody, or forward - from the list, without opening the
     * conversation first.
     *
     * The body is fetched before the composer opens rather than after, because a
     * reply whose quote arrives a second later is one somebody has already
     * started typing above the wrong place. The plain text, never the HTML:
     * quoting markup into a reply is how a thread turns into nested tables.
     */
    const answer = useCallback(
        (kind: "reply" | "reply-all" | "forward", messageId: string) => {
            if (!messageId) return;
            startBusy(async () => {
                const outcome = await openMessageAction(messageId);
                const said = refusalOf(outcome);
                if (said) {
                    toast.show({ title: said });
                    return;
                }
                const envelope = "envelope" in outcome ? outcome.envelope : null;
                const readable = "readable" in outcome ? outcome.readable : null;
                if (!envelope) return;
                const quoted = readable?.text ?? "";
                openComposer(
                    kind === "forward"
                        ? forwardSeed(envelope, quoted)
                        : replySeed(
                              envelope,
                              accounts.map((account) => account.address),
                              kind === "reply-all",
                              quoted
                          )
                );
            });
        },
        [accounts, openComposer, toast]
    );

    /**
     * Refuse a sender.
     *
     * Confirmed first, because it is the one action here that acts on every
     * message somebody will ever get from an address rather than on the one in
     * front of them - and because what it does is throw mail away.
     */
    const block = useCallback((accountId: string, address: string) => {
        if (!address) return;
        setBlocking({ accountId, address });
    }, []);

    /**
     * What a drag is carrying.
     *
     * Whatever is selected when the drag starts, or the one row under the
     * pointer when nothing is. That is what every file manager does and what
     * anybody dragging a row expects: dragging one of five picked rows moves the
     * five, and dragging an unpicked row moves that one and leaves the selection
     * alone.
     */
    const dragging = useCallback(
        (thread: MailThreadView): string[] => {
            if (selected.includes(thread.id) && selectedMessageIds.length > 0)
                return selectedMessageIds;
            return [thread.leadMessageId].filter(Boolean);
        },
        [selected, selectedMessageIds]
    );

    const allPicked = threads.length > 0 && selected.length === threads.length;

    return (
        <div className="flex h-full min-h-0">
            <section
                className={cn(
                    // `min-h-0` is what keeps the two panes scrolling apart.
                    // A flex item's floor is its content, so without it the
                    // `overflow-y-auto` inside never gets shorter than the list
                    // and the scroll escapes to whatever contains both - which
                    // is one scrollbar moving the message and the list together.
                    "flex min-h-0 min-w-0 flex-col",
                    // Two shapes, and which one is a decision its reader makes.
                    //
                    // `split` keeps a narrow list beside the conversation, which
                    // is what somebody triaging a hundred messages wants. `full`
                    // gives the list the whole width and hands the whole width to
                    // the message once one is open, which is what somebody who
                    // reads one message at a time wants. Neither is right for
                    // both, which is why this is not a constant.
                    //
                    // In `split` the list is the same width the whole time. It
                    // used to take the screen until something was opened and then
                    // snap to a fifth of it, so choosing the reading pane meant
                    // watching the list jump every time you came back to an empty
                    // one - a column that changes width is a column nobody can
                    // learn to read. Narrow only where there is room for the pane
                    // beside it; a phone gets the list and then the message.
                    layout === "split"
                        ? openThread
                            ? "hidden w-80 shrink-0 border-r border-border lg:flex"
                            : "flex flex-1 lg:w-80 lg:flex-none lg:shrink-0 lg:border-r lg:border-border"
                        : openThread
                          ? "hidden"
                          : "flex flex-1"
                )}
                aria-label={context.title}
            >
                <header className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2">
                    <div className="flex items-center gap-2">
                        <Checkbox
                            checked={allPicked}
                            aria-label={
                                allPicked ? "Clear the selection" : "Select everything shown"
                            }
                            onChange={(event) =>
                                setSelected(
                                    event.target.checked ? threads.map((thread) => thread.id) : []
                                )
                            }
                        />
                        {selected.length === 0 ? (
                            <>
                                <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-tight">
                                    {context.title}
                                </h1>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={
                                        layout === "split"
                                            ? "Show one message at a time"
                                            : "Show the list beside the message"
                                    }
                                    title={
                                        layout === "split"
                                            ? "Show one message at a time"
                                            : "Show the list beside the message"
                                    }
                                    onClick={() => setLayout(layout === "split" ? "full" : "split")}
                                >
                                    {layout === "split" ? (
                                        <Rows3 className="size-4 shrink-0" aria-hidden />
                                    ) : (
                                        <Columns2 className="size-4 shrink-0" aria-hidden />
                                    )}
                                </Button>
                                <ListFilters filter={filter} sort={sort} fixed={fixedFilter} />
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Check for new mail"
                                    title="Check for new mail"
                                    disabled={busy || accounts.length === 0}
                                    onClick={() =>
                                        startBusy(async () => {
                                            await syncAllAction();
                                            refresh();
                                        })
                                    }
                                >
                                    <RefreshCw
                                        className={cn("size-4 shrink-0", busy && "animate-spin")}
                                        aria-hidden
                                    />
                                </Button>
                            </>
                        ) : (
                            <div className="flex min-w-0 flex-1 items-center gap-1">
                                <span className="mr-1 shrink-0 text-[12px] text-muted-foreground tabular-nums">
                                    {selected.length} picked
                                </span>
                                {context.canArchive ? (
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label="Archive"
                                        title="Archive"
                                        disabled={busy}
                                        onClick={() =>
                                            act("archive", selectedMessageIds, "Archived.")
                                        }
                                    >
                                        <Archive className="size-4 shrink-0" aria-hidden />
                                    </Button>
                                ) : null}
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Mark as read"
                                    title="Mark as read"
                                    disabled={busy}
                                    onClick={() =>
                                        act("read", selectedMessageIds, "Marked as read.")
                                    }
                                >
                                    <MailOpen className="size-4 shrink-0" aria-hidden />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Mark as unread"
                                    title="Mark as unread"
                                    disabled={busy}
                                    onClick={() =>
                                        act("unread", selectedMessageIds, "Marked as unread.")
                                    }
                                >
                                    <Mail className="size-4 shrink-0" aria-hidden />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Snooze until tomorrow morning"
                                    title="Snooze until tomorrow morning"
                                    disabled={busy}
                                    onClick={() => snooze(selectedMessageIds, tomorrowMorning())}
                                >
                                    <Clock className="size-4 shrink-0" aria-hidden />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Report as spam"
                                    title="Report as spam"
                                    disabled={busy}
                                    onClick={() =>
                                        act("junk", selectedMessageIds, "Moved to spam.")
                                    }
                                >
                                    <Bug className="size-4 shrink-0" aria-hidden />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={
                                        context.permanentDelete
                                            ? "Delete for ever"
                                            : "Move to trash"
                                    }
                                    title={
                                        context.permanentDelete
                                            ? "Delete for ever"
                                            : "Move to trash"
                                    }
                                    disabled={busy}
                                    onClick={() =>
                                        act(
                                            context.permanentDelete ? "delete" : "trash",
                                            selectedMessageIds,
                                            context.permanentDelete
                                                ? "Deleted."
                                                : "Moved to the trash."
                                        )
                                    }
                                >
                                    <Trash2 className="size-4 shrink-0" aria-hidden />
                                </Button>
                            </div>
                        )}
                    </div>
                    <MailSearch />
                    {categorised ? <CategoryTabs current={category} /> : null}
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto">
                    {threads.every((thread) => patched[thread.id]?.gone) ? (
                        <div className="p-6">
                            <EmptyState
                                icon={<Inbox className="size-5 shrink-0" aria-hidden />}
                                title={context.emptyTitle}
                                description={context.emptyBody}
                            />
                        </div>
                    ) : (
                        <ul>
                            {threads
                                .filter((thread) => !patched[thread.id]?.gone)
                                .map((thread) => (
                                    <ThreadContextMenu
                                        key={thread.id}
                                        thread={shown(thread)}
                                        canArchive={context.canArchive}
                                        permanentDelete={context.permanentDelete}
                                        onAct={act}
                                        onSnooze={snooze}
                                        onLabel={label}
                                        onAnswer={answer}
                                        onBlock={block}
                                    >
                                        <ThreadRow
                                            thread={shown(thread)}
                                            onCursor={onRow?.id === thread.id}
                                            onPeek={() => warm(thread.leadMessageId)}
                                            open={openThread?.id === thread.id}
                                            picked={selected.includes(thread.id)}
                                            color={accountColor(thread.accountId)}
                                            showColor={accounts.length > 1}
                                            wide={layout === "full" && !openThread}
                                            mine={mine}
                                            sort={sort}
                                            onPick={(next, run) => pick(thread.id, next, run)}
                                            dragging={() => dragging(thread)}
                                            canArchive={context.canArchive}
                                            permanentDelete={context.permanentDelete}
                                            onAct={(action, announce) =>
                                                act(action, [thread.leadMessageId], announce)
                                            }
                                            onSnooze={() =>
                                                snooze([thread.leadMessageId], tomorrowMorning())
                                            }
                                            onStar={() =>
                                                act(
                                                    shown(thread).starred ? "unstar" : "star",
                                                    [thread.leadMessageId],
                                                    shown(thread).starred
                                                        ? "Unstarred."
                                                        : "Starred."
                                                )
                                            }
                                        />
                                    </ThreadContextMenu>
                                ))}
                        </ul>
                    )}

                    {cursor ? <MoreRows onReach={loadMore} busy={loadingMore} /> : null}
                </div>
            </section>

            {helpOpen ? <ShortcutSheet onClose={() => setHelpOpen(false)} /> : null}

            {blocking ? (
                <ConfirmDeleteDialog
                    open
                    name={blocking.address}
                    kind="sender"
                    // A plain confirmation rather than typing the address out:
                    // it is one sender of many and it can be undone from the
                    // Blocked screen in one press.
                    requireTyping={false}
                    title={`Block ${blocking.address}?`}
                    question={`Send everything from ${blocking.address} to the trash?`}
                    description="What they have already sent goes to the trash too. Mail cannot be refused before it arrives - only your provider can do that - so it will still reach your mailbox; you simply will not see it."
                    confirmLabel="Block"
                    pending={busy}
                    onOpenChange={(next) => (next ? undefined : setBlocking(null))}
                    onConfirm={() =>
                        startBusy(async () => {
                            const outcome = await blockSenderAction(blocking.accountId, {
                                address: blocking.address,
                                as: "trash"
                            });
                            setBlocking(null);
                            const said = refusalOf(outcome);
                            if (said) {
                                toast.show({ title: said });
                                return;
                            }
                            toast.show({ title: `${blocking.address} is blocked.` });
                            refresh();
                        })
                    }
                />
            ) : null}

            <section
                className={cn(
                    // Same reason as the list beside it: this pane owns its own
                    // scrollbar, and it only can while its own height is bounded.
                    "min-h-0 min-w-0 flex-1",
                    openThread ? "flex" : layout === "split" ? "hidden lg:flex" : "hidden"
                )}
                aria-label="Conversation"
            >
                {openThread ? (
                    <ThreadView
                        thread={shown(openThread)}
                        messages={openMessages}
                        context={context}
                        // Opening a message marks it read on the server, which
                        // takes a round trip. The row stops being bold now.
                        onRead={() => patch([openThread.id], { unreadCount: 0 })}
                        // Filed or thrown away from its own header. Same reason
                        // as above, from the other side of the screen.
                        markRead={preferences.markRead}
                        onGone={
                            preferences.afterFiling === "next"
                                ? () => openNext([openThread.id])
                                : closeOpen
                        }
                        onStayed={() => openAgain(openThread.id)}
                        // Reading one message at a time needs a way back, because
                        // the list it came from is not on screen.
                        onBack={
                            layout === "full"
                                ? () => router.push(window.location.pathname, { scroll: false })
                                : undefined
                        }
                    />
                ) : (
                    <div className="flex flex-1 items-center justify-center p-8">
                        <p className="text-[13px] text-foreground-subtle">
                            Pick a conversation to read it.
                        </p>
                    </div>
                )}
            </section>
        </div>
    );
}

/**
 * The bottom of the list, which asks for more of it when it comes into view.
 *
 * Watched rather than clicked: a mail list is scrolled, and a button at the
 * bottom of one is a thing somebody has to notice and aim at every fifty rows.
 * The margin is what makes it feel like there is no bottom at all - the next
 * page is asked for while the last one is still a screen away, so it has
 * usually arrived by the time anybody reaches it.
 */
function MoreRows({ onReach, busy }: { onReach: () => void; busy: boolean }) {
    const mark = useRef<HTMLDivElement | null>(null);
    // Held in a ref so the observer is not torn down and rebuilt every time the
    // list grows, which is every time it fires.
    const reach = useRef(onReach);
    reach.current = onReach;

    useEffect(() => {
        const node = mark.current;
        if (!node) return;
        const watcher = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) reach.current();
            },
            { rootMargin: "600px" }
        );
        watcher.observe(node);
        return () => watcher.disconnect();
    }, []);

    return (
        <div ref={mark} className="p-3">
            {/* Shaped like the rows it is about to become, so the list does not
                jump when they land. */}
            <div className="space-y-2" aria-hidden={!busy}>
                <div className="h-3 w-1/3 animate-pulse rounded bg-card" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-card" />
            </div>
            <span className="sr-only" role="status">
                {busy ? "Loading older conversations" : ""}
            </span>
        </div>
    );
}

/**
 * The tabs above the inbox.
 *
 * Not filing: a message stays in exactly the folder it was in, with the same
 * flags, and every one of them is still in the list with no tab chosen. This is
 * a way of looking at the same inbox, which is why it lives in the address as a
 * parameter rather than anywhere that would outlive the visit.
 *
 * The one Polaris has that others do not is the codes: they are the most
 * time-sensitive mail anybody gets and the least worth keeping, and gathering
 * them is what makes it possible to offer to clear them up.
 */
/**
 * The two questions above the list that are not a search: which of it, and in
 * what order.
 *
 * They live in the address rather than in state, exactly as the tabs and the
 * search do, so a list narrowed to what is unread is a page somebody can go
 * back to, bookmark, and open beside the one they came from. It also means the
 * server builds the query - "unread" is a column with an index on it, answered
 * over the whole folder, and not the search window read and matched.
 *
 * Unread gets a button of its own beside the menu because it is not one filter
 * of four: it is the one somebody presses twenty times a day, and burying it a
 * click deeper than the other nineteen things in this header would be a strange
 * thing to have decided.
 *
 * A screen that already IS one of these - Starred - does not offer it again, and
 * never offers its opposite: a Read button on the Unread list is a switch whose
 * only effect is an empty page.
 */
function ListFilters({
    filter,
    sort,
    fixed
}: {
    filter: core.MailFilter | "";
    sort: core.MailSort;
    fixed: core.MailFilter | "";
}) {
    const router = useRouter();
    const search = useSearchParams();
    const pathname = usePathname();

    function go(change: { filter?: core.MailFilter | ""; sort?: core.MailSort }): void {
        const url = new URLSearchParams(search.toString());
        if (change.filter !== undefined) {
            if (change.filter) url.set("filter", change.filter);
            else url.delete("filter");
        }
        if (change.sort !== undefined) {
            if (change.sort !== core.DEFAULT_MAIL_SORT) url.set("sort", change.sort);
            else url.delete("sort");
        }
        // A different list: the cursor and whatever was open beside it belong to
        // the one being left.
        url.delete("before");
        url.delete("open");
        const query = url.toString();
        router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }

    /** Whether an option would fight the narrowing the screen already is. Only
     *  the same question asked twice conflicts: read and unread are one switch,
     *  and starred on the Starred list is a tick that cannot be untucked. */
    function settled(option: core.MailFilter): boolean {
        if (!fixed) return false;
        if (option === fixed) return true;
        return (
            (fixed === "unread" && option === "read") || (fixed === "read" && option === "unread")
        );
    }

    const offered = core.MAIL_FILTERS.filter((option) => !settled(option));
    const narrowed = core.mailListIsNarrowed(filter, sort);

    return (
        <>
            {settled("unread") ? null : (
                <Button
                    variant="ghost"
                    size="icon"
                    aria-pressed={filter === "unread"}
                    aria-label={
                        filter === "unread" ? "Show everything" : "Show only what is unread"
                    }
                    title={filter === "unread" ? "Show everything" : "Show only what is unread"}
                    className={cn(filter === "unread" && "bg-muted text-foreground")}
                    onClick={() => go({ filter: filter === "unread" ? "" : "unread" })}
                >
                    <Mail className="size-4 shrink-0" aria-hidden />
                </Button>
            )}
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Filter and sort"
                        title="Filter and sort"
                        className={cn(narrowed && "text-primary")}
                    >
                        <ListFilter className="size-4 shrink-0" aria-hidden />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                    {offered.length > 0 ? (
                        <>
                            <DropdownMenuLabel>Show</DropdownMenuLabel>
                            <Choice
                                label="Everything"
                                chosen={!filter}
                                onChoose={() => go({ filter: "" })}
                            />
                            {offered.map((option) => (
                                <Choice
                                    key={option}
                                    label={core.MAIL_FILTER_LABELS[option]}
                                    chosen={filter === option}
                                    onChoose={() => go({ filter: option })}
                                />
                            ))}
                            <DropdownMenuSeparator />
                        </>
                    ) : null}
                    <DropdownMenuLabel>Order</DropdownMenuLabel>
                    {core.MAIL_SORTS.map((option) => (
                        <Choice
                            key={option}
                            label={core.MAIL_SORT_LABELS[option]}
                            chosen={sort === option}
                            onChoose={() => go({ sort: option })}
                        />
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
        </>
    );
}

/** One option in that menu. A tick rather than a radio, because the menu closes
 *  on the choice and what it is showing is where the ticks are. */
function Choice({
    label,
    chosen,
    onChoose
}: {
    label: string;
    chosen: boolean;
    onChoose: () => void;
}) {
    return (
        <DropdownMenuItem onSelect={onChoose}>
            <Check
                className={cn("size-3.5 shrink-0", chosen ? "opacity-100" : "opacity-0")}
                aria-hidden
            />
            {label}
        </DropdownMenuItem>
    );
}

function CategoryTabs({ current }: { current: string }) {
    const router = useRouter();
    const search = useSearchParams();
    const pathname = usePathname();

    function go(next: string): void {
        const url = new URLSearchParams(search.toString());
        if (next) url.set("tab", next);
        else url.delete("tab");
        // A different tab is a different list: the cursor and whatever was open
        // belong to the one being left.
        url.delete("before");
        url.delete("open");
        const query = url.toString();
        router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }

    return (
        <ScrollRow
            className="-mb-2 flex items-center gap-1"
            role="tablist"
            aria-label="Sort the inbox"
        >
            <TabButton label="All" active={!current} onClick={() => go("")} />
            {core.MAIL_CATEGORIES.map((one) => (
                <TabButton
                    key={one}
                    label={core.MAIL_CATEGORY_LABELS[one]}
                    title={core.MAIL_CATEGORY_NOTES[one]}
                    active={current === one}
                    onClick={() => go(one)}
                />
            ))}
        </ScrollRow>
    );
}

function TabButton({
    label,
    title,
    active,
    onClick
}: {
    label: string;
    title?: string;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            role="tab"
            aria-selected={active}
            title={title}
            className={cn(
                "shrink-0 border-b-2 px-2 pb-1.5 pt-0.5 text-[12px]",
                active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
            )}
            onClick={onClick}
        >
            {label}
        </button>
    );
}

/** How `/` finds the search box, and which elements own a key press rather than
 *  the screen. Named because two places read each. */
const SEARCH_BOX = 'input[aria-label="Search mail"]';
const EDITABLE = /^(?:INPUT|TEXTAREA|SELECT)$/;

/** What the keys do. Reached with `?`, and from nowhere else - it is a reminder
 *  for people who already use them, not a feature anybody has to find. */
function ShortcutSheet({ onClose }: { onClose: () => void }) {
    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Keyboard</DialogTitle>
                </DialogHeader>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                    {MAIL_SHORTCUTS.map((entry) => (
                        <div key={entry.keys} className="contents">
                            <dt className="font-mono text-[12px] text-foreground">{entry.keys}</dt>
                            <dd className="text-muted-foreground">{entry.what}</dd>
                        </div>
                    ))}
                </dl>
                <p className="mt-2 text-[12px] text-foreground-subtle">
                    Every one of these has a button on screen as well.
                </p>
            </DialogContent>
        </Dialog>
    );
}

/** What an action changes about a row before the server has confirmed it. Only
 *  the two things a list actually draws differently. */
interface ThreadPatch {
    unreadCount?: number;
    starred?: boolean;
    /** Taken out of this list. Drawn as gone at once and put back if the server
     *  refuses, rather than left sitting there while a mail server is asked. */
    gone?: boolean;
}

/**
 * How a row should look the instant an action is asked for.
 *
 * Every action, including the ones that take the conversation out of the list.
 * That was held back at first on the grounds that a row vanishing and
 * reappearing after a refusal is worse than the wait - but the wait is a round
 * trip to somebody's mail server, and pressing Archive and watching the row sit
 * there reads as the button not having worked. A refusal is rare, it says why,
 * and the row comes back.
 */
function optimistically(action: MailAction): ThreadPatch | null {
    switch (action) {
        case "read":
            return { unreadCount: 0 };
        case "unread":
            return { unreadCount: 1 };
        case "star":
            return { starred: true };
        case "unstar":
            return { starred: false };
        default:
            return leavesTheView(action) ? { gone: true } : null;
    }
}

/** Eight tomorrow morning, in the reader's own clock. The one snooze everybody
 *  reaches for; the rest are on the conversation's own menu. */
function tomorrowMorning(): Date {
    const when = new Date();
    when.setDate(when.getDate() + 1);
    when.setHours(8, 0, 0, 0);
    return when;
}

/**
 * One row.
 *
 * It takes and passes on whatever else it is handed, and that is not tidiness:
 * the right-click menu wraps this in a Radix trigger with `asChild`, which works
 * by cloning the child and handing it the handler and the ref that make the menu
 * open. A component that declares its props and drops the rest swallows both
 * silently - no error, no warning, and a right-click on a conversation that does
 * nothing at all. That is what it did.
 */
function ThreadRow({
    thread,
    onCursor,
    onPeek,
    open,
    picked,
    color,
    showColor,
    wide,
    mine,
    onPick,
    dragging,
    canArchive,
    permanentDelete,
    sort,
    onAct,
    onSnooze,
    onStar,
    ...rest
}: ComponentPropsWithRef<"li"> & {
    thread: MailThreadView;
    /** Whether the keyboard is on this row. Drawn as an edge rather than a fill,
     *  so it stays legible over the fill an open or picked row already has. */
    onCursor: boolean;
    /** Somebody is looking at this row. Fetching its body now is what makes
     *  opening it feel instant - see `WARM_AFTER_MS`. */
    onPeek: () => void;
    open: boolean;
    picked: boolean;
    color: string;
    showColor: boolean;
    /** Whether the list has the whole width. Then a row is one line - sender,
     *  subject, snippet, date - the way a full-width list is read; narrow, it
     *  stacks, because three columns in twenty rems is unreadable. */
    wide: boolean;
    /** Every address belonging to the reader, so their own name is kept out of
     *  the column that says who a conversation is with. */
    mine: ReadonlySet<string>;
    /** `run` is Shift being held: take everything between the last row picked
     *  on its own and this one. */
    onPick: (next: boolean, run: boolean) => void;
    /** What a drag from this row is carrying, asked as it starts. */
    dragging: () => readonly string[];
    canArchive: boolean;
    permanentDelete: boolean;
    /** Which way the list is ordered, which decides what the corner of the row
     *  says. */
    sort: core.MailSort;
    onAct: (action: MailAction, announce: string) => void;
    onSnooze: () => void;
    onStar: () => void;
}) {
    const unread = thread.unreadCount > 0;
    /** Whether this list is being read by size rather than by date - see
     *  `Stamp`, which is what the row shows for it. */
    const bySize = sort === "largest" || sort === "smallest";
    return (
        <li
            {...rest}
            // A pointer resting here, or focus landing on it, is enough to go
            // and fetch what is in it - so opening it is a screen drawing rather
            // than a wait on somebody else's mail server.
            //
            // Both call on through: this row is a context-menu trigger and it is
            // handed handlers by it, so replacing one rather than adding to it
            // would cost the right-click menu to save a fetch.
            onPointerEnter={(event) => {
                rest.onPointerEnter?.(event);
                onPeek();
            }}
            onFocus={(event) => {
                rest.onFocus?.(event);
                onPeek();
            }}
            // Dragged onto a folder in the rail to file it there. The payload is
            // ids and nothing else: what is dropped is looked up and authorized
            // on the server, so a drag cannot become a way of naming somebody
            // else's mail.
            draggable
            onDragStart={(event) => {
                const carried = dragging();
                if (carried.length === 0) {
                    event.preventDefault();
                    return;
                }
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(MAIL_DRAG_TYPE, carried.join(","));
                // Firefox refuses a drag with no plain payload at all.
                event.dataTransfer.setData("text/plain", "");
            }}
            className={cn(
                "group relative border-b border-border/60",
                // Unread is a lift off the page as well as bolder text. Weight
                // alone is what a list of forty read messages and three unread
                // ones looked like: three rows in a slightly darker grey,
                // which is not something anybody scans for. A tone difference
                // is - it is what every mail client people already use does,
                // and on the light theme it is exactly Protonmail's: the page
                // is grey and an unread row is white.
                //
                // A tier rather than a wash of its own, and `card` rather than
                // `surface`: on the dark theme surface is two per cent off the
                // page, which measures as a lift and reads as nothing. Card is
                // the first tone anybody actually sees there, and on the light
                // theme both are the same white.
                unread && !open && !picked && "bg-card hover:bg-card-hover",
                // The one being read, and the ones ticked, take the accent
                // instead of a tone. They have to outrank unread and they
                // cannot do it by being another shade of the same grey - on the
                // light theme every tier above the page is white, so a selected
                // row and an unread row were the same colour the moment unread
                // had one. Accent for "this one", tone for "not read yet"; the
                // rail already spends its colour the same way.
                open || picked ? "bg-primary/10" : !unread && "hover:bg-card/60",
                onCursor && "ring-1 ring-inset ring-border-strong",
                rest.className
            )}
        >
            {showColor ? (
                <span
                    className="absolute inset-y-0 left-0 w-0.5"
                    style={{ backgroundColor: color }}
                    aria-hidden
                />
            ) : null}
            <div className="flex items-start gap-2 py-2 pl-3 pr-2">
                {/* Who it is from, before the name is read. Drawn from the
                    first person who is not the reader, which in an inbox is the
                    sender and in Sent is who it went to. */}
                <SenderFace
                    className="mt-0.5"
                    name={faceOf(thread, mine).name}
                    address={faceOf(thread, mine).address}
                />
                <Checkbox
                    className="mt-0.5"
                    checked={picked}
                    aria-label={`Select the conversation ${thread.subject || "with no subject"}`}
                    // Read off the click rather than off a key handler: the
                    // browser tells us which modifiers were down when the box
                    // was ticked, and tracking that ourselves would be wrong
                    // every time somebody alt-tabbed away holding shift.
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) =>
                        onPick(
                            event.target.checked,
                            (event.nativeEvent as MouseEvent).shiftKey === true
                        )
                    }
                />
                <button
                    type="button"
                    className="mt-0.5 shrink-0 text-foreground-subtle hover:text-foreground"
                    aria-label={thread.starred ? "Unstar" : "Star"}
                    title={thread.starred ? "Unstar" : "Star"}
                    onClick={onStar}
                >
                    <Star
                        className={cn(
                            "size-4 shrink-0",
                            thread.starred && "fill-current text-warning"
                        )}
                        aria-hidden
                    />
                </button>
                <Link
                    href={`?open=${thread.id}`}
                    scroll={false}
                    className={cn("min-w-0 flex-1", wide && "flex items-baseline gap-3")}
                    aria-current={open ? "true" : undefined}
                >
                    <div className={cn("flex items-baseline gap-2", wide && "w-56 shrink-0")}>
                        <span
                            // Same reason, same row: three names in a group
                            // conversation are cut after the first, and which
                            // three it is decides whether this is the thread
                            // somebody meant.
                            title={people(thread, mine)}
                            className={cn(
                                "min-w-0 flex-1 truncate text-[13px]",
                                unread ? "font-semibold text-foreground" : "text-muted-foreground"
                            )}
                        >
                            {people(thread, mine)}
                        </span>
                        {thread.messageCount > 1 ? (
                            <span className="shrink-0 text-[11px] tabular-nums text-foreground-subtle">
                                {thread.messageCount}
                            </span>
                        ) : null}
                        {wide ? null : <Stamp thread={thread} bySize={bySize} />}
                    </div>
                    <div className={cn("min-w-0", wide && "flex flex-1 items-baseline gap-2")}>
                        <p
                            // The whole of it, for a row that is showing half.
                            // A subject is the one thing in a row somebody is
                            // actually deciding on, and in a narrow list it is
                            // the thing most likely to be cut - "Re: your invoice
                            // for Aug..." is not an answer to whether this is the
                            // message they are looking for. Every other mail
                            // client answers it by hovering; this is that.
                            title={thread.subject || "(no subject)"}
                            className={cn(
                                "truncate text-[13px]",
                                wide && "shrink-0 max-w-[50%]",
                                unread ? "font-medium text-foreground" : "text-muted-foreground"
                            )}
                        >
                            {thread.subject || "(no subject)"}
                        </p>
                        <div className="flex min-w-0 flex-1 items-center gap-1.5">
                            <p
                                title={thread.snippet}
                                className="min-w-0 flex-1 truncate text-[12px] text-foreground-subtle"
                            >
                                {thread.snippet}
                            </p>
                        </div>
                    </div>
                    {wide ? <Stamp thread={thread} bySize={bySize} /> : null}
                    {thread.labels.length > 0 && !wide ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                            {thread.labels.map((label) => (
                                <span
                                    key={label.id}
                                    className="rounded px-1 text-[10px] font-medium"
                                    style={{
                                        backgroundColor: `${label.color}22`,
                                        color: label.color
                                    }}
                                >
                                    {label.name}
                                </span>
                            ))}
                        </div>
                    ) : null}
                </Link>
                {/* What somebody triaging a list reaches for, on the row rather
                    than after selecting it. Shown on hover and on keyboard
                    focus, never on a touch screen where there is no hover and
                    the menu is a long press away - `hidden sm:flex`.

                    They sit ON TOP of the row rather than in its flow, so a row
                    does not change width when the pointer crosses it, which is
                    a list that shivers as you read down it. */}
                <div className="pointer-events-none absolute inset-y-0 right-0 hidden items-center pr-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 sm:flex">
                    <div className="pointer-events-auto flex items-center gap-0.5 rounded-md border border-border bg-surface px-0.5 py-0.5 shadow-sm">
                        {thread.unsubscribe ? (
                            <RowAction
                                icon={BellOff}
                                label={`Stop these emails from ${people(thread, mine)}`}
                                href={thread.unsubscribe}
                            />
                        ) : null}
                        {canArchive ? (
                            <RowAction
                                icon={Archive}
                                label="Archive"
                                onClick={() => onAct("archive", "Archived.")}
                            />
                        ) : null}
                        <RowAction
                            icon={unread ? MailOpen : Mail}
                            label={unread ? "Mark as read" : "Mark as unread"}
                            onClick={() =>
                                onAct(
                                    unread ? "read" : "unread",
                                    unread ? "Marked as read." : "Marked as unread."
                                )
                            }
                        />
                        <RowAction
                            icon={Clock}
                            label="Snooze until tomorrow morning"
                            onClick={onSnooze}
                        />
                        <RowAction
                            icon={Trash2}
                            danger
                            label={permanentDelete ? "Delete for ever" : "Move to trash"}
                            onClick={() =>
                                onAct(
                                    permanentDelete ? "delete" : "trash",
                                    permanentDelete ? "Deleted." : "Moved to the trash."
                                )
                            }
                        />
                    </div>
                </div>
            </div>
        </li>
    );
}

/**
 * One of the buttons that appear on a row under the pointer.
 *
 * A link when it goes somewhere and a button when it does something, rather than
 * one element pretending to be both: the unsubscribe is an address on somebody
 * else's server and has to open in its own tab, with the referrer withheld -
 * a mailing list does not get told which message the click came from.
 */
function RowAction({
    icon: Icon,
    label,
    href,
    danger,
    onClick
}: {
    icon: typeof Archive;
    label: string;
    href?: string;
    danger?: boolean;
    onClick?: () => void;
}) {
    const look = cn(
        "flex size-6 items-center justify-center rounded text-foreground-subtle hover:bg-card hover:text-foreground",
        danger && "hover:text-danger"
    );
    if (href) {
        return (
            <a
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                aria-label={label}
                title={label}
                className={look}
                // The row underneath is a link to the conversation.
                onClick={(event) => event.stopPropagation()}
            >
                <Icon className="size-3.5 shrink-0" aria-hidden />
            </a>
        );
    }
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            className={look}
            onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onClick?.();
            }}
        >
            <Icon className="size-3.5 shrink-0" aria-hidden />
        </button>
    );
}

/** Whose face a row wears: the first participant who is not the reader, so an
 *  inbox shows the sender and Sent shows who it went to. */
function faceOf(
    thread: MailThreadView,
    mine: ReadonlySet<string>
): { name: string; address: string } {
    const other = thread.participants.find((one) => !mine.has(one.address.trim().toLowerCase()));
    const chosen = other ?? thread.participants[0];
    return { name: chosen?.name ?? "", address: chosen?.address ?? "" };
}

/**
 * Who a conversation is with, as a list shows it.
 *
 * The people, not the addresses, and never more than three names before it says
 * how many more. The reader themself is not one of the people: they are on every
 * conversation in their own mailbox, so their name in that column is a word
 * repeated down the whole screen that tells nobody anything. A message somebody
 * sent to themself is the one case where it is all there is, and then it stands.
 */
function people(thread: MailThreadView, mine: ReadonlySet<string>): string {
    const others = thread.participants.filter(
        (entry) => !mine.has(entry.address.trim().toLowerCase())
    );
    const shown = others.length > 0 ? others : thread.participants;
    const names = shown.map(
        (entry) => entry.name.trim() || entry.address.split("@")[0] || entry.address
    );
    if (names.length === 0) return "(nobody)";
    if (names.length <= 3) return names.join(", ");
    return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

/**
 * The right-hand end of a row: whether it carries anything, and how old it is.
 *
 * How old rather than when, and that is a reversal. This used to print the time
 * for today and the date for everything else, on the argument that a list is
 * scanned for a date somebody half remembers and a relative one makes that
 * arithmetic the reader's job. The argument holds for a message from March and
 * not at all for one from this morning, which is most of an inbox: "14:02" is
 * itself arithmetic, against a clock the reader has to go and look at.
 *
 * So it says the age, keeps saying it as the minutes pass, and holds the exact
 * moment on the hover - and past a fortnight it goes back to printing the date,
 * because "14 months ago" is a worse answer than the month it happened in. The
 * half-remembered date is answered where it was actually being asked.
 *
 * Narrow, because this column is a few characters wide beside a subject that is
 * already being truncated: "3h ago" rather than "3 hours ago".
 *
 * The paperclip sits here rather than out on the preview line, where it was.
 * Whether a conversation has something attached is read in the same glance as
 * how old it is - both are why somebody picks one row out of forty - and the
 * preview line is the one thing on the row that is genuinely prose.
 */
function Stamp({ thread, bySize }: { thread: MailThreadView; bySize: boolean }) {
    const format = useDisplayFormat();
    return (
        <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-foreground-subtle">
            {thread.hasAttachments ? (
                <Paperclip className="size-3 shrink-0" aria-label="Has attachments" />
            ) : null}
            {bySize ? (
                // A list sorted by size says the size where it would say the
                // age, and keeps the date on the hover - sorting by something a
                // row does not show is a list somebody has to take on trust.
                <span title={shortDate(thread.lastMessageAt, format)}>
                    {core.formatBytes(thread.size)}
                </span>
            ) : (
                <RelativeTime iso={thread.lastMessageAt} formatStyle="narrow" threshold="P14D" />
            )}
        </span>
    );
}

/**
 * The absolute form, for the hover and for a list read by size.
 *
 * Both halves go through the display format, which is where the clock and the
 * date order this deployment uses are decided - never through the browser's
 * locale, because the whole point of that setting is that the order is chosen
 * rather than implied.
 */
function shortDate(iso: string, format: DisplayFormat): string {
    const when = new Date(iso);
    const now = new Date();
    return when.toDateString() === now.toDateString() ? format.time(when) : format.date(when);
}
