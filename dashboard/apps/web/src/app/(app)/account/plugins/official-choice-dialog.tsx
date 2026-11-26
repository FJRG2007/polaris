"use client";

/**
 * Installing a plugin whose device's official software is on this computer
 * (the desktop app finds it and names it): what to do with that software first,
 * what Polaris asks for, and what it carries over from it. Answered by the
 * desktop app (`plugins.official`); an app older than that never gets here.
 */

import { useCallback, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { pluginRequirements, pluginText, type PluginEntry, type PluginPlatform } from "@polaris/core/device-plugins";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, useToast } from "@polaris/ui";
import { lookOfficial, readOfficialChoice, PERMISSION_KEY, type PluginsBridge, type OfficialControl, type OfficialLook } from "@/lib/device-plugins-client";

type Choice = "stop" | "uninstall" | "keep";
type Fate = "mapped" | "kept" | "dropped";

const CHOICES: readonly Choice[] = ["stop", "uninstall", "keep"];

type Say = (key: string, values?: Record<string, string | number>) => string;

function useSay(): Say {
    const t = useTranslations("account");
    return useCallback((key, values) => (t as unknown as Say)(`plugins.${key}`, values), [t]);
}

function fateOf(control: OfficialControl): Fate {
    return control.mapped ? "mapped" : control.kept ? "kept" : "dropped";
}

/** The controls of the official app, by page, in the order the device has them. */
export function controlsByPage(controls: readonly OfficialControl[]): [number, OfficialControl[]][] {
    const pages = new Map<number, OfficialControl[]>();
    for (const control of controls) pages.set(control.page, [...(pages.get(control.page) ?? []), control]);
    for (const list of pages.values()) list.sort((a, b) => (a.control === b.control ? a.slot - b.slot : a.control === "knob" ? -1 : 1));
    return [...pages.entries()].sort(([a], [b]) => a - b);
}

const FATE_TONE: Record<Fate, string> = {
    mapped: "text-foreground",
    kept: "text-muted-foreground",
    dropped: "text-muted-foreground line-through decoration-muted-foreground/60"
};

function ImportSummary({ look, say }: { look: OfficialLook; say: Say }) {
    const controls = look.imported?.controls ?? [];
    if (controls.length === 0) return <p className="text-sm text-muted-foreground">{say("official.importNone")}</p>;
    const count = (fate: Fate) => controls.filter((control) => fateOf(control) === fate).length;
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <p className="text-sm">{say("official.importCounts", { mapped: count("mapped"), kept: count("kept"), dropped: count("dropped") })}</p>
            <div className="flex max-h-56 min-w-0 flex-col gap-3 overflow-y-auto overscroll-contain rounded-md border border-border p-3">
                {controlsByPage(controls).map(([page, list]) => (
                    <section key={page} className="flex min-w-0 flex-col gap-1" aria-label={say("official.page", { number: page })}>
                        <h4 className="text-xs font-medium text-muted-foreground">{say("official.page", { number: page })}</h4>
                        <ul className="flex min-w-0 flex-col gap-1">
                            {list.map((control) => {
                                const fate = fateOf(control);
                                const what = control.name || control.official;
                                return (
                                    <li key={`${control.control}-${control.slot}`} className="flex min-w-0 items-baseline justify-between gap-3 text-sm">
                                        <span className={`min-w-0 truncate ${FATE_TONE[fate]}`} title={`${control.official}${control.name ? ` - ${control.name}` : ""}`}>
                                            {say(`official.control.${control.control}`, { number: control.slot })}
                                            {what ? `: ${what}` : ""}
                                        </span>
                                        <span className="shrink-0 text-xs text-muted-foreground">{say(`official.fate.${fate}`)}</span>
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                ))}
            </div>
        </div>
    );
}

/**
 * The install entry point's first step for a plugin with official software:
 * `offer(entry)` resolves true when it showed the choice (and carries it out),
 * false when there is nothing to choose and the plain install should run.
 */
export function useOfficialChoice(bridge: PluginsBridge | null, platform: PluginPlatform | null = null): [(entry: PluginEntry) => Promise<boolean>, ReactNode] {
    const say = useSay();
    const locale = useLocale();
    const toast = useToast();
    const [open, setOpen] = useState<{ entry: PluginEntry; look: OfficialLook } | null>(null);
    const [busy, setBusy] = useState<Choice | null>(null);

    const offer = useCallback(
        async (entry: PluginEntry) => {
            const look = await lookOfficial(bridge, entry.id);
            if (!look?.found) return false;
            setOpen({ entry, look });
            return true;
        },
        [bridge]
    );

    const choose = async (choice: Choice) => {
        if (!open || !bridge?.official || busy) return;
        setBusy(choice);
        const answer = readOfficialChoice(await bridge.official(open.entry.id, { kind: "choose", choice, accepted: open.entry.permissions, requires: pluginRequirements(open.entry, platform).map((item) => item.key) }).catch(() => null));
        setBusy(null);
        if (answer.ok) {
            setOpen(null);
            return;
        }
        if (answer.reason === "cancelled") return;
        const title = answer.reason === "install" ? say(`failure.${answer.install === "app-version" ? "appVersion" : (answer.install ?? "other")}`) : say(`official.failure.${answer.reason}`);
        toast.show({ title });
    };

    const name = open?.entry.name ?? "";
    const app = open?.look.found?.app?.displayName ?? say("official.appName");
    const element = (
        <Dialog open={open !== null} onOpenChange={(next) => !next && !busy && setOpen(null)}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle className="pe-8">{say("official.title", { name })}</DialogTitle>
                    <DialogDescription>{say("official.intro", { app })}</DialogDescription>
                </DialogHeader>
                {open ? (
                    <div className="flex min-w-0 flex-col gap-4">
                        <div className="flex min-w-0 flex-col gap-2" role="group" aria-label={say("official.choices")}>
                            {CHOICES.map((choice) => (
                                <Button
                                    key={choice}
                                    variant={choice === "stop" ? "primary" : "secondary"}
                                    className="h-auto min-w-0 flex-col items-start gap-0.5 whitespace-normal py-2 text-start"
                                    disabled={busy !== null || (choice === "uninstall" && !open.look.found?.app)}
                                    aria-busy={busy === choice}
                                    onClick={() => void choose(choice)}
                                >
                                    <span className="font-medium">{say(`official.choice.${choice}`)}</span>
                                    <span className="text-xs font-normal opacity-80">{say(`official.choiceHint.${choice}`, { app })}</span>
                                </Button>
                            ))}
                            <p className="text-xs text-muted-foreground">{say("official.adminNote")}</p>
                        </div>
                        <section className="flex min-w-0 flex-col gap-1" aria-label={say("official.permissions")}>
                            <h3 className="text-sm font-medium">{say("official.permissions")}</h3>
                            {open.entry.permissions.length === 0 && pluginRequirements(open.entry, platform).length === 0 ? (
                                <p className="text-sm text-muted-foreground">{say("install.none")}</p>
                            ) : (
                                <ul className="list-disc ps-5 text-sm">
                                    {open.entry.permissions.map((permission) => (
                                        <li key={permission}>{say(`permission.${PERMISSION_KEY[permission]}`)}</li>
                                    ))}
                                    {pluginRequirements(open.entry, platform).map((requirement) => (
                                        <li key={`requires.${requirement.key}`}>{pluginText(requirement.label, locale)}</li>
                                    ))}
                                </ul>
                            )}
                        </section>
                        <section className="flex min-w-0 flex-col gap-1" aria-label={say("official.import")}>
                            <h3 className="text-sm font-medium">{say("official.import")}</h3>
                            <ImportSummary look={open.look} say={say} />
                        </section>
                    </div>
                ) : null}
                <DialogFooter>
                    <Button variant="ghost" disabled={busy !== null} onClick={() => setOpen(null)}>
                        {say("official.cancel")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
    return [offer, element];
}
