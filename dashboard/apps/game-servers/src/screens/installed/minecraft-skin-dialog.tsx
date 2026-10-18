"use client";

/**
 * A player's skin: what they wear now, turned in 3D, and - for whoever may
 * change it - a file, a pasted image, a link or a username to put on instead,
 * previewed in the same view before it is applied.
 */

import * as actions from "./skin-actions";
import { useGameText } from "../game-text";
import * as skin from "../../lib/minecraft/skin";
import { defaultSkin } from "../../lib/minecraft/default-skin";
import { hostUi } from "@polaris/app-host/client";
import { RestartPlanner } from "./restart-planner";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, RotateCcw, TriangleAlert, Upload } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl,
    Skeleton
} from "@polaris/ui";

const { useConfirm } = hostUi.confirmDialog;

type LiveSkin = NonNullable<Awaited<ReturnType<typeof actions.readSkinAction>>["live"]>;

/** A skin ready to draw: the PNG when it is held here, else where to load it. */
interface Shown {
    readonly png: string | null;
    readonly url: string | null;
    readonly model: skin.SkinModel;
}

/** An imported skin waiting for Apply. */
interface Preview {
    readonly png: string;
    readonly model: skin.SkinModel;
    readonly signed: skin.SignedSkin | null;
}

const VIEWER_WIDTH = 240;
const VIEWER_HEIGHT = 300;

function toBase64(bytes: Uint8Array): string {
    let text = "";
    for (let at = 0; at < bytes.length; at += 0x8000)
        text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return btoa(text);
}

function dataUrl(png: string): string {
    return `data:image/png;base64,${png}`;
}

/** The sentence for a refusal the mod answered with. */
const REFUSALS = {
    offline: "offline",
    notStaged: "notStaged",
    badValue: "unreadable",
    badSignature: "unreadable",
    badToken: "unreadable",
    unsaved: "unsaved"
} as const;

function refusalKey(why: string) {
    const known = (REFUSALS as Record<string, (typeof REFUSALS)[keyof typeof REFUSALS]>)[why];
    return known ? (`skins.refusals.${known}` as const) : ("skins.refused" as const);
}

export function SkinDialog({
    installedAppId,
    player,
    canEdit,
    online,
    running,
    canRestart,
    playersOnline = 0,
    onClose
}: {
    installedAppId: string;
    player: string;
    /** Whether this viewer moderates the server, and so may change anybody's
     *  skin. The player themselves may change their own, which the read says. */
    canEdit: boolean;
    /** Whether they are on the server now. */
    online: boolean;
    running: boolean;
    /** Whether this viewer may restart the server for a mod update. */
    canRestart: boolean;
    playersOnline?: number;
    onClose: () => void;
}) {
    const [ownSkin, setOwnSkin] = useState(false);
    const editable = canEdit || ownSkin;
    const t = useGameText("minecraft");
    const [confirm, confirmElement] = useConfirm();
    const [live, setLive] = useState<LiveSkin | null>(null);
    const [uuid, setUuid] = useState<string | null>(null);
    const [reading, setReading] = useState(true);
    const [readError, setReadError] = useState<string | null>(null);
    const [current, setCurrent] = useState<Shown | null>(null);
    const [preview, setPreview] = useState<Preview | null>(null);
    const [model, setModel] = useState<skin.SkinModel>("classic");
    const [source, setSource] = useState("");
    const [busy, setBusy] = useState<"load" | "apply" | "reset" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [picking, setPicking] = useState(false);

    /** What the server says they wear, as something the view can draw. */
    const showLive = useCallback(
        async (next: LiveSkin, mayEdit: boolean) => {
            setLive(next);
            if (next.state !== "read" || !next.skin) {
                setCurrent(null);
                return;
            }
            const { hash, model: worn } = next.skin;
            const url = skin.textureUrl(hash);
            // The texture is fetched through Polaris for whoever may, so it can be
            // exported too; a reader gets the address.
            if (mayEdit) {
                const fetched = await actions
                    .previewSkinAction({ installedAppId, player, kind: "text", text: url })
                    .catch(() => null);
                if (fetched?.png) {
                    setCurrent({ png: fetched.png, url: null, model: worn });
                    return;
                }
            }
            setCurrent({ png: null, url, model: worn });
        },
        [installedAppId, player]
    );

    useEffect(() => {
        let alive = true;
        setReading(true);
        setReadError(null);
        void actions.readSkinAction({ installedAppId, player }).then(
            async (result) => {
                if (!alive) return;
                if (result.error) setReadError(result.error);
                else {
                    const own = result.ownSkin ?? false;
                    setOwnSkin(own);
                    setUuid(result.uuid ?? null);
                    if (result.live) await showLive(result.live, canEdit || own);
                }
                if (alive) setReading(false);
            },
            () => {
                if (!alive) return;
                setReadError(t("players.unreachable"));
                setReading(false);
            }
        );
        return () => {
            alive = false;
        };
    }, [installedAppId, player, attempt, canEdit, showLive, t]);

    const unsupported = live?.state === "unsupported";
    // An older mod changes a skin only on a player who is in, and refuses one who
    // is not; a newer one reads back what is kept for them, marked offline.
    const offline =
        live?.state === "refused" ? live.why === "offline" : !online && live?.state !== "read";
    const changeable = editable && !offline;

    /** Says what went wrong when the server did not take a change. */
    function answered(next: LiveSkin) {
        if (next.state === "refused") setError(t(refusalKey(next.why), { name: player }));
        if (next.state === "unanswered") setError(t("skins.unanswered"));
        setLive(next);
    }
    // No skin of their own: the game draws one of its defaults, picked from the
    // UUID the same way on every machine, so that one is drawn here too. Nothing
    // kept for a player who is away says nothing of what they wear: on an online
    // server that is their account's own skin.
    const bare = live?.state === "read" && !live.skin && !live.offline;
    const fallback = bare && uuid !== null ? defaultSkin(uuid) : null;
    const shown: Shown | null = preview
        ? { png: preview.png, url: null, model }
        : (current ?? (fallback ? { png: null, url: fallback.path, model: fallback.model } : null));
    // A preview of exactly what they wear already - the same picture, the same
    // arms - changes nothing, so there is nothing to apply.
    const unchanged = preview !== null && current?.png === preview.png && current.model === model;

    async function importFile(file: File) {
        setError(null);
        setNotice(null);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const check = skin.checkSkinPng(bytes);
        if (!check.ok) {
            setError(t(`skins.failures.${check.problem}`));
            return;
        }
        setBusy("load");
        const result = await actions
            .previewSkinAction({
                installedAppId,
                player,
                kind: "file",
                png: toBase64(bytes),
                fileName: file.name
            })
            .catch(() => ({ error: t("skins.couldNotLoad") }) as const);
        setBusy(null);
        took(result, skin.modelFromFileName(file.name));
    }

    async function importText() {
        const text = source.trim();
        if (!text) return;
        setError(null);
        setNotice(null);
        setBusy("load");
        const result = await actions
            .previewSkinAction({ installedAppId, player, kind: "text", text })
            .catch(() => ({ error: t("skins.couldNotLoad") }) as const);
        setBusy(null);
        took(result, null);
    }

    function took(
        result: Awaited<ReturnType<typeof actions.previewSkinAction>>,
        named: skin.SkinModel | null
    ) {
        if (result.error || !result.png) {
            setError(result.error ?? t("skins.couldNotLoad"));
            return;
        }
        // A file this screen exported names its model; that wins over a guess.
        const next = named ?? result.model ?? "classic";
        setPreview({ png: result.png, model: next, signed: result.signed ?? null });
        setModel(next);
    }

    function imageFrom(items: DataTransferItemList | FileList | null): File | null {
        if (!items) return null;
        for (const item of Array.from(items as ArrayLike<DataTransferItem | File>)) {
            const file = "getAsFile" in item ? item.getAsFile() : item;
            if (file && file.type.startsWith("image/")) return file;
        }
        return null;
    }

    async function apply() {
        if (!preview) return;
        setError(null);
        setNotice(null);
        setBusy("apply");
        const result = await actions
            .applySkinAction({
                installedAppId,
                player,
                png: preview.png,
                model,
                signed: preview.signed
            })
            .catch(() => ({ error: t("skins.couldNotApply") }) as const);
        setBusy(null);
        if ("live" in result && result.live) answered(result.live);
        if (result.error) {
            setError(result.error);
            return;
        }
        if (!("live" in result) || result.live?.state !== "read") return;
        setPreview(null);
        setNotice(t("skins.applied"));
        // What the server holds now, not what was sent.
        await showLive(result.live, editable);
    }

    async function reset() {
        const agreed = await confirm({
            title: t("skins.reset"),
            description: t("skins.resetConfirm", { name: player }),
            confirmLabel: t("playersTab.confirm"),
            danger: true
        });
        if (!agreed) return;
        setError(null);
        setNotice(null);
        setBusy("reset");
        const result = await actions
            .clearSkinAction({ installedAppId, player })
            .catch(() => ({ error: t("skins.couldNotApply") }) as const);
        setBusy(null);
        if ("live" in result && result.live) answered(result.live);
        if (result.error) {
            setError(result.error);
            return;
        }
        if (!("live" in result) || result.live?.state !== "read") return;
        setPreview(null);
        setNotice(t("skins.resetDone"));
        await showLive(result.live, editable);
    }

    function exportPng() {
        if (!shown?.png) return;
        const link = document.createElement("a");
        link.href = dataUrl(shown.png);
        link.download = skin.exportFileName(player, shown.model);
        link.click();
    }

    const worn = live?.state === "read" ? live.skin : null;
    const working = busy !== null;

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                className="max-h-[88vh] max-w-2xl overflow-y-auto overscroll-contain"
                onPaste={(event) => {
                    if (!changeable || unsupported) return;
                    const file = imageFrom(event.clipboardData.items);
                    if (!file) return;
                    event.preventDefault();
                    void importFile(file);
                }}
            >
                <DialogHeader>
                    <DialogTitle>{t("skins.title", { name: player })}</DialogTitle>
                    <DialogDescription>{t("skins.description")}</DialogDescription>
                </DialogHeader>

                {readError ? (
                    <div className="flex flex-col items-start gap-3 py-4">
                        <p role="alert" className="flex items-start gap-2 text-sm text-danger">
                            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                            {readError}
                        </p>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setAttempt((n) => n + 1)}
                        >
                            <RotateCcw className="size-4" aria-hidden />
                            {t("skins.retry")}
                        </Button>
                    </div>
                ) : unsupported ? (
                    <div className="flex flex-col gap-3">
                        <p className="flex items-start gap-2 text-sm text-muted-foreground">
                            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                            {t("skins.needsUpdate")}
                        </p>
                        {canRestart && running && (
                            <RestartPlanner
                                installedAppId={installedAppId}
                                running={running}
                                changed
                                reason={t("skins.updateReason")}
                                title={t("skins.updateTitle")}
                                detail={t("skins.needsUpdate")}
                                playersOnline={playersOnline}
                                onRestarted={() => setAttempt((n) => n + 1)}
                            />
                        )}
                    </div>
                ) : (
                    <div className="grid min-w-0 gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
                        <div className="flex min-w-0 flex-col items-center gap-2">
                            {reading ? (
                                <Skeleton
                                    className="rounded-md"
                                    style={{ width: VIEWER_WIDTH, height: VIEWER_HEIGHT }}
                                />
                            ) : (
                                <SkinView
                                    shown={shown}
                                    label={t("skins.viewer")}
                                    empty={!offline && bare ? t("skins.noSkinSet") : null}
                                />
                            )}
                            <p className="text-center text-xs text-muted-foreground">
                                {preview
                                    ? t("skins.previewing")
                                    : reading
                                      ? " "
                                      : worn
                                        ? `${t("skins.current")} - ${t(`skins.models.${worn.model}`)}`
                                        : fallback
                                          ? `${t("skins.noSkinSet")} - ${fallback.name.charAt(0).toUpperCase()}${fallback.name.slice(1)}`
                                          : offline
                                            ? " "
                                            : t("skins.accountSkin")}
                            </p>
                        </div>

                        <div className="flex min-w-0 flex-col gap-3">
                            {worn && !worn.signed && !preview && (
                                <p className="text-sm text-muted-foreground">
                                    {t("skins.unsigned")}
                                </p>
                            )}
                            {offline && (
                                <p className="text-sm text-muted-foreground">
                                    {t("skins.notOnline", { name: player })}
                                </p>
                            )}
                            {live?.state === "read" && live.offline && (
                                <p className="text-sm text-muted-foreground">
                                    {t("skins.nextJoin", { name: player })}
                                </p>
                            )}

                            {changeable && (
                                <section className="flex min-w-0 flex-col gap-3">
                                    <h3 className="text-sm font-medium">{t("skins.import")}</h3>
                                    <div
                                        role="button"
                                        tabIndex={0}
                                        aria-label={t("skins.dropHere")}
                                        className="flex min-h-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        onClick={() => setPicking(true)}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter" || event.key === " ") {
                                                event.preventDefault();
                                                setPicking(true);
                                            }
                                        }}
                                        onDragOver={(event) => event.preventDefault()}
                                        onDrop={(event) => {
                                            event.preventDefault();
                                            const file = imageFrom(event.dataTransfer.files);
                                            if (file) void importFile(file);
                                            else setError(t("skins.failures.notPng"));
                                        }}
                                    >
                                        <Upload className="size-4" aria-hidden />
                                        {t("skins.dropHere")}
                                    </div>
                                    {picking ? (
                                        <hostUi.filePicker.ChooseFilesDialog
                                            accept="image/png"
                                            title={t("skins.chooseFile")}
                                            onClose={() => setPicking(false)}
                                            onFailed={setError}
                                            onFiles={(files: File[]) => {
                                                const file = files[0];
                                                if (file) void importFile(file);
                                            }}
                                        />
                                    ) : null}
                                    <form
                                        className="flex min-w-0 gap-2"
                                        onSubmit={(event) => {
                                            event.preventDefault();
                                            void importText();
                                        }}
                                    >
                                        <Input
                                            value={source}
                                            onChange={(event) => setSource(event.target.value)}
                                            placeholder={t("skins.sourcePlaceholder")}
                                            aria-label={t("skins.importHint")}
                                            maxLength={2048}
                                            className="min-w-0 flex-1"
                                        />
                                        <Button
                                            type="submit"
                                            variant="secondary"
                                            disabled={working || !source.trim()}
                                        >
                                            {busy === "load" && (
                                                <Loader2
                                                    className="size-4 animate-spin"
                                                    aria-hidden
                                                />
                                            )}
                                            {busy === "load" ? t("skins.loading") : t("skins.load")}
                                        </Button>
                                    </form>
                                    <p className="text-xs text-muted-foreground">
                                        {t("skins.importHint")}
                                    </p>
                                    {(preview || current?.png) && (
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className="text-sm">{t("skins.model")}</span>
                                            <SegmentedControl
                                                value={preview ? model : (current?.model ?? model)}
                                                onValueChange={(value) => {
                                                    // Other arms on what they wear now is a new
                                                    // skin to apply, previewed first.
                                                    if (!preview && current?.png)
                                                        setPreview({
                                                            png: current.png,
                                                            model: value,
                                                            signed: null
                                                        });
                                                    setModel(value);
                                                }}
                                                options={skin.SKIN_MODELS.map((value) => ({
                                                    value,
                                                    label: t(`skins.models.${value}`)
                                                }))}
                                                aria-label={t("skins.model")}
                                                size="sm"
                                            />
                                        </div>
                                    )}
                                </section>
                            )}

                            {error && (
                                <p
                                    role="alert"
                                    className="flex items-start gap-2 text-sm text-danger"
                                >
                                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                                    {error}
                                </p>
                            )}
                            {notice && !error && (
                                <p role="status" className="text-sm text-success">
                                    {notice}
                                </p>
                            )}
                        </div>
                    </div>
                )}

                <DialogFooter className="flex-wrap gap-2">
                    {!unsupported && !readError && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={exportPng}
                            disabled={!shown?.png || working}
                        >
                            <Download className="size-4" aria-hidden />
                            {t("skins.export")}
                        </Button>
                    )}
                    {changeable && !unsupported && !readError && worn && !preview && (
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void reset()}
                            disabled={working}
                        >
                            {busy === "reset" && (
                                <Loader2 className="size-4 animate-spin" aria-hidden />
                            )}
                            {t("skins.reset")}
                        </Button>
                    )}
                    {preview && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                                setPreview(null);
                                setError(null);
                            }}
                            disabled={working}
                        >
                            {t("skins.discard")}
                        </Button>
                    )}
                    {preview && changeable ? (
                        <Button
                            size="sm"
                            onClick={() => void apply()}
                            disabled={working || unchanged}
                            title={unchanged ? t("skins.alreadyWorn") : undefined}
                        >
                            {busy === "apply" && (
                                <Loader2 className="size-4 animate-spin" aria-hidden />
                            )}
                            {busy === "apply" ? t("skins.applying") : t("skins.apply")}
                        </Button>
                    ) : (
                        <Button variant="ghost" size="sm" onClick={onClose}>
                            {t("players.close")}
                        </Button>
                    )}
                </DialogFooter>
                {confirmElement}
            </DialogContent>
        </Dialog>
    );
}

/**
 * The 3D view. The library is loaded only once the dialog opens, and the canvas
 * and its GPU context are released when it closes.
 *
 * `empty` is said over the viewer while there is nothing to draw: a profile with
 * no skin of its own whose UUID the server does not know, so which of the
 * game's defaults it wears cannot be told.
 */
function SkinView({
    shown,
    label,
    empty
}: {
    shown: Shown | null;
    label: string;
    empty: string | null;
}) {
    const t = useGameText("minecraft");
    const canvas = useRef<HTMLCanvasElement>(null);
    const viewer = useRef<import("skinview3d").SkinViewer | null>(null);
    const [ready, setReady] = useState(false);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let alive = true;
        void import("skinview3d").then(
            ({ SkinViewer }) => {
                if (!alive || !canvas.current) return;
                try {
                    const made = new SkinViewer({
                        canvas: canvas.current,
                        width: VIEWER_WIDTH,
                        height: VIEWER_HEIGHT
                    });
                    made.controls.enablePan = false;
                    made.controls.enableRotate = true;
                    viewer.current = made;
                    setReady(true);
                } catch {
                    setFailed(true);
                }
            },
            () => alive && setFailed(true)
        );
        return () => {
            alive = false;
            viewer.current?.dispose();
            viewer.current = null;
        };
    }, []);

    const src = shown ? (shown.png ? dataUrl(shown.png) : shown.url) : null;
    const model = shown?.model;
    useEffect(() => {
        const made = viewer.current;
        if (!ready || !made) return;
        if (!src || !model) {
            made.loadSkin(null);
            return;
        }
        setFailed(false);
        void Promise.resolve(
            made.loadSkin(src, { model: model === "slim" ? "slim" : "default" })
        ).catch(() => setFailed(true));
    }, [ready, src, model]);

    return (
        <div className="relative" style={{ width: VIEWER_WIDTH, height: VIEWER_HEIGHT }}>
            <canvas
                ref={canvas}
                aria-label={label}
                role="img"
                className="cursor-grab touch-none rounded-md bg-muted active:cursor-grabbing"
                style={{ width: VIEWER_WIDTH, height: VIEWER_HEIGHT }}
            />
            {!failed && !shown && empty && (
                <p className="absolute inset-0 flex items-center justify-center rounded-md px-4 text-center text-sm text-muted-foreground">
                    {empty}
                </p>
            )}
            {failed && (
                <p className="absolute inset-0 flex items-center justify-center rounded-md bg-muted px-4 text-center text-sm text-muted-foreground">
                    {t("skins.viewerFailed")}
                </p>
            )}
        </div>
    );
}
