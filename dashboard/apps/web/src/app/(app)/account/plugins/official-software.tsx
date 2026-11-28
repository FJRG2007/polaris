"use client";

/**
 * A plugin page's line about its device's official software: open it while
 * it is installed, and put it back as it was after Polaris stopped or
 * uninstalled it. While Polaris' own driver holds the device the official app
 * cannot reach it, so the line says it is not needed and offers no Open.
 * Draws nothing for a plugin with none, or an older app.
 */

import { Button, cn, settingType, useToast } from "@polaris/ui";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { lookOfficial, readOfficialRestore, type PluginsBridge, type OfficialLook } from "@/lib/device-plugins-client";

type Say = (key: string, values?: Record<string, string | number>) => string;

/** The last look per plugin for the tab's lifetime: the line draws at once on the next visit, and is looked at again behind it. */
const lastLooks = new Map<string, OfficialLook | null>();

export function OfficialSoftware({ id, bridge }: { id: string; bridge: PluginsBridge }) {
    const t = useTranslations("account");
    const say = useCallback<Say>((key, values) => (t as unknown as Say)(`plugins.${key}`, values), [t]);
    const toast = useToast();
    const [look, setLook] = useState<OfficialLook | null>(() => lastLooks.get(id) ?? null);
    const [busy, setBusy] = useState<"restore" | "launch" | null>(null);

    const load = useCallback(
        () =>
            lookOfficial(bridge, id).then((value) => {
                lastLooks.set(id, value);
                setLook(value);
            }),
        [bridge, id]
    );
    useEffect(() => {
        let live = true;
        setLook(lastLooks.get(id) ?? null);
        void lookOfficial(bridge, id).then((value) => {
            lastLooks.set(id, value);
            if (live) setLook(value);
        });
        return () => {
            live = false;
        };
    }, [bridge, id]);

    if (!bridge.official || !look) return null;
    const app = look.found?.app ?? null;
    const restorable = look.backup !== null && !look.backup.restored;
    if (!app && !restorable) return null;
    const unneeded = look.driverInUse && app !== null;

    const restore = async () => {
        if (!bridge.official) return;
        setBusy("restore");
        const outcome = readOfficialRestore(await bridge.official(id, { kind: "restore" }).catch(() => null));
        setBusy(null);
        toast.show({ title: say(`official.restore.${outcome}`) });
        await load();
    };
    const launch = async () => {
        if (!bridge.official) return;
        setBusy("launch");
        const started = (await bridge.official(id, { kind: "launch" }).catch(() => false)) === true;
        setBusy(null);
        if (!started) toast.show({ title: say("official.launchFailed", { app: app?.displayName ?? say("official.appName") }) });
    };

    return (
        <div className={cn(settingType.body, "flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2")}>
            <span className="min-w-0 text-muted-foreground">{unneeded ? say("official.notNeeded", { app: app.displayName }) : restorable ? say(`official.backup.${look.backup?.choice ?? "stop"}`) : say("official.installed", { app: app?.displayName ?? say("official.appName") })}</span>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
                {app && !unneeded ? (
                    <Button size="sm" variant="secondary" disabled={busy !== null} aria-busy={busy === "launch"} onClick={() => void launch()}>
                        {say("official.launch", { app: app.displayName })}
                    </Button>
                ) : null}
                {restorable ? (
                    <Button size="sm" variant="secondary" disabled={busy !== null} aria-busy={busy === "restore"} onClick={() => void restore()}>
                        {say("official.restoreAction")}
                    </Button>
                ) : null}
            </div>
        </div>
    );
}
