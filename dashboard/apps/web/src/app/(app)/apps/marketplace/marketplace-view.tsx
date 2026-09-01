"use client";

/**
 * The marketplace grid and the per-app install wizard. The catalog is imported
 * directly (it is static and client-safe); the installed state comes from the
 * server. Installing opens a dialog that reuses Deploy's notions of a target
 * server and per-volume storage (a server-local volume or a NAS mount), then
 * calls the deploy.manage-gated install action.
 *
 * It reads as a store now rather than as a list of what happens to be declared,
 * and four things are what changed:
 *
 * - **A search field.** Every store has one, and a page of categories somebody
 *   has to scroll to find "Minecraft" is a page that gets scrolled past. Fuzzy,
 *   so a near miss and a category still land.
 * - **Coming soon goes last.** It was mixed in with what can actually be
 *   installed, so the first row of a category could be three things nobody can
 *   have. They are still shown - saying what is coming is the point of declaring
 *   them - underneath, and out of the way.
 * - **Every card says who is behind it.** A store that does not say where a thing
 *   comes from is a store nobody should install from. Read off the image the app
 *   installs rather than typed in - see `appProvenance`.
 * - **Installed lists apps, not their parts.** A camera relay and six Minecraft
 *   servers are not seven things somebody installed; they are what two apps run.
 *   The manifests already said so (`internal` and `ownedBy`) and this screen was
 *   the one place not reading it.
 */

import Fuse from "fuse.js";
import Link from "next/link";
import { Loader2, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { appProvenance } from "@/lib/apps/provenance";
import { AppMark } from "@/components/app-mark";
import { appInstallInputSchema } from "@/lib/apps/install-schema";
import { defaultInstallInput } from "@/lib/apps/install-defaults";
import type { InstalledAppView } from "@/lib/apps/install-service";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
    appsByCategory,
    findApp,
    isInstallable,
    promptedEnvVars,
    type AppCapability,
    type AppManifest
} from "@/lib/apps/catalog";
import {
    installAppAction,
    listInstallTargetsAction,
    listStorageConnectionsAction,
    type InstallTarget,
    type StorageConnectionOption
} from "./actions";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    PageHeader,
    Select,
    cn
} from "@polaris/ui";

const CAPABILITY_LABEL: Record<AppCapability, string> = {
    "messaging-hub": "Messaging",
    "messaging-channel": "Channel",
    "ai-assistant": "AI assistant",
    "game-manager": "Game servers",
    "game-server": "Game server",
    "camera-hub": "Cameras",
    "home-hub": "Home",
    tool: "Tool"
};

const STATUS_LABEL: Record<string, string> = {
    installing: "Installing",
    running: "Running",
    stopped: "Stopped",
    failed: "Failed"
};

export function MarketplaceView({ installed }: { installed: InstalledAppView[] }) {
    const router = useRouter();
    const [wizardApp, setWizardApp] = useState<AppManifest | null>(null);
    const [installingId, setInstallingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState("");
    const groups = appsByCategory();

    /**
     * One click installs the app the way its manifest describes it: on this
     * server, with its own defaults, and it opens on the app afterwards. Anyone
     * who wants a different server or NAS-backed storage has Configure, which is
     * the same install with the choices exposed.
     */
    function install(app: AppManifest): void {
        setError(null);
        setInstallingId(app.id);
        void installAppAction(defaultInstallInput(app))
            .then((result) => {
                if (result.error || !result.installedAppId) {
                    setError(result.error ?? "Could not install the app");
                    setInstallingId(null);
                    return;
                }
                router.push(app.opensAt ?? `/apps/installed/${result.installedAppId}`);
            })
            .catch(() => {
                setError("Could not install the app");
                setInstallingId(null);
            });
    }

    /**
     * Everything on offer, indexed once.
     *
     * Over the name, the summary and the category, weighted in that order: people
     * search a store for a name, occasionally for what a thing does, and the
     * category is the tie-break rather than the answer. The description is
     * deliberately left out - it is a paragraph, and matching inside one puts
     * apps at the top for a word buried in their third sentence.
     */
    const index = useMemo(() => {
        const all = groups.flatMap((group) => group.apps);
        return new Fuse(all, {
            threshold: 0.35,
            ignoreLocation: true,
            keys: [
                { name: "name", weight: 3 },
                { name: "summary", weight: 2 },
                { name: "category", weight: 1 }
            ]
        });
    }, [groups]);

    /**
     * What the grid draws: the categories, or one flat list of matches.
     *
     * A search that still drew category headings would draw four headings with
     * one card under each, which is a worse answer than the list. Within either,
     * what can be installed comes before what is only announced.
     */
    const shown = useMemo(() => {
        const term = query.trim();
        if (term) {
            const hits = index.search(term).map((hit) => hit.item);
            return hits.length === 0 ? [] : [{ category: "Results", apps: sortOffered(hits) }];
        }
        return groups.map((group) => ({ category: group.category, apps: sortOffered(group.apps) }));
    }, [groups, index, query]);

    const installedByCatalog = useMemo(() => {
        const map = new Map<string, number>();
        for (const item of installed) map.set(item.catalogId, (map.get(item.catalogId) ?? 0) + 1);
        return map;
    }, [installed]);

    // An app that only runs once per Polaris opens instead of offering a second
    // install that the server would refuse.
    const singletonInstall = useMemo(() => {
        const map = new Map<string, string>();
        for (const item of installed) if (!map.has(item.catalogId)) map.set(item.catalogId, item.id);
        return map;
    }, [installed]);

    return (
        <div className="flex flex-col gap-6">
            <PageHeader title="Marketplace" description="Install and run apps on your servers in one click." />

            {/* Above everything, the way a store puts it: the first thing
                somebody arriving with a name in mind reaches for. */}
            <div className="relative max-w-md">
                <Search className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
                <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search apps"
                    aria-label="Search apps"
                    className="pl-8"
                />
            </div>

            {error && <p className="text-sm text-danger">{error}</p>}

            {installed.length > 0 && !query.trim() && <InstalledSection installed={installed} />}

            {shown.length === 0 ? (
                <p className="text-muted-foreground py-10 text-center text-sm">
                    Nothing here matches that.
                </p>
            ) : null}

            {shown.map((group) => (
                <section key={group.category} className="flex flex-col gap-3">
                    <h2 className="text-sm font-medium text-muted-foreground">{group.category}</h2>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {group.apps.map((app) => (
                            <AppCard
                                key={app.id}
                                app={app}
                                installedCount={installedByCatalog.get(app.id) ?? 0}
                                openHref={openHrefFor(app, singletonInstall)}
                                installing={installingId === app.id}
                                disabled={installingId !== null}
                                onInstall={() => install(app)}
                                onConfigure={() => setWizardApp(app)}
                            />
                        ))}
                    </div>
                </section>
            ))}

            {wizardApp && <InstallWizard app={wizardApp} onClose={() => setWizardApp(null)} />}
        </div>
    );
}

/**
 * Where Open goes for an app that is already installed.
 *
 * Usually the app's own page. An app that runs nothing says where it really
 * lives (`opensAt`), because its install page would be a row of lifecycle
 * buttons over a status that can only ever read "not running" - a click that
 * exists to be clicked through.
 */
function openHrefFor(app: AppManifest, singletonInstall: Map<string, string>): string | null {
    if (!app.singleton || !singletonInstall.has(app.id)) return null;
    return app.opensAt ?? `/apps/installed/${singletonInstall.get(app.id)}`;
}

/**
 * What can be installed, before what is only announced.
 *
 * Coming soon is worth showing - it is why those manifests exist - but mixed in
 * it meant the first row of a category could be three things nobody can have.
 * Order is otherwise left alone: the catalog's is deliberate.
 */
function sortOffered(apps: readonly AppManifest[]): AppManifest[] {
    return [...apps].sort((left, right) => Number(left.comingSoon ?? false) - Number(right.comingSoon ?? false));
}

/**
 * The apps somebody has installed - the apps, not the containers they run.
 *
 * A camera relay, a face recognizer and six Minecraft servers are not eight
 * things anybody installed: they are what Places and Game servers run, and every
 * one of them was appearing here as an independent app with its own card. The
 * manifests have said so all along (`internal`, and `ownedBy` naming the app that
 * creates them); this screen was the one place not reading it.
 *
 * An install whose manifest is gone entirely is still shown. It is on somebody's
 * server, and hiding it because the catalog no longer describes it is how a
 * container becomes unreachable from the product that started it.
 */
function ownInstalls(installed: readonly InstalledAppView[]): InstalledAppView[] {
    return installed.filter((item) => {
        const manifest = findApp(item.catalogId);
        return !manifest || !manifest.internal;
    });
}

function InstalledSection({ installed }: { installed: InstalledAppView[] }) {
    const own = ownInstalls(installed);
    if (own.length === 0) return null;

    return (
        <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-muted-foreground">Installed</h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {own.map((item) => {
                    const manifest = findApp(item.catalogId);
                    return (
                        <Link key={item.id} href={manifest?.opensAt ?? `/apps/installed/${item.id}`}>
                            <Card className="transition-colors hover:border-border">
                                <CardBody className="flex items-center gap-3 py-3">
                                    {manifest ? (
                                        <AppMark app={manifest} size={36} />
                                    ) : (
                                        <div className="border-border bg-surface grid size-9 shrink-0 place-items-center rounded-md" />
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium">{item.name}</p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {manifest?.category ?? item.catalogId}
                                        </p>
                                    </div>
                                    <Badge
                                        className={cn(
                                            item.status === "failed" && "border-danger/40 text-danger",
                                            item.status === "running" && "border-success/40 text-success"
                                        )}
                                    >
                                        {STATUS_LABEL[item.status] ?? item.status}
                                    </Badge>
                                </CardBody>
                            </Card>
                        </Link>
                    );
                })}
            </div>
        </section>
    );
}

/**
 * One line naming who is behind an app.
 *
 * Both halves when they differ - somebody else's software in somebody else's
 * container is two facts and a reader deciding whether to run it wants both - and
 * one when they do not, because "Polaris - published by Polaris" says nothing
 * twice.
 */
function by(from: { developer: string; distributor: string }): string {
    return from.developer === from.distributor
        ? `By ${from.developer}`
        : `By ${from.developer} - image by ${from.distributor}`;
}

function AppCard({
    app,
    installedCount,
    openHref,
    installing,
    disabled,
    onInstall,
    onConfigure
}: {
    app: AppManifest;
    installedCount: number;
    /** Where its one instance lives, for an app that only runs once. */
    openHref: string | null;
    installing: boolean;
    /** Another install is running; one at a time keeps the target's deploy queue
     *  and this page's feedback honest. */
    disabled: boolean;
    onInstall: () => void;
    onConfigure: () => void;
}) {
    const installable = isInstallable(app);
    // Who made it and who ships the image, read off what the app installs rather
    // than typed in - see `appProvenance`.
    const from = appProvenance(app);
    return (
        <Card className={cn("flex h-full flex-col", app.comingSoon && "opacity-75")}>
            <CardBody className="flex h-full flex-col gap-3">
                <div className="flex items-start gap-3">
                    <AppMark app={app} size={40} />
                    <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{app.name}</p>
                        {/* Who is behind it, in the line the category used to
                            have to itself. The category is a heading two inches
                            above; whose software this is was nowhere. */}
                        <p className="text-muted-foreground truncate text-xs" title={by(from)}>
                            {by(from)}
                        </p>
                    </div>
                </div>
                <p className="line-clamp-3 text-sm text-muted-foreground">{app.summary}</p>
                <div className="flex flex-wrap gap-1">
                    {app.capabilities.map((capability) => (
                        <Badge key={capability}>{CAPABILITY_LABEL[capability]}</Badge>
                    ))}
                </div>
                {app.consent && (
                    <p className="text-xs text-muted-foreground">
                        Installing accepts the{" "}
                        <a
                            href={app.consent.url}
                            target="_blank"
                            rel="noreferrer"
                            className="underline underline-offset-2 hover:text-foreground"
                        >
                            {app.consent.label}
                        </a>
                        .
                    </p>
                )}
                <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                    {installedCount > 0 ? (
                        <span className="text-xs text-muted-foreground">{installedCount} installed</span>
                    ) : (
                        <span />
                    )}
                    {openHref ? (
                        <Link href={openHref}>
                            <Button size="sm" variant="secondary">
                                Open
                            </Button>
                        </Link>
                    ) : installable ? (
                        <div className="flex items-center gap-1">
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={onConfigure}
                                disabled={disabled}
                                title="Choose the server, storage and settings first"
                            >
                                Configure
                            </Button>
                            <Button size="sm" onClick={onInstall} disabled={disabled}>
                                {installing && <Loader2 className="size-4 animate-spin" />}
                                {installing ? "Installing" : "Install"}
                            </Button>
                        </div>
                    ) : (
                        <Badge className="text-muted-foreground">Coming soon</Badge>
                    )}
                </div>
            </CardBody>
        </Card>
    );
}

function InstallWizard({ app, onClose }: { app: AppManifest; onClose: () => void }) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const template = app.template;
    const volumes = template?.volumes ?? [];
    // Only what an operator answers: the generated credentials and the licence the
    // install itself accepts are not fields.
    const envFields = promptedEnvVars(app);

    const [name, setName] = useState(app.name);
    const [serverId, setServerId] = useState("");
    const [targets, setTargets] = useState<InstallTarget[] | null>(null);
    const [connections, setConnections] = useState<StorageConnectionOption[]>([]);
    const [storage, setStorage] = useState<Record<string, { backing: "local" | "nas"; connectionId?: string }>>(
        () => Object.fromEntries(volumes.map((volume) => [volume.name, { backing: "local" as const }]))
    );
    const [env, setEnv] = useState<Record<string, string>>(
        () => Object.fromEntries(envFields.map((field) => [field.key, field.default ?? ""]))
    );
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        void Promise.all([listInstallTargetsAction(), listStorageConnectionsAction()])
            .then(([loadedTargets, loadedConnections]) => {
                if (!active) return;
                setTargets(loadedTargets);
                setConnections(loadedConnections);
                setServerId((current) => current || loadedTargets[0]?.id || "local");
            })
            .catch(() => active && setError("Could not load your servers"));
        return () => {
            active = false;
        };
    }, []);

    function submit() {
        setError(null);
        const input = {
            catalogId: app.id,
            name,
            serverId,
            storage: volumes.map((volume) => {
                const choice = storage[volume.name];
                return {
                    volumeName: volume.name,
                    backing: choice?.backing ?? "local",
                    connectionId: choice?.backing === "nas" ? choice.connectionId : undefined
                };
            }),
            env: envFields.map((field) => ({ key: field.key, value: env[field.key] ?? field.default ?? "" }))
        };
        const parsed = appInstallInputSchema.safeParse(input);
        if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? "Check the form and try again");
            return;
        }
        startTransition(async () => {
            const result = await installAppAction(parsed.data);
            if (result.error || !result.installedAppId) {
                setError(result.error ?? "Could not install the app");
                return;
            }
            // Land on the app that was just installed, the way installing from the
            // card does - it is deploying, and its page is where that is visible.
            router.push(`/apps/installed/${result.installedAppId}`);
        });
    }

    const Icon = app.icon;
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Icon className="size-5" /> Install {app.name}
                    </DialogTitle>
                    <DialogDescription>{app.description}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Name</span>
                        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="My app" />
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Server</span>
                        <Select
                            value={serverId}
                            onValueChange={setServerId}
                            placeholder={targets ? "Choose a server" : "Loading..."}
                            options={(targets ?? []).map((target) => ({ value: target.id, label: target.name }))}
                        />
                    </label>

                    {volumes.length > 0 && (
                        <div className="flex flex-col gap-3">
                            <span className="text-sm font-medium">Storage</span>
                            {volumes.map((volume) => {
                                const choice = storage[volume.name] ?? { backing: "local" as const };
                                return (
                                    <div key={volume.name} className="flex flex-col gap-2 rounded-md border border-border p-3">
                                        <span className="text-sm">{volume.label}</span>
                                        <Select
                                            value={choice.backing}
                                            onValueChange={(value) =>
                                                setStorage((current) => ({
                                                    ...current,
                                                    [volume.name]: { backing: value as "local" | "nas" }
                                                }))
                                            }
                                            options={[
                                                { value: "local", label: "This server" },
                                                { value: "nas", label: "NAS" }
                                            ]}
                                        />
                                        {choice.backing === "nas" &&
                                            (connections.length > 0 ? (
                                                <Select
                                                    value={choice.connectionId ?? ""}
                                                    onValueChange={(value) =>
                                                        setStorage((current) => ({
                                                            ...current,
                                                            [volume.name]: { backing: "nas", connectionId: value }
                                                        }))
                                                    }
                                                    placeholder="Choose a NAS"
                                                    options={connections.map((connection) => ({
                                                        value: connection.id,
                                                        label: connection.name
                                                    }))}
                                                />
                                            ) : (
                                                <p className="text-xs text-muted-foreground">
                                                    No NAS connections yet. Add one in Drive first.
                                                </p>
                                            ))}
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {envFields.length > 0 && (
                        <div className="flex flex-col gap-3">
                            <span className="text-sm font-medium">Configuration</span>
                            {envFields.map((field) => (
                                <label key={field.key} className="flex flex-col gap-1 text-sm">
                                    <span>{field.label}</span>
                                    {field.options ? (
                                        <Select
                                            value={env[field.key] ?? field.default ?? ""}
                                            onValueChange={(value) =>
                                                setEnv((current) => ({ ...current, [field.key]: value }))
                                            }
                                            options={field.options}
                                        />
                                    ) : (
                                        <Input
                                            type={field.secret ? "password" : "text"}
                                            value={env[field.key] ?? ""}
                                            onChange={(event) =>
                                                setEnv((current) => ({ ...current, [field.key]: event.target.value }))
                                            }
                                        />
                                    )}
                                    {field.help && <span className="text-xs text-muted-foreground">{field.help}</span>}
                                </label>
                            ))}
                        </div>
                    )}

                    {error && <p className="text-sm text-danger">{error}</p>}

                    {app.consent && (
                        <p className="text-xs text-muted-foreground">
                            Installing accepts the{" "}
                            <a
                                href={app.consent.url}
                                target="_blank"
                                rel="noreferrer"
                                className="underline underline-offset-2 hover:text-foreground"
                            >
                                {app.consent.label}
                            </a>
                            .
                        </p>
                    )}

                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            Cancel
                        </Button>
                        <Button onClick={submit} disabled={pending || !serverId}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Install
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
