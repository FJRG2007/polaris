// @vitest-environment jsdom

/**
 * "Filter settings" on a service's Settings tab: what matches (the card's own
 * words in the screen's language, and its keywords in English and Spanish), the
 * empty state and its Clear, the rail following the filter, and "/" reaching the
 * box. The matching is asserted pure; the rest mounts the real settings kit.
 */

import { MessagesWrapper } from "../setup/i18n";
import { GitBranch, ShieldCheck } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SettingsCard, SettingsLayout, SettingsSection } from "@/app/(app)/apps/deploy/settings-kit";
import {
    filterSettings,
    foldText,
    matchesQuery,
    type SettingsIndex
} from "@/app/(app)/apps/deploy/settings-search";

afterEach(cleanup);

const INDEX: SettingsIndex = {
    repository: {
        section: "source",
        keywords: { en: ["github", "branch"], es: ["repositorio", "rama"] }
    },
    securityHeaders: {
        section: "security",
        keywords: { en: ["hsts", "csp"], es: ["cabeceras de seguridad"] }
    }
};

describe("matching a typed filter", () => {
    it("ignores case, accents and extra spacing", () => {
        expect(foldText("  Cabeceras   de SEGURIDAD ")).toBe("cabeceras de seguridad");
        expect(matchesQuery("Directorio raíz", "RAIZ")).toBe(true);
    });

    it("needs every typed word, in any order", () => {
        expect(matchesQuery("Security headers", "headers security")).toBe(true);
        expect(matchesQuery("Security headers", "headers port")).toBe(false);
    });

    it("finds a card by its title, or by a keyword in either language", () => {
        const mounted = [
            { entry: "repository", text: "Repository The code this service builds." },
            { entry: "securityHeaders", text: "Security headers" }
        ];
        expect([...filterSettings(INDEX, mounted, "cabeceras").cards]).toEqual(["securityHeaders"]);
        expect([...filterSettings(INDEX, mounted, "hsts").sections]).toEqual(["security"]);
        expect([...filterSettings(INDEX, mounted, "rama").cards]).toEqual(["repository"]);
        expect(filterSettings(INDEX, mounted, "nothing like this").cards.size).toBe(0);
    });

    it("leaves out a card that is not drawn, and one the page never declared", () => {
        const result = filterSettings(INDEX, [{ entry: "unknown", text: "Security headers" }], "security");
        expect(result.cards.size).toBe(0);
        expect(result.sections.size).toBe(0);
    });
});

function Page() {
    return (
        <SettingsLayout
            index={INDEX}
            sections={[
                { id: "s-source", group: "source", label: "Source", icon: GitBranch },
                { id: "s-security", group: "security", label: "Security & edge", icon: ShieldCheck }
            ]}
        >
            <SettingsSection id="s-source" group="source" icon={GitBranch} title="Source" intro="Code.">
                <SettingsCard entry="repository" title="Repository" description="The code it builds." />
            </SettingsSection>
            <SettingsSection
                id="s-security"
                group="security"
                icon={ShieldCheck}
                title="Security & edge"
                intro="Guards."
            >
                <SettingsCard entry="securityHeaders" title="Security headers" description="Sent on every answer." />
            </SettingsSection>
        </SettingsLayout>
    );
}

function rail(): string[] {
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    return within(nav)
        .queryAllByRole("button")
        .map((button) => button.textContent ?? "");
}

describe("the filter on the Settings tab", () => {
    it("hides what does not match and keeps the rail to the sections left", () => {
        render(<Page />, { wrapper: MessagesWrapper });
        const box = screen.getByRole("searchbox", { name: "Filter settings" });
        expect(rail()).toEqual(["Source", "Security & edge"]);

        fireEvent.change(box, { target: { value: "cabeceras" } });
        expect(screen.getByRole("heading", { name: "Security headers" })).toBeDefined();
        expect(screen.queryByRole("heading", { name: "Repository" })).toBeNull();
        expect(rail()).toEqual(["Security & edge"]);
    });

    it("says nothing matched, and Clear brings every setting back", () => {
        render(<Page />, { wrapper: MessagesWrapper });
        const box = screen.getByRole("searchbox", { name: "Filter settings" });
        fireEvent.change(box, { target: { value: "zzz" } });
        expect(screen.getByText('No setting matches "zzz"')).toBeDefined();
        expect(rail()).toEqual([]);

        fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
        expect((box as HTMLInputElement).value).toBe("");
        expect(screen.getByRole("heading", { name: "Repository" })).toBeDefined();
        expect(rail()).toEqual(["Source", "Security & edge"]);
    });

    it("is reached with / from anywhere but a field, and Escape empties it", () => {
        render(<Page />, { wrapper: MessagesWrapper });
        const box = screen.getByRole("searchbox", { name: "Filter settings" });
        fireEvent.keyDown(document.body, { key: "/" });
        expect(document.activeElement).toBe(box);

        fireEvent.change(box, { target: { value: "github" } });
        fireEvent.keyDown(box, { key: "Escape" });
        expect((box as HTMLInputElement).value).toBe("");
    });
});
