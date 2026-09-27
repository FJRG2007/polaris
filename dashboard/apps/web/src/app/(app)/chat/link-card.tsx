"use client";

/**
 * What a link in a message turned out to be: a card that describes it, or - for
 * the sites in `lib/chat/embeds.ts` - a card with a player in it.
 *
 * Its own file so the choice between the two can be rendered and asserted on
 * without the whole message list around it.
 */

import { cn } from "@polaris/ui";
import { Play } from "lucide-react";
import { useEffect, useState } from "react";
import { usableAccent } from "@/lib/chat/accent";
import type { ChatMessageView } from "@/lib/chat/messages";
import { embedFor, playerAddress, type EmbedShape } from "@/lib/chat/embeds";

/**
 * The room each kind of player takes, the same before and after play is
 * pressed so the conversation does not jump when the frame arrives.
 *
 * An upright video is capped in width rather than stretched to the card: a
 * TikTok at the card's full width would be taller than a phone's screen. A post
 * has no natural ratio - its height is the post's - so it gets a fixed panel the
 * frame scrolls inside, like the site's own embed would at that size.
 */
const SHAPES: Readonly<Record<EmbedShape, string>> = {
    video: "aspect-video w-full",
    portrait: "aspect-[9/16] w-full max-w-[20rem]",
    post: "h-[32rem] max-h-[70vh] w-full",
    audio: "h-[166px] w-full"
};

/**
 * What a link in a message turned out to be.
 *
 * Under the message rather than replacing it: the sentence somebody wrote about
 * the link is usually the point, and a card that swallowed it would lose that.
 *
 * The picture comes from Polaris rather than from the site, so scrolling past a
 * card does not announce the reader to whoever runs the page.
 */
export function LinkCard({ preview }: { preview: NonNullable<ChatMessageView["preview"]> }) {
    const [playing, setPlaying] = useState(false);

    // Twitch plays only in a page served over HTTPS (or on localhost), which is
    // exactly what the browser calls a secure context. Polaris reached by a LAN
    // address over plain HTTP gets the card for a Twitch link rather than a
    // play button whose player could only refuse. Read after mounting, since
    // the server cannot know how the page was reached.
    const [secure, setSecure] = useState(true);
    useEffect(() => setSecure(window.isSecureContext ?? true), []);
    const playable = embedFor(preview.url);
    const embed = playable && (!playable.needsParent || secure) ? playable : null;

    // The edge takes the site's own colour when it has published a usable one,
    // so a video reads as YouTube at a glance. Everything else keeps Polaris'
    // accent.
    const accent = usableAccent(preview.accent);
    const edge = accent ? { borderLeftColor: accent } : undefined;

    const details = (
        <span className="flex min-w-0 flex-col gap-0.5">
            {(preview.siteName || preview.author) && (
                <span className="truncate text-[0.6875rem] text-muted-foreground">
                    {[preview.siteName, preview.author].filter(Boolean).join(" - ")}
                </span>
            )}
            <span className="truncate text-xs font-medium text-foreground">
                {preview.title || preview.url}
            </span>
            {/* A video's own description is a wall of links and sponsorships,
                and the card already says the three things somebody wants: the
                site, who made it, and what it is called. */}
            {preview.description && !embed && (
                <span className="line-clamp-2 text-xs text-muted-foreground">
                    {preview.description}
                </span>
            )}
        </span>
    );

    // Something Polaris can play. The frame is built only once somebody presses
    // play: until then nothing has been requested from the site, which is the
    // same promise the picture already keeps.
    if (embed) {
        return (
            <div
                style={edge}
                className="mt-1 flex max-w-lg flex-col gap-2 rounded-md border border-border border-l-2 border-l-primary bg-card p-2"
            >
                <a
                    href={preview.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="min-w-0 no-underline"
                >
                    {details}
                </a>
                {playing ? (
                    <iframe
                        // Starts on its own. Pressing play in Polaris and then
                        // having to press play again in somebody else's player
                        // is one press too many, and the press that has already
                        // happened is what the site needs to allow the sound.
                        // The hostname is for Twitch, which will not play in a
                        // page that has not named itself.
                        src={playerAddress(embed, window.location.hostname)}
                        title={preview.title || embed.provider}
                        // What a player needs and nothing more: its own script
                        // and storage (which is its own origin, not Polaris'),
                        // a new tab when somebody clicks through to the site,
                        // and casting. No forms, no navigating Polaris' tab, no
                        // downloads.
                        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
                        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                        allowFullScreen
                        referrerPolicy="strict-origin-when-cross-origin"
                        className={cn("rounded border-0 bg-black", SHAPES[embed.shape])}
                    />
                ) : (
                    <button
                        type="button"
                        onClick={() => setPlaying(true)}
                        aria-label={`Play this on ${embed.provider}, here`}
                        title={`Plays here. ${embed.provider} sees you once you press it.`}
                        className={cn(
                            "group/play relative overflow-hidden rounded bg-muted transition-colors hover:bg-card-hover",
                            SHAPES[embed.shape]
                        )}
                    >
                        {preview.hasImage && (
                            // eslint-disable-next-line @next/next/no-img-element -- fetched through Polaris, no loader wanted
                            <img
                                src={`/api/chat/links/${preview.id}/image`}
                                alt=""
                                loading="lazy"
                                className="size-full object-cover"
                            />
                        )}
                        <span className="absolute inset-0 flex items-center justify-center">
                            <span className="flex size-11 items-center justify-center rounded-full bg-background/80 text-foreground transition-transform group-hover/play:scale-110">
                                <Play className="size-5 fill-current" />
                            </span>
                        </span>
                    </button>
                )}
            </div>
        );
    }

    return (
        <a
            href={preview.url}
            style={edge}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1 flex max-w-lg gap-3 rounded-md border border-border border-l-2 border-l-primary bg-card p-2 transition-colors hover:bg-card-hover"
        >
            {preview.hasImage && (
                // eslint-disable-next-line @next/next/no-img-element -- one thumbnail, fetched through Polaris, no loader wanted
                <img
                    src={`/api/chat/links/${preview.id}/image`}
                    alt=""
                    loading="lazy"
                    className="size-16 shrink-0 rounded object-cover"
                />
            )}
            {details}
        </a>
    );
}
