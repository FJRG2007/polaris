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
 * **A card per thing, rows per place it runs.** Each card says what the thing
 * does, lists where it can be installed with the one thing to press beside each,
 * and ends on a drawing of it in use. The long step-by-step instructions open
 * from a row rather than filling the card. What can be installed right now comes
 * first; what is coming says so, with no button that implies a file.
 *
 * Everything that waits on GitHub waits behind its own boundary: the cards, the
 * headings and the instructions are drawn before the release lookup has answered,
 * because a page about downloading things must not be blank while it finds out
 * what the versions are.
 */

import { Suspense } from "react";
import { loadEnv } from "@polaris/config";
import { listApiKeys } from "@polaris/auth";
import { Badge, Skeleton } from "@polaris/ui";
import { CliSection } from "./cli-section";
import { requireUser } from "@/lib/session";
import { ExtensionCard } from "./extension-card";
import { AssistantsCard } from "./assistants-card";
import { Monitor, Smartphone } from "lucide-react";
import { SystemMark } from "@/components/client-marks";
import { publicAppUrl } from "@/lib/domain-service";
import { getTranslations } from "@/lib/i18n/request";
import { InstallAppOffer } from "@/components/installed-app";
import { DesktopFiles, ExtensionFiles } from "@/components/app-download";
import { companionDownload, streamDeckDownload } from "@/lib/app-releases";
import { DeckFile, StreamDeckSection, type ConnectedDeck } from "./streamdeck-section";
import { DownloadCard, DownloadRow, DownloadRows } from "./download-card";
import { DesktopPreview, PhonePreview, WebAppPreview } from "./download-previews";

export const dynamic = "force-dynamic";

/** The phone systems the mobile card names; product names, the same in every language. */
// i18n-ignore systems' names
const MOBILE_SYSTEMS = ["iOS", "Android"] as const;

/** The Stream Deck plugin's installer, once GitHub has answered. */
async function StreamDeckRelease({ repo }: { repo: string }) {
    return <DeckFile download={await streamDeckDownload(repo)} suffix=".streamDeckPlugin" />;
}

/** The Companion module's package, once GitHub has answered. */
async function CompanionRelease({ repo }: { repo: string }) {
    return <DeckFile download={await companionDownload(repo)} suffix=".tgz" />;
}

/** The decks connected to this account: its live keys of kind "streamdeck". */
async function connectedDecks(userId: string): Promise<ConnectedDeck[]> {
    const now = Date.now();
    return (await listApiKeys(userId))
        .filter(
            (key) =>
                key.kind === "streamdeck" &&
                !key.revokedAt &&
                (!key.expiresAt || Date.parse(key.expiresAt) > now)
        )
        .map((key) => ({
            id: key.id,
            name: key.name,
            createdAt: key.createdAt,
            lastUsedAt: key.lastUsedAt
        }));
}

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
    const user = await requireUser();
    const [t, tc, serverUrl, decks] = await Promise.all([
        getTranslations("account"),
        getTranslations("components"),
        // The address the CLI signs in to. Null falls back to the one this page
        // is open on, which the reader has just proven reaches this Polaris.
        publicAppUrl().catch(() => null),
        connectedDecks(user.id)
    ]);
    const repo = loadEnv().POLARIS_REPO;

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <div className="flex flex-col items-center gap-1 text-center">
                <h1 className="text-[17px] font-semibold tracking-tight">
                    {t("downloads.page.title")}
                </h1>
                <p className="text-sm text-muted-foreground">{t("downloads.page.intro")}</p>
            </div>

            <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
                {/* The one thing everybody can have right now, wide, with the
                    browser's own install offer. Nothing in it waits. */}
                <DownloadCard
                    id="app"
                    tint="violet"
                    className="lg:col-span-2"
                    icon={<Monitor className="size-4 shrink-0" />}
                    title={t("downloads.web.title")}
                    description={tc("installApp.intro")}
                    side={<WebAppPreview />}
                >
                    <InstallAppOffer />
                </DownloadCard>

                {/* Everything that waits on GitHub waits behind its own boundary:
                    the cards, their rows and the steps draw before the release
                    lookup has answered. */}
                <ExtensionCard
                    repo={repo}
                    files={
                        <Suspense fallback={<FilesSkeleton />}>
                            <ExtensionFiles repo={repo} />
                        </Suspense>
                    }
                />

                <StreamDeckSection
                    decks={decks}
                    repo={repo}
                    address={serverUrl?.replace(/\/+$/, "") ?? null}
                    pluginFile={
                        <Suspense fallback={<Skeleton className="h-9 w-48" />}>
                            <StreamDeckRelease repo={repo} />
                        </Suspense>
                    }
                    moduleFile={
                        <Suspense fallback={<Skeleton className="h-9 w-48" />}>
                            <CompanionRelease repo={repo} />
                        </Suspense>
                    }
                />

                <CliSection repo={repo} serverUrl={serverUrl} />

                <AssistantsCard />

                <DownloadCard
                    id="desktop"
                    tint="slate"
                    icon={<Monitor className="size-4 shrink-0" />}
                    title={tc("installApp.title")}
                    description={tc("installApp.native")}
                    preview={<DesktopPreview />}
                >
                    <Suspense fallback={<FilesSkeleton />}>
                        <DesktopFiles repo={repo} />
                    </Suspense>
                </DownloadCard>

                {/* Present, unlinked and honest. A real plan with nothing built,
                    and saying so is the only thing that can be said about it - a
                    disabled button implies a file that is nearly ready, which
                    would be a different and untrue statement. */}
                <DownloadCard
                    id="mobile"
                    tint="rose"
                    icon={<Smartphone className="size-4 shrink-0" />}
                    title={t("downloads.later.mobile")}
                    description={t("downloads.later.mobileHint")}
                    preview={<PhonePreview />}
                >
                    <DownloadRows label={t("downloads.later.title")}>
                        {MOBILE_SYSTEMS.map((os) => (
                            <DownloadRow
                                key={os}
                                mark={<SystemMark os={os} />}
                                name={os}
                                action={
                                    <Badge variant="neutral">{t("downloads.mobile.planned")}</Badge>
                                }
                            />
                        ))}
                    </DownloadRows>
                </DownloadCard>
            </div>
        </div>
    );
}
