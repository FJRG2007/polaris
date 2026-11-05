"use client";

/**
 * The band across the top of somebody's profile.
 *
 * Two things in one, and only one of them is usually a picture: the banner an
 * account uploaded, over a colour taken from its face. The colour is not a
 * placeholder waiting to be replaced - it is what almost every profile will
 * show, because almost nobody uploads a banner, and a profile that looked
 * half-finished for everybody except the three people who did would be a worse
 * screen than one with no banner at all.
 *
 * The picture is simply drawn on top. An account without one is answered with a
 * transparent pixel by the route, exactly as a face without a photo is, so the
 * colour shows through and nothing here has to ask which case it is in first.
 *
 * A colour somebody actually chose outranks the one taken from their face. That
 * is the whole of the appearance panel as far as this component is concerned:
 * the derived colour was always a good guess at what they would have picked, and
 * it stops being interesting the moment they pick.
 */

import { cn } from "@polaris/ui";
import { useEffect, useState } from "react";
import { bannerUrl, orgBannerUrl } from "@/lib/avatar-url";
import { tintFor } from "@polaris/core";
import { accentGradient, useAccent, type AccentSubject } from "@/lib/profile-accent";
import { fillCss, readFill, type BannerFill } from "@polaris/core";
import { useProfileStyle } from "@/components/profile-style-store";

/**
 * What each band last looked like, kept for the life of the page.
 *
 * A band is drawn again from nothing whenever whatever holds it is - a card a
 * menu opened over, a panel that came back - and the colour under it used to
 * start again from what a new mount knows: no answer from the appearance store
 * yet, so the colour from their face, then the one they chose a moment later.
 * That was the flash. The last colour this page already drew for them stands in
 * until the store answers, and a picture that already failed is not asked for
 * again only to fail a second time.
 */
const drawnFill = new Map<string, BannerFill | null>();
const failedPictures = new Set<string>();

/** Forget what the page kept - for tests, which start every case clean. */
export function resetProfileBannerMemory(): void {
    drawnFill.clear();
    failedPictures.clear();
}

export function ProfileBanner({
    person,
    kind = "user",
    fill,
    className
}: {
    person: { readonly id: string; readonly name: string };
    /**
     * Whose page this band is across.
     *
     * An organization gets the same band, from its own two pictures: its mark
     * stands where a face does and its banner where a person's does. One
     * component rather than two, because a company page that looked like a
     * different product from a person page is exactly the drift this repeats
     * everywhere else to avoid.
     */
    kind?: AccentSubject;
    /**
     * The background they chose, when whoever is drawing this already knows it.
     *
     * For the public profile page, which is rendered for readers who may not be
     * signed in at all: there is no store above that page to ask, so the server
     * that already read the profile hands the colour down with it.
     */
    fill?: BannerFill | string | null;
    className?: string;
}) {
    const accent = useAccent(person.id, kind);
    // An organization has no appearance of its own to wear; asking would be a
    // request per company card for a row that cannot exist.
    const stored = useProfileStyle(kind === "org" || fill !== undefined ? null : person.id);
    const key = `${kind}:${person.id}`;
    const given = fill === undefined ? undefined : typeof fill === "string" ? readFill(fill) : fill;
    // Null from the store is "not known yet", not "none": a plain profile comes
    // back as a style whose banner is null, which is an answer and replaces what
    // was kept.
    const known = given !== undefined ? given : stored ? (stored.banner ?? null) : undefined;
    const chosen = known !== undefined ? known : (drawnFill.get(key) ?? null);
    useEffect(() => {
        if (known !== undefined) drawnFill.set(key, known);
    }, [key, known]);
    // A face with no colour in it - initials, a black and white photograph - is
    // still that person's colour: the tint their initials are drawn on is
    // already stable per account and already what everybody has learnt to
    // recognise them by.
    const background = chosen
        ? fillCss(chosen)
        : accent
          ? accentGradient(accent)
          : tintFor(person.id);
    const src = kind === "org" ? orgBannerUrl(person.id) : bannerUrl(person.id);
    const [failed, setFailed] = useState(() => failedPictures.has(src));

    return (
        <div className={cn("relative w-full overflow-hidden", className)} style={{ background }}>
            {!failed && (
                // eslint-disable-next-line @next/next/no-img-element -- one picture per profile, no loader wanted
                <img
                    src={src}
                    alt=""
                    onError={() => {
                        failedPictures.add(src);
                        setFailed(true);
                    }}
                    className="absolute inset-0 size-full object-cover"
                />
            )}
        </div>
    );
}
