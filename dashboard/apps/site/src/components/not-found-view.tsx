/** What an address with no page says, in one language. */

import Link from "next/link";
import { buttonVariants } from "@polaris/ui";
import type { SiteLocale } from "@/data/builders";
import { href, words } from "@/lib/site";

export function NotFoundView({ locale }: { locale: SiteLocale }) {
    const t = words(locale).notFound;
    return (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
            <h1 className="text-3xl font-semibold tracking-tight">{t.title}</h1>
            <p className="text-muted-foreground">{t.intro}</p>
            <Link href={href(locale)} className={buttonVariants({ variant: "primary" })}>
                {t.home}
            </Link>
        </div>
    );
}
