"use client";

/**
 * Creating a tag from the place it is needed - a picker, a row menu - instead of
 * from the space's settings.
 *
 * The tag it creates is kept here as well, merged into the space's own list. That
 * is what makes the tag land on the task: an edit is drawn against the tags the
 * screen knows about, and a tag created a moment ago is not among the ones the
 * server sent when the page opened. Without it the id is written and then dropped
 * on its way to the screen, which reads as the tag never having been added.
 *
 * Held in a ref as well as in state, because the two are needed at different
 * moments. A picker hands the id back the instant the server answers - before
 * React has re-rendered anything - so `resolve` reads the ref, while `tags` is the
 * state the pickers are drawn from. The server's list wins once it arrives: the
 * merge only covers the gap between creating a tag and being told about it.
 */

import * as actions from "./actions";
import { runAction } from "@/lib/run-action";
import { useCallback, useMemo, useRef, useState } from "react";
import type { TagView } from "@/lib/tasks/space-service";

/** Anything drawn against a space's tags - a whole context, or a bare list. */
interface Tagged {
    readonly tags: readonly TagView[];
}

/** The space's tags with the ones created here folded in, in the order the space's
 *  own list arrives in, so a new tag takes its alphabetical place straight away. */
function merge(tags: readonly TagView[], created: readonly TagView[]): readonly TagView[] {
    if (created.length === 0) return tags;
    const held = new Set(tags.map((tag) => tag.id));
    const extra = created.filter((tag) => !held.has(tag.id));
    return extra.length === 0 ? tags : [...tags, ...extra].sort((left, right) => left.name.localeCompare(right.name));
}

export interface TagCreation {
    /** The space's tags, with anything created here already among them. */
    readonly tags: readonly TagView[];
    /** Create the tag - or find the one that already carries that name - and answer
     *  with its id, which is what a picker puts on the task. */
    create: (name: string, color: string) => Promise<string | null>;
    /** The same merge, applied to whatever an edit is about to be resolved against.
     *  Current at the moment it is called rather than at the last render. */
    resolve: <Space extends Tagged>(space: Space) => Space;
}

export function useTagCreation(
    spaceId: string,
    tags: readonly TagView[],
    onError: (message: string) => void
): TagCreation {
    const [created, setCreated] = useState<readonly TagView[]>([]);
    const madeHere = useRef<readonly TagView[]>([]);

    const create = useCallback(
        async (name: string, color: string): Promise<string | null> => {
            const result = await runAction(() => actions.createTagAction(spaceId, name, color), onError);
            if (result?.error) onError(result.error);
            const tag = result?.tag;
            if (!tag) return null;
            if (!madeHere.current.some((entry) => entry.id === tag.id)) {
                madeHere.current = [...madeHere.current, tag];
                setCreated(madeHere.current);
            }
            return tag.id;
        },
        [spaceId, onError]
    );

    const resolve = useCallback(<Space extends Tagged>(space: Space): Space => {
        const merged = merge(space.tags, madeHere.current);
        return merged === space.tags ? space : { ...space, tags: merged };
    }, []);

    return { tags: useMemo(() => merge(tags, created), [tags, created]), create, resolve };
}
