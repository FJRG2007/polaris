"use client";

/**
 * An app's Marketplace page. The manifest half (name, mark, description, what
 * it does, screenshots, details) is drawn here from the static catalog, so it
 * paints with the shell; the install half arrives from the server inside its
 * own Suspense boundary and reuses the grid's install flow - the same one-click
 * install, the same Configure wizard, the same uninstall action.
 */

import Link from "next/link";
import { AppMark } from "@/components/app-mark";
import { appProvenance } from "@/lib/apps/provenance";
import { useMemo, useState, type ReactNode } from "react";
import { appScreenshots } from "@/lib/apps/app-screenshots";
import { useNavLabel } from "@/components/i18n/use-nav-label";
import { categoryLabel, localizeApp } from "@/lib/apps/app-words";
import type { InstalledAppReaderView } from "@/lib/apps/install-service";
import { ArrowLeft, ExternalLink, Loader2, Trash2 } from "lucide-react";
import { UninstallDialog } from "@/app/(app)/apps/marketplace/uninstall-dialog";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { findApp, isInstallable, type AppManifest } from "@/lib/apps/catalog";
import { Badge, Button, Card, CardBody, Skeleton, cn } from "@polaris/ui";
import {
    CAPABILITY_KEYS,
    InstallWizard,
    by,
    statusLabel,
    useOneClickInstall
} from "../marketplace-view";
import styles from "./screenshots.module.css";
import { ImageViewer, type ViewedImage } from "@/components/image-viewer";
import { GameLogo } from "@/components/game-logo";
import { GAMES, GAME_SERVERS_APP_ID } from "@/lib/apps/games-catalog";

/** The manifest, in the reader's words. Null for an id the catalog does not know. */
function useLocalizedApp(appId: string): AppManifest | null {
    const words = useTranslations("catalog");
    const navLabel = useNavLabel();
    return useMemo(() => {
        const app = findApp(appId);
        return app ? localizeApp(words, app, navLabel) : null;
    }, [appId, words, navLabel]);
}

/**
 * The games Game servers can run, each with its own logo - the first thing
 * somebody choosing it wants to know is whether their game is one of them.
 * Read from the same catalogue the app itself offers when a server is made.
 */
function SupportedGames() {
    const t = useTranslations("marketplace");
    return (
        <section className="flex min-w-0 flex-col gap-3" aria-label={t("detail.games")}>
            <h2 className="text-sm font-medium">{t("detail.games")}</h2>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {GAMES.map((game) => {
                    const key = `detail.gameSummaries.${game.id}`;
                    const summary = t.has(key) ? t(key as never) : game.summary;
                    return (
                        <li
                            key={game.id}
                            className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-card p-3"
                        >
                            <GameLogo game={game} className="size-10 shrink-0" />
                            <div className="flex min-w-0 flex-col gap-0.5">
                                <span className="truncate text-sm font-medium" title={game.name}>
                                    {game.name}
                                </span>
                                <span className="text-xs text-muted-foreground">{summary}</span>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

/** The version an app's image is pinned to, when its tag says one. */
function imageVersion(image: string | undefined): string | null {
    if (!image) return null;
    const tag = image.slice(image.lastIndexOf("/") + 1).split(":")[1];
    return tag && tag !== "latest" ? tag : null;
}

export function AppDetail({ appId, children }: { appId: string; children: ReactNode }) {
    const t = useTranslations("marketplace");
    const words = useTranslations("catalog");
    const navLabel = useNavLabel();
    const locale = useLocale();
    const app = useLocalizedApp(appId);
    const [viewing, setViewing] = useState<ViewedImage | null>(null);
    if (!app) return null;
    const from = appProvenance(app);
    const shots = appScreenshots(app.id, locale);
    const image = app.template?.image;
    const version = imageVersion(image);
    // The screenshots as the viewer pages through them, in the reader's theme:
    // the page picks by CSS, and the viewer opens after the page is drawn, so
    // the class on the document is already the answer.
    const light =
        typeof document !== "undefined" &&
        (document.documentElement.classList.contains("light") ||
            (document.documentElement.classList.contains("system") &&
                window.matchMedia("(prefers-color-scheme: light)").matches));
    const gallery: ViewedImage[] = shots.map((shot, index) => ({
        url: shot[light ? "light" : "dark"].desktop,
        name: t("detail.screenshotAlt", { name: app.name, index: index + 1 })
    }));

    return (
        <div className="flex min-w-0 flex-col gap-6">
            <Link
                href="/apps/marketplace"
                className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
            >
                <ArrowLeft className="size-4" />
                {t("detail.back")}
            </Link>

            <header className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
                <AppMark app={app} size={72} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <h1 className="break-words text-2xl font-semibold">{app.name}</h1>
                    <p className="text-muted-foreground break-words text-sm">{by(t, from)}</p>
                    <p className="break-words text-sm">{app.summary}</p>
                </div>
            </header>

            {children}

            {shots.length > 0 && (
                <section
                    className="flex min-w-0 flex-col gap-3"
                    aria-label={t("detail.screenshots")}
                >
                    <h2 className="text-sm font-medium">{t("detail.screenshots")}</h2>
                    <div className="flex snap-x gap-3 overflow-x-auto pb-2">
                        {shots.map((shot, index) => {
                            const alt = t("detail.screenshotAlt", {
                                name: app.name,
                                index: index + 1
                            });
                            return (
                                <figure
                                    key={shot.dark.desktop}
                                    className="w-[85%] max-w-2xl shrink-0 snap-start sm:w-[70%]"
                                >
                                    <button
                                        type="button"
                                        aria-label={t("detail.openScreenshot", { name: alt })}
                                        onClick={() => setViewing(gallery[index] ?? null)}
                                        className="block w-full cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    >
                                    {(["dark", "light"] as const).map((theme) => (
                                        <picture key={theme} className={styles[theme]}>
                                            <source
                                                media="(max-width: 640px)"
                                                srcSet={shot[theme].mobile}
                                            />
                                            {/* eslint-disable-next-line @next/next/no-img-element -- static webp, no optimizer needed */}
                                            <img
                                                src={shot[theme].desktop}
                                                alt={alt}
                                                loading={index === 0 ? "eager" : "lazy"}
                                                className="border-border w-full rounded-md border"
                                            />
                                        </picture>
                                    ))}
                                    </button>
                                </figure>
                            );
                        })}
                    </div>
                    <ImageViewer
                        image={viewing}
                        gallery={gallery}
                        onNavigate={setViewing}
                        onClose={() => setViewing(null)}
                    />
                </section>
            )}

            {app.id === GAME_SERVERS_APP_ID ? <SupportedGames /> : null}

            <section className="flex min-w-0 flex-col gap-2">
                <h2 className="text-sm font-medium">{t("detail.about")}</h2>
                <p className="text-muted-foreground whitespace-pre-line break-words text-sm">
                    {app.description}
                </p>
            </section>

            {app.capabilities.length > 0 && (
                <section className="flex min-w-0 flex-col gap-2">
                    <h2 className="text-sm font-medium">{t("detail.features")}</h2>
                    <div className="flex flex-wrap gap-1">
                        {app.capabilities.map((capability) => (
                            <Badge key={capability}>{t(CAPABILITY_KEYS[capability])}</Badge>
                        ))}
                    </div>
                </section>
            )}

            <section className="flex min-w-0 flex-col gap-2">
                <h2 className="text-sm font-medium">{t("detail.information")}</h2>
                <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
                    <Fact label={t("detail.developer")}>{from.developer}</Fact>
                    <Fact label={t("detail.category")}>
                        {categoryLabel(words, app.category, navLabel)}
                    </Fact>
                    {version && <Fact label={t("detail.version")}>{version}</Fact>}
                    {image && (
                        <Fact label={t("detail.image")}>
                            <code className="break-all text-xs">{image}</code>
                        </Fact>
                    )}
                    {app.docsUrl && (
                        <Fact label={t("detail.docs")}>
                            <a
                                href={app.docsUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex min-w-0 items-center gap-1 break-all underline underline-offset-2"
                            >
                                {app.docsUrl}
                                <ExternalLink className="size-3 shrink-0" />
                            </a>
                        </Fact>
                    )}
                </dl>
            </section>
        </div>
    );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{children}</dd>
        </>
    );
}

/** Shaped like the panel it stands in for: a row of buttons. */
export function AppInstallPanelSkeleton() {
    return (
        <div className="flex gap-2" aria-hidden>
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-9 w-24" />
        </div>
    );
}

export interface DetailInstall extends InstalledAppReaderView {
    /** From `uninstallAccess`, the check the uninstall action makes. */
    readonly canUninstall: boolean;
}

export function AppInstallPanel({
    appId,
    canInstall,
    installs
}: {
    appId: string;
    /** deploy.manage, the permission the install action requires. */
    canInstall: boolean;
    installs: DetailInstall[];
}) {
    const t = useTranslations("marketplace");
    const app = useLocalizedApp(appId);
    const { install, installingId, error } = useOneClickInstall();
    const [wizard, setWizard] = useState(false);
    const [removing, setRemoving] = useState<DetailInstall | null>(null);
    if (!app) return null;
    const manifest = findApp(appId) ?? app;
    // One install per Polaris, or per owner: a second would be refused.
    const offerInstall = isInstallable(app) && !(app.singleton && installs.length > 0);
    const openHref = (item: InstalledAppReaderView) => app.opensAt ?? `/apps/installed/${item.id}`;

    return (
        <section className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                {app.singleton && installs[0] && (
                    <Link href={openHref(installs[0])}>
                        <Button>{t("card.open")}</Button>
                    </Link>
                )}
                {app.comingSoon && (
                    <Badge className="text-muted-foreground">{t("card.comingSoon")}</Badge>
                )}
                {offerInstall && canInstall && (
                    <>
                        <Button onClick={() => install(manifest)} disabled={installingId !== null}>
                            {installingId && <Loader2 className="size-4 animate-spin" />}
                            {installingId ? t("card.installing") : t("card.install")}
                        </Button>
                        {app.installMethod !== "builtin" && (
                            <Button
                                variant="secondary"
                                onClick={() => setWizard(true)}
                                disabled={installingId !== null}
                                title={t("card.configureHint")}
                            >
                                {t("card.configure")}
                            </Button>
                        )}
                    </>
                )}
            </div>
            {offerInstall && !canInstall && (
                <p className="text-muted-foreground text-sm">{t("detail.readOnly")}</p>
            )}
            {error && <p className="text-danger text-sm">{error}</p>}

            {installs.length > 0 && (
                <div className="flex min-w-0 flex-col gap-2">
                    <h2 className="text-sm font-medium">{t("detail.installs")}</h2>
                    {installs.map((item) => (
                        <Card key={item.id}>
                            <CardBody className="flex min-w-0 flex-wrap items-center gap-3 py-3">
                                <Link
                                    href={openHref(item)}
                                    className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
                                    title={item.name}
                                >
                                    {item.name}
                                </Link>
                                <Badge
                                    className={cn(
                                        item.status === "failed" &&
                                            "border-danger-edge text-danger",
                                        item.status === "running" &&
                                            "border-success-edge text-success"
                                    )}
                                >
                                    {statusLabel(t, item.status)}
                                </Badge>
                                <div className="flex items-center gap-1">
                                    {!app.singleton && (
                                        <Link href={openHref(item)}>
                                            <Button size="sm" variant="secondary">
                                                {t("card.open")}
                                            </Button>
                                        </Link>
                                    )}
                                    {item.canUninstall ? (
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => setRemoving(item)}
                                            className="hover:text-danger"
                                        >
                                            <Trash2 className="size-4" />
                                            {t("uninstall.confirm")}
                                        </Button>
                                    ) : null}
                                </div>
                            </CardBody>
                        </Card>
                    ))}
                    {installs.some((item) => !item.canUninstall) && (
                        <p className="text-muted-foreground text-xs">{t("detail.ownerOnly")}</p>
                    )}
                </div>
            )}

            {wizard && <InstallWizard app={manifest} onClose={() => setWizard(false)} />}
            {removing && <UninstallDialog install={removing} onClose={() => setRemoving(null)} />}
        </section>
    );
}
