/**
 * /robots.txt - every crawler may fetch everything, on purpose, and there is no
 * sitemap.
 *
 * What keeps Polaris out of search results is the `X-Robots-Tag: noindex` that
 * next.config sends on every response (and the root layout's robots metadata),
 * not this file. Google's own guidance is that robots.txt is not a way to keep a
 * page out of the index: a URL it blocks can still be indexed from links that
 * point at it, without its content, and a crawler that may not fetch a page
 * never sees the noindex that would have removed it
 * (developers.google.com/search/docs/crawling-indexing/block-indexing,
 * .../robots/intro). A Disallow here would therefore make a leaked share link
 * MORE likely to appear in results, not less - the failure behind the shared
 * chats of other assistants that turned up in search in 2025.
 */

import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
    return { rules: [{ userAgent: "*", allow: "/" }] };
}
