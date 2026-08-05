/**
 * What an organization is, at a glance: how much of each thing it holds, and the
 * last few things that were done to it.
 *
 * Every number is a link. A count that cannot be opened is trivia, and the whole
 * reason somebody lands here is to get to the part they came for.
 */

import Link from "next/link";
import { Card, CardBody } from "@polaris/ui";
import { hasOrgPermission } from "@polaris/core";
import { orgTotals } from "@/lib/orgs/org-service";
import { listOrgActivity } from "@/lib/audit-service";
import { requireOrgPage } from "@/lib/orgs/page-access";
import { RelativeTime } from "@/components/relative-time";
import { Globe, History, IdCard, Rocket, SquareCheckBig, Users, UsersRound, type LucideIcon } from "lucide-react";

export const dynamic = "force-dynamic";

/** How many recent lines earn a place here. Enough to answer "has anything
 *  happened", few enough that the page is still a summary. */
const RECENT = 5;

export default async function OrganizationOverviewPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const { org, access } = await requireOrgPage(slug);

    const canReadActivity = hasOrgPermission(access.permissions, "activity.read");
    const [totals, recent] = await Promise.all([
        orgTotals(org.id),
        canReadActivity ? listOrgActivity(org.id, { limit: RECENT }) : Promise.resolve([])
    ]);

    const base = `/account/organizations/${org.slug}`;
    const tiles: { label: string; count: number; href: string; icon: LucideIcon; shown: boolean }[] = [
        { label: "People", count: totals.members, href: `${base}/people`, icon: Users, shown: true },
        { label: "Teams", count: totals.teams, href: `${base}/teams`, icon: UsersRound, shown: true },
        { label: "Spaces", count: totals.spaces, href: `${base}/spaces`, icon: SquareCheckBig, shown: true },
        {
            label: "Roles",
            count: totals.roles,
            href: `${base}/roles`,
            icon: IdCard,
            shown: hasOrgPermission(access.permissions, "roles.manage")
        },
        {
            label: "Domains",
            count: totals.domains,
            href: `${base}/domains`,
            icon: Globe,
            shown: hasOrgPermission(access.permissions, "domains.manage")
        },
        {
            label: "Services",
            count: totals.projects,
            href: "/apps/deploy",
            icon: Rocket,
            shown: hasOrgPermission(access.permissions, "deploy.manage")
        }
    ];

    return (
        <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {tiles
                    .filter((tile) => tile.shown)
                    .map((tile) => (
                        <Link
                            key={tile.label}
                            href={tile.href}
                            className="border-border bg-surface/40 hover:bg-muted flex flex-col gap-1 rounded-lg border p-3 transition-colors"
                        >
                            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                                <tile.icon className="size-3.5 shrink-0" />
                                {tile.label}
                            </span>
                            <span className="text-2xl font-semibold tabular-nums">{tile.count}</span>
                        </Link>
                    ))}
            </div>

            {canReadActivity && (
                <Card>
                    <CardBody className="flex flex-col gap-2">
                        <div className="flex items-center justify-between gap-2">
                            <h2 className="flex items-center gap-2 text-sm font-medium">
                                <History className="size-4 shrink-0" /> Recently
                            </h2>
                            <Link href={`${base}/activity`} className="text-muted-foreground hover:text-foreground text-xs">
                                All activity
                            </Link>
                        </div>
                        {recent.length === 0 ? (
                            <p className="text-muted-foreground text-sm">Nothing has been done here yet.</p>
                        ) : (
                            <ul className="flex flex-col">
                                {recent.map((entry) => (
                                    <li
                                        key={entry.id}
                                        className="border-border flex items-center justify-between gap-3 border-b py-1.5 text-sm last:border-0"
                                    >
                                        <span className="min-w-0 truncate">
                                            <span className="font-medium">{entry.actorName}</span>{" "}
                                            <span className="text-muted-foreground">{entry.action}</span>
                                        </span>
                                        <span className="text-muted-foreground shrink-0 text-xs">
                                            <RelativeTime iso={entry.at} />
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardBody>
                </Card>
            )}

            <p className="text-muted-foreground text-xs">
                Started {new Date(org.createdAt).getFullYear()} by {org.ownerName}.
            </p>
        </div>
    );
}
