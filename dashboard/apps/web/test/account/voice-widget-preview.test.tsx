// @vitest-environment jsdom
/**
 * The voice widget preview in Settings > This app.
 *
 * What has to hold: it lists as many people as the widget would, the viewer is
 * the first face with their own picture, the sample people wear the bundled
 * illustrations (shipped with Polaris, never fetched from elsewhere) except the
 * ones left on initials, and every face is the shared `Avatar` a call draws.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { withMessages } from "../setup/i18n";
import { SessionScopeProvider } from "@/components/session-scope";
import { defaultAppSettings } from "@/components/this-app/app-settings-values";
import { SAMPLE, VoiceWidgetPreview, previewRows } from "@/app/(app)/account/app/[category]/voice-widget-preview";
import messages from "../../messages/en-US/appSettings.json";

const PUBLIC = join(__dirname, "../../public");

function draw(viewer: { id: string; name: string } | null) {
    const snapshot = { ...defaultAppSettings(), voiceWidget: true, voiceWidgetPeople: "always", voiceWidgetNames: "always", voiceWidgetMaxUsers: 0 } as const;
    const preview = <VoiceWidgetPreview snapshot={snapshot} />;
    const html = renderToStaticMarkup(
        withMessages(viewer ? <SessionScopeProvider userId={viewer.id} name={viewer.name}>{preview}</SessionScopeProvider> : preview)
    );
    const host = document.createElement("div");
    host.innerHTML = html;
    return host;
}

describe("the voice widget preview", () => {
    it("draws up to the chosen number and counts the rest, Off drawing everybody", () => {
        expect(previewRows(6, 8)).toEqual({ shown: 6, more: 0 });
        expect(previewRows(6, 5)).toEqual({ shown: 5, more: 1 });
        expect(previewRows(6, 0)).toEqual({ shown: 6, more: 0 });
        expect(previewRows(0, 5)).toEqual({ shown: 0, more: 0 });
    });

    it("puts the viewer first, with the picture every other face of theirs loads", () => {
        const faces = [...draw({ id: "user_viewer", name: "Pat Example" }).querySelectorAll("[data-avatar]")];
        expect(faces).toHaveLength(SAMPLE.length + 1);
        expect(faces[0]!.getAttribute("title")).toBe("Pat Example");
        expect(faces[0]!.querySelector("img")?.getAttribute("src")).toBe("/api/avatar/user_viewer");
    });

    it("gives the samples bundled illustrations and leaves some on initials", () => {
        const faces = [...draw(null).querySelectorAll("[data-avatar]")];
        expect(faces).toHaveLength(SAMPLE.length);
        const names = messages.overlay.people as Record<string, string>;
        let initialsOnly = 0;
        for (const [index, person] of SAMPLE.entries()) {
            const face = faces[index]!;
            expect(face.getAttribute("title")).toBe(names[person.id]);
            const source = face.querySelector("img")?.getAttribute("src") ?? null;
            expect(source).toBe(person.picture);
            if (!source) {
                initialsOnly += 1;
                expect(face.textContent).not.toBe("");
                continue;
            }
            // Served by Polaris itself, never another origin.
            expect(source.startsWith("/voice-widget/")).toBe(true);
            const file = join(PUBLIC, source);
            expect(existsSync(file)).toBe(true);
            const svg = readFileSync(file, "utf8");
            expect(svg.startsWith("<svg")).toBe(true);
            expect(svg).not.toMatch(/<script|href=|url\(|<image/i);
            expect(svg.length).toBeLessThan(2048);
        }
        expect(initialsOnly).toBeGreaterThanOrEqual(1);
        expect(initialsOnly).toBeLessThanOrEqual(2);
    });
});
