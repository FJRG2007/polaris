/**
 * Docs (/tasks/docs), with the open page in the query string so a link to a page
 * is a link somebody can send.
 */

import { prisma } from "@polaris/db";
import { requirePermission } from "@/lib/session";
import { DocsView } from "@/app/(app)/tasks/docs-view";
import { docTree, getDoc } from "@/lib/tasks/doc-service";
import { visibleSpaceIds, type TaskActor } from "@/lib/tasks/access";

export const dynamic = "force-dynamic";

export default async function DocsPage({ searchParams }: { searchParams: Promise<{ doc?: string }> }) {
    const { doc: docId } = await searchParams;
    const user = await requirePermission("tasks.read");
    const actor: TaskActor = { id: user.id, isAdmin: user.isAdmin };
    const spaceIds = await visibleSpaceIds(actor);

    const [tree, spaces] = await Promise.all([
        docTree(spaceIds),
        prisma.taskSpace.findMany({
            where: { id: { in: spaceIds } },
            orderBy: { order: "asc" },
            select: { id: true, name: true }
        })
    ]);

    // A page in a space the reader cannot see is simply not opened, rather than
    // refused loudly - the id in the URL is not a secret worth confirming.
    const doc = docId ? await getDoc(docId) : null;
    const readable = doc && (doc.spaceId === null || spaceIds.includes(doc.spaceId)) ? doc : null;

    return <DocsView tree={tree} doc={readable} spaces={spaces} canEdit />;
}
