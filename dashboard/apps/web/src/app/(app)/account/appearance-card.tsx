"use client";

/**
 * Choosing what your profile looks like.
 *
 * The whole card is a preview with controls under it, rather than a list of
 * settings with a preview somewhere else. Every one of these decisions is about
 * how something looks next to something else - a ring around your face over that
 * banner, your name on that plate - and a picker that shows a swatch cannot
 * answer that. So the card at the top is the real thing, drawn by the same
 * components that draw it on your profile, and it changes as each option is
 * pressed.
 *
 * Nothing here is sold, gated or earned. The whole reason it is a catalogue
 * rather than an upload is that a catalogue costs nothing to give everybody: no
 * moderation queue, no storage, and no way to put an arbitrary image beside your
 * name in a list of colleagues.
 *
 * Every option is a button rather than an entry in a dropdown, because the
 * answer is the picture on the button. A menu that says "Aurora" is a menu
 * somebody has to open five times to find out what five words mean. The
 * decorations go further and are a gallery of faces wearing them: they are
 * drawings, and a swatch of a drawing is not a smaller drawing.
 */

import * as core from "@polaris/core";
import { useMemo, useState } from "react";
import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { saveProfileStyleAction } from "./actions";
import { avatarUrl, bannerUrl } from "@/lib/avatar-url";
import { ProfileBanner } from "@/components/profile-banner";
import { PictureEditor, usePicture } from "./avatar-card";
import { BAND_CROP, FACE_CROP } from "@/components/image-cropper";
import { Camera, Image as ImageIcon, RotateCcw, Sparkles } from "lucide-react";
import { useProfileStyleRefresh } from "@/components/profile-style-store";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    ColorPicker,
    cn
} from "@polaris/ui";
import {
    frameCss,
    nameLookCss,
    nameplateCss,
    nameStyleClass,
    sheenCss,
    SHEEN_LAYER
} from "@/lib/profile-style-css";

/** The colours a background starts from when somebody turns one on, so the first
 *  thing they see is a band rather than black. */
const FIRST_COLOR = "#5b8def";
const SECOND_COLOR = "#a06bff";

type Background = "photo" | "solid" | "gradient";

export function AppearanceCard({
    userId,
    name,
    hasPhoto,
    hasBanner,
    initial
}: {
    userId: string;
    name: string;
    /** Whether there is a picture of their own behind each of the two handles,
     *  which is what decides whether there is anything to reframe or take away. */
    hasPhoto: boolean;
    hasBanner: boolean;
    initial: core.ProfileStyle;
}) {
    const [style, setStyle] = useState<core.ProfileStyle>(initial);
    const [saved, setSaved] = useState<core.ProfileStyle>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState(false);
    const refreshFaces = useProfileStyleRefresh();
    const photo = usePicture("/api/avatar", avatarUrl(userId), FACE_CROP);
    const banner = usePicture("/api/banner", bannerUrl(userId), BAND_CROP);
    const pictureError = photo.error || banner.error;

    const changed = useMemo(
        () => JSON.stringify(style) !== JSON.stringify(saved),
        [style, saved]
    );
    const background: Background = style.banner?.kind ?? "photo";
    const effect = core.effectOf(style.effect);
    const plate = core.nameplateOf(style.nameplate);
    const painted = core.nameLookOf(style.nameStyle);
    const frame = effect ? frameCss(effect) : null;
    const sheen = effect ? sheenCss(effect) : null;

    const set = (part: Partial<core.ProfileStyle>) => {
        setStyle((was) => ({ ...was, ...part }));
        setDone(false);
    };

    /** Turning a background on and off, and switching between its two kinds
     *  without losing the colour already picked. */
    const setBackground = (kind: Background) => {
        if (kind === "photo") return set({ banner: null });
        const first = style.banner?.kind === "solid" ? style.banner.color : style.banner?.from ?? FIRST_COLOR;
        if (kind === "solid") return set({ banner: { kind: "solid", color: first } });
        const second = style.banner?.kind === "gradient" ? style.banner.to : SECOND_COLOR;
        set({ banner: { kind: "gradient", angle: style.banner?.kind === "gradient" ? style.banner.angle : 135, from: first, to: second } });
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>Appearance</CardTitle>
                <p className="text-xs text-muted-foreground">
                    How your profile looks to everybody else. Without a photo, Polaris uses the
                    picture your email address has on Gravatar and your initials if it has none;
                    without a banner, a colour taken from your photo.
                </p>
            </CardHeader>
            <CardBody className="flex flex-col gap-5">
                {/* Drawn by the same components your profile is drawn by, so what
                    is on this card is what other people will see rather than an
                    impression of it. */}
                <div
                    className={cn(
                        "relative overflow-hidden rounded-lg border border-border",
                        frame && "border-2"
                    )}
                    style={frame ?? undefined}
                >
                    {sheen ? (
                        // The light an effect walks across the card. Drawn over
                        // the band and the top of the body, which is what makes
                        // it read as light on a surface rather than as a stripe
                        // painted on one thing.
                        <span
                            aria-hidden="true"
                            className={SHEEN_LAYER} // enigma: not a panel - a layer of light crossing the card; nothing to dismiss and nothing behind it
                            style={sheen}
                        />
                    ) : null}
                    <div className="relative">
                        <ProfileBanner
                            person={{ id: userId, name }}
                            fill={style.banner}
                            className="h-24"
                        />
                        {/* Only over a banner that is actually a picture. With a
                            colour or a gradient chosen, the uploaded one is not
                            what is on screen, and a handle to reframe something
                            invisible is a handle that does nothing anybody can
                            see. */}
                        {background === "photo" && (
                            <PictureEditor
                                label="banner"
                                icon={ImageIcon}
                                picture={banner}
                                exists={hasBanner}
                                radius="none"
                            />
                        )}
                    </div>
                    <div className="flex flex-col gap-2 p-4">
                        <div className="-mt-12 flex items-end gap-3">
                            {/* A flex box, so it is exactly the size of the face.
                                Left as a block it takes the line box of the image
                                inside it, which is a few pixels taller than the
                                circle - and the round handle laid over `inset-0`
                                then draws as an ellipse hanging below it. */}
                            <span className="relative flex w-fit rounded-full ring-4 ring-card">
                                <Avatar
                                    person={{ id: userId, name }}
                                    size={72}
                                    decoration={style.decoration}
                                    status={false}
                                />
                                <PictureEditor
                                    label="photo"
                                    icon={Camera}
                                    picture={photo}
                                    exists={hasPhoto}
                                    radius="full"
                                />
                            </span>
                        </div>
                        <p className="text-base font-semibold leading-tight">
                            <span
                                className={nameStyleClass(painted)}
                                style={painted ? nameLookCss(painted) : undefined}
                            >
                                {name}
                            </span>
                        </p>
                        {/* What a plate actually looks like: a row in a list, not
                            a pill on a card. It is the only place one is drawn,
                            so the preview has to be that place. */}
                        <span
                            className="flex w-56 max-w-full items-center gap-2 rounded-md px-2 py-1"
                            style={plate ? nameplateCss(plate) : undefined}
                        >
                            <Avatar
                                person={{ id: userId, name }}
                                size={24}
                                decoration={style.decoration}
                                status={false}
                            />
                            <span className="truncate text-sm">
                                <span
                                    className={nameStyleClass(painted)}
                                    style={painted ? nameLookCss(painted) : undefined}
                                >
                                    {name}
                                </span>
                            </span>
                        </span>
                    </div>
                </div>

                <section className="flex flex-col gap-2">
                    <Field
                        label="Banner"
                        hint="The band across the top of your profile, under your banner picture."
                    />
                    <div className="flex flex-wrap gap-1.5">
                        <Choice
                            chosen={background === "photo"}
                            onClick={() => setBackground("photo")}
                            label="From your photo"
                        />
                        <Choice
                            chosen={background === "solid"}
                            onClick={() => setBackground("solid")}
                            label="One colour"
                        />
                        <Choice
                            chosen={background === "gradient"}
                            onClick={() => setBackground("gradient")}
                            label="Two colours"
                        />
                    </div>

                    {style.banner?.kind === "solid" ? (
                        <ColorPicker
                            className="max-w-sm"
                            label="Background"
                            value={style.banner.color}
                            onChange={(color) => set({ banner: { kind: "solid", color } })}
                        />
                    ) : null}

                    {style.banner?.kind === "gradient" ? (
                        <div className="flex flex-col gap-3">
                            <div className="grid gap-4 sm:grid-cols-2">
                                <ColorPicker
                                    label="From"
                                    value={style.banner.from}
                                    onChange={(from) =>
                                        set({ banner: { ...(style.banner as core.BannerFill & { kind: "gradient" }), from } })
                                    }
                                />
                                <ColorPicker
                                    label="To"
                                    value={style.banner.to}
                                    onChange={(to) =>
                                        set({ banner: { ...(style.banner as core.BannerFill & { kind: "gradient" }), to } })
                                    }
                                />
                            </div>
                            <label className="flex items-center gap-3 text-xs text-muted-foreground">
                                Angle
                                <input
                                    type="range"
                                    min={0}
                                    max={359}
                                    value={style.banner.angle}
                                    aria-label="The angle the two colours run at"
                                    onChange={(event) =>
                                        set({
                                            banner: {
                                                ...(style.banner as core.BannerFill & { kind: "gradient" }),
                                                angle: Number(event.target.value)
                                            }
                                        })
                                    }
                                    className="h-1.5 max-w-xs flex-1 cursor-pointer appearance-none rounded-full bg-muted"
                                />
                                <span className="w-10 font-mono tabular-nums">{style.banner.angle}&deg;</span>
                            </label>
                        </div>
                    ) : null}
                </section>

                <section className="flex flex-col gap-2">
                    <Field
                        label="Avatar decoration"
                        hint="Drawn on your picture everywhere it appears, at whatever size it is drawn. Every one of them is free."
                    />
                    {/* A gallery rather than a row of chips, because a decoration
                        is a drawing and the only useful way to choose between
                        fourteen drawings is to see them. Each tile is your own
                        face wearing the thing, drawn by the component that will
                        draw it in every list you appear in - so what is on the
                        tile is what other people get, not an impression of it. */}
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-1.5">
                        <Tile
                            chosen={!style.decoration}
                            onClick={() => set({ decoration: null })}
                            label="None"
                        >
                            <Avatar
                                person={{ id: userId, name }}
                                size={44}
                                decoration={null}
                                status={false}
                            />
                        </Tile>
                        {core.AVATAR_DECORATIONS.map((decoration) => (
                            <Tile
                                key={decoration.id}
                                chosen={style.decoration === decoration.id}
                                onClick={() => set({ decoration: decoration.id })}
                                label={decoration.label}
                                // Said out loud rather than left to be discovered
                                // one press at a time, for somebody choosing
                                // between them who does not want movement.
                                note={core.decorationMoves(decoration) ? "Moves" : undefined}
                            >
                                <Avatar
                                    person={{ id: userId, name }}
                                    size={44}
                                    decoration={decoration.id}
                                    status={false}
                                />
                            </Tile>
                        ))}
                    </div>
                </section>

                <section className="flex flex-col gap-2">
                    <Field
                        label="Nameplate"
                        hint="Where your name appears in a list of people, like the members of a conversation."
                    />
                    <div className="flex flex-wrap gap-1.5">
                        <Choice chosen={!style.nameplate} onClick={() => set({ nameplate: null })} label="None" />
                        {core.NAMEPLATES.map((entry) => (
                            <Choice
                                key={entry.id}
                                chosen={style.nameplate === entry.id}
                                onClick={() => set({ nameplate: entry.id })}
                                label={entry.label}
                            >
                                <span
                                    aria-hidden="true"
                                    className="h-4 w-6 shrink-0 rounded"
                                    style={{
                                        backgroundImage: `linear-gradient(${entry.angle}deg, ${entry.from}, ${entry.to})`
                                    }}
                                />
                            </Choice>
                        ))}
                    </div>
                </section>

                <section className="flex flex-col gap-2">
                    <Field
                        label="Display name style"
                        hint="An effect, letterforms and your own colours. Nothing changes the size, so a name is never taller than the row it is in."
                    />
                    <NameStylePicker value={style.nameStyle} onChange={(next) => set({ nameStyle: next })} />
                </section>

                <section className="flex flex-col gap-2">
                    <Field label="Profile effect" hint="An edge, a slow band of light, or both. It stops for anybody who has asked their machine for less motion." />
                    <div className="flex flex-wrap gap-1.5">
                        <Choice chosen={!style.effect} onClick={() => set({ effect: null })} label="None" />
                        {core.PROFILE_EFFECTS.map((entry) => (
                            <Choice
                                key={entry.id}
                                chosen={style.effect === entry.id}
                                onClick={() => set({ effect: entry.id })}
                                label={entry.label}
                            >
                                <span
                                    aria-hidden="true"
                                    className="size-4 shrink-0 rounded border"
                                    style={{
                                        borderColor: entry.frame?.from ?? "transparent",
                                        background: entry.sheen
                                            ? `linear-gradient(100deg, transparent 30%, ${entry.sheen}66 50%, transparent 70%)`
                                            : undefined
                                    }}
                                />
                            </Choice>
                        ))}
                    </div>
                </section>

                <div className="flex items-center justify-between gap-2">
                    {error || pictureError ? (
                        <p className="text-danger text-sm">{error || pictureError}</p>
                    ) : null}
                    {done && !error ? <p className="text-success text-sm">Saved.</p> : null}
                    <div className="ml-auto flex items-center gap-2">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy || core.styleIsPlain(style)}
                            onClick={() => set({ banner: null, decoration: null, nameplate: null, effect: null, nameStyle: null })}
                        >
                            <RotateCcw className="size-4 shrink-0" />
                            Clear it all
                        </Button>
                        <Button
                            type="button"
                            disabled={busy || !changed}
                            onClick={async () => {
                                setBusy(true);
                                setError("");
                                setDone(false);
                                const going = style;
                                const result = await runAction(
                                    () => saveProfileStyleAction(going),
                                    setError
                                );
                                setBusy(false);
                                if (!result || result.error) {
                                    if (result?.error) setError(result.error);
                                    return;
                                }
                                setSaved(going);
                                setDone(true);
                                // Every other face of yours on the screen behind
                                // this card is still wearing what you saved last
                                // time; the store keeps an appearance for the
                                // session precisely because it does not change on
                                // its own.
                                refreshFaces();
                            }}
                        >
                            {busy ? "Saving..." : "Save"}
                        </Button>
                    </div>
                </div>
            </CardBody>
        </Card>
    );
}

function Field({ label, hint }: { label: string; hint: string }) {
    return (
        <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-sm font-medium">
                <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
                {label}
            </span>
            <span className="text-xs text-muted-foreground">{hint}</span>
        </div>
    );
}

/** One option. The picture on it is the answer; the word beside it is only there
 *  so the picture can be named out loud. */
function Choice({
    chosen,
    onClick,
    label,
    style,
    labelClass,
    children
}: {
    chosen: boolean;
    onClick: () => void;
    label: string;
    style?: React.CSSProperties;
    /** For a treatment that needs keyframes as well as properties - the colours
     *  of a moving name are a class, since a `style` attribute cannot hold one. */
    labelClass?: string;
    children?: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={chosen}
            className={cn(
                "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
                chosen
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-card-hover hover:text-foreground"
            )}
        >
            {children}
            <span className={labelClass} style={style}>
                {label}
            </span>
        </button>
    );
}

/**
 * One tile of the gallery: a drawing, its name, and whether it moves.
 *
 * A tile rather than a chip because what is being chosen is a picture. The name
 * under it is what a screen reader announces and what somebody says out loud
 * when they want the one their colleague has; it is not what the choice is made
 * on.
 */
function Tile({
    chosen,
    onClick,
    label,
    note,
    children
}: {
    chosen: boolean;
    onClick: () => void;
    label: string;
    note?: string;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={chosen}
            title={note ? `${label} - ${note.toLowerCase()}` : label}
            className={cn(
                "flex flex-col items-center gap-1 rounded-lg border px-1 py-2 transition-colors",
                chosen
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-card-hover hover:text-foreground"
            )}
        >
            {children}
            <span className="w-full truncate px-1 text-center text-[0.6875rem] leading-tight">
                {label}
            </span>
            {/* Only on the ones it is true of, so the row of words under the
                gallery stays quiet. */}
            {note ? (
                <span className="text-muted-foreground text-[0.625rem] leading-none">{note}</span>
            ) : null}
        </button>
    );
}

/** What each effect is called on the button, and what it is for. */
const EFFECT_LABELS: Record<core.NameEffect, string> = {
    solid: "Solid",
    gradient: "Gradient",
    neon: "Neon",
    toon: "Toon",
    pop: "Pop",
    gummy: "Gummy",
    prism: "Prism"
};

const FONT_LABELS: Record<core.NameFont, string> = {
    sans: "Default",
    serif: "Serif",
    mono: "Mono",
    rounded: "Rounded",
    caps: "Small caps"
};

/** Where a name starts when somebody turns one on, so the first thing they see
 *  is a painted name rather than black on black. */
const FIRST_INK = "#5b8def";
const SECOND_INK = "#a06bff";

/**
 * Choosing how a name is painted.
 *
 * Three questions, in the order they matter: what it does, what it is set in,
 * and in which colours. Every button is drawn in the thing it selects - the word
 * "Neon" glows, "Serif" is set in a serif - because the alternative is a list of
 * nouns somebody has to try one at a time to find out what they mean.
 *
 * The catalogue that came before this is not offered any more, and does not need
 * to be: everything in it was a gradient between two colours, which is one of
 * the seven with the colour pickers underneath it. What is still read is the
 * stored ids, so nobody's name changes because the screen did.
 */
function NameStylePicker({
    value,
    onChange
}: {
    value: string | null;
    onChange: (next: string | null) => void;
}) {
    const look = core.nameLookOf(value);
    const on = look !== null;
    const effect = look?.effect ?? "gradient";
    const font = look?.font ?? "sans";
    const first = look?.colors[0] ?? FIRST_INK;
    const second = look?.colors[1] ?? SECOND_INK;

    /** Write the whole look every time. It is one value in one column, so there
     *  is no half-changed state to be in. */
    const put = (part: Partial<core.NameLook>) =>
        onChange(
            core.writeNameLook({
                effect: part.effect ?? effect,
                font: part.font ?? font,
                colors: part.colors ?? [first, second],
                moving: false
            })
        );

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
                <Choice chosen={!on} onClick={() => onChange(null)} label="Plain" />
                {core.NAME_EFFECTS.map((entry) => (
                    <Choice
                        key={entry}
                        chosen={on && effect === entry}
                        onClick={() => put({ effect: entry })}
                        label={EFFECT_LABELS[entry]}
                        // Painted as the thing it selects, in the colours
                        // already chosen, so the choice is made by looking.
                        labelClass={nameStyleClass({ moving: entry === "prism" })}
                        style={nameLookCss({
                            effect: entry,
                            font,
                            colors: [first, second],
                            moving: entry === "prism"
                        })}
                    />
                ))}
            </div>

            {on && (
                <>
                    <div className="flex flex-wrap gap-1.5">
                        {core.NAME_FONTS.map((entry) => (
                            <Choice
                                key={entry}
                                chosen={font === entry}
                                onClick={() => put({ font: entry })}
                                label={FONT_LABELS[entry]}
                                style={nameLookCss({
                                    effect: "solid",
                                    font: entry,
                                    colors: ["currentColor"],
                                    moving: false
                                })}
                            />
                        ))}
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                        <ColorPicker
                            label={core.effectTakesTwo(effect) ? "From" : "Colour"}
                            value={first}
                            onChange={(next) => put({ colors: [next, second] })}
                        />
                        {/* Only for the effects that actually run between two.
                            A second picker on Solid is a control that changes
                            nothing, which is worse than one that is missing. */}
                        {core.effectTakesTwo(effect) && (
                            <ColorPicker
                                label="To"
                                value={second}
                                onChange={(next) => put({ colors: [first, next] })}
                            />
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
