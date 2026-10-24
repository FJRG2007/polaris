/**
 * What a TikTok video page says about its video, to a fetch that is not a
 * browser.
 *
 * TikTok's oEmbed used to answer with the caption, the account and the cover.
 * It now answers with the player and nothing else, and the page
 * still has no `og:` tags - so a TikTok came back as a card with no picture and
 * no name. The page does carry the whole video as JSON, in the script it
 * rehydrates from (`__UNIVERSAL_DATA_FOR_REHYDRATION__`), and that is read here.
 *
 * Pure, so it can be asserted against a saved page. The JSON is untrusted: it
 * is parsed, narrowed by a schema to the four strings a card uses, and those are
 * only ever text and a picture address checked by the caller.
 */

import { z } from "zod";

const MARKER = 'id="__UNIVERSAL_DATA_FOR_REHYDRATION__"';

const Page = z.object({
    __DEFAULT_SCOPE__: z.object({
        "webapp.video-detail": z.object({
            itemInfo: z.object({
                itemStruct: z.object({
                    desc: z.string().optional(),
                    author: z
                        .object({
                            uniqueId: z.string().optional(),
                            nickname: z.string().optional()
                        })
                        .optional(),
                    video: z
                        .object({
                            cover: z.string().optional(),
                            originCover: z.string().optional()
                        })
                        .optional()
                })
            })
        })
    })
});

export interface TikTokVideo {
    /** The caption, which may be empty: a video posted without one. */
    readonly caption: string;
    /** The account's display name, or its handle when it has none. */
    readonly author: string;
    /** The cover, a signed address that expires - see `previewImage`. */
    readonly cover: string | null;
}

/** The video a TikTok page is about, or null when the page carries none. */
export function tiktokVideoOf(html: string): TikTokVideo | null {
    const at = html.indexOf(MARKER);
    if (at === -1) return null;
    const start = html.indexOf(">", at);
    const end = start === -1 ? -1 : html.indexOf("</script>", start);
    if (end === -1) return null;

    let data: unknown;
    try {
        data = JSON.parse(html.slice(start + 1, end));
    } catch {
        return null;
    }
    const page = Page.safeParse(data);
    if (!page.success) return null;

    const item = page.data.__DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct;
    const author = item.author?.nickname?.trim() || item.author?.uniqueId?.trim() || "";
    const cover = item.video?.cover || item.video?.originCover || null;
    const caption = item.desc?.trim() ?? "";
    if (!caption && !author && !cover) return null;
    return { caption, author, cover };
}
