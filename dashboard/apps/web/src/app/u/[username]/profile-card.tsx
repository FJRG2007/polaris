"use client";

/**
 * The card a profile is drawn in.
 *
 * The same shape as the panel beside a direct message - a band, the face cut out
 * of its lower edge, everything reading down from there - because they are the
 * same person and a second, different-looking profile is how a product stops
 * feeling like one. The band and its colour come from `ProfileBanner`, which is
 * where that shape already lives.
 *
 * Where somebody works reads as two different claims and is drawn as two. An
 * organization on this Polaris carries its own mark and a tick, and its name
 * leads to it: it is a roster Polaris holds and the person is on it, which is
 * the only thing Polaris can actually vouch for. A typed line carries neither -
 * it is a sentence somebody wrote about themselves, and drawing it identically
 * would make Polaris appear to confirm it.
 *
 * The owner of a page sees exactly what everybody else sees, and a way to change
 * it. Anything else and the one person who cannot check what their own page says
 * is the person it is about.
 *
 * A name carries three things beside it and each is a different question. The
 * headline is what somebody does, in one line. The pronouns are how they want to
 * be referred to and are drawn only when they have said - an empty value is a
 * person who did not answer, not a field waiting to be filled in. The bio is a
 * paragraph, and it goes underneath, because a paragraph beside a name is a
 * paragraph nobody reads.
 */

import Link from "next/link";
import { Avatar, OrgAvatar } from "@/components/avatar";
import { Badge, Button, Card, CardBody } from "@polaris/ui";
import type { PublicProfile } from "@/lib/profile-service";
import { ProfileBanner } from "@/components/profile-banner";
import { useDisplayFormat } from "@/components/display-format";
import { ProfileActions } from "./profile-actions";
import { MutualPanel } from "@/components/mutual-panel";
import { FollowLists } from "./follow-lists";
import { linkLabel } from "@polaris/core";
import { AtSign, BadgeCheck, Building2, CalendarDays, LinkIcon, Mail, Pencil } from "lucide-react";

export function ProfileCard({
    profile,
    own,
    signedIn
}: {
    profile: PublicProfile;
    own: boolean;
    /** Whether the reader has an account here. Everything a reader can DO about
     *  somebody needs one, so a stranger is shown the page and no buttons rather
     *  than buttons that send them to a sign-in screen. */
    signedIn: boolean;
}) {
    const format = useDisplayFormat();
    const person = { id: profile.id, name: profile.name };

    return (
        <Card className="overflow-hidden">
            <ProfileBanner person={person} className="h-28" />
            <CardBody className="flex flex-col gap-4">
                <div className="-mt-12 flex items-end gap-3">
                    <span className="rounded-full ring-4 ring-card">
                        {/* Initials rather than a photo for a reader they do not
                            show it to. The same rule the rest of Polaris draws
                            them by, answered on the server. */}
                        <Avatar
                            person={profile.showsAvatar ? person : { id: null, name: profile.name }}
                            size={72}
                            status={false}
                        />
                    </span>
                    {own ? (
                        <span className="mb-1 flex flex-wrap items-center gap-2">
                            <Badge variant="neutral">This is your page</Badge>
                            {/* What everybody else sees, which is why there is a
                                way to change it right here: the page is the
                                preview and Account is where it is written. */}
                            <Button asChild size="xs" variant="outline">
                                <Link href="/account">
                                    <Pencil className="size-3 shrink-0" />
                                    Edit
                                </Link>
                            </Button>
                        </span>
                    ) : null}
                </div>

                <div className="flex flex-col gap-0.5">
                    <h1 className="flex flex-wrap items-baseline gap-2 text-lg font-semibold leading-tight tracking-tight">
                        {profile.name}
                        {/* Beside the name, because that is what it is about -
                            and only when they have said. */}
                        {profile.pronouns ? (
                            <span className="text-muted-foreground text-sm font-normal">
                                {profile.pronouns}
                            </span>
                        ) : null}
                    </h1>
                    {profile.fullName && profile.fullName !== profile.name ? (
                        <p className="text-muted-foreground text-sm">{profile.fullName}</p>
                    ) : null}
                    <p className="text-muted-foreground flex items-center gap-1 text-sm">
                        <AtSign className="size-3.5 shrink-0" />
                        {profile.username}
                    </p>
                    {profile.headline ? (
                        <p className="mt-1 text-sm text-foreground/90">{profile.headline}</p>
                    ) : null}
                </div>

                {!own && signedIn ? (
                    <ProfileActions personId={profile.id} name={profile.name} standing={profile.standing} />
                ) : null}

                {profile.mutual ? (
                    <MutualPanel friends={profile.mutual.friends} spaces={profile.mutual.spaces} />
                ) : null}

                {profile.follows ? (
                    <FollowLists
                        personId={profile.id}
                        name={profile.name}
                        followers={profile.follows.followers}
                        following={profile.follows.following}
                    />
                ) : null}

                {profile.description ? (
                    <p className="text-sm leading-relaxed text-foreground/90">{profile.description}</p>
                ) : null}

                {profile.organizations.length > 0 || profile.companies.length > 0 ? (
                    <div className="flex flex-col gap-2 border-t border-border pt-4">
                        {profile.organizations.map((org) => (
                            <Link
                                key={org.id}
                                // Its own page, not the screen that runs it: a
                                // reader following this may not be on its roster
                                // at all, and the management screen would turn
                                // them away from a name they were only reading.
                                href={`/o/${org.slug}`}
                                className="flex items-center gap-2 text-sm hover:underline"
                            >
                                {/* Its own mark, the way an organization is drawn
                                    everywhere else here - a row of identical grey
                                    outlines is a row nobody scans. */}
                                <OrgAvatar org={org} size={20} />
                                {org.name}
                                <BadgeCheck
                                    className="text-primary size-3.5 shrink-0"
                                    aria-label="An organization on this Polaris"
                                />
                            </Link>
                        ))}
                        {profile.companies.map((company) => (
                            <p
                                key={company}
                                className="text-muted-foreground flex items-center gap-2 text-sm"
                                // Said rather than implied: the tick above means
                                // Polaris holds the roster, and its absence has to
                                // mean something legible.
                                title="Typed by them. Polaris knows nothing about it."
                            >
                                <span className="flex size-5 shrink-0 items-center justify-center">
                                    <Building2 className="size-3.5 shrink-0" />
                                </span>
                                {company}
                            </p>
                        ))}
                    </div>
                ) : null}

                {profile.links.length > 0 ? (
                    <div className="flex flex-col gap-1.5 border-t border-border pt-4">
                        {profile.links.map((link) => (
                            <a
                                key={link.url}
                                href={link.url}
                                target="_blank"
                                // Somebody else's address, opened from a page
                                // anybody can publish: the tab it opens gets no
                                // handle on this one, and no referrer goes with
                                // it.
                                rel="noreferrer noopener nofollow"
                                className="text-muted-foreground flex items-center gap-2 text-sm hover:text-foreground"
                            >
                                <LinkIcon className="size-3.5 shrink-0" />
                                <span className="min-w-0 truncate" title={link.url}>
                                    {linkLabel(link)}
                                </span>
                            </a>
                        ))}
                    </div>
                ) : null}

                <div className="text-muted-foreground flex flex-col gap-1.5 border-t border-border pt-4 text-sm">
                    {profile.email ? (
                        <a
                            href={`mailto:${profile.email}`}
                            className="flex items-center gap-1.5 hover:text-foreground"
                        >
                            <Mail className="size-3.5 shrink-0" />
                            {profile.email}
                        </a>
                    ) : null}
                    <p className="flex items-center gap-1.5">
                        <CalendarDays className="size-3.5 shrink-0" />
                        Here since {format.date(profile.joinedAt)}
                    </p>
                </div>
            </CardBody>
        </Card>
    );
}
