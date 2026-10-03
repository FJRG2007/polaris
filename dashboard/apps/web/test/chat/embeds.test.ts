/**
 * Which links Polaris will put a player in for.
 *
 * The rule this is really testing is that the frame's address is *built* from
 * parts that were checked, never rewritten from the string somebody posted. An
 * embed is a page loaded inside Polaris, so "whatever came after the slash" is
 * not an id - it is an address an attacker chose, framed by a site the reader
 * trusts. Every id here has to look like one before anything is returned.
 */

import { describe, expect, it } from "vitest";
import {
    embedFor,
    isShareLink,
    landingOf,
    oembedFor,
    playerAddress,
    playerFailed
} from "../../src/lib/chat/embeds";

/** Every address in a list frames the same player. */
function allFrame(addresses: string[], url: string): void {
    for (const address of addresses) expect(embedFor(address)?.url, address).toBe(url);
}

/** None of the addresses in a list gets a player. */
function noneFrame(addresses: string[]): void {
    for (const address of addresses) expect(embedFor(address), address).toBeNull();
}

describe("YouTube", () => {
    const player = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";

    it("plays a watch link", () => {
        const embed = embedFor("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        expect(embed?.provider).toBe("YouTube");
        expect(embed?.url).toBe(player);
        expect(embed?.shape).toBe("video");
    });

    it("plays every form a video address comes in", () => {
        allFrame(
            [
                "https://youtu.be/dQw4w9WgXcQ",
                "https://youtu.be/dQw4w9WgXcQ?si=abcdef",
                "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share",
                "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM",
                "https://www.youtube.com/embed/dQw4w9WgXcQ",
                "https://www.youtube.com/live/dQw4w9WgXcQ",
                "https://www.youtube.com/v/dQw4w9WgXcQ",
                "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
                "http://youtube.com/watch?v=dQw4w9WgXcQ"
            ],
            player
        );
    });

    it("frames a Short upright", () => {
        const embed = embedFor("https://www.youtube.com/shorts/dQw4w9WgXcQ");
        expect(embed?.url).toBe(player);
        expect(embed?.shape).toBe("portrait");
        expect(embedFor("https://m.youtube.com/shorts/dQw4w9WgXcQ?feature=share")?.shape).toBe(
            "portrait"
        );
    });

    it("keeps the moment a link was posted at, in either spelling", () => {
        // Somebody who links to 1:26 meant 1:26.
        expect(embedFor("https://youtu.be/dQw4w9WgXcQ?t=86s")?.url).toBe(`${player}?start=86`);
        expect(embedFor("https://youtu.be/dQw4w9WgXcQ?t=86")?.url).toBe(`${player}?start=86`);
        expect(embedFor("https://youtu.be/dQw4w9WgXcQ?t=1m26s")?.url).toBe(`${player}?start=86`);
        expect(embedFor("https://youtu.be/dQw4w9WgXcQ?t=1h0m1s")?.url).toBe(`${player}?start=3601`);
        // A time that is not one is dropped, not passed along.
        expect(embedFor("https://youtu.be/dQw4w9WgXcQ?t=soon")?.url).toBe(player);
    });

    it("refuses anything that is not an id", () => {
        // The whole point: what comes after the slash is not trusted to be a
        // video, because the answer is put into a frame's src.
        noneFrame([
            "https://youtu.be/../../evil",
            "https://www.youtube.com/watch?v=x",
            "https://youtu.be/dQw4w9WgXcQ%2F%2Fevil.example",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ'onload='",
            "https://www.youtube.com/@somechannel",
            "https://www.youtube.com/playlist?list=PL123"
        ]);
    });

    it("is not fooled by a hostname that merely ends in one it knows", () => {
        noneFrame([
            "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
            "https://notyoutube.com/watch?v=dQw4w9WgXcQ"
        ]);
    });
});

describe("Vimeo", () => {
    it("plays a numbered video without tracking the session", () => {
        expect(embedFor("https://vimeo.com/76979871")?.url).toBe(
            "https://player.vimeo.com/video/76979871?dnt=1"
        );
    });

    it("finds the video inside a channel, group, album or showcase", () => {
        allFrame(
            [
                "https://vimeo.com/channels/staffpicks/76979871",
                "https://vimeo.com/groups/shortfilms/videos/76979871",
                "https://vimeo.com/album/12345/video/76979871",
                "https://vimeo.com/showcase/12345/video/76979871",
                "https://player.vimeo.com/video/76979871"
            ],
            "https://player.vimeo.com/video/76979871?dnt=1"
        );
    });

    it("keeps an unlisted video's key", () => {
        const url = "https://player.vimeo.com/video/76979871?dnt=1&h=8f3a2b1c0d";
        allFrame(
            [
                "https://vimeo.com/76979871/8f3a2b1c0d",
                "https://player.vimeo.com/video/76979871?h=8f3a2b1c0d"
            ],
            url
        );
        // A key that is not hexadecimal is left out rather than passed through.
        expect(embedFor("https://vimeo.com/76979871/x&y=z")?.url).toBe(
            "https://player.vimeo.com/video/76979871?dnt=1"
        );
    });

    it("refuses one with no video in it", () => {
        // A showcase's own number is not a video.
        noneFrame([
            "https://vimeo.com/channels/staffpicks",
            "https://vimeo.com/showcase/12345",
            "https://vimeo.com/someone"
        ]);
    });
});

describe("Spotify", () => {
    it("plays a track as a strip and an album as a panel", () => {
        const track = embedFor("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT");
        expect(track?.url).toBe("https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT");
        expect(track?.shape).toBe("audio");
        expect(embedFor("https://open.spotify.com/album/4cOdK2wGLETKBW3PvgPWqT")?.shape).toBe(
            "post"
        );
    });

    it("plays every kind, localised or shared", () => {
        for (const kind of ["album", "playlist", "episode", "show", "artist"]) {
            expect(
                embedFor(`https://open.spotify.com/${kind}/4cOdK2wGLETKBW3PvgPWqT?si=abc`)?.url
            ).toBe(`https://open.spotify.com/embed/${kind}/4cOdK2wGLETKBW3PvgPWqT`);
        }
        expect(embedFor("https://open.spotify.com/intl-es/track/4cOdK2wGLETKBW3PvgPWqT")?.url).toBe(
            "https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT"
        );
    });

    it("refuses a kind it does not know", () => {
        noneFrame([
            "https://open.spotify.com/user/4cOdK2wGLETKBW3PvgPWqT",
            "https://open.spotify.com/track/short"
        ]);
    });
});

describe("TikTok", () => {
    const player = "https://www.tiktok.com/player/v1/7232918429372394779";

    it("plays a video upright", () => {
        const embed = embedFor("https://www.tiktok.com/@someone/video/7232918429372394779");
        expect(embed?.provider).toBe("TikTok");
        expect(embed?.url).toBe(player);
        expect(embed?.shape).toBe("portrait");
    });

    it("plays the mobile, shared and embed forms", () => {
        allFrame(
            [
                "https://www.tiktok.com/@some.one_2/video/7232918429372394779?is_from_webapp=1&sender_device=pc",
                "https://m.tiktok.com/v/7232918429372394779.html",
                "https://www.tiktok.com/embed/v2/7232918429372394779",
                "https://www.tiktok.com/embed/7232918429372394779",
                "https://www.tiktok.com/player/v1/7232918429372394779",
                "https://tiktok.com/@someone/video/7232918429372394779",
                // Where a vm./vt. share link lands: the account is left out.
                "https://www.tiktok.com/@/video/7232918429372394779?_r=1&u_code=abc"
            ],
            player
        );
    });

    it("gives a short link, a photo post, a live and a profile the card", () => {
        // A share-button link names nothing until the server has followed it.
        noneFrame([
            "https://vm.tiktok.com/ZMabcdef/",
            "https://vt.tiktok.com/ZSabcdef/",
            "https://www.tiktok.com/t/ZTabcdef/",
            "https://www.tiktok.com/@someone/photo/7232918429372394779",
            "https://www.tiktok.com/@someone/live",
            "https://www.tiktok.com/@someone",
            "https://m.tiktok.com/h5/share/usr/6868799137997210630.html",
            "https://www.tiktok.com/@someone/video/123",
            "https://www.tiktok.com/@someone/video/7232918429372394779abc"
        ]);
    });
});

describe("Instagram", () => {
    it("plays a post and a reel as a post", () => {
        const post = embedFor("https://www.instagram.com/p/CxYz123AbC_/");
        expect(post?.provider).toBe("Instagram");
        expect(post?.url).toBe("https://www.instagram.com/p/CxYz123AbC_/embed/");
        expect(post?.shape).toBe("post");
        expect(embedFor("https://www.instagram.com/reel/CxYz123AbC_/")?.url).toBe(
            "https://www.instagram.com/reel/CxYz123AbC_/embed/"
        );
    });

    it("reads every form a link comes in", () => {
        allFrame(
            [
                "https://www.instagram.com/reels/CxYz123AbC_/",
                "https://instagram.com/reel/CxYz123AbC_?igsh=MWQ1ZGUxMzBkMA==",
                "https://www.instagram.com/someone/reel/CxYz123AbC_/",
                "https://m.instagram.com/reel/CxYz123AbC_/"
            ],
            "https://www.instagram.com/reel/CxYz123AbC_/embed/"
        );
        allFrame(
            [
                "https://www.instagram.com/tv/CxYz123AbC_/",
                "https://www.instagram.com/someone/p/CxYz123AbC_/?img_index=2",
                "https://instagr.am/p/CxYz123AbC_/"
            ],
            "https://www.instagram.com/p/CxYz123AbC_/embed/"
        );
    });

    it("gives a profile, a story and a bad code the card", () => {
        noneFrame([
            "https://www.instagram.com/someone/",
            "https://www.instagram.com/stories/someone/3200000000000000000/",
            "https://www.instagram.com/p/a%22b/",
            "https://www.instagram.com/p/",
            // A sound's page, whose "code" is the word audio.
            "https://www.instagram.com/reels/audio/1234567890123/",
            "https://www.instagram.com/a/b/p/CxYz123AbC_/"
        ]);
    });
});

describe("X", () => {
    const player = "https://platform.twitter.com/embed/Tweet.html?id=1700000000000000000&dnt=true";

    it("plays a post on either name", () => {
        const embed = embedFor("https://x.com/someone/status/1700000000000000000");
        expect(embed?.provider).toBe("X");
        expect(embed?.url).toBe(player);
        expect(embed?.shape).toBe("post");
        allFrame(
            [
                "https://twitter.com/someone/status/1700000000000000000?s=20",
                "https://mobile.twitter.com/someone/status/1700000000000000000",
                "https://mobile.x.com/someone/status/1700000000000000000",
                "https://www.x.com/someone/status/1700000000000000000/photo/1",
                "https://x.com/i/web/status/1700000000000000000",
                "https://x.com/i/status/1700000000000000000",
                "https://twitter.com/someone/statuses/1700000000000000000"
            ],
            player
        );
    });

    it("gives a profile and a bad id the card", () => {
        noneFrame([
            "https://x.com/someone",
            "https://x.com/someone/status/abc",
            "https://x.com/someone/status/"
        ]);
    });
});

describe("Twitch", () => {
    it("plays a channel live", () => {
        const embed = embedFor("https://www.twitch.tv/SomeStreamer");
        expect(embed?.provider).toBe("Twitch");
        expect(embed?.url).toBe("https://player.twitch.tv/?channel=somestreamer");
        expect(embed?.needsParent).toBe(true);
        expect(embed?.shape).toBe("stream");
        expect(embedFor("https://m.twitch.tv/somestreamer")?.url).toBe(
            "https://player.twitch.tv/?channel=somestreamer"
        );
    });

    it("plays a past broadcast", () => {
        allFrame(
            [
                "https://www.twitch.tv/videos/1234567890",
                "https://m.twitch.tv/videos/1234567890?t=1h2m",
                "https://www.twitch.tv/somestreamer/video/1234567890"
            ],
            "https://player.twitch.tv/?video=v1234567890"
        );
    });

    it("plays a clip, on either host", () => {
        allFrame(
            [
                "https://clips.twitch.tv/FunnyClipSlug-AbC123_xyz",
                "https://www.twitch.tv/somestreamer/clip/FunnyClipSlug-AbC123_xyz",
                "https://m.twitch.tv/somestreamer/clip/FunnyClipSlug-AbC123_xyz?filter=clips",
                "https://clips.twitch.tv/embed?clip=FunnyClipSlug-AbC123_xyz"
            ],
            "https://clips.twitch.tv/embed?clip=FunnyClipSlug-AbC123_xyz"
        );
    });

    it("does not take Twitch's own pages for a channel", () => {
        noneFrame([
            "https://www.twitch.tv/directory",
            "https://www.twitch.tv/settings",
            "https://www.twitch.tv/somestreamer/about",
            "https://www.twitch.tv/videos/abc",
            "https://www.twitch.tv/a",
            "https://clips.twitch.tv/embed?clip=a%26b"
        ]);
    });
});

describe("SoundCloud", () => {
    it("plays a track as a strip", () => {
        const embed = embedFor("https://soundcloud.com/some-artist/a-track?utm_source=clipboard");
        expect(embed?.provider).toBe("SoundCloud");
        expect(embed?.url).toBe(
            "https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fsome-artist%2Fa-track&visual=false&show_teaser=false"
        );
        expect(embed?.shape).toBe("audio");
        expect(embedFor("https://m.soundcloud.com/some-artist/a-track")?.url).toBe(embed?.url);
    });

    it("plays a playlist as a panel, and a private link with its key", () => {
        const set = embedFor("https://soundcloud.com/some-artist/sets/an-album");
        expect(set?.shape).toBe("post");
        expect(set?.url).toContain(
            encodeURIComponent("https://soundcloud.com/some-artist/sets/an-album")
        );
        expect(embedFor("https://soundcloud.com/some-artist/a-track/s-AbCd1234")?.url).toContain(
            encodeURIComponent("https://soundcloud.com/some-artist/a-track/s-AbCd1234")
        );
    });

    it("gives a profile, a tab, SoundCloud's own pages and a short link the card", () => {
        noneFrame([
            "https://soundcloud.com/some-artist",
            "https://soundcloud.com/some-artist/likes",
            "https://soundcloud.com/some-artist/sets",
            "https://soundcloud.com/discover/sets/charts-top",
            "https://soundcloud.com/some-artist/a-track/not-a-key",
            "https://on.soundcloud.com/AbCdEf"
        ]);
    });
});

describe("Reddit", () => {
    const player = "https://embed.reddit.com/r/programming/comments/1abc2de/?embed=true";

    it("plays a post from any of Reddit's front doors", () => {
        const embed = embedFor("https://www.reddit.com/r/programming/comments/1abc2de/a_title/");
        expect(embed?.provider).toBe("Reddit");
        expect(embed?.url).toBe(player);
        expect(embed?.shape).toBe("post");
        allFrame(
            [
                "https://old.reddit.com/r/programming/comments/1abc2de/a_title/",
                "https://new.reddit.com/r/programming/comments/1abc2de",
                "https://np.reddit.com/r/programming/comments/1abc2de/a_title/",
                "https://m.reddit.com/r/programming/comments/1abc2de/a_title/?utm_source=share",
                "https://www.reddit.com/r/programming/comments/1abc2de/a_title/kx9y8z7/"
            ],
            player
        );
    });

    it("gives a subreddit, a short link and a share link the card", () => {
        noneFrame([
            "https://www.reddit.com/r/programming/",
            "https://redd.it/1abc2de",
            "https://www.reddit.com/comments/1abc2de",
            "https://www.reddit.com/r/programming/s/AbCdEf123",
            "https://www.reddit.com/r/programming/comments/NOT_AN_ID/",
            "https://www.reddit.com/r/a/comments/1abc2de/"
        ]);
    });
});

describe("Streamable and Dailymotion", () => {
    it("plays a Streamable video from its page or its player", () => {
        allFrame(
            ["https://streamable.com/abc12x", "https://streamable.com/e/abc12x"],
            "https://streamable.com/e/abc12x"
        );
        noneFrame(["https://streamable.com/login", "https://streamable.com/a/b/c"]);
    });

    it("plays a Dailymotion video from every form", () => {
        allFrame(
            [
                "https://www.dailymotion.com/video/x8abc12",
                "https://www.dailymotion.com/video/x8abc12_some-title",
                "https://dai.ly/x8abc12",
                "https://www.dailymotion.com/embed/video/x8abc12",
                "https://geo.dailymotion.com/player.html?video=x8abc12",
                "https://geo.dailymotion.com/player/xabc1.html?video=x8abc12"
            ],
            "https://www.dailymotion.com/embed/video/x8abc12"
        );
        noneFrame(["https://www.dailymotion.com/someone", "https://dai.ly/y8abc12"]);
    });
});

describe("Kick", () => {
    it("plays a channel live", () => {
        const embed = embedFor("https://kick.com/SomeStreamer");
        expect(embed?.provider).toBe("Kick");
        expect(embed?.url).toBe("https://player.kick.com/somestreamer");
        expect(embed?.shape).toBe("video");
        allFrame(
            ["https://www.kick.com/somestreamer", "https://kick.com/somestreamer?ref=x"],
            "https://player.kick.com/somestreamer"
        );
    });

    it("gives Kick's own pages, a past broadcast and a clip the card", () => {
        // Kick documents a player for a live channel only.
        noneFrame([
            "https://kick.com/",
            "https://kick.com/browse",
            "https://kick.com/categories",
            "https://kick.com/somestreamer/videos/0b2b5a8e-0000-4000-8000-000000000000",
            "https://kick.com/somestreamer/clips/clip_01ABCDEF",
            "https://kick.com/a",
            "https://kick.com.evil.example/somestreamer"
        ]);
    });
});

describe("share-button short links", () => {
    it("recognises the shape each site hands out", () => {
        for (const address of [
            "https://vm.tiktok.com/ZMJxrLUGr/",
            "https://vt.tiktok.com/ZSmhQWGRu/",
            "https://www.tiktok.com/t/ZTRabc123/",
            "https://on.soundcloud.com/AbCdEf123",
            "https://spotify.link/AbCdEf123",
            "https://redd.it/1abc2de",
            "https://www.reddit.com/r/videos/s/AbCdEf123"
        ]) {
            expect(isShareLink(address), address).toBe(true);
        }
    });

    it("follows nothing else, not even another path on the same host", () => {
        for (const address of [
            "https://vm.tiktok.com/",
            "https://vm.tiktok.com/a/b/c",
            "https://vm.tiktok.com/ZM<script>/",
            "https://www.tiktok.com/@someone/video/7232918429372394779",
            "https://www.tiktok.com/t/",
            "https://www.reddit.com/r/videos/comments/1abc2de/",
            "https://www.reddit.com/r/videos/s/",
            "https://vm.tiktok.com.evil.example/ZMabcdef/",
            "https://example.com/ZMabcdef",
            "ftp://vm.tiktok.com/ZMabcdef/",
            "not a url"
        ]) {
            expect(isShareLink(address), address).toBe(false);
        }
    });

    it("keeps where one led without the sharer's query", () => {
        expect(
            landingOf(
                "https://www.tiktok.com/@/video/7606895926577319189?_r=1&_d=secCgY&u_code=f1dd&share_item_id=7606895926577319189#x"
            )
        ).toBe("https://www.tiktok.com/@/video/7606895926577319189");
        expect(landingOf("javascript:alert(1)")).toBeNull();
    });
});

describe("everything else", () => {
    it("has no player, and gets the ordinary card", () => {
        noneFrame([
            "https://example.com/article",
            "not a url at all",
            // A scheme that is not the web is not something to frame.
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "ftp://youtube.com/watch?v=dQw4w9WgXcQ"
        ]);
    });
});

describe("pressing play", () => {
    it("starts the player it builds, each in its own spelling", () => {
        // Pressing play in Polaris and then again inside somebody else's player
        // is one press too many.
        const youtube = embedFor("https://youtu.be/dQw4w9WgXcQ")!;
        expect(playerAddress(youtube, "polaris.example")).toBe(
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1"
        );
        const soundcloud = embedFor("https://soundcloud.com/some-artist/a-track")!;
        expect(playerAddress(soundcloud, "polaris.example")).toMatch(/&auto_play=true$/);
    });

    it("keeps the moment the link was posted at", () => {
        const embed = embedFor("https://youtu.be/dQw4w9WgXcQ?t=42")!;
        expect(playerAddress(embed, "polaris.example")).toBe(
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42&autoplay=1"
        );
    });

    it("adds nothing for a player with no start parameter", () => {
        const embed = embedFor("https://x.com/someone/status/1700000000000000000")!;
        expect(playerAddress(embed, "polaris.example")).toBe(embed.url);
    });

    it("tells Twitch which site it is on, and only a hostname", () => {
        const embed = embedFor("https://www.twitch.tv/somestreamer")!;
        expect(playerAddress(embed, "Polaris.Example")).toBe(
            "https://player.twitch.tv/?channel=somestreamer&autoplay=true&parent=polaris.example"
        );
        // Anything that is not a hostname is not put in the address.
        expect(playerAddress(embed, "evil.example&channel=other")).toBe(
            "https://player.twitch.tv/?channel=somestreamer&autoplay=true"
        );
    });

    it("does not tell anybody else", () => {
        const embed = embedFor("https://vimeo.com/76979871")!;
        expect(playerAddress(embed, "polaris.example")).not.toContain("parent=");
    });
});

describe("asking a site about its link", () => {
    it("asks the sites that answer without a key", () => {
        const cases: Array<[string, string]> = [
            ["https://youtu.be/dQw4w9WgXcQ", "https://www.youtube.com/oembed"],
            ["https://vimeo.com/76979871", "https://vimeo.com/api/oembed.json"],
            [
                "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
                "https://open.spotify.com/oembed"
            ],
            [
                "https://www.tiktok.com/@someone/video/7232918429372394779",
                "https://www.tiktok.com/oembed"
            ],
            ["https://soundcloud.com/some-artist/a-track", "https://soundcloud.com/oembed"],
            [
                "https://old.reddit.com/r/programming/comments/1abc2de/",
                "https://www.reddit.com/oembed"
            ],
            ["https://streamable.com/abc12x", "https://api.streamable.com/oembed.json"],
            [
                "https://www.dailymotion.com/video/x8abc12",
                "https://www.dailymotion.com/services/oembed"
            ]
        ];
        for (const [address, endpoint] of cases) {
            const asked = new URL(oembedFor(address)!);
            expect(`${asked.origin}${asked.pathname}`, address).toBe(endpoint);
            expect(asked.searchParams.get("url")).toBe(new URL(address).href);
        }
    });

    it("asks YouTube about the watch page for a no-cookie player link", () => {
        const asked = new URL(
            oembedFor("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=10")!
        );
        expect(`${asked.origin}${asked.pathname}`).toBe("https://www.youtube.com/oembed");
        expect(asked.searchParams.get("url")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    });

    it("asks Dailymotion about the video's page, whichever form was posted", () => {
        // The newer player's address is not a page, and oEmbed has nothing to
        // say about it; the page it plays does.
        for (const address of [
            "https://geo.dailymotion.com/player.html?video=x8abc12",
            "https://dai.ly/x8abc12",
            "https://www.dailymotion.com/embed/video/x8abc12"
        ]) {
            const asked = new URL(oembedFor(address)!);
            expect(asked.origin, address).toBe("https://www.dailymotion.com");
            expect(asked.searchParams.get("url"), address).toBe(
                "https://www.dailymotion.com/video/x8abc12"
            );
        }
    });

    it("asks nobody about a site that needs a key or is not one it knows", () => {
        expect(oembedFor("https://www.instagram.com/p/CxYz123AbC_/")).toBeNull();
        expect(oembedFor("https://www.twitch.tv/somestreamer")).toBeNull();
        expect(oembedFor("https://example.com/")).toBeNull();
        expect(oembedFor("https://reddit.com.evil.example/r/x")).toBeNull();
        expect(oembedFor("https://notyoutube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    });
});

describe("a player saying it could not play", () => {
    const tiktok = embedFor("https://www.tiktok.com/@someone/video/7232918429372394779")!;
    const failed = (errorCode: unknown) => ({
        type: "onPlayerError",
        value: { errorCode, errorType: "PLAYBACK_ERROR" },
        "x-tiktok-player": true
    });

    it("is TikTok's failure to fetch or play the video, from TikTok's frame", () => {
        // What TikTok's player posted, word for word, on a first play in a
        // browser with no TikTok cookie yet (ERR_BLOCKED_BY_ORB on the video).
        expect(playerFailed(tiktok, "https://www.tiktok.com", failed(3001))).toBe(true);
        expect(playerFailed(tiktok, "https://www.tiktok.com", failed(2001))).toBe(true);
    });

    it("is not a failure another load cannot fix", () => {
        expect(playerFailed(tiktok, "https://www.tiktok.com", failed(1001))).toBe(false);
        expect(playerFailed(tiktok, "https://www.tiktok.com", failed(3002))).toBe(false);
    });

    it("is nothing from anywhere else, or shaped any other way", () => {
        expect(playerFailed(tiktok, "https://evil.example", failed(3001))).toBe(false);
        expect(playerFailed(tiktok, "https://tiktok.com", failed(3001))).toBe(false);
        expect(playerFailed(tiktok, "https://www.tiktok.com", "onPlayerError")).toBe(false);
        expect(playerFailed(tiktok, "https://www.tiktok.com", null)).toBe(false);
        expect(playerFailed(tiktok, "https://www.tiktok.com", failed("3001"))).toBe(false);
        expect(
            playerFailed(tiktok, "https://www.tiktok.com", {
                ...failed(3001),
                "x-tiktok-player": false
            })
        ).toBe(false);
        expect(
            playerFailed(tiktok, "https://www.tiktok.com", {
                ...failed(3001),
                type: "onStateChange"
            })
        ).toBe(false);
        expect(
            playerFailed(tiktok, "https://www.tiktok.com", { ...failed(3001), value: null })
        ).toBe(false);
    });

    it("is only ever TikTok's - no other player is reloaded", () => {
        const youtube = embedFor("https://youtu.be/dQw4w9WgXcQ")!;
        expect(playerFailed(youtube, "https://www.youtube-nocookie.com", failed(3001))).toBe(false);
    });
});
