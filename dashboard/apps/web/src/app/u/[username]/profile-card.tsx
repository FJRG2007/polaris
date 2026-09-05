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
import { effectOf, linkLabel, nameStyleOf } from "@polaris/core";
import { frameCss, nameStyleCss, sheenCss } from "@/lib/profile-style-css";
import { usePresence } from "@/components/presence-store";
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
    // Where they are, and the line they are showing. The same two facts the panel
    // beside a direct message draws, from the same store, because they are the
    // same profile - and a page that knew somebody's name but not whether they
    // were at their desk was the one screen in Polaris that did not.
    //
    // Null for a reader with no account: there is no store around a public page,
    // and presence is not published to people who are not signed in.
    const where = usePresence(profile.id);
    // Handed down with the profile rather than asked for: this page is drawn for
    // readers who may not be signed in, and there is no store above it.
    const effect = effectOf(profile.style.effect);
    const frame = effect ? frameCss(effect) : null;
    const sheen = effect ? sheenCss(effect) : null;
    const painted = nameStyleOf(profile.style.nameStyle);

    return (
        <Card className={frame ? "relative overflow-hidden border-2" : "overflow-hidden"} style={frame ?? undefined}>
            {sheen ? (
                // Above the card and below nothing: it crosses the banner and the
                // top of the body, which is what makes it read as light on a
                // surface rather than as a stripe drawn on one thing. It stops
                // for anybody who asked for less motion - the rule in tokens.css
                // covers every animation in the product.
                <span
                    aria-hidden="true"
                    // enigma: not a panel - the band of light an effect walks across the card, sized as a third of it on every screen.
                    className="profile-sheen pointer-events-none absolute inset-y-0 left-0 z-10 w-1/3 skew-x-12"
                    style={sheen}
                />
            ) : null}
            <ProfileBanner person={person} fill={profile.style.banner} className="h-28" />
            <CardBody className="flex flex-col gap-4">
                <div className="-mt-12 flex items-end gap-3">
                    <span className="rounded-full ring-4 ring-card">
                        {/* Initials rather than a photo for a reader they do not
                            show it to. The same rule the rest of Polaris draws
                            them by, answered on the server. */}
                        {/* The dot is handed over rather than looked up, so it
                            still appears on a face drawn as initials: where
                            somebody is has nothing to do with whether they show
                            their photo, and asking through the face would have
                            tied the two together. */}
                        <Avatar
                            person={profile.showsAvatar ? person : { id: null, name: profile.name }}
                            size={72}
                            presence={where?.status}
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
                        <span style={painted ? nameStyleCss(painted) : undefined}>{profile.name}</span>
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

                {/* The line they are showing, and only that. Where they are is
                    already on their face: the dot says it, in the colour it says
                    it in everywhere else, and printing "Online" underneath is the
                    same fact twice - the second one taking a line of the page to
                    tell somebody what the first already told them. The word is
                    still on the dot's own label and tooltip, so a reader who
                    cannot see a colour still gets it.

                    The note is not the same fact. It is what this person chose to
                    say, and nothing else on screen carries it. It is only ever
                    there while they actually are here; see `presence-service`. */}
                {where?.note ? (
                    <p className="w-full whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2 text-xs text-foreground">
                        {where.note}
                    </p>
                ) : null}

                {!own && signedIn ? (
                    <ProfileActions personId={profile.id} name={profile.name} standing={profile.standing} />
                ) : null}

                {profile.mutual ? (
                    <MutualPanel friends={profile.mutual.friends} spaces={profile.mutual.spaces} />
                ) : null}

                <FollowLists
                    personId={profile.id}
                    name={profile.name}
                    followers={profile.follows.followers}
                    following={profile.follows.following}
                    showsNames={profile.follows.showsNames}
                />

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
