"use client";

/**
 * Dashboard shell for an installed app: lifecycle controls, an app-specific panel
 * keyed by the catalog id, and the runtime log (reusing Deploy's log endpoint and
 * the shared LogViewer). Apps with an adapted panel lead with it and keep the raw
 * log as a collapsible secondary section, so opening the app is not just a wall of
 * logs; apps without one show the log directly.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useRuntimeLog } from "./use-runtime-log";
import { MinecraftPanel } from "./minecraft-panel";
import { LogViewer } from "@/components/log-viewer";
import { MessagingBridgePanel } from "./messaging-bridge-panel";
import type { GameContext } from "./page";
import type { InstalledAppDetail, InstalledAppSetting } from "@/lib/apps/install-service";
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, Play, RefreshCw, Square, Trash2 } from "lucide-react";
import {
    redeployInstalledAppAction,
    setInstalledAppRunningAction,
    uninstallInstalledAppAction
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
    PageHeader,
    cn
} from "@polaris/ui";

const STATUS_LABEL: Record<string, string> = {
    installing: "Installing",
    running: "Running",
    stopped: "Stopped",
    failed: "Failed"
};

/**
 * The adapted dashboard an app brings with it, by catalog id. An app without one
 * falls back to the shell's own lifecycle controls and runtime log, which is what
 * the shell renders around this either way. New apps are added here and nowhere
 * else in the shell.
 */
function adaptedPanelFor(
    app: InstalledAppDetail,
    settings: InstalledAppSetting[],
    running: boolean,
    game: GameContext | null
) {
    switch (app.catalogId) {
        case "messaging-bridge":
            return <MessagingBridgePanel />;
        // The manager runs nothing itself - its dashboard is the Game servers page,
        // and this is the door to it rather than a second copy of the list.
        case "minecraft-manager":
            return (
                <Card>
                    <CardBody className="flex flex-col items-center gap-3 py-10 text-center">
                        <p className="text-sm font-medium">Your servers live on the Game servers page</p>
                        <p className="max-w-md text-sm text-muted-foreground">
                            Create as many as you want, Java or Bedrock, each with its own address, console, players and
                            mods. The manager itself runs nothing.
                        </p>
                        <Link href="/apps/games">
                            <Button size="sm">Open Game servers</Button>
                        </Link>
                    </CardBody>
                </Card>
            );
        // Both editions are driven by the same panel; what differs is underneath,
        // and the panel offers what the edition it is looking at actually has.
        case "minecraft":
        case "minecraft-bedrock":
            return (
                <MinecraftPanel
                    installedAppId={app.id}
                    applicationId={app.applicationId}
                    settings={settings}
                    running={running}
                    game={game}
                />
            );
        default:
            return null;
    }
}

export function InstalledAppDashboard({
    app,
    settings,
    game = null
}: {
    app: InstalledAppDetail;
    /** What the app was deployed with, for a panel that edits its settings. */
    settings: InstalledAppSetting[];
    /** For a game server: its address, and what still has to be opened for
     *  players outside this network. Null for anything that is not one. */
    game?: GameContext | null;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [confirmingUninstall, setConfirmingUninstall] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const running = app.applicationStatus === "running";
    const applicationId = app.applicationId;
    // Apps with an adapted panel lead with it and fold the raw log away by default.
    const adaptedPanel = adaptedPanelFor(app, settings, running, game);
    const [showLogs, setShowLogs] = useState(adaptedPanel === null);
    const { log, refresh: loadLog } = useRuntimeLog(applicationId, running && showLogs);
    // Back goes where this app is listed, which for a game server is the Game
    // servers page rather than the marketplace it was installed from.
    const isGame = app.catalogId.startsWith("minecraft");
    const backHref = isGame ? "/apps/games" : "/apps/marketplace";
    const backLabel = isGame ? "Game servers" : "Marketplace";

    function run(action: () => Promise<{ error?: string }>) {
        setError(null);
        startTransition(async () => {
            const result = await action();
            if (result.error) {
                setError(result.error);
                return;
            }
            router.refresh();
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <Link
                href={backHref}
                className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
                <ArrowLeft className="size-4" /> {backLabel}
            </Link>

            <PageHeader
                title={app.name}
                description={[app.catalogName, app.serverName].filter(Boolean).join(" - ")}
                actions={
                    <div className="flex items-center gap-2">
                        <Badge
                            className={cn(
                                app.applicationStatus === "failed" && "border-danger/40 text-danger",
                                running && "border-success/40 text-success"
                            )}
                        >
                            {app.applicationStatus ? (STATUS_LABEL[app.applicationStatus] ?? app.applicationStatus) : "-"}
                        </Badge>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => run(() => setInstalledAppRunningAction(app.id, !running))}
                            disabled={pending || !applicationId}
                        >
                            {running ? <Square className="size-4" /> : <Play className="size-4" />}
                            {running ? "Stop" : "Start"}
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => run(() => redeployInstalledAppAction(app.id))}
                            disabled={pending || !applicationId}
                        >
                            <RefreshCw className="size-4" /> Redeploy
                        </Button>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmingUninstall(true)}
                            disabled={pending}
                        >
                            <Trash2 className="size-4" /> Uninstall
                        </Button>
                    </div>
                }
            />

            {error && <p className="text-sm text-danger">{error}</p>}

            {adaptedPanel}

            <Card>
                <CardBody className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <button
                            type="button"
                            onClick={() => setShowLogs((value) => !value)}
                            className="flex items-center gap-1 text-sm font-medium hover:text-foreground"
                        >
                            {showLogs ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                            Runtime logs
                        </button>
                        {showLogs && (
                            <Button size="sm" variant="ghost" onClick={() => void loadLog()} disabled={!applicationId}>
                                <RefreshCw className="size-4" /> Refresh
                            </Button>
                        )}
                    </div>
                    {showLogs && (
                        <LogViewer
                            log={log}
                            name={app.name}
                            searchable
                            emptyText={running ? "Waiting for output..." : "The app is not running."}
                            className="h-80"
                        />
                    )}
                </CardBody>
            </Card>

            <Dialog open={confirmingUninstall} onOpenChange={setConfirmingUninstall}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Uninstall {app.name}?</DialogTitle>
                        <DialogDescription>
                            This tears down its container and removes it from your apps. Data on server-local volumes is
                            lost; data on a NAS mount is kept.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => setConfirmingUninstall(false)} disabled={pending}>
                            Cancel
                        </Button>
                        <Button
                            variant="danger"
                            onClick={() =>
                                startTransition(async () => {
                                    const result = await uninstallInstalledAppAction(app.id);
                                    if (result.error) {
                                        setError(result.error);
                                        setConfirmingUninstall(false);
                                        return;
                                    }
                                    router.push(backHref);
                                })
                            }
                            disabled={pending}
                        >
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            Uninstall
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
