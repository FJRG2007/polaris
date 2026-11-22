/**
 * The 1200x630 picture a chat app shows under a pasted Polaris link.
 *
 * Drawn by `next/og` from the faces checked into `src/fonts/og` (IBM Plex Sans,
 * the interface's own, as WOFF because the renderer cannot read WOFF2), so a
 * render never reaches for a font service - this server may have no outbound
 * DNS at all. Every string drawn has already been through `previewText`, which
 * drops what those faces cannot draw for the same reason.
 */

import { join } from "node:path";
import type { ReactNode } from "react";
import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";

export const PREVIEW_SIZE = { width: 1200, height: 630 } as const;

/** The design tokens of the dark theme, as the renderer needs them: literal colours. */
const COLORS = {
    background: "hsl(225, 12%, 5%)",
    card: "hsl(225, 11%, 9%)",
    border: "hsl(225, 10%, 16%)",
    foreground: "hsl(220, 14%, 96%)",
    muted: "hsl(222, 10%, 66%)",
    primary: "hsl(258, 82%, 62%)",
    primarySoft: "hsl(258, 90%, 78%)",
    /** The mark's own purple, as `public/icon.svg` paints it. */
    mark: "#7632EC"
} as const;

type Font = { name: string; data: Buffer; weight: 400 | 600; style: "normal" };

let fonts: Promise<Font[]> | null = null;

/** Read once per process; a failed read is retried on the next render. */
function loadFonts(): Promise<Font[]> {
    if (!fonts) {
        const dir = join(process.cwd(), "src", "fonts", "og");
        fonts = Promise.all([
            readFile(join(dir, "IBMPlexSans-Regular.woff")),
            readFile(join(dir, "IBMPlexSans-SemiBold.woff"))
        ]).then(
            ([regular, semibold]) => [
                { name: "Plex", data: regular, weight: 400, style: "normal" },
                { name: "Plex", data: semibold, weight: 600, style: "normal" }
            ],
            (caught) => {
                fonts = null;
                throw caught;
            }
        );
    }
    return fonts;
}

/** The Polaris mark: the geometry of `public/icon.svg`, scaled. */
function Mark({ size }: { size: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 32 32">
            <rect width="32" height="32" rx="7" fill={COLORS.mark} />
            <path
                d="M16 3Q17.6 12.6 29 16Q17.6 19.4 16 29Q14.4 19.4 3 16Q14.4 12.6 16 3Z"
                fill="#FFFFFF"
            />
        </svg>
    );
}

function Frame({ children }: { children: ReactNode }) {
    return (
        <div
            style={{
                width: "100%",
                height: "100%",
                display: "flex",
                flexDirection: "column",
                backgroundColor: COLORS.background,
                backgroundImage: "radial-gradient(circle at 100% 0%, hsla(258, 82%, 62%, 0.28) 0%, hsla(258, 82%, 62%, 0) 55%)",
                color: COLORS.foreground,
                fontFamily: "Plex",
                position: "relative"
            }}
        >
            {children}
            <div
                style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: 8,
                    backgroundColor: COLORS.primary
                }}
            />
        </div>
    );
}

/** Up to two letters for a person or organization with no picture drawn. */
export function initialsOf(name: string): string {
    const words = name.split(/\s+/).filter(Boolean);
    const letters = words.length > 1 ? [words[0]?.[0] ?? "", words.at(-1)?.[0] ?? ""] : [...name].slice(0, 2);
    return letters.join("").toUpperCase();
}

export interface PreviewImageText {
    /** "Shared from Drive", "Note"... drawn as a pill above a disclosed name. */
    label?: string;
    /** The big line; absent draws the plain banner. */
    title?: string;
    detail?: string;
    /** Draw initials beside the title (a profile or organization). */
    avatar?: boolean;
    /** The line under the name on the plain banner. */
    tagline?: string;
}

function Banner({ tagline }: { tagline?: string }) {
    return (
        <Frame>
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    flexGrow: 1,
                    padding: "0 96px"
                }}
            >
                <Mark size={168} />
                <div style={{ marginTop: 40, fontSize: 104, fontWeight: 600, letterSpacing: -2 }}>
                    Polaris
                </div>
                {tagline ? (
                    <div
                        style={{
                            marginTop: 16,
                            fontSize: 36,
                            color: COLORS.muted,
                            textAlign: "center",
                            maxWidth: 960
                        }}
                    >
                        {tagline}
                    </div>
                ) : null}
            </div>
        </Frame>
    );
}

function Card({ label, title, detail, avatar }: PreviewImageText) {
    return (
        <Frame>
            <div style={{ display: "flex", alignItems: "center", padding: "64px 80px 0" }}>
                <Mark size={64} />
                <div style={{ marginLeft: 20, fontSize: 40, fontWeight: 600, letterSpacing: -0.5 }}>
                    Polaris
                </div>
            </div>
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    flexGrow: 1,
                    padding: "0 80px 40px"
                }}
            >
                {label ? (
                    <div style={{ display: "flex" }}>
                        <div
                            style={{
                                display: "flex",
                                padding: "10px 24px",
                                borderRadius: 999,
                                border: `2px solid ${COLORS.primary}`,
                                backgroundColor: "hsla(258, 82%, 62%, 0.14)",
                                color: COLORS.primarySoft,
                                fontSize: 30,
                                fontWeight: 600
                            }}
                        >
                            {label}
                        </div>
                    </div>
                ) : null}
                {title ? (
                    <div style={{ display: "flex", alignItems: "center", marginTop: label ? 36 : 0 }}>
                        {avatar ? (
                            <div
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: 128,
                                    height: 128,
                                    flexShrink: 0,
                                    marginRight: 36,
                                    borderRadius: 999,
                                    backgroundColor: COLORS.card,
                                    border: `3px solid ${COLORS.border}`,
                                    color: COLORS.primarySoft,
                                    fontSize: 52,
                                    fontWeight: 600
                                }}
                            >
                                {initialsOf(title)}
                            </div>
                        ) : null}
                        <div
                            style={{
                                display: "block",
                                fontSize: 68,
                                fontWeight: 600,
                                lineHeight: 1.15,
                                letterSpacing: -1,
                                maxWidth: avatar ? 876 : 1040,
                                overflow: "hidden",
                                lineClamp: 2,
                                wordBreak: "break-word"
                            }}
                        >
                            {title}
                        </div>
                    </div>
                ) : null}
                {detail ? (
                    <div
                        style={{
                            display: "block",
                            marginTop: 20,
                            fontSize: 34,
                            color: COLORS.muted,
                            maxWidth: 1040,
                            overflow: "hidden",
                            whiteSpace: "nowrap",
                            textOverflow: "ellipsis"
                        }}
                    >
                        {detail}
                    </div>
                ) : null}
            </div>
        </Frame>
    );
}

/** The picture itself, as a PNG response with the given cache lifetime. */
export async function renderPreviewImage(
    text: PreviewImageText,
    maxAgeSeconds: number
): Promise<ImageResponse> {
    const element = text.title ? <Card {...text} /> : <Banner tagline={text.tagline} />;
    return new ImageResponse(element, {
        ...PREVIEW_SIZE,
        fonts: await loadFonts(),
        headers: {
            "Cache-Control": `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}`
        }
    });
}
