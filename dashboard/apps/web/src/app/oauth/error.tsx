"use client";

/**
 * Error boundary for the sign-in screens.
 *
 * These sit outside the dashboard, so `(app)/error.tsx` never covered them and a
 * failure on the way in reached Next's own handler instead - the one that
 * replaces the whole document with "a client-side exception has occurred" and
 * leaves nothing to press. On the screen somebody uses to get into Polaris that
 * is the worst place to have no boundary: there is no shell left around it, no
 * navigation, and the person reading it cannot even tell whether the fault is
 * theirs.
 *
 * The failure worth recognising by name is the one that is not a fault at all. A
 * tab open across an update is holding chunks and action ids from a build that
 * has been replaced; nothing can be retried away, and fetching the new build
 * cures it. So it is reloaded from once, before anybody is shown anything - and
 * only once, because a reload that does not fix it would loop.
 *
 * Everything else is shown rather than swallowed. A sign-in screen that says
 * only "something went wrong" is a screen nobody can report: the message and the
 * reference are what turn it into something somebody can act on.
 */

import { useEffect } from "react";
import { RotateCcw } from "lucide-react";
import { isStaleBuildError, reloadForNewBuild } from "@/lib/stale-build";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, CardHeader, CardTitle, PolarisMark } from "@polaris/ui";

export default function OauthError({ error }: { error: Error & { digest?: string } }) {
    const t = useTranslations("auth");
    const staleBuild = isStaleBuildError(error);

    useEffect(() => {
        console.error(error);
    }, [error]);

    useEffect(() => {
        if (staleBuild) reloadForNewBuild();
    }, [staleBuild]);

    return (
        <main className="grid min-h-dvh place-items-center p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>
                        {staleBuild ? t("error.updatedTitle") : t("error.brokenTitle")}
                    </CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4">
                    <p className="text-sm text-muted-foreground">
                        {staleBuild ? t("error.updatedBody") : t("error.brokenBody")}
                    </p>
                    {/* Not for the stale build: its message is an id nobody can do
                        anything with, under a heading that already says what
                        happened. */}
                    {error.message && !staleBuild ? (
                        <p className="max-h-40 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs text-muted-foreground">
                            {error.message}
                        </p>
                    ) : null}
                    {error.digest && !staleBuild ? (
                        <p className="font-mono text-xs text-muted-foreground">
                            {t("error.reference", { digest: error.digest })}
                        </p>
                    ) : null}
                    <Button className="self-end" onClick={() => window.location.reload()}>
                        <RotateCcw className="size-4" /> {t("error.reload")}
                    </Button>
                </CardBody>
            </Card>
        </main>
    );
}
