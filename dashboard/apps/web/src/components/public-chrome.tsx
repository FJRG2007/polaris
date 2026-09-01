/**
 * The frame a page that is readable without an account is drawn in.
 *
 * A public profile is the one screen in Polaris built to be opened by somebody
 * who is not in it - pasted into a message, a signature, a CV - and it used to be
 * drawn as a bare centred card on an empty page. That reads as having left
 * Polaris rather than as having arrived at part of it, which is exactly wrong for
 * the page whose whole job is to be a first impression of this deployment.
 *
 * So it gets a bar: the same height, surface and border as the signed-in one, the
 * mark in the same place, and on the right the two things a reader without an
 * account can actually do. Somebody who is signed in never sees this - they get
 * the real chrome, rail and all (see AppChrome) - because a second, simpler
 * navigation for a person who has the full one is a dead end they have to find
 * their own way out of.
 *
 * The way in is deliberately not called "sign up". Accounts here come from an
 * invitation and nothing else (see invite-service), so a button promising to
 * create one would be a button that cannot: what is offered is the screen that
 * redeems an invitation, for the reader who is holding one.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { LogIn, Ticket } from "lucide-react";
import { PUBLIC_PATHS } from "@/lib/legal/service";
import { Button, PolarisMark, cn } from "@polaris/ui";

export function PublicChrome({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <div className="flex min-h-screen flex-col bg-background">
            {/* Deliberately the signed-in header's own measurements. A public
                page an inch shorter in the bar is the kind of difference nobody
                can name and everybody notices. */}
            <header className="sticky top-0 z-40 flex h-header shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-3 sm:gap-4 sm:px-4">
                <Link
                    href={PUBLIC_PATHS.home}
                    aria-label="Polaris"
                    className="flex shrink-0 items-center rounded-sm text-foreground outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <PolarisMark />
                </Link>
                <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/oauth/accept-invite">
                            <Ticket className="size-4" />
                            {/* The label is the reader's situation, not ours.
                                "Accept an invite" asks them to have one; this
                                asks whether they do. */}
                            <span className="hidden sm:inline">I have an invite</span>
                            <span className="sm:hidden">Invite</span>
                        </Link>
                    </Button>
                    <Button asChild size="sm">
                        <Link href="/oauth/login">
                            <LogIn className="size-4" />
                            Sign in
                        </Link>
                    </Button>
                </div>
            </header>

            <main className={cn("mx-auto w-full max-w-2xl flex-1 px-4 py-6 sm:px-6 sm:py-10", className)}>
                {children}
            </main>

            <footer className="mx-auto flex w-full max-w-2xl flex-wrap items-center gap-x-5 gap-y-1 px-4 pb-8 text-xs text-muted-foreground sm:px-6">
                <Link href={PUBLIC_PATHS.home} className="transition-colors hover:text-foreground">
                    About
                </Link>
                <Link href={PUBLIC_PATHS.privacy} className="transition-colors hover:text-foreground">
                    Privacy
                </Link>
                <Link href={PUBLIC_PATHS.terms} className="transition-colors hover:text-foreground">
                    Terms
                </Link>
            </footer>
        </div>
    );
}
