"use client";

/**
 * Starting this server over as something else.
 *
 * What people do instead is delete the server and make a new one, and it costs
 * them the address, the player list, the access other people hold on it and the
 * port - none of which is what they were trying to replace. So this is the same
 * server: only the game it plays, the release it runs and the map it plays on
 * change, and the card says which things it will not touch before it is opened
 * rather than after.
 *
 * It is not a delete and it does not read as one. The map being played is kept on
 * disk and the server can be switched back onto it under World, which is what
 * makes choosing the wrong blueprint survivable.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useGameText } from "../game-text";
import { findMap } from "../../lib/minecraft/maps";
import { resetGameServerAction } from "./minecraft-actions";
import { expectedMemoryAction, saveServerAsTemplateAction } from "../actions";
import { BookmarkPlus, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { findBlueprint } from "../../lib/minecraft/blueprints";
import {
    BlueprintFields,
    DEFAULT_SHAPE,
    LATEST,
    shapeError,
    type BlueprintShape
} from "../../components/game-blueprint-fields";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Checkbox,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input,
    Skeleton,
    cn
} from "@polaris/ui";

export function MinecraftReset({
    installedAppId,
    edition,
    blueprintId,
    mapId,
    crossplay,
    playersOnline,
    onDone
}: {
    installedAppId: string;
    edition: "java" | "bedrock";
    /** What it is built from now, so the dialog opens on it. */
    blueprintId: string | null;
    /** The map it is on now, for the same reason. */
    mapId: string | null;
    /** Whether Bedrock clients join this Java server through Geyser. A reset does
     *  not change it - the second published port is part of the deployment - but
     *  Geyser still has to have a build for whatever release is picked, so the
     *  version list has to know. */
    crossplay: boolean;
    playersOnline: number;
    onDone: () => void;
}) {
    const t = useGameText("minecraft");
    const [open, setOpen] = useState(false);
    const current = findBlueprint(blueprintId ?? "");
    const currentMap = findMap(mapId ?? "");

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <RotateCcw className="size-4 text-primary" />
                    {t("reset.startOver")}
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">{t("reset.buildThisServerAgainAs")}</p>
                <p className="text-xs text-muted-foreground">
                    {currentMap
                        ? t("reset.builtFromOn", {
                              name: current?.name ?? t("reset.aBlueprint"),
                              map: currentMap.name
                          })
                        : current
                          ? t("reset.builtFrom", { name: current.name })
                          : t("reset.itWasNotBuiltFrom")}{" "}
                    {t("reset.theMapItIsOn")}
                </p>
                <div className="flex justify-end">
                    <Button variant="secondary" onClick={() => setOpen(true)}>
                        {t("reset.startOver")}
                    </Button>
                </div>
            </CardBody>

            {open && (
                <ResetDialog
                    installedAppId={installedAppId}
                    edition={edition}
                    blueprintId={blueprintId}
                    mapId={mapId}
                    crossplay={crossplay}
                    playersOnline={playersOnline}
                    onClose={() => setOpen(false)}
                    onDone={onDone}
                />
            )}
        </Card>
    );
}

function ResetDialog({
    installedAppId,
    edition,
    blueprintId,
    mapId,
    crossplay,
    playersOnline,
    onClose,
    onDone
}: {
    installedAppId: string;
    edition: "java" | "bedrock";
    blueprintId: string | null;
    mapId: string | null;
    crossplay: boolean;
    playersOnline: number;
    onClose: () => void;
    onDone: () => void;
}) {
    const t = useGameText("minecraft");
    const [shape, setShape] = useState<BlueprintShape>(() => {
        const blueprint = findBlueprint(blueprintId ?? "");
        return blueprint
            ? {
                  ...DEFAULT_SHAPE,
                  blueprintId: blueprint.id,
                  // What it is on now, not what a new server of this game would
                  // open on: a reset is meant to start from where the server is.
                  mapId: mapId ?? "",
                  levelType: blueprint.levelType ?? DEFAULT_SHAPE.levelType
              }
            : DEFAULT_SHAPE;
    });
    const [concurrentPlayers, setConcurrentPlayers] = useState(8);
    const [keepPlayers, setKeepPlayers] = useState(false);
    const [templateName, setTemplateName] = useState("");
    const [templateNote, setTemplateNote] = useState<string | null>(null);
    const [savingTemplate, setSavingTemplate] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const seedError = shapeError(shape);
    /** Undefined while it is being asked for, null for an edition with no heap. */
    const [memory, setMemory] = useState<string | null | undefined>(undefined);
    useEffect(() => {
        let active = true;
        const timer = setTimeout(() => {
            void expectedMemoryAction({
                edition,
                blueprintId: shape.blueprintId,
                software: edition === "java" && shape.software ? shape.software : undefined,
                softwareSource: edition === "java" && shape.source ? shape.source : undefined,
                mapId: shape.mapId || undefined,
                crossplay,
                concurrentPlayers,
                installedAppId
            })
                .then((figure) => active && setMemory(figure))
                .catch(() => undefined);
        }, 250);
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [
        edition,
        shape.blueprintId,
        shape.software,
        shape.mapId,
        crossplay,
        concurrentPlayers,
        installedAppId
    ]);
    // Bedrock keeps player data inside the level database, where it cannot be
    // separated from the terrain, so there it is not offered.
    // Not onto a map, and not as a preference: carrying players means creating the
    // new level folder before the server boots, and the image fetches the map only
    // when that folder is absent. Offering the choice would be offering a server
    // with no map in it.
    // The map being *chosen*, not the one the server is on now. Gating on the
    // latter meant a server that had ever been built on a map could never carry
    // players again, including onto a plain generated world - which is neither
    // what was meant nor anything the reader could work out from the sentence
    // underneath the box.
    const carriesPlayers = edition === "java" && !shape.mapId;

    async function submit(): Promise<void> {
        setPending(true);
        setError(null);
        const result = await resetGameServerAction({
            installedAppId,
            blueprintId: shape.blueprintId,
            ...(shape.mapId ? { mapId: shape.mapId } : {}),
            ...(edition === "java" ? { software: shape.software } : {}),
            ...(edition === "java" && shape.source ? { softwareSource: shape.source } : {}),
            version: shape.version.trim() || LATEST,
            ...(shape.seed.trim() ? { seed: shape.seed.trim() } : {}),
            ...(edition === "java" ? { levelType: shape.levelType, biome: shape.biome } : {}),
            concurrentPlayers,
            keepPlayers: keepPlayers && carriesPlayers
        });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onDone();
        onClose();
    }

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto overscroll-contain">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <RotateCcw className="size-4" /> {t("reset.startThisServerOver")}
                    </DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <BlueprintFields
                        edition={edition}
                        crossplay={crossplay}
                        value={shape}
                        onChange={setShape}
                    />

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("reset.playingAtOnceUsually")}</span>
                        <Input
                            type="number"
                            min={1}
                            value={concurrentPlayers}
                            onChange={(event) =>
                                setConcurrentPlayers(Math.max(1, Number(event.target.value) || 1))
                            }
                        />
                        <span className="text-xs text-muted-foreground">
                            {memory === null ? null : (
                                <>
                                    {t.rich<ReactNode>("reset.memoryGiven", {
                                        memory: () =>
                                            memory === undefined ? (
                                                <Skeleton
                                                    key="memory"
                                                    className="inline-block h-3 w-10 align-middle"
                                                />
                                            ) : (
                                                <strong key="memory" className="text-foreground">
                                                    {memory}
                                                </strong>
                                            )
                                    })}{" "}
                                </>
                            )}
                            {t("reset.playerSlotsAndEverythingElse")}
                        </span>
                    </label>

                    {/* The opposite of everything else on this screen: it changes
                        nothing about this server, it writes down how it is built so
                        another can be built the same way. Here because this is
                        where its blueprint and its map are, which is most of what
                        gets written down. */}
                    <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
                        <label className="flex flex-1 flex-col gap-1 text-sm">
                            <span className="font-medium">{t("reset.saveThisServerAsA")}</span>
                            <Input
                                value={templateName}
                                onChange={(event) => setTemplateName(event.target.value)}
                                placeholder={t("reset.mySurvivalSetup")}
                                maxLength={60}
                            />
                            <span className="text-xs text-muted-foreground">
                                {templateNote ?? t("reset.keepsWhatYouChangedFrom")}
                            </span>
                        </label>
                        <Button
                            variant="secondary"
                            disabled={savingTemplate || templateName.trim().length === 0}
                            onClick={() => {
                                setSavingTemplate(true);
                                setTemplateNote(null);
                                void saveServerAsTemplateAction(
                                    installedAppId,
                                    templateName,
                                    ""
                                ).then((answer) => {
                                    setSavingTemplate(false);
                                    setTemplateNote(answer.error ?? t("reset.templateSaved"));
                                    if (!answer.error) setTemplateName("");
                                });
                            }}
                        >
                            {savingTemplate ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : (
                                <BookmarkPlus className="size-4" />
                            )}
                            {t("reset.save")}
                        </Button>
                    </div>

                    <label
                        className={cn(
                            "flex items-start gap-2 text-sm",
                            carriesPlayers ? "cursor-pointer" : "opacity-60"
                        )}
                    >
                        <Checkbox
                            checked={keepPlayers && carriesPlayers}
                            disabled={!carriesPlayers}
                            onChange={(event) => setKeepPlayers(event.target.checked)}
                            className="mt-0.5"
                        />
                        <span className="flex flex-col gap-0.5">
                            <span className="font-medium">
                                {t("reset.keepWhatPlayersAreCarrying")}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {carriesPlayers
                                    ? t("reset.inventoriesEnderChestsStatsAnd")
                                    : shape.mapId
                                      ? t("reset.aBuiltMapComesWith")
                                      : t("reset.bedrockKeepsPlayerDataInside")}
                            </span>
                        </span>
                    </label>

                    <p className="flex items-start gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs">
                        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                        <span className="text-muted-foreground">
                            {playersOnline > 0
                                ? t("reset.restartWarningPlaying", { count: playersOnline })
                                : t("reset.restartWarning")}
                        </span>
                    </p>

                    {error && <p className="text-sm text-danger">{error}</p>}

                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            {t("reset.cancel")}
                        </Button>
                        <Button
                            onClick={() => void submit()}
                            disabled={pending || seedError !== null}
                        >
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            {t("reset.startOver")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
