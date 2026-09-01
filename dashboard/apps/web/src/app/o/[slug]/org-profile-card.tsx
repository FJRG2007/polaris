"use client";

/**
 * The card an organization's page is drawn in.
 *
 * Deliberately the same shape as a person's - a band, the mark cut out of its
 * lower edge, everything reading down from there - because they are pages of the
 * same kind and a second, different-looking one is how a product stops feeling
 * like one. What differs is what a page of each has to say, and only that.
 *
 * The people on it are the ones who marked this organization on their own
 * profile, and the line under them says so. That matters: a reader who took the
 * list for the roster would read four names as "this company has four people",
 * and it is not the roster - it is everybody who said, one at a time, that they
 * work here.
 */

import Link from "next/link";
import type { OrgProfile } from "@/lib/profile-service";
import { Badge, Button, Card, CardBody } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { AtSign, CalendarDays, Settings2 } from "lucide-react";
import { Avatar, OrgAvatar, tintFor } from "@/components/avatar";

export function OrgProfileCard({ org }: { org: OrgProfile }) {
    const format = useDisplayFormat();

    return (
        <Card className="overflow-hidden">
            {/* The organization's own colour rather than a banner: there is no
                banner to upload for one, and a grey strip on every company page
                would be a placeholder waiting for a feature nobody asked for. */}
            <div className="h-28 w-full" style={{ background: tintFor(org.id) }} />
            <CardBody className="flex flex-col gap-4">
                <div className="-mt-12 flex items-end gap-3">
                    <span className="rounded-lg ring-4 ring-card">
                        <OrgAvatar org={org} size={72} />
                    </span>
                    {org.manageable ? (
                        <Button asChild size="xs" variant="outline" className="mb-1">
                            <Link href={`/account/organizations/${org.slug}`}>
                                <Settings2 className="size-3 shrink-0" />
                                Manage
                            </Link>
                        </Button>
                    ) : null}
                </div>

                <div className="flex flex-col gap-0.5">
                    <h1 className="flex flex-wrap items-center gap-2 text-lg font-semibold leading-tight tracking-tight">
                        {org.name}
                        <Badge variant="neutral">Organization</Badge>
                    </h1>
                    <p className="text-muted-foreground flex items-center gap-1 text-sm">
                        <AtSign className="size-3.5 shrink-0" />
                        {org.slug}
                    </p>
                </div>

                {org.description ? (
                    <p className="text-sm leading-relaxed text-foreground/90">{org.description}</p>
                ) : null}

                {org.people.length > 0 ? (
                    <div className="flex flex-col gap-2 border-t border-border pt-4">
                        <p className="text-muted-foreground text-xs">
                            {org.people.length === 1
                                ? "One person shows this organization on their profile."
                                : `${org.people.length} people show this organization on their profile.`}
                        </p>
                        <ul className="flex flex-col gap-1">
                            {org.people.map((person) => (
                                <li key={person.id}>
                                    <Link
                                        href={`/u/${person.username}`}
                                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted"
                                    >
                                        <Avatar person={person} size={24} status={false} />
                                        <span className="min-w-0 flex-1 truncate" title={person.name}>
                                            {person.name}
                                        </span>
                                        <span className="text-muted-foreground shrink-0 text-xs">
                                            @{person.username}
                                        </span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </div>
                ) : null}

                <div className="text-muted-foreground flex flex-col gap-1.5 border-t border-border pt-4 text-sm">
                    <p className="flex items-center gap-1.5">
                        <CalendarDays className="size-3.5 shrink-0" />
                        Here since {format.date(org.createdAt)}
                    </p>
                </div>
            </CardBody>
        </Card>
    );
}
