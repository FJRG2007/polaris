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
import { InstallAppCard } from "@/components/installed-app";
import { Puzzle, Smartphone, Terminal } from "lucide-react";
import { DesktopFiles, ExtensionFiles } from "@/components/app-download";
import { Button, Card, CardBody, CardHeader, CardTitle, Skeleton } from "@polaris/ui";

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
    await requireUser();
    const repo = loadEnv().POLARIS_REPO;

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">Downloads</h1>
                <p className="text-sm text-muted-foreground">
                    Polaris on your desktop, in your browser, and on your own machine.
                </p>
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
                        Browser extension
                    </CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4 text-sm">
                    <p className="text-muted-foreground">
                        Fills a login, saves a new one, and unlocks from your vault. It asks the
                        browser for permission to talk to this Polaris and no other, and holds no
                        standing access to the pages you open.
                    </p>

                    <div className="flex flex-col gap-2">
                        <p className="font-medium">From your browser&apos;s store</p>
                        <p className="text-muted-foreground">
                            Not published yet. The store version is the one that keeps itself up to
                            date, so it is worth waiting for if you can.
                        </p>
                        <div>
                            <Button size="sm" variant="secondary" disabled>
                                Get it from the store
                            </Button>
                        </div>
                    </div>

                    <div className="flex flex-col gap-2 border-t border-border/60 pt-4">
                        <p className="font-medium">Load it yourself</p>
                        <p className="text-muted-foreground">
                            Unpack the file for your browser and load it: Chrome and Edge at
                            chrome://extensions with Developer mode on, then Load unpacked. Firefox
                            at about:debugging, This Firefox, then Load Temporary Add-on. Loaded this
                            way it does not update itself, and Firefox lets it go when it closes.
                        </p>
                        <Suspense fallback={<FilesSkeleton />}>
                            <ExtensionFiles repo={repo} />
                        </Suspense>
                    </div>

                    <p className="border-t border-border/60 pt-4 text-muted-foreground">
                        Already have it?{" "}
                        <Link className="underline" href="/vault/clients">
                            Connect it to your vault
                        </Link>
                        .
                    </p>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Not here yet</CardTitle>
                </CardHeader>
                <CardBody className="flex flex-col gap-4 text-sm">
                    {/* Present, unlinked and honest. Each of these is a real plan with
                        nothing built, and saying so is the only thing that can be said
                        about it - a disabled button implies a file that is nearly
                        ready, which would be a different and untrue statement. */}
                    <div className="flex items-start gap-3">
                        <Smartphone className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <div>
                            <p className="font-medium">Android and iOS</p>
                            <p className="text-muted-foreground">
                                No app yet. Installing Polaris as an app above puts it on your home
                                screen from the browser, which is most of the way there.
                            </p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3">
                        <Terminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <div>
                            <p className="font-medium">Command line</p>
                            <p className="text-muted-foreground">
                                For managing your things from your own computer, and for opening a
                                tunnel from it to a service here. Nothing to install yet, so there is
                                no command to copy.
                            </p>
                        </div>
                    </div>
                </CardBody>
            </Card>
        </div>
    );
}
