/**
 * A space (/tasks/s/<id>): its lists, and the vocabulary they share.
 */

import { prisma } from "@polaris/db";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/session";
import * as spaces from "@/lib/tasks/space-service";
import { listForms } from "@/lib/tasks/form-service";
import type { SpaceVisibility } from "@polaris/core";
import { sharingBaseUrl } from "@/lib/domain-service";
import { SpaceTree } from "@/app/(app)/tasks/space-tree";
import { SpaceScreen } from "@/app/(app)/tasks/space-view";
import { listAutomations } from "@/lib/tasks/automation-service";
import { requireSpace, visibleScope, type TaskActor } from "@/lib/tasks/access";

export const dynamic = "force-dynamic";

export default async function SpacePage({
    params,
    searchParams
}: {
    params: Promise<{ spaceId: string }>;
    searchParams: Promise<{ tab?: string }>;
}) {
    const { spaceId } = await params;
    // The tab is in the URL so the rest of the app can send somebody straight to
    // it - "edit statuses" from a status menu has to land on the statuses.
    const { tab } = await searchParams;
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
        select: {
            name: true,
            prefix: true,
            description: true,
            visibility: true,
            // Named rather than a flag, because "internal" means this
            // organization's people and the header has to say which one.
            org: { select: { name: true } }
        }
    });
    if (!space) redirect("/tasks");

    const canManage = role === "owner" || role === "admin";
    const [tree, statuses, fields, tags, members, automations, forms, baseUrl] = await Promise.all([
        spaces.listSpaceTree(user.id, await visibleScope(actor), user.isAdmin),
        spaces.listStatuses(spaceId),
        spaces.listCustomFields(spaceId),
        spaces.listTags(spaceId),
        spaces.listSpaceMembers(spaceId),
        listAutomations(spaceId),
        listForms(spaceId),
        // A form is filled in by somebody outside Polaris, so its link is built on the
        // address Polaris hands out rather than the hostname this tab is on.
        sharingBaseUrl()
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
                orgName={space.org?.name ?? null}
                lists={allLists}
                statuses={statuses}
                fields={fields}
                tags={tags}
                members={members}
                automations={automations}
                forms={forms}
                people={members.map((member) => ({ id: member.userId, name: member.name, image: member.image }))}
                canManage={canManage}
                baseUrl={baseUrl}
                initialTab={tab}
            />
        </div>
    );
}
