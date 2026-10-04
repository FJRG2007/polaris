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
 * server that does not come back up. `join-guard` makes that choice, and it makes
 * it for the create path too, so what this screen calls On is the same project a
 * new server already arrived with.
 *
 * A new server has it on already. This screen is where it is turned off, and
 * where somebody arriving at an older server turns it on - the switch stopped
 * being the only way the guard ever got installed, because a switch only protects
 * the servers whose owner went looking for it.
 *
 * Where Polaris's own login has a build (Paper, Purpur and Spigot from 1.20.6,
 * and NeoForge 1.21.4) and Polaris has a public address, it is the only login
 * this card manages, unless the server already has a login Polaris does not
 * manage - see
 * `minecraft-polaris-login`. A server still on the Modrinth project is not
 * offered a second choice: Turn on replaces it directly, and says so, because
 * replacing it makes every player register again. Without a public address the
 * card keeps the Modrinth behaviour below instead. While the mod is on, it is
 * the guard this card describes and the one Turn off takes away.
 *
 * Java only, and the card says so on Bedrock rather than going quiet. Bedrock
 * loads neither plugins nor mods and has no Modrinth list at all, so there is
 * nothing here to offer it - but its own authentication switch sits on this same
 * screen, and telling that operator to "switch to Paper, or to a mod loader"
 * would be advice about software their edition does not have.
 */

import { useState, type ReactNode } from "react";
import { useGameText } from "../game-text";
import * as modrinth from "../../lib/minecraft/modrinth";
import { setLoginAction } from "./minecraft-login-actions";
import { KeyRound, Loader2, TriangleAlert } from "lucide-react";
import * as polarisLogin from "../../lib/minecraft/polaris-login";
import type { MinecraftEdition } from "../../lib/minecraft/service";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { projectFitsAction, updateServerSettingsAction } from "./minecraft-actions";
import {
    foreignLogin,
    joinGuardFor,
    joinGuardSlugs,
    PROJECTS_KEY
} from "../../lib/minecraft/join-guard";
import {
    LOGIN_IDLE_MS,
    LoginDetails,
    LoginSkeleton,
    useLoginState,
    type LoginStateHandle
} from "./minecraft-polaris-login";
import { hostUi } from "@polaris/app-host/client";

const { useConfirm } = hostUi.confirmDialog;

/** Whether an entry names one of those projects, whatever version or suffix it
 *  was written with. */
function names(entry: string, slugs: readonly string[]): boolean {
    const slug = modrinth.projectSlug(entry)?.toLowerCase();
    return typeof slug === "string" && slugs.includes(slug);
}

/** Which of those projects the list carries, so an older server that still runs
 *  the one this guard replaced is described as that one. */
function listedSlug(projects: string, slugs: readonly string[]): string | null {
    const entry = modrinth.parseProjectList(projects).find((item) => names(item, slugs));
    return entry === undefined ? null : (modrinth.projectSlug(entry)?.toLowerCase() ?? null);
}

export function MinecraftJoinPassword({
    installedAppId,
    edition,
    projects,
    software,
    playersOnline,
    login: shared,
    onOpenPlayers,
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
    /** The login state, when the page already reads it. */
    login?: LoginStateHandle;
    /** Where each player's password is shown and reset. */
    onOpenPlayers?: () => void;
    onSaved: () => void;
}) {
    const t = useGameText("minecraft");
    const [confirm, confirmElement] = useConfirm();
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const java = edition === "java";
    const guard = java ? joinGuardFor(software) : null;
    const listed = guard === null ? null : listedSlug(projects, joinGuardSlugs(guard));
    // Only software Polaris login has a build for is asked about it.
    const modCapable = java && polarisLogin.hasBuildFor(software);
    const own = useLoginState(installedAppId, null, modCapable && !shared, LOGIN_IDLE_MS);
    const login = shared ?? own;
    const modOn = login.state?.on === true;
    const foreign = java ? foreignLogin(projects) : null;
    const offerMod = Boolean(login.state?.build) && foreign === null;
    /** Polaris login is what this server should use, when it is not on already. */
    const preferMod = offerMod && login.state?.reachable === true;

    // Held in state so the switch answers the press immediately, and taken from
    // the server again whenever its answer changes underneath - the Mods screen
    // edits the same list. Synced during render rather than in an effect, so the
    // badge never trails the details it sits above by a commit.
    const serverKey = `${listed ?? ""}|${modOn}`;
    const [on, setOn] = useState(listed !== null || modOn);
    const [syncedKey, setSyncedKey] = useState(serverKey);
    if (syncedKey !== serverKey) {
        setSyncedKey(serverKey);
        setOn(listed !== null || modOn);
    }
    const installed = on && listed !== null ? listed : guard?.slug;
    const locked = foreign !== null && !on;
    /**
     * What the switch is about. Where Polaris login applies it is the only login
     * this card manages: a Modrinth guard still on the server is described as
     * what Turn on replaces, not offered as a second choice.
     */
    const shownOn = preferMod ? modOn : on;

    const restartNote =
        playersOnline > 0
            ? t("joinPassword.playersWillDrop", { count: playersOnline })
            : t("joinPassword.restartsToApply");

    /**
     * Run one of the switches, busy until it settles.
     *
     * Not a React transition: both switches ask for confirmation first, and a
     * state update made inside a transition is held until the transition ends -
     * so the dialog never appeared, and the button spun forever waiting on an
     * answer nobody could give. A failure that is not an answer (a request the
     * server could not match, a dropped connection) is said, not swallowed.
     */
    async function run(task: () => Promise<void>): Promise<void> {
        setPending(true);
        try {
            await task();
        } catch (cause) {
            console.error(cause);
            setError(t("joinPassword.noAnswer"));
        } finally {
            setPending(false);
        }
    }

    function switchMod(wanted: boolean): void {
        setError(null);
        void run(async () => {
            const asked = await confirm({
                title: wanted
                    ? t("joinPassword.restartOntoPolarisLogin")
                    : t("joinPassword.restartToStopAsking"),
                description: wanted
                    ? `${restartNote} ${listed ? t("joinPassword.modOnListed", { name: listed }) : t("joinPassword.modOn")}`
                    : `${restartNote} ${t("joinPassword.modOff")}`,
                confirmLabel: wanted
                    ? t("joinPassword.usePolarisLogin")
                    : t("joinPassword.turnOffAndRestart"),
                danger: !wanted
            });
            if (!asked) return;
            const result = await setLoginAction({ installedAppId, on: wanted });
            if (result.error) {
                setError(result.error);
                return;
            }
            setOn(wanted);
            await login.reload();
            onSaved();
        });
    }

    function apply(wanted: boolean): void {
        if (!guard || (wanted && foreign !== null)) return;
        setError(null);
        void run(async () => {
            // Asked before the operator is asked anything, because the answer that
            // matters is whether this server can load it at all - and finding that
            // out after the restart means a server that came up without it while
            // this card says On. Only on the way in: taking a project off the list
            // cannot fail for want of a build.
            if (wanted) {
                const fit = await projectFitsAction({ installedAppId, slug: guard.slug });
                if (!fit.fits) {
                    setError(
                        fit.version
                            ? t("joinPassword.noBuildFor", {
                                  name: guard.slug,
                                  version: fit.version
                              })
                            : t("joinPassword.noBuild", { name: guard.slug })
                    );
                    return;
                }
            }
            const said = restartNote;
            const asked = await confirm({
                title: wanted
                    ? t("joinPassword.restartToAskPlayersFor")
                    : t("joinPassword.restartToStopAsking"),
                description: wanted
                    ? `${said} ${t("joinPassword.guardOn")}`
                    : `${said} ${t("joinPassword.guardOff")}`,
                confirmLabel: wanted
                    ? t("joinPassword.turnOnAndRestart")
                    : t("joinPassword.turnOffAndRestart"),
                danger: !wanted
            });
            if (!asked) return;

            const entries = modrinth.parseProjectList(projects);
            const without = entries.filter((entry) => !names(entry, joinGuardSlugs(guard)));
            const next = wanted ? [...without, `${guard.slug}?`] : without;
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
                    {t("joinPassword.passwordOnJoin")}
                    {shownOn && <Badge variant="success">{t("joinPassword.on")}</Badge>}
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                    {t("joinPassword.playersSetAPasswordThe")}
                </p>

                {!java ? (
                    <p className="flex items-start gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
                        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                        {t("joinPassword.bedrockHasNoEquivalentIt")}
                    </p>
                ) : guard === null ? (
                    <p className="flex items-start gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
                        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                        {t("joinPassword.thisServerRunsNeitherPlugins")}
                    </p>
                ) : modCapable && !login.loaded ? (
                    <LoginSkeleton />
                ) : modOn && login.state ? (
                    <LoginDetails state={login.state} onOpenPlayers={onOpenPlayers} />
                ) : locked ? (
                    <p className="text-xs text-muted-foreground">
                        {t.rich<ReactNode>("joinPassword.foreign", {
                            name: foreign ?? "",
                            mono: monoTags()
                        })}
                    </p>
                ) : preferMod ? (
                    <>
                        <p className="text-xs text-muted-foreground">
                            {t.rich<ReactNode>("joinPassword.usesLogin", { mono: monoTags() })}
                        </p>
                        {listed !== null && (
                            <p className="flex items-start gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
                                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                                <span>
                                    {t.rich<ReactNode>(
                                        guard.entry === "trigger"
                                            ? "joinPassword.stillNumeric"
                                            : "joinPassword.still",
                                        { name: listed, mono: monoTags() }
                                    )}
                                </span>
                            </p>
                        )}
                    </>
                ) : (
                    <>
                        <p className="text-xs text-muted-foreground">
                            {t.rich<ReactNode>("joinPassword.installs", {
                                name: installed,
                                mono: monoTags()
                            })}
                        </p>
                        {/* The commands, because nobody reading this is the person who
                            will need them: the player is in the game, locked out, with
                            no way to find out what to type. Only the modded one is
                            spelled out - those commands were read off a running server.
                            The plugin's own are not repeated here unverified. */}
                        {guard.entry === "trigger" ? (
                            <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                                {t.rich<ReactNode>("joinPassword.triggerHelp", {
                                    mono: monoTags()
                                })}
                            </p>
                        ) : (
                            <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                                {t.rich<ReactNode>("joinPassword.pluginHelp", {
                                    name: installed,
                                    mono: monoTags()
                                })}
                                {installed === guard.slug && (
                                    <> {t("joinPassword.theirPasswordCanAppearIn")}</>
                                )}
                            </p>
                        )}
                    </>
                )}

                {(error ?? login.error) && (
                    <p className="text-sm text-danger">{error ?? login.error}</p>
                )}

                {/* No button at all on Bedrock rather than one that can never be
                    pressed: there is nothing behind it to install, and a disabled
                    control reads as something the reader is one step away from. */}
                {java && !locked && (
                    <div className="flex justify-end">
                        <Button
                            size="sm"
                            variant={shownOn ? "outline" : "primary"}
                            disabled={pending || guard === null || !login.loaded}
                            onClick={() =>
                                modOn ? switchMod(false) : preferMod ? switchMod(true) : apply(!on)
                            }
                        >
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            {shownOn ? t("joinPassword.turnOff") : t("joinPassword.turnOn")}
                        </Button>
                    </div>
                )}
            </CardBody>
        </Card>
    );
}

/** A command in a sentence, set in the monospace it is typed in. Each call keys
 *  its spans afresh, since one sentence can hold several. */
function monoTags(): (chunks: ReactNode[]) => ReactNode {
    let next = 0;
    return (chunks) => (
        <span key={`mono-${next++}`} className="font-mono">
            {chunks}
        </span>
    );
}
