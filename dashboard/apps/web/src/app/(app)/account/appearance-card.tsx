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
 * Every option is a button in a row rather than a dropdown, because the answer
 * is the picture on the button. A menu that says "Aurora" is a menu somebody has
 * to open five times to find out what five words mean.
 */

import * as core from "@polaris/core";
import { useMemo, useState } from "react";
import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { RotateCcw, Sparkles } from "lucide-react";
import { saveProfileStyleAction } from "./actions";
import { ProfileBanner } from "@/components/profile-banner";
import { useProfileStyleRefresh } from "@/components/profile-style-store";
import { Button, Card, CardBody, CardHeader, CardTitle, ColorPicker, cn } from "@polaris/ui";
import {
    frameCss,
    nameStyleCss,
    nameplateCss,
    ringBackground,
    sheenCss
} from "@/lib/profile-style-css";

/** The colours a background starts from when somebody turns one on, so the first
 *  thing they see is a band rather than black. */
const FIRST_COLOR = "#5b8def";
const SECOND_COLOR = "#a06bff";

type Background = "photo" | "solid" | "gradient";

export function AppearanceCard({
    userId,
    name,
    initial
}: {
    userId: string;
    name: string;
    initial: core.ProfileStyle;
}) {
    const [style, setStyle] = useState<core.ProfileStyle>(initial);
    const [saved, setSaved] = useState<core.ProfileStyle>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState(false);
    const refreshFaces = useProfileStyleRefresh();

    const changed = useMemo(
        () => JSON.stringify(style) !== JSON.stringify(saved),
        [style, saved]
    );
    const background: Background = style.banner?.kind ?? "photo";
    const effect = core.effectOf(style.effect);
    const plate = core.nameplateOf(style.nameplate);
    const painted = core.nameStyleOf(style.nameStyle);
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
                            className="profile-sheen pointer-events-none absolute inset-y-0 left-0 z-10 w-1/3 skew-x-12" // enigma: not a panel - a band of light crossing the card, a third of its width at every size; nothing to dismiss and nothing behind it
                            style={sheen}
                        />
                    ) : null}
                    <ProfileBanner
                        person={{ id: userId, name }}
                        fill={style.banner}
                        className="h-24"
                    />
                    <div className="flex flex-col gap-2 p-4">
                        <div className="-mt-12 flex items-end gap-3">
                            <span className="rounded-full ring-4 ring-card">
                                <Avatar
                                    person={{ id: userId, name }}
                                    size={72}
                                    decoration={style.decoration}
                                    status={false}
                                />
                            </span>
                        </div>
                        <p className="text-base font-semibold leading-tight">
                            <span style={painted ? nameStyleCss(painted) : undefined}>{name}</span>
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
                                <span style={painted ? nameStyleCss(painted) : undefined}>{name}</span>
                            </span>
                        </span>
                    </div>
                </div>

                <section className="flex flex-col gap-2">
                    <Field
                        label="Behind your name"
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
                        label="Around your face"
                        hint="Drawn on your picture everywhere it appears, at whatever size it is drawn."
                    />
                    <div className="flex flex-wrap gap-1.5">
                        <Choice chosen={!style.decoration} onClick={() => set({ decoration: null })} label="None" />
                        {core.AVATAR_DECORATIONS.map((decoration) => (
                            <Choice
                                key={decoration.id}
                                chosen={style.decoration === decoration.id}
                                onClick={() => set({ decoration: decoration.id })}
                                label={decoration.label}
                            >
                                <span
                                    aria-hidden="true"
                                    className="size-4 shrink-0 rounded-full"
                                    style={{ background: ringBackground(decoration) }}
                                />
                            </Choice>
                        ))}
                    </div>
                </section>

                <section className="flex flex-col gap-2">
                    <Field
                        label="Behind your row"
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
                    <Field label="Your name" hint="Two colours across the letters. Nothing else changes: not the size, not the weight." />
                    <div className="flex flex-wrap gap-1.5">
                        <Choice chosen={!style.nameStyle} onClick={() => set({ nameStyle: null })} label="Plain" />
                        {core.NAME_STYLES.map((entry) => (
                            <Choice
                                key={entry.id}
                                chosen={style.nameStyle === entry.id}
                                onClick={() => set({ nameStyle: entry.id })}
                                label={entry.label}
                                style={nameStyleCss(entry)}
                            />
                        ))}
                    </div>
                </section>

                <section className="flex flex-col gap-2">
                    <Field label="Your profile card" hint="An edge, a slow band of light, or both. It stops for anybody who has asked their machine for less motion." />
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
                    {error ? <p className="text-danger text-sm">{error}</p> : null}
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
    children
}: {
    chosen: boolean;
    onClick: () => void;
    label: string;
    style?: React.CSSProperties;
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
            <span style={style}>{label}</span>
        </button>
    );
}
