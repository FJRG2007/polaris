/**
 * Assembling what a task screen needs before it renders.
 *
 * Every screen wants the same five things about a space - its statuses, tags,
 * fields, people, and enough of its tasks to link one to another - and wants
 * them in one round trip rather than five waterfalls once the page is already
 * on screen. This is that one trip.
 */

import * as spaces from "./space-service";
import { listTasks } from "./task-service";
import type { SpaceContext } from "./facts";
import type { SpaceAccess, TaskScope } from "./access";

/** How many sibling tasks the dependency picker is given. Beyond this a person
 *  is searching, not scanning, and the picker filters what it was handed. */
const SIBLING_LIMIT = 500;

export async function buildSpaceContext(
    spaceId: string,
    role: SpaceAccess,
    currentUserId: string,
    /**
     * Whether this account may change work at all - `tasks.manage`, held on the
     * instance rather than in this space.
     *
     * Both questions have to be asked, and only one of them used to be. A role
     * in a space says which work somebody reaches; the permission says whether
     * they may reshape any of it. Somebody holding `tasks.read` and a place on a
     * space's roster was drawn every control an owner sees - the status marker,
     * the assignee picker, the drag handle, the delete - and every one of them
     * bounced off the action behind it, which does not redraw the screen with an
     * explanation but sends them to their home page. A control that cannot work
     * is worse than no control: it reads as the software being broken rather
     * than as permission they do not have.
     */
    mayManage: boolean,
    /** Passed when the reader only reaches part of this space, so the sibling
     *  list a dependency picker offers cannot name another client's work. */
    scope?: TaskScope
): Promise<SpaceContext> {
    const partial = scope?.partialSpaceIds.includes(spaceId) ?? false;
    const [statuses, tags, fields, people, siblings] = await Promise.all([
        spaces.listStatuses(spaceId),
        spaces.listTags(spaceId),
        spaces.listCustomFields(spaceId),
        spaces.spacePeople(spaceId),
        listTasks(
            partial ? { listIds: scope?.listIds ?? [] } : { spaceIds: [spaceId] },
            { limit: SIBLING_LIMIT }
        )
    ]);

    return {
        spaceId,
        statuses,
        tags,
        fields,
        people,
        canEdit: mayManage && (role === "owner" || role === "admin" || role === "member"),
        canModerate: mayManage && (role === "owner" || role === "admin"),
        currentUserId,
        siblings
    };
}
