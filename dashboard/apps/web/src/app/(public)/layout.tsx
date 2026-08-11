import Link from "next/link";
import { LogIn } from "lucide-react";
import type { ReactNode } from "react";
import { Button, PolarisMark } from "@polaris/ui";
import { PUBLIC_PATHS } from "@/lib/legal/service";

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
export default function PublicLayout({ children }: { children: ReactNode }) {
    return (
        <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 p-6">
            <header className="flex items-center justify-between gap-2">
                <Link href={PUBLIC_PATHS.home} className="flex items-center gap-2 text-muted-foreground hover:text-foreground">
                    <PolarisMark className="size-6" />
                    <span className="text-sm font-medium">Polaris</span>
                </Link>
                <Button asChild size="sm" variant="ghost">
                    <Link href="/oauth/login">
                        <LogIn className="size-4" />
                        Sign in
                    </Link>
                </Button>
            </header>

            <main className="flex flex-1 flex-col gap-8">{children}</main>

            <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-4 text-xs text-muted-foreground">
                <Link href={PUBLIC_PATHS.home} className="hover:text-foreground">
                    About
                </Link>
                <Link href={PUBLIC_PATHS.privacy} className="hover:text-foreground">
                    Privacy
                </Link>
                <Link href={PUBLIC_PATHS.terms} className="hover:text-foreground">
                    Terms
                </Link>
                <a
                    href="https://github.com/FJRG2007/polaris"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="hover:text-foreground"
                >
                    Source
                </a>
            </footer>
        </div>
    );
}
