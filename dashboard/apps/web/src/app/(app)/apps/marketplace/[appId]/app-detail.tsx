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
import { categoryLabel } from "@/lib/apps/app-words";
import type { InstalledAppReaderView } from "@/lib/apps/install-service";
import { ArrowLeft, ExternalLink, Trash2 } from "lucide-react";
import { UninstallDialog } from "@/app/(app)/apps/marketplace/uninstall-dialog";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { appNeeds } from "@/lib/apps/app-needs";
import { CAPABILITY_KEYS } from "@/lib/apps/capability-words";
import type { AppManifest } from "@/lib/apps/catalog";
import { Badge, Button, Card, CardBody, Skeleton, cn } from "@polaris/ui";
import {
    InstallWizard,
    by,
    statusLabel,
    useOneClickInstall
} from "../marketplace-view";
import { ScreenshotGallery } from "./screenshot-gallery";
import { AppPreview, PrimaryActionButton, StatusBadge } from "../store-card";
import {
    ADDED_ON,
    findStoreApp,
    installBadge,
    primaryAction,
    storeHome,
    storeScope
} from "@/lib/apps/marketplace-store";
import { GameLogo } from "@/components/game-logo";
import { GAMES, GAME_SERVERS_APP_ID } from "@/lib/apps/games-catalog";
import { ReplacesRow } from "../replaces-row";
import { useLocalizeStoreApp } from "../use-store-words";
import { TemplateDeployDialog } from "../template-deploy-dialog";

/** The manifest, in the reader's words. Null for an id the catalog does not know. */
function useLocalizedApp(appId: string): AppManifest | null {
    const localize = useLocalizeStoreApp();
    return useMemo(() => {
        const app = findStoreApp(appId);
        return app ? localize(app) : null;
    }, [appId, localize]);
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
    if (!app) return null;
    const from = appProvenance(app);
    const shots = appScreenshots(app.id, locale);
    const image = app.template?.image;
    const version = imageVersion(image);
    const added = ADDED_ON[app.id]
        ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
              new Date(`${ADDED_ON[app.id]}T00:00:00Z`)
          )
        : null;
    return (
        <div className="flex min-w-0 flex-col gap-6">
            <Link
                href={storeHome(storeScope(app))}
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

            {/* The real captures, or - for an app nobody has captured yet - the
                same designed preview its card shows, never a mocked-up screen. */}
            {shots.length > 0 ? (
                <ScreenshotGallery name={app.name} shots={shots} />
            ) : (
                <AppPreview
                    app={app}
                    shot={null}
                    className="max-w-2xl rounded-lg border border-border"
                />
            )}

            {app.id === GAME_SERVERS_APP_ID ? <SupportedGames /> : null}

            <section className="flex min-w-0 flex-col gap-2">
                <h2 className="text-sm font-medium">{t("detail.about")}</h2>
                <p className="text-muted-foreground whitespace-pre-line break-words text-sm">
                    {app.description}
                </p>
            </section>

            <ReplacesRow appId={app.id} />

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
                <h2 className="text-sm font-medium">{t("detail.needs")}</h2>
                <ul className="text-muted-foreground flex list-disc flex-col gap-1 pl-5 text-sm">
                    {appNeeds(t, app).map((line) => (
                        <li key={line} className="break-words">
                            {line}
                        </li>
                    ))}
                </ul>
            </section>

            <section className="flex min-w-0 flex-col gap-2">
                <h2 className="text-sm font-medium">{t("detail.information")}</h2>
                <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
                    <Fact label={t("detail.developer")}>{from.developer}</Fact>
                    <Fact label={t("detail.category")}>
                        {categoryLabel(words, app.category, navLabel)}
                    </Fact>
                    {version && <Fact label={t("detail.version")}>{version}</Fact>}
                    {added && <Fact label={t("detail.added")}>{added}</Fact>}
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
    const [deploying, setDeploying] = useState(false);
    const [removing, setRemoving] = useState<DetailInstall | null>(null);
    if (!app) return null;
    const manifest = findStoreApp(appId) ?? app;
    const openHref = (item: InstalledAppReaderView) => app.opensAt ?? `/apps/installed/${item.id}`;
    const action = primaryAction(app, {
        installs,
        canInstall,
        installing: installingId === app.id
    });
    const badge = installBadge(app, installs);

    return (
        <section className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                {action.kind !== "locked" && (
                    <PrimaryActionButton
                        action={action}
                        onInstall={() =>
                            manifest.deployTemplate ? setDeploying(true) : install(manifest)
                        }
                        disabled={installingId !== null}
                        size="md"
                    />
                )}
                {action.kind === "install" && action.configurable && (
                    <Button
                        variant="secondary"
                        onClick={() => setWizard(true)}
                        disabled={installingId !== null}
                        title={t("card.configureHint")}
                    >
                        {t("card.configure")}
                    </Button>
                )}
                {badge?.kind === "status" && (
                    <StatusBadge status={badge.status} label={statusLabel(t, badge.status)} />
                )}
            </div>
            {action.kind === "locked" && (
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
            {deploying && manifest.deployTemplate ? (
                <TemplateDeployDialog
                    templateId={manifest.deployTemplate}
                    name={app.name}
                    onClose={() => setDeploying(false)}
                />
            ) : null}
            {removing && <UninstallDialog install={removing} onClose={() => setRemoving(null)} />}
        </section>
    );
}
