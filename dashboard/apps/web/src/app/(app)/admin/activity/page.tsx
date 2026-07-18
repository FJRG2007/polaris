import { prisma } from "@polaris/db";
import { Badge, PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { listActivity } from "@/lib/audit-service";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
    await requireAdmin();
    const events = await listActivity(200);

    // Resolve actor ids to names in one query.
    const actorIds = [...new Set(events.map((event) => event.actorId).filter((id): id is string => Boolean(id)))];
    const actors = await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true }
    });
    const nameById = new Map(actors.map((actor) => [actor.id, actor.name || actor.email]));

    return (
        <>
            <PageHeader
                title="Activity"
                description="A global history of actions across Polaris - connections, reads, writes, and management."
            />
            <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-sm">
                    <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-medium">When</th>
                            <th className="px-3 py-2 font-medium">Who</th>
                            <th className="px-3 py-2 font-medium">Action</th>
                            <th className="hidden px-3 py-2 font-medium md:table-cell">Details</th>
                        </tr>
                    </thead>
                    <tbody>
                        {events.length === 0 ? (
                            <tr>
                                <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                                    No activity recorded yet.
                                </td>
                            </tr>
                        ) : (
                            events.map((event) => (
                                <tr key={event.id} className="border-t border-border hover:bg-card-hover">
                                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                                        {new Date(event.at).toLocaleString()}
                                    </td>
                                    <td className="px-3 py-2">
                                        {event.actorId ? (nameById.get(event.actorId) ?? "unknown") : "system"}
                                    </td>
                                    <td className="px-3 py-2">
                                        <Badge variant="neutral">{event.action}</Badge>
                                    </td>
                                    <td className="hidden max-w-md truncate px-3 py-2 text-xs text-muted-foreground md:table-cell">
                                        {event.metadata ?? ""}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </>
    );
}
