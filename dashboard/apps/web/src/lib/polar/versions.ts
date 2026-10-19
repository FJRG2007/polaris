/**
 * The versions of a Polar conversation.
 *
 * Every message knows the one it follows (`parentId`). Editing a message, or
 * regenerating an answer, adds a sibling under the same parent instead of
 * replacing it, so the conversation is a tree and the screen shows one path
 * through it. These are the pure steps the panel needs: learn the path it is
 * showing, list a message's versions, and the path through another version.
 *
 * Client-safe.
 */

import type { UIMessage } from "ai";

export interface VersionNode {
    message: UIMessage;
    parentId: string | null;
}

/** Messages by id, in the order they were first seen (oldest first). */
export type VersionTree = Map<string, VersionNode>;

/**
 * Adds the path on screen to the tree. A message already known keeps its
 * parent - an id names one place in the tree for ever - but its content is
 * refreshed, because a stream or an approval changes a message in place.
 */
export function learnPath(
    tree: VersionTree,
    messages: readonly UIMessage[],
    known?: ReadonlyMap<string, string | null>
): void {
    messages.forEach((message, index) => {
        const existing = tree.get(message.id);
        if (existing) {
            existing.message = message;
            return;
        }
        const parentId = known?.has(message.id)
            ? (known.get(message.id) ?? null)
            : (messages[index - 1]?.id ?? null);
        tree.set(message.id, { message, parentId });
    });
}

/** Every version of the turn this message is one of, oldest first. */
export function versionsOf(tree: VersionTree, id: string): string[] {
    const node = tree.get(id);
    if (!node) return [id];
    const versions: string[] = [];
    for (const [key, entry] of tree) {
        if (entry.parentId === node.parentId && entry.message.role === node.message.role)
            versions.push(key);
    }
    return versions;
}

/** The newest message that follows this one, or null at the end of a path. */
function newestChild(tree: VersionTree, id: string): string | null {
    let found: string | null = null;
    for (const [key, entry] of tree) if (entry.parentId === id) found = key;
    return found;
}

/**
 * The path to show when the message at `index` is switched to `version`: what
 * came before it unchanged, then that version, then the newest answer to it,
 * and so on to the end.
 */
export function pathThrough(
    tree: VersionTree,
    messages: readonly UIMessage[],
    index: number,
    version: string
): UIMessage[] {
    const path = messages.slice(0, index);
    const seen = new Set<string>();
    let current: string | null = version;
    while (current && !seen.has(current)) {
        seen.add(current);
        const node = tree.get(current);
        if (!node) break;
        path.push(node.message);
        current = newestChild(tree, current);
    }
    return path;
}
