/**
 * A space (/tasks/s/<id>): its lists, and the vocabulary they share.
 */

import { prisma } from "@polaris/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/session";
import * as spaces from "@/lib/tasks/space-service";
import { listForms } from "@/lib/tasks/form-service";
import type { SpaceVisibility } from "@polaris/core";
import { SpaceTree } from "@/app/(app)/tasks/space-tree";
import { SpaceScreen } from "@/app/(app)/tasks/space-view";
import { listAutomations } from "@/lib/tasks/automation-service";
import { requireSpace, visibleSpaceIds, type TaskActor } from "@/lib/tasks/access";

export const dynamic = "force-dynamic";

/** The origin this instance is being reached on, so a form link is one that
 *  actually resolves rather than a guess at the hostname. */
async function currentOrigin(): Promise<string> {
    const header = await headers();
    const host = header.get("x-forwarded-host") ?? header.get("host") ?? "";
    const protocol = header.get("x-forwarded-proto") ?? "https";
    return host ? `${protocol}://${host}` : "";
}

export default async function SpacePage({ params }: { params: Promise<{ spaceId: string }> }) {
    const { spaceId } = await params;
    const user = await requirePermission("tasks.read");
    const actor: TaskActor = { id: user.id, isAdmin: user.isAdmin };

    let role;
    try {
        role = await requireSpace(actor, spaceId, "guest");
    } catch {
        redirect("/tasks");
    }

    const space = await prisma.taskSpace.findUnique({
        where: { id: spaceId },
        select: { name: true, prefix: true, description: true, visibility: true }
    });
    if (!space) redirect("/tasks");

    const canManage = role === "owner" || role === "admin";
    const [tree, statuses, fields, tags, members, automations, forms, origin] = await Promise.all([
        spaces.listSpaceTree(user.id, await visibleSpaceIds(actor), user.isAdmin),
        spaces.listStatuses(spaceId),
        spaces.listCustomFields(spaceId),
        spaces.listTags(spaceId),
        spaces.listSpaceMembers(spaceId),
        listAutomations(spaceId),
        listForms(spaceId),
        currentOrigin()
    ]);

    const lists = tree.find((entry) => entry.id === spaceId);
    const allLists = lists ? [...lists.lists, ...lists.folders.flatMap((folder) => folder.lists)] : [];

    return (
        <div className="flex w-full flex-col gap-6 md:flex-row">
            <SpaceTree spaces={tree} canCreate />
            <SpaceScreen
                spaceId={spaceId}
                name={space.name}
                prefix={space.prefix}
                description={space.description}
                visibility={space.visibility as SpaceVisibility}
                lists={allLists}
                statuses={statuses}
                fields={fields}
                tags={tags}
                members={members}
                automations={automations}
                forms={forms}
                people={members.map((member) => ({ id: member.userId, name: member.name, image: member.image }))}
                canManage={canManage}
                origin={origin}
            />
        </div>
    );
}
