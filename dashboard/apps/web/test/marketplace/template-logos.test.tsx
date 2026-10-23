// @vitest-environment jsdom

/**
 * Deploy templates in the store: each one wears its project's own logo, and a
 * template whose job a built-in app already does says so on its card - with a
 * link only for a reader who may open that app.
 */

import { resolve } from "node:path";
import { MessagesWrapper } from "../setup/i18n";
import { SERVICE_TEMPLATES } from "@polaris/core";
import { existsSync, readdirSync } from "node:fs";
import { templateLogoSrc } from "@/lib/apps/template-apps";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MarketplaceView } from "@/app/(app)/apps/marketplace/marketplace-view";
import { builtInAlternative, findStoreApp } from "@/lib/apps/marketplace-store";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/(app)/apps/deploy/actions", () => ({
    listTemplateTargetsAction: vi.fn(async () => []),
    listDeployServersAction: vi.fn(async () => []),
    createApplicationAction: vi.fn()
}));
vi.mock("@/app/(app)/apps/marketplace/actions", () => ({
    installAppAction: vi.fn(),
    listInstallTargetsAction: vi.fn(async () => []),
    listStorageConnectionsAction: vi.fn(async () => [])
}));
vi.mock("@/app/(app)/apps/installed/[id]/actions", () => ({
    uninstallInstalledAppAction: vi.fn()
}));

afterEach(cleanup);

const PUBLIC = resolve(__dirname, "../../public");
const SERVED = resolve(PUBLIC, "logos/apps");

describe("template logos", () => {
    it("serves a logo for every template", () => {
        for (const template of SERVICE_TEMPLATES) {
            const src = templateLogoSrc(template.id);
            expect(existsSync(resolve(PUBLIC, `.${src}`)), template.id).toBe(true);
            expect(findStoreApp(`template-${template.id}`)?.logo).toBe(src);
        }
    });

    it("serves no logo for a template that is gone", () => {
        const served = readdirSync(SERVED).map((file) => file.replace(/\.(svg|webp)$/, ""));
        expect(served.sort()).toEqual(SERVICE_TEMPLATES.map((template) => template.id).sort());
    });
});

describe("a template a built-in app already covers", () => {
    const covered = (id: string) => {
        const app = findStoreApp(`template-${id}`);
        return app ? builtInAlternative(app)?.href : "missing template";
    };

    it("is matched to the built-in that lists its product", () => {
        expect(covered("vaultwarden")).toBe("/vault");
        expect(covered("uptime-kuma")).toBe("/watch");
        expect(covered("n8n")).toBe("/automations");
        expect(covered("nextcloud")).toBe("/drive");
        expect(covered("mattermost")).toBe("/chat");
        expect(covered("vikunja")).toBe("/tasks");
    });

    it("points to the section that does the job, with the permission it needs", () => {
        const umami = findStoreApp("template-umami");
        expect(umami && builtInAlternative(umami)).toEqual({
            label: "Analytics",
            href: "/apps/analytics",
            permission: "deploy.manage"
        });
    });

    it("is not claimed where no built-in does the job", () => {
        expect(covered("stirling-pdf")).toBeUndefined();
        expect(covered("wordpress")).toBeUndefined();
    });

    it("says so on its card, linking only for a reader who may open the app", () => {
        const { rerender } = render(
            <MarketplaceView
                installed={[]}
                initialQuery="Vaultwarden"
                openableBuiltIns={["/vault"]}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByText(/Polaris already does this with Vault/)).toBeTruthy();
        expect(screen.getByRole("link", { name: "Open Vault" }).getAttribute("href")).toBe(
            "/vault"
        );

        rerender(
            <MarketplaceView installed={[]} initialQuery="Vaultwarden" openableBuiltIns={[]} />
        );
        expect(screen.getByText(/Polaris already does this with Vault/)).toBeTruthy();
        expect(screen.queryByRole("link", { name: "Open Vault" })).toBeNull();
    });

    it("draws the template's own logo", () => {
        render(<MarketplaceView installed={[]} initialQuery="Uptime Kuma" />, {
            wrapper: MessagesWrapper
        });
        const logos = Array.from(document.querySelectorAll("img")).map((img) =>
            img.getAttribute("src")
        );
        expect(logos).toContain("/logos/apps/uptime-kuma.svg");
    });
});
