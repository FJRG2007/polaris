"use client";

/**
 * Asking players for a password of their own.
 *
 * A Minecraft server with Mojang authentication off cannot tell one player from
 * another: the client sends a name and the server believes it. The player list
 * still closes the server - an unlisted name does not get in - but it closes it
 * to names, and anybody who learns a listed name can type it. That is the whole
 * gap, and it is the reason the ask exists: somebody who is already allowed in
 * should have to prove they are themselves.
 *
 * What this installs does that the only way a server can without Mojang: each
 * player sets a password the first time they join and gives it on every join
 * after. It is a project on the server's own list rather than anything Polaris
 * runs, so it is installed and removed the same way every other mod and plugin
 * is, and the Mods screen shows it sitting there afterwards.
 *
 * Which project depends on what the server runs, and there is no single answer -
 * a plugin has no build for a modded server and a mod has none for Paper. Both
 * of the ones offered here install on their own, with nothing else to add
 * alongside them, which matters because a dependency that cannot be resolved is a
 * server that does not come back up.
 *
 * Java only, and the card says so on Bedrock rather than going quiet. Bedrock
 * loads neither plugins nor mods and has no Modrinth list at all, so there is
 * nothing here to offer it - but its own authentication switch sits on this same
 * screen, and telling that operator to "switch to Paper, or to a mod loader"
 * would be advice about software their edition does not have.
 */

import { useConfirm } from "@/components/confirm-dialog";
import * as modrinth from "@/lib/apps/minecraft/modrinth";
import { useEffect, useState, useTransition } from "react";
import { KeyRound, Loader2, TriangleAlert } from "lucide-react";
import type { MinecraftEdition } from "@/lib/apps/minecraft/service";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { projectFitsAction, updateServerSettingsAction } from "./minecraft-actions";

const PROJECTS_KEY = "MODRINTH_PROJECTS";

/** The plugin for a server that runs plugins, and the mod for one that runs mods.
 *  Both install with no dependencies of their own on every release they publish,
 *  which is what makes them safe to add behind one switch. */
const GUARD_BY_KIND = { plugin: "mylogin", mod: "auth" } as const;

/** What this server could install, or null when it can install nothing at all -
 *  a vanilla server loads neither plugins nor mods. */
function guardFor(software: string): string | null {
    const loader = modrinth.loaderForType(software);
    if (!loader) return null;
    return modrinth.isPluginLoader(loader) ? GUARD_BY_KIND.plugin : GUARD_BY_KIND.mod;
}

/** Whether the list already carries that project, whatever version or suffix the
 *  entry was written with. */
function listed(projects: string, slug: string): boolean {
    return modrinth
        .parseProjectList(projects)
        .some((entry) => modrinth.projectSlug(entry)?.toLowerCase() === slug);
}

export function MinecraftJoinPassword({
    installedAppId,
    edition,
    projects,
    software,
    playersOnline,
    onSaved
}: {
    installedAppId: string;
    /** Which Minecraft this is. Bedrock takes none of this, and is told so. */
    edition: MinecraftEdition;
    /** `MODRINTH_PROJECTS` as it stands, which is the only record of what is on. */
    projects: string;
    /** The server's `TYPE`, which decides whether it takes plugins or mods. */
    software: string;
    playersOnline: number;
    onSaved: () => void;
}) {
    const [confirm, confirmElement] = useConfirm();
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const java = edition === "java";
    const guard = java ? guardFor(software) : null;
    const [on, setOn] = useState(false);

    // Held in state so the switch answers the press immediately, and taken from
    // the server again whenever its answer changes underneath - the Mods screen
    // edits the same list.
    useEffect(() => {
        setOn(guard !== null && listed(projects, guard));
    }, [projects, guard]);

    function apply(wanted: boolean): void {
        if (!guard) return;
        setError(null);
        startTransition(async () => {
            // Asked before the operator is asked anything, because the answer that
            // matters is whether this server can load it at all - and finding that
            // out after the restart means finding it out from a server that is
            // down. Only on the way in: taking a project off the list cannot fail
            // for want of a build.
            if (wanted) {
                const fit = await projectFitsAction({ installedAppId, slug: guard });
                if (!fit.fits) {
                    setError(
                        `${guard} has no build for the release this server runs${fit.version ? ` (${fit.version})` : ""}. Turning this on would stop the server rather than close it.`
                    );
                    return;
                }
            }
            const said =
                playersOnline > 0
                    ? `${playersOnline} ${playersOnline === 1 ? "player is" : "players are"} connected and will be disconnected.`
                    : "The server restarts to install it.";
            const asked = await confirm({
                title: wanted
                    ? "Restart to ask players for a password?"
                    : "Restart to stop asking?",
                description: wanted
                    ? `${said} Everybody sets their own the next time they join.`
                    : `${said} Anybody on the player list gets in on their name alone afterwards.`,
                confirmLabel: wanted ? "Turn on and restart" : "Turn off and restart",
                danger: !wanted
            });
            if (!asked) return;

            const entries = modrinth.parseProjectList(projects);
            const without = entries.filter(
                (entry) => modrinth.projectSlug(entry)?.toLowerCase() !== guard
            );
            const next = wanted ? [...without, guard] : without;
            const result = await updateServerSettingsAction(installedAppId, [
                { key: PROJECTS_KEY, value: modrinth.formatProjectList(next) }
            ]);
            if (result.error) {
                setError(result.error);
                return;
            }
            setOn(wanted);
            onSaved();
        });
    }

    return (
        <Card>
            {confirmElement}
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <KeyRound className="size-4 text-primary" />
                    Password on join
                    {on && <Badge variant="success">On</Badge>}
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                    Players set a password the first time they join and give it every time after.
                    Worth having when Mojang authentication is off, because without it the server
                    has only a name to go on and anyone who knows a listed name can use it.
                </p>

                {!java ? (
                    <p className="flex items-start gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
                        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                        Bedrock has no equivalent. It loads neither plugins nor mods, so the player
                        list and the addresses it is bound to are what closes this server.
                    </p>
                ) : guard === null ? (
                    <p className="flex items-start gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
                        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                        This server runs neither plugins nor mods, so there is nothing to install.
                        Switch it to Paper, or to a mod loader, from Settings first.
                    </p>
                ) : (
                    <p className="text-xs text-muted-foreground">
                        Installs <span className="font-mono">{guard}</span> from Modrinth, which the
                        Mods screen shows afterwards like anything else on the list. If it cannot be
                        installed the server says so on startup rather than starting without it.
                    </p>
                )}

                {error && <p className="text-sm text-danger">{error}</p>}

                {/* No button at all on Bedrock rather than one that can never be
                    pressed: there is nothing behind it to install, and a disabled
                    control reads as something the reader is one step away from. */}
                {java && (
                    <div className="flex justify-end">
                        <Button
                            size="sm"
                            variant={on ? "outline" : "primary"}
                            disabled={pending || guard === null}
                            onClick={() => apply(!on)}
                        >
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            {on ? "Turn off" : "Turn on"}
                        </Button>
                    </div>
                )}
            </CardBody>
        </Card>
    );
}
