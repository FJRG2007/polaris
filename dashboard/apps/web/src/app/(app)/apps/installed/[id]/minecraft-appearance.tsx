"use client";

/**
 * What the server looks like in the multiplayer list: its name, its picture, and
 * the two lines under it.
 *
 * The MOTD is the reason this is a screen rather than a text field. It carries
 * formatting codes whose effects are not visible in the source - a colour silently
 * clears bold, formatting runs across the line break, and centring depends on the
 * pixel width of a font nobody has in their head. Without a preview the only way to
 * see what you wrote is to save, restart the server and go and look at it, so the
 * preview is the point and it renders on every keystroke.
 *
 * What it cannot do is apply on every keystroke. The image writes server.properties
 * from its environment at boot, so a new MOTD or a new icon is a restart, and the
 * buttons say so rather than pretending otherwise.
 */

import Image from "next/image";
import * as mc from "@/lib/apps/minecraft/motd";
import { useConfirm } from "@/components/confirm-dialog";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { AlignCenter, Check, Code2, ImageUp, Loader2, RotateCw } from "lucide-react";
import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import { renameGameServerAction, setServerIconAction, updateServerSettingsAction } from "./minecraft-actions";

/** Minecraft's own rule for the icon, and the only size it will load. */
const ICON_SIDE = 64;

export function MinecraftAppearance({
    installedAppId,
    name,
    motd,
    iconSetAt,
    playersOnline,
    onSaved
}: {
    installedAppId: string;
    name: string;
    /** The MOTD the container is running on, as its variable holds it. */
    motd: string;
    /** When an icon was last uploaded, so the panel can show there is one. */
    iconSetAt: string | null;
    playersOnline: number;
    onSaved: () => void;
}) {
    return (
        <div className="flex flex-col gap-4">
            <NameCard installedAppId={installedAppId} name={name} onSaved={onSaved} />
            <MotdCard
                installedAppId={installedAppId}
                name={name}
                motd={motd}
                playersOnline={playersOnline}
                onSaved={onSaved}
            />
            <IconCard installedAppId={installedAppId} iconSetAt={iconSetAt} onSaved={onSaved} />
        </div>
    );
}

/** What Polaris calls the server. Not its address - that is next door, and moving
 *  a server players have written down is a different decision from fixing a typo. */
function NameCard({
    installedAppId,
    name,
    onSaved
}: {
    installedAppId: string;
    name: string;
    onSaved: () => void;
}) {
    const [value, setValue] = useState(name);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const trimmed = value.trim();
    const changed = trimmed !== name && trimmed.length > 0;

    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <p className="text-sm font-medium">Name</p>
                <p className="text-xs text-muted-foreground">
                    What this server is called in Polaris. Its address does not change with it.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        aria-label="Server name"
                        className="min-w-48 flex-1"
                        maxLength={60}
                    />
                    <Button
                        size="sm"
                        disabled={pending || !changed}
                        onClick={() => {
                            setError(null);
                            startTransition(async () => {
                                const result = await renameGameServerAction(installedAppId, trimmed);
                                if (result.error) {
                                    setError(result.error);
                                    return;
                                }
                                onSaved();
                            });
                        }}
                    >
                        {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Rename
                    </Button>
                </div>
                {error && <p className="text-xs text-danger">{error}</p>}
            </CardBody>
        </Card>
    );
}

function MotdCard({
    installedAppId,
    name,
    motd,
    playersOnline,
    onSaved
}: {
    installedAppId: string;
    name: string;
    motd: string;
    playersOnline: number;
    onSaved: () => void;
}) {
    const saved = useMemo(() => mc.decodeMotd(motd), [motd]);
    const [text, setText] = useState(saved);
    // Whether the field holds the text or the codes. Formatted is the default
    // because the codes are an implementation detail of the file; raw is there
    // because somebody who knows them is faster typing them, and because a MOTD
    // pasted from a generator on the web arrives as codes.
    const [raw, setRaw] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmElement] = useConfirm();
    const area = useRef<HTMLTextAreaElement>(null);
    const map = useMemo(() => mc.motdMap(text), [text]);
    const preview = useMemo(() => mc.motdSpans(text), [text]);
    const changed = mc.encodeMotd(text) !== motd;
    const shown = raw ? text : map.plain;

    /**
     * Apply a code to whatever is selected.
     *
     * The selection is wrapped, not replaced, and the formatting after it is put
     * back - so colouring a word colours that word. With nothing selected the
     * code lands at the caret and applies from there on, which is what the game
     * does with it.
     */
    const apply = useCallback(
        (code: string) => {
            const field = area.current;
            const from = field?.selectionStart ?? shown.length;
            const to = field?.selectionEnd ?? from;
            // The field's offsets are the stored string's in raw mode and the
            // visible text's in formatted mode; the edit is always in the latter.
            const start = raw ? mc.plainIndexAt(map, from) : from;
            const end = raw ? mc.plainIndexAt(map, to) : to;
            const next = mc.applyMotdCode(text, start, end, code);
            setText(next.text);
            requestAnimationFrame(() => {
                if (!field) return;
                field.focus();
                const after = mc.motdMap(next.text);
                const caret = raw
                    ? [after.offsets[next.start] ?? next.text.length, after.offsets[next.end] ?? next.text.length]
                    : [next.start, next.end];
                field.setSelectionRange(caret[0] as number, caret[1] as number);
            });
        },
        [map, raw, shown.length, text]
    );

    /** What the person typed, folded back into the string the server stores. */
    const edit = useCallback(
        (value: string) => setText((current) => (raw ? value : mc.replaceMotdPlain(current, value))),
        [raw]
    );

    async function save(): Promise<void> {
        setError(null);
        const warning =
            playersOnline > 0
                ? `${playersOnline} ${playersOnline === 1 ? "player is" : "players are"} connected and will be disconnected.`
                : "The server restarts to pick the new description up.";
        if (!(await confirm({ title: "Restart with the new description?", description: warning, confirmLabel: "Save and restart" }))) {
            return;
        }
        startTransition(async () => {
            const result = await updateServerSettingsAction(installedAppId, [
                { key: "MOTD", value: mc.encodeMotd(text) }
            ]);
            if (result.error) {
                setError(result.error);
                return;
            }
            onSaved();
        });
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <p className="text-sm font-medium">Description</p>
                    <p className="text-xs text-muted-foreground">
                        The two lines under the server in a player&apos;s multiplayer list. Select some text and pick a
                        colour or a style for it; with nothing selected it applies from the cursor on. A colour
                        clears the style before it, which is Minecraft&apos;s rule and the reason for the preview.
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-1">
                    {Object.entries(mc.MOTD_COLORS).map(([code, colour]) => (
                        <button
                            key={code}
                            type="button"
                            onClick={() => apply(code)}
                            aria-label={colour.name}
                            title={colour.name}
                            className="size-6 rounded border border-border transition-transform hover:scale-110"
                            style={{ backgroundColor: colour.hex }}
                        />
                    ))}
                    <span className="mx-1 h-5 w-px bg-border" />
                    {Object.entries(mc.MOTD_STYLES).map(([code, label]) => (
                        <Button
                            key={code}
                            size="sm"
                            variant="ghost"
                            onClick={() => apply(code)}
                            title={label}
                            aria-label={label}
                            className="h-6 px-2 text-xs"
                        >
                            {label}
                        </Button>
                    ))}
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => apply(mc.RESET)}
                        title="Reset the formatting from here on"
                        aria-label="Reset the formatting from here on"
                        className="h-6 px-2 text-xs"
                    >
                        Reset
                    </Button>
                </div>

                <textarea
                    ref={area}
                    value={shown}
                    onChange={(event) => edit(event.target.value)}
                    rows={mc.MOTD_MAX_LINES}
                    aria-label={raw ? "Server description, with its formatting codes" : "Server description"}
                    spellCheck={false}
                    className="w-full resize-none rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-primary"
                />

                <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                        {mc.MOTD_MAX_LINES} lines. Anything after them is not shown.
                    </span>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        onClick={() => setRaw((current) => !current)}
                        title={raw ? "Edit the text and let the buttons write the codes" : "Edit the codes yourself"}
                    >
                        <Code2 className="size-3.5" /> {raw ? "Formatted" : "Codes"}
                    </Button>
                    {/* A button and not a switch: it pads the text that is there
                        now, so there is no state to be in afterwards. Running it
                        twice leaves the same result. */}
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        onClick={() => setText((current) => mc.centerMotd(current))}
                        title="Pad the lines so they sit in the middle of the list"
                    >
                        <AlignCenter className="size-3.5" /> Centre the lines
                    </Button>
                </div>

                <MotdPreview name={name} lines={preview} />

                {error && <p className="text-xs text-danger">{error}</p>}

                <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                        {changed ? "Pending a restart." : "This is what the server is running on."}
                    </p>
                    <Button onClick={() => void save()} disabled={pending || !changed}>
                        {pending ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
                        Save and restart
                    </Button>
                </div>

                {confirmElement}
            </CardBody>
        </Card>
    );
}

/**
 * The server as the multiplayer list draws it.
 *
 * Deliberately styled like the game rather than like the dashboard: the whole
 * question being answered is "what will this look like there", and a preview in the
 * dashboard's own type and colours would answer a different one.
 */
function MotdPreview({ name, lines }: { name: string; lines: mc.MotdSpan[][] }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Preview</span>
            <div
                className="overflow-x-auto rounded-md border border-border p-3 font-mono text-sm leading-tight"
                style={{ backgroundColor: mc.MOTD_BACKGROUND }}
            >
                <p className="mb-1 whitespace-pre text-[#FFFFFF]">{name}</p>
                {Array.from({ length: mc.MOTD_MAX_LINES }, (_, index) => (
                    <p key={index} className="whitespace-pre">
                        {(lines[index] ?? []).map((span, spanIndex) => (
                            <span
                                key={spanIndex}
                                style={{
                                    color: span.color,
                                    fontWeight: span.bold ? 700 : 400,
                                    fontStyle: span.italic ? "italic" : "normal",
                                    textDecoration:
                                        [span.underline ? "underline" : "", span.strikethrough ? "line-through" : ""]
                                            .filter(Boolean)
                                            .join(" ") || "none",
                                    // Minecraft redraws these characters every frame. A
                                    // still cannot show that, so it shows that they are
                                    // unreadable rather than showing them as readable.
                                    opacity: span.obfuscated ? 0.45 : 1
                                }}
                            >
                                {span.text}
                            </span>
                        ))}
                        {/* Keeps the empty second line at full height, so the preview
                            does not change size as somebody types into it. */}
                        {(lines[index] ?? []).length === 0 ? " " : null}
                    </p>
                ))}
            </div>
            <span className="text-xs text-muted-foreground">
                Minecraft draws its own font, so the spacing here is close rather than exact.
            </span>
        </div>
    );
}

/**
 * The picture beside the server in the list.
 *
 * Whatever is picked is scaled to 64x64 in the browser, because that is the only
 * size Minecraft loads and refusing everything else would send people off to find
 * an image editor. The server checks the result anyway - the browser is the
 * convenience, not the authority.
 */
function IconCard({
    installedAppId,
    iconSetAt,
    onSaved
}: {
    installedAppId: string;
    iconSetAt: string | null;
    onSaved: () => void;
}) {
    const [preview, setPreview] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const [pending, startTransition] = useTransition();
    const picker = useRef<HTMLInputElement>(null);

    function choose(file: File | undefined): void {
        if (!file) return;
        setError(null);
        setDone(false);
        void scaleToIcon(file)
            .then((dataUrl) => {
                setPreview(dataUrl);
                const png = dataUrl.slice(dataUrl.indexOf(",") + 1);
                startTransition(async () => {
                    const result = await setServerIconAction({ installedAppId, png });
                    if (result.error) {
                        setError(result.error);
                        return;
                    }
                    setDone(true);
                    onSaved();
                });
            })
            .catch(() => setError("That file could not be read as an image"));
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <p className="text-sm font-medium">Icon</p>
                    <p className="text-xs text-muted-foreground">
                        Shown beside the server in the multiplayer list. Any image will do - it is scaled to{" "}
                        {ICON_SIDE}x{ICON_SIDE} for you. The server picks it up on its next restart.
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    <div
                        className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-md border border-border"
                        style={{ backgroundColor: mc.MOTD_BACKGROUND }}
                    >
                        {preview ? (
                            <Image
                                src={preview}
                                alt="The icon that will be used"
                                width={ICON_SIDE}
                                height={ICON_SIDE}
                                unoptimized
                            />
                        ) : (
                            <ImageUp className="size-5 text-muted-foreground" />
                        )}
                    </div>
                    <div className="flex flex-col gap-1">
                        <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => picker.current?.click()}
                            disabled={pending}
                        >
                            {pending ? <Loader2 className="size-4 animate-spin" /> : <ImageUp className="size-4" />}
                            Choose an image
                        </Button>
                        <span className="text-xs text-muted-foreground">
                            {done
                                ? "Uploaded. Restart the server to show it."
                                : iconSetAt
                                  ? "An icon is already set. Choosing one replaces it."
                                  : "No icon yet."}
                        </span>
                    </div>
                </div>

                <input
                    ref={picker}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        choose(event.target.files?.[0]);
                        // So picking the same file twice still fires a change.
                        event.target.value = "";
                    }}
                />

                {error && <p className="text-xs text-danger">{error}</p>}
            </CardBody>
        </Card>
    );
}

/** Draw whatever was picked into a 64x64 PNG. Canvas rather than a dependency:
 *  every browser has one, and this is the only image work Polaris does. */
function scaleToIcon(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new window.Image();
        image.onload = () => {
            URL.revokeObjectURL(url);
            const canvas = document.createElement("canvas");
            canvas.width = ICON_SIDE;
            canvas.height = ICON_SIDE;
            const context = canvas.getContext("2d");
            if (!context) {
                reject(new Error("no canvas"));
                return;
            }
            // Cover rather than stretch: a wide banner squashed into a square reads
            // as a broken upload, where a centre crop reads as the icon they picked.
            const side = Math.min(image.width, image.height);
            context.drawImage(
                image,
                (image.width - side) / 2,
                (image.height - side) / 2,
                side,
                side,
                0,
                0,
                ICON_SIDE,
                ICON_SIDE
            );
            resolve(canvas.toDataURL("image/png"));
        };
        image.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("not an image"));
        };
        image.src = url;
    });
}
