"use client";

/**
 * A plugin page's line about its device's official software: open it while
 * it is installed, and put it back as it was after Polaris stopped or
 * uninstalled it. Draws nothing for a plugin with none, or an older app.
 */

import { Button, useToast } from "@polaris/ui";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { lookOfficial, readOfficialRestore, type PluginsBridge, type OfficialLook } from "@/lib/device-plugins-client";

type Say = (key: string, values?: Record<string, string | number>) => string;

export function OfficialSoftware({ id, bridge }: { id: string; bridge: PluginsBridge }) {
    const t = useTranslations("account");
    const say = useCallback<Say>((key, values) => (t as unknown as Say)(`plugins.${key}`, values), [t]);
    const toast = useToast();
    const [look, setLook] = useState<OfficialLook | null>(null);
    const [busy, setBusy] = useState<"restore" | "launch" | null>(null);

    const load = useCallback(() => lookOfficial(bridge, id).then(setLook), [bridge, id]);
    useEffect(() => {
        let live = true;
        void lookOfficial(bridge, id).then((value) => live && setLook(value));
        return () => {
            live = false;
        };
    }, [bridge, id]);

    if (!bridge.official || !look) return null;
    const app = look.found?.app ?? null;
    const restorable = look.backup !== null && !look.backup.restored;
    if (!app && !restorable) return null;

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
        if (!started) toast.show({ title: say("official.launchFailed") });
    };

    return (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
            <span className="min-w-0 text-muted-foreground">{restorable ? say(`official.backup.${look.backup?.choice ?? "stop"}`) : say("official.installed", { app: app?.displayName ?? say("official.appName") })}</span>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
                {app ? (
                    <Button size="sm" variant="secondary" disabled={busy !== null} aria-busy={busy === "launch"} onClick={() => void launch()}>
                        {say("official.launch")}
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
