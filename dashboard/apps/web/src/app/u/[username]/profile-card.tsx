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
 * organization on this Polaris carries a tick: it is a roster Polaris holds and
 * the person is on it, which is the only thing Polaris can actually vouch for. A
 * typed line carries none - it is a sentence somebody wrote about themselves,
 * and drawing it identically would make Polaris appear to confirm it.
 */

import { Avatar } from "@/components/avatar";
import { Badge, Card, CardBody } from "@polaris/ui";
import type { PublicProfile } from "@/lib/profile-service";
import { ProfileBanner } from "@/components/profile-banner";
import { useDisplayFormat } from "@/components/display-format";
import { AtSign, BadgeCheck, Building2, CalendarDays, Mail } from "lucide-react";

export function ProfileCard({ profile, own }: { profile: PublicProfile; own: boolean }) {
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
                        <Badge variant="neutral" className="mb-1">
                            This is your page
                        </Badge>
                    ) : null}
                </div>

                <div className="flex flex-col gap-0.5">
                    <h1 className="text-lg font-semibold leading-tight tracking-tight">{profile.name}</h1>
                    {profile.fullName && profile.fullName !== profile.name ? (
                        <p className="text-muted-foreground text-sm">{profile.fullName}</p>
                    ) : null}
                    <p className="text-muted-foreground flex items-center gap-1 text-sm">
                        <AtSign className="size-3.5 shrink-0" />
                        {profile.username}
                    </p>
                </div>

                {profile.description ? (
                    <p className="text-sm leading-relaxed text-foreground/90">{profile.description}</p>
                ) : null}

                {profile.organizations.length > 0 || profile.company ? (
                    <div className="flex flex-col gap-1.5 border-t border-border pt-4">
                        {profile.organizations.map((org) => (
                            <p key={org.id} className="flex items-center gap-1.5 text-sm">
                                <Building2 className="size-3.5 shrink-0 text-muted-foreground" />
                                {org.name}
                                <BadgeCheck
                                    className="size-3.5 shrink-0 text-primary"
                                    aria-label="An organization on this Polaris"
                                />
                            </p>
                        ))}
                        {profile.company ? (
                            <p
                                className="text-muted-foreground flex items-center gap-1.5 text-sm"
                                // Said rather than implied: the tick above means
                                // Polaris holds the roster, and its absence has to
                                // mean something legible.
                                title="Typed by them. Polaris knows nothing about it."
                            >
                                <Building2 className="size-3.5 shrink-0" />
                                {profile.company}
                            </p>
                        ) : null}
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
