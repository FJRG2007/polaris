/** Any address the export has no page for, in the site's own frame. */

import Link from "next/link";
import type { Metadata } from "next";
import { buttonVariants } from "@polaris/ui";
import { SiteShell } from "@/components/site-shell";
import { href, pageMetadata, SITE_VIEWPORT, words } from "@/lib/site";

export const metadata: Metadata = pageMetadata("en", { title: words("en").notFound.title });
export const viewport = SITE_VIEWPORT;

export default function GlobalNotFound() {
    const en = words("en").notFound;
    const es = words("es").notFound;
    return (
        <SiteShell locale="en">
            <div className="flex flex-col items-center gap-3 py-16 text-center">
                <h1 className="text-3xl font-semibold tracking-tight">{en.title}</h1>
                <p className="text-muted-foreground">{en.intro}</p>
                <p lang="es" className="text-sm text-muted-foreground">
                    {es.intro}
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                    <Link href={href("en")} className={buttonVariants({ variant: "primary" })}>
                        {en.home}
                    </Link>
                    <Link href={href("es")} hrefLang="es" className={buttonVariants({ variant: "secondary" })}>
                        {es.home}
                    </Link>
                </div>
            </div>
        </SiteShell>
    );
}
