/**
 * The frame every public link page is drawn in.
 *
 * A share, a drop point, a snippet and a text drop point are all reached by
 * people who may have no account here, so they all open on the same thing: the
 * Polaris mark, a way in for somebody who does have an account, and one card.
 * Each of them had its own copy of that frame, which is how three pages end up
 * looking like three products.
 */

import Link from "next/link";
import { ArrowUpRight, LogIn } from "lucide-react";
import { Button, Card, CardBody, CardHeader, CardTitle, cn, PolarisMark } from "@polaris/ui";

export function PublicShell({
    children,
    signedIn,
    className
}: {
    children: React.ReactNode;
    /** Omit on a page that offers no way into the app at all. */
    signedIn?: boolean;
    className?: string;
}) {
    return (
        <div className={cn("mx-auto flex min-h-screen max-w-2xl flex-col gap-4 p-6", className)}>
            <header className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-muted-foreground">
                    <PolarisMark className="size-6" />
                    <span className="text-sm font-medium">Polaris</span>
                </div>
                {signedIn === undefined ? null : signedIn ? (
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/home">
                            Open Polaris
                            <ArrowUpRight className="size-4" />
                        </Link>
                    </Button>
                ) : (
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/oauth/login">
                            <LogIn className="size-4" />
                            Sign in
                        </Link>
                    </Button>
                )}
            </header>
            {children}
        </div>
    );
}

/**
 * What a link that cannot be served says. Deliberately the same shape whatever
 * the reason: a page that distinguishes "never existed" from "expired" answers a
 * question somebody probing links wanted answered.
 */
export function LinkUnavailable({
    message,
    signedIn,
    title = "Link unavailable"
}: {
    message: string;
    signedIn?: boolean;
    title?: string;
}) {
    return (
        <PublicShell signedIn={signedIn}>
            <Card>
                <CardHeader>
                    <CardTitle>{title}</CardTitle>
                </CardHeader>
                <CardBody>
                    <p className="text-sm text-muted-foreground">{message}</p>
                </CardBody>
            </Card>
        </PublicShell>
    );
}
