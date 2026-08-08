"use client";

/**
 * The marketplace grid and the per-app install wizard. The catalog is imported
 * directly (it is static and client-safe); the installed state comes from the
 * server. Installing opens a dialog that reuses Deploy's notions of a target
 * server and per-volume storage (a server-local volume or a NAS mount), then
 * calls the deploy.manage-gated install action.
 */

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
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
                router.push(`/apps/installed/${result.installedAppId}`);
            })
            .catch(() => {
                setError("Could not install the app");
                setInstallingId(null);
            });
    }

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

            {error && <p className="text-sm text-danger">{error}</p>}

            {installed.length > 0 && <InstalledSection installed={installed} />}

            {groups.map((group) => (
                <section key={group.category} className="flex flex-col gap-3">
                    <h2 className="text-sm font-medium text-muted-foreground">{group.category}</h2>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {group.apps.map((app) => (
                            <AppCard
                                key={app.id}
                                app={app}
                                installedCount={installedByCatalog.get(app.id) ?? 0}
                                openHref={
                                    app.singleton && singletonInstall.has(app.id)
                                        ? `/apps/installed/${singletonInstall.get(app.id)}`
                                        : null
                                }
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

function InstalledSection({ installed }: { installed: InstalledAppView[] }) {
    return (
        <section className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-muted-foreground">Installed</h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {installed.map((item) => {
                    const manifest = findApp(item.catalogId);
                    const Icon = manifest?.icon;
                    return (
                        <Link key={item.id} href={`/apps/installed/${item.id}`}>
                            <Card className="transition-colors hover:border-border">
                                <CardBody className="flex items-center gap-3 py-3">
                                    <div className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-surface">
                                        {Icon ? <Icon className="size-4" /> : null}
                                    </div>
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
    const Icon = app.icon;
    const installable = isInstallable(app);
    return (
        <Card className="flex h-full flex-col">
            <CardBody className="flex h-full flex-col gap-3">
                <div className="flex items-start gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-surface">
                        <Icon className="size-5" />
                    </div>
                    <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{app.name}</p>
                        <p className="text-xs text-muted-foreground">{app.category}</p>
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
