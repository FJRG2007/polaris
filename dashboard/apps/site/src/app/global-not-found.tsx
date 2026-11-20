/**
 * Any address the export has no page for, in the site's own frame.
 *
 * GitHub Pages serves this one file for every missing address in either
 * language, so it is English, and a reader who was on a Spanish address - or,
 * on an address with no language in it, whose browser is in Spanish - is sent
 * to the Spanish one (`[locale]/missing`) before anything is drawn.
 */

import type { Metadata } from "next";
import { SiteShell } from "@/components/site-shell";
import { NotFoundView } from "@/components/not-found-view";
import { pageMetadata, SITE_VIEWPORT, words } from "@/lib/site";

export const metadata: Metadata = {
    ...pageMetadata("en", { title: words("en").notFound.title }),
    robots: { index: false }
};
export const viewport = SITE_VIEWPORT;

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Runs first in the body. A constant, with nothing from the address in it. */
const SPANISH = `(function(){try{var b=${JSON.stringify(BASE)};var p=location.pathname;if(b&&p.indexOf(b)===0)p=p.slice(b.length);var first=p.split("/")[1]||"";var es=first==="es"||(first!=="en"&&/^es\\b/i.test(navigator.language||""));if(es)location.replace(b+"/es/missing/");}catch(e){}})();`;

export default function GlobalNotFound() {
    return (
        <SiteShell locale="en" before={<script dangerouslySetInnerHTML={{ __html: SPANISH }} />}>
            <NotFoundView locale="en" />
        </SiteShell>
    );
}
