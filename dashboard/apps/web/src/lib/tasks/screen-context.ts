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
import type { SpaceAccess } from "./access";
import type { SpaceContext } from "./facts";

/** How many sibling tasks the dependency picker is given. Beyond this a person
 *  is searching, not scanning, and the picker filters what it was handed. */
const SIBLING_LIMIT = 500;

export async function buildSpaceContext(
    spaceId: string,
    role: SpaceAccess,
    currentUserId: string
): Promise<SpaceContext> {
    const [statuses, tags, fields, people, siblings] = await Promise.all([
        spaces.listStatuses(spaceId),
        spaces.listTags(spaceId),
        spaces.listCustomFields(spaceId),
        spaces.spacePeople(spaceId),
        listTasks({ spaceIds: [spaceId] }, { limit: SIBLING_LIMIT })
    ]);

    return {
        spaceId,
        statuses,
        tags,
        fields,
        people,
        canEdit: role === "owner" || role === "admin" || role === "member",
        canModerate: role === "owner" || role === "admin",
        currentUserId,
        siblings
    };
}
