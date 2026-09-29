import Link from "next/link";
import { LogIn } from "lucide-react";
import type { ReactNode } from "react";
import { SmoothScroll } from "./smooth-scroll";
import { Button, PolarisMark } from "@polaris/ui";
import { PUBLIC_PATHS } from "@/lib/legal/service";
import { getTranslations } from "@/lib/i18n/request";

/**
 * The pages that exist outside the login: what this deployment is, and the terms
 * it is offered under.
 *
 * No session is resolved here, deliberately. These are the pages an outside
 * reviewer opens signed out - Google fails verification for a home page behind a
 * login - so nothing on them may depend on knowing who is reading. The way in is
 * a link to the sign-in screen, which is the only thing anybody who belongs here
 * needs from these pages.
 */
export default async function PublicLayout({ children }: { children: ReactNode }) {
    const t = await getTranslations("publicPages");
    return (
        <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-6 py-10 sm:py-16">
            {/* Drives the document that is already here, and renders nothing - so the
                first paint is exactly what the server sent. */}
            <SmoothScroll />

            <header className="flex items-center justify-between gap-2">
                {/* The mark alone. The name is written under it in the page's
                    own heading, and the two together read as the word twice -
                    which is what it looked like: a wordmark stuttering into a
                    title. Named for a screen reader, which cannot see a mark. */}
                <Link
                    href={PUBLIC_PATHS.home}
                    // i18n-ignore: the product's name, for a screen reader
                    aria-label="Polaris"
                    className="flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
                >
                    {/* The glyph alone, said as such: a size on the row squashed
                        the name under the star rather than removing it. */}
                    <PolarisMark nameClassName="hidden" />
                </Link>
                <Button asChild size="sm" variant="ghost">
                    <Link href="/oauth/login">
                        <LogIn className="size-4" />
                        {t("layout.signIn")}
                    </Link>
                </Button>
            </header>

            {/* The gap carries the rhythm of the page: sections are far enough apart to
                read as separate things, which is what a single stack of paragraphs at
                one size was not doing. */}
            <main className="flex flex-1 flex-col gap-16 pt-16 sm:gap-20 sm:pt-24">{children}</main>

            <footer className="mt-24 flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border pt-6 text-xs text-muted-foreground">
                <Link href={PUBLIC_PATHS.home} className="transition-colors hover:text-foreground">
                    {t("layout.about")}
                </Link>
                <Link href={PUBLIC_PATHS.privacy} className="transition-colors hover:text-foreground">
                    {t("layout.privacy")}
                </Link>
                <Link href={PUBLIC_PATHS.terms} className="transition-colors hover:text-foreground">
                    {t("layout.terms")}
                </Link>
                <a
                    href="https://github.com/FJRG2007/polaris"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="transition-colors hover:text-foreground"
                >
                    {t("layout.source")}
                </a>
            </footer>
        </div>
    );
}
