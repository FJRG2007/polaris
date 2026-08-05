/**
 * The work this organization owns.
 *
 * A management view, not a board: it answers "what does this group have, and who
 * reaches it", and every row opens the real thing in Tasks. Making a space is
 * done there too, with this organization picked as its owner - which is why the
 * empty state points at the switcher rather than offering a button that would be
 * the second place spaces are created.
 */

import Link from "next/link";
import { SquareCheckBig } from "lucide-react";
import { Badge, Card, CardBody } from "@polaris/ui";
import { listOrgSpaces } from "@/lib/orgs/org-service";
import { requireOrgPage } from "@/lib/orgs/page-access";

export const dynamic = "force-dynamic";

export default async function OrganizationSpacesPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const { org } = await requireOrgPage(slug);
    const spaces = await listOrgSpaces(org.id);

    if (spaces.length === 0) {
        return (
            <Card>
                <CardBody className="flex flex-col items-center gap-2 py-10 text-center">
                    <SquareCheckBig className="text-muted-foreground size-6 shrink-0" />
                    <p className="text-sm font-medium">{org.name} owns no work yet</p>
                    <p className="text-muted-foreground max-w-md text-sm">
                        Switch to {org.name} in the header, then create a space in Tasks. It will belong to the
                        organization rather than to you, and outlive anybody leaving.
                    </p>
                    <Link href="/tasks" className="text-sm underline">
                        Open Tasks
                    </Link>
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            {spaces.map((space) => (
                <Link
                    key={space.id}
                    href={`/tasks/s/${space.id}`}
                    className="border-border bg-surface/40 hover:bg-muted flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 transition-colors"
                >
                    <span
                        aria-hidden="true"
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: space.color }}
                    />
                    <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium" title={space.name}>{space.name}</span>
                            <span className="text-muted-foreground text-xs">{space.prefix}</span>
                            {space.archived && <Badge variant="neutral">archived</Badge>}
                        </span>
                        <span className="text-muted-foreground block truncate text-xs">
                            {space.taskCount} task{space.taskCount === 1 ? "" : "s"} -{" "}
                            {space.teams.length > 0
                                ? `reached by ${space.teams.join(", ")}`
                                : space.visibility === "internal"
                                  ? "open to everybody on this roster"
                                  : "no team reaches it yet"}
                        </span>
                    </span>
                </Link>
            ))}
            <p className="text-muted-foreground text-xs">
                A team reaches a space because it was granted it, which is done from the space&rsquo;s own access
                settings in Tasks.
            </p>
        </div>
    );
}
