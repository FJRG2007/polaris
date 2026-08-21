"use client";

/**
 * Creating a tag from the place it is needed - a picker, a row menu - instead of
 * from the space's settings.
 *
 * Optimistic, because a tag gets created mid-sentence: somebody is filing a task,
 * types a word no tag carries yet, and means it to be on that task. So the tag is
 * there the moment they press enter, under an id this browser made up, and the
 * request runs behind it. `settleTagIds` turns those ids into real ones on the way
 * to the server - waiting for the request if it has not answered yet - so a write
 * can never carry an id the database has never seen.
 *
 * Refused, it is taken back off: the tag leaves the screen, the write goes without
 * it, and a note names what failed. Nothing is left looking saved that is not.
 *
 * The store is module-level rather than a context because one tag has to be
 * resolvable in several places at once - the picker that made it, the row behind
 * it, the subtask list under it, and the write each of them sends - and those hold
 * their own state. Entries last the session; they cost a name and a colour each.
 */

import * as actions from "./actions";
import { useToast } from "@polaris/ui";
import { runAction } from "@/lib/run-action";
import type { TagView } from "@/lib/tasks/space-service";
import { useCallback, useMemo, useSyncExternalStore } from "react";

/** Marks an id this browser made up, so a write can tell it from a real one. */
const PROVISIONAL = "new-tag:";

let counter = 0;

interface Made {
    readonly spaceId: string;
    readonly tag: TagView;
    /** The id the server gave it, or null if it refused - see `settleTagIds`. */
    readonly done: Promise<string | null>;
}

const made = new Map<string, Made>();
const listeners = new Set<() => void>();
let snapshot: readonly Made[] = [];

function publish(): void {
    snapshot = [...made.values()];
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

const read = (): readonly Made[] => snapshot;

/** Whether an id is one of this browser's, still on its way to being real. */
export function isProvisionalTagId(id: string): boolean {
    return id.startsWith(PROVISIONAL);
}

/** Anything drawn against a space's tags: a whole context, or a bare list. */
interface Tagged {
    readonly spaceId: string;
    readonly tags: readonly TagView[];
}

/**
 * The space's tags with the ones created here among them, in the order the
 * server's own list arrives in so a new tag takes its alphabetical place.
 *
 * `aliases` is the difference between the two things this list is for. Drawing a
 * picker, a tag the server has since sent back under its real name is one entry,
 * not two. Resolving the ids a row is holding, the browser's own id has to keep
 * naming something, because a row painted a moment ago is still carrying it.
 */
function fold(space: Tagged, created: readonly Made[], aliases: boolean): readonly TagView[] {
    const named = new Set(space.tags.map((tag) => tag.name));
    // By id as well, because these lists are folded more than once: a screen keeps
    // one for its pickers to draw, and folds it again when an edit is resolved.
    const held = new Set(space.tags.map((tag) => tag.id));
    const extra = created
        .filter(
            (entry) =>
                entry.spaceId === space.spaceId &&
                !held.has(entry.tag.id) &&
                (aliases || !named.has(entry.tag.name))
        )
        .map((entry) => entry.tag);
    if (extra.length === 0) return space.tags;
    return [...space.tags, ...extra].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The space an edit is about to be resolved against, with every tag created here
 * in it. Read at the moment it is called rather than at the last render: a picker
 * hands its id back before React has drawn anything.
 */
export function withCreatedTags<Space extends Tagged>(space: Space): Space {
    const tags = fold(space, snapshot, true);
    return tags === space.tags ? space : { ...space, tags };
}

/**
 * Real ids for a list that may name tags this browser has only just invented.
 * Waits for any creation still in flight, and drops the ones that were refused -
 * a write must never carry an id that will never exist.
 */
export async function settleTagIds(ids: readonly string[]): Promise<string[]> {
    if (!ids.some((id) => made.has(id))) return [...ids];
    const settled = await Promise.all(ids.map((id) => made.get(id)?.done ?? Promise.resolve<string | null>(id)));
    return settled.filter((id): id is string => id !== null);
}

export interface TagCreation {
    /** The space's tags, with anything created here already among them. */
    readonly tags: readonly TagView[];
    /** Create a tag and answer at once with the id to put on the task. The request
     *  runs behind it; `settleTagIds` is what a write goes through. */
    create: (name: string, color: string) => Promise<string>;
}

export function useTagCreation(spaceId: string, tags: readonly TagView[]): TagCreation {
    const toast = useToast();
    const created = useSyncExternalStore(subscribe, read, read);

    const create = useCallback(
        async (name: string, color: string): Promise<string> => {
            counter += 1;
            const id = `${PROVISIONAL}${counter}`;
            let answer: (real: string | null) => void = () => undefined;
            const done = new Promise<string | null>((resolve) => {
                answer = resolve;
            });
            made.set(id, { spaceId, tag: { id, name, color }, done });
            publish();

            /** Take it back off, and say so - the picker it was typed into is
             *  usually closed by the time this is known. */
            const refuse = (message: string): void => {
                made.delete(id);
                publish();
                answer(null);
                toast.show({ key: `tag-create:${name}`, title: `Could not create "${name}"`, body: message });
            };

            void (async () => {
                const result = await runAction(() => actions.createTagAction(spaceId, name, color), refuse);
                // A rejected call has already been refused by the handler above.
                if (!result) return;
                if (!result.tag) refuse(result.error ?? "The tag was not added.");
                else answer(result.tag.id);
            })();

            return id;
        },
        [spaceId, toast]
    );

    return { tags: useMemo(() => fold({ spaceId, tags }, created, false), [spaceId, tags, created]), create };
}
