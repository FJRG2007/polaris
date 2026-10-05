/**
 * Downloads (/account/downloads): every way of having Polaris somewhere other
 * than this tab.
 *
 * One page rather than a card wherever each thing happened to be built. The
 * desktop app was offered under Preferences because that is where the browser's
 * install prompt was already being held, and the extension under "Connect an app"
 * because that screen was about pasting a server address into Bitwarden's clients
 * - so somebody after "the Polaris apps" had to know which unrelated screen each
 * one was hiding behind. There is now one answer to that question, and the two
 * screens point here.
 *
 * **Ordered by what exists.** What can be installed right now is at the top, and
 * what is coming is a short list underneath rather than four more cards with a
 * disabled button in each - a page of things you cannot have is a worse answer
 * than a page that says plainly which two you can.
 *
 * Everything that waits on GitHub waits behind its own boundary: the cards, the
 * headings and the instructions are drawn before the release lookup has answered,
 * because a page about downloading things must not be blank while it finds out
 * what the versions are.
 */

import Link from "next/link";
import { Suspense } from "react";
import { loadEnv } from "@polaris/config";
import { requireUser } from "@/lib/session";
import { publicAppUrl } from "@/lib/domain-service";
import { CliSection } from "./cli-section";
import { ExtensionSteps } from "./extension-steps";
import { getTranslations } from "@/lib/i18n/request";
import { ExtensionCommand } from "./extension-command";
import { InstallAppCard } from "@/components/installed-app";
import { Puzzle, Smartphone } from "lucide-react";
import { DesktopFiles, ExtensionFiles } from "@/components/app-download";
import { Badge, Card, CardBody, CardHeader, CardTitle, Skeleton } from "@polaris/ui";

export const dynamic = "force-dynamic";

/** The shape of a list of files, while the release is being looked up. */
function FilesSkeleton() {
    return (
        <div className="flex flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
        </div>
    );
}

export default async function DownloadsPage() {
    const [, t, serverUrl] = await Promise.all([
        requireUser(),
        getTranslations("account"),
        // The address the CLI signs in to. Null falls back to the one this page
        // is open on, which the reader has just proven reaches this Polaris.
        publicAppUrl().catch(() => null)
    ]);
    const repo = loadEnv().POLARIS_REPO;

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("downloads.page.title")}
                </h1>
                <p className="text-sm text-muted-foreground">{t("downloads.page.intro")}</p>
            </div>

            {/* The PWA install and the native builds, in the card that already held
                both. The per-platform list is the only thing here that waits. */}
            <InstallAppCard
                nativeApp={
                    <Suspense fallback={<FilesSkeleton />}>
                        <DesktopFiles repo={repo} />
                    </Suspense>
                }
            />

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Puzzle className="size-4" />
                        {t("downloads.extension.title")}
                    </CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4 text-sm">
                    <p className="text-muted-foreground">{t("downloads.extension.description")}</p>

                    <div className="flex flex-col gap-2">
                        <p className="flex items-center gap-2 font-medium">
                            {t("downloads.extension.store")}
                            <Badge variant="neutral">{t("downloads.extension.notYet")}</Badge>
                        </p>
                        <p className="text-muted-foreground">
                            {t("downloads.extension.storeHint")}
                        </p>
                    </div>

                    <div className="flex flex-col gap-4 border-t border-border/60 pt-4">
                        <p className="font-medium">{t("downloads.extension.loadYourself")}</p>
                        {/* First, because it is the only way on this screen that
                            keeps itself current afterward - the line sets up a
                            job that swaps in new releases and the extension
                            restarts into them on its own. The zip and the steps
                            stay under it for anybody who would rather do it by
                            hand, with nothing keeping that copy current. */}
                        <ExtensionCommand repo={repo} />
                        <Suspense fallback={<FilesSkeleton />}>
                            <ExtensionFiles repo={repo} />
                        </Suspense>
                        {/* Guided rather than described, like the router steps in
                            the domain setup: this is somebody working in a window
                            that is not this one, where every value has to be
                            exact and a paragraph holding five of them is a
                            paragraph they lose their place in. */}
                        <ExtensionSteps />
                    </div>

                    <p className="border-t border-border/60 pt-4 text-muted-foreground">
                        {t.rich("downloads.extension.alreadyHave", {
                            link: (chunks) => (
                                <Link key="link" className="underline" href="/account/extension">
                                    {chunks}
                                </Link>
                            )
                        })}
                    </p>
                </CardBody>
            </Card>

            <CliSection repo={repo} serverUrl={serverUrl} />

            <Card>
                <CardHeader>
                    <CardTitle>{t("downloads.later.title")}</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4 text-sm">
                    {/* Present, unlinked and honest. Each of these is a real plan with
                        nothing built, and saying so is the only thing that can be said
                        about it - a disabled button implies a file that is nearly
                        ready, which would be a different and untrue statement. */}
                    <div className="flex items-start gap-3">
                        <Smartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <div>
                            <p className="font-medium">{t("downloads.later.mobile")}</p>
                            <p className="text-muted-foreground">
                                {t("downloads.later.mobileHint")}
                            </p>
                        </div>
                    </div>
                </CardBody>
            </Card>
        </div>
    );
}
