// @vitest-environment jsdom

/**
 * Domains, split into pages.
 *
 * /admin/domains was one long page; its tunnels, ports, certificates and security
 * inventory now each have a page under the same rail. What has to hold: every
 * page exists, is an administrator's alone, and draws the cards it was given -
 * and every anchor the old page had still lands on the card it named, because
 * notifications already stored point at `/admin/domains#that-anchor`.
 *
 * The cards are stood in for: what is under test is which page holds which card,
 * not the cards themselves (each has its own test).
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({
    requireAdmin: vi.fn(async () => ({ id: "admin-1", isAdmin: true }))
}));
const router = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("@/lib/session", () => session);
vi.mock("@/lib/i18n/request", () => ({ getTranslations: vi.fn(async () => (key: string) => key) }));
vi.mock("@/components/i18n/messages", () => ({
    Messages: ({ children }: { children: React.ReactNode }) => children
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

/** A stand-in that says which card it is. */
function stub(name: string) {
    return () => <section data-card={name} />;
}

const DOMAINS = "src/app/(app)/admin/domains";

vi.mock("@/app/(app)/admin/domains/domains-view", () => ({
    DomainsView: stub("DomainsView"),
    LocalCertificate: stub("LocalCertificate")
}));
vi.mock("@/app/(app)/admin/domains/backup-access-card", () => ({
    BackupAccessCard: stub("BackupAccessCard")
}));
vi.mock("@/app/(app)/admin/domains/tailscale-card", () => ({
    TailscaleCard: stub("TailscaleCard")
}));
vi.mock("@/app/(app)/admin/domains/game-ports-card", () => ({
    GamePortsCard: stub("GamePortsCard")
}));
vi.mock("@/app/(app)/admin/domains/call-ports-card", () => ({
    CallPortsCard: stub("CallPortsCard")
}));
vi.mock("@/app/(app)/admin/domains/certificate-contact-card", () => ({
    CertificateContactCard: stub("CertificateContactCard")
}));
vi.mock("@/components/domain-security/security-inventory", () => ({
    SecurityInventory: stub("SecurityInventory")
}));

import { APP_SUBAPPS, resolveSubapp } from "@/lib/apps";
import DomainsPage from "@/app/(app)/admin/domains/page";
import PortsPage from "@/app/(app)/admin/domains/ports/page";
import SecurityPage from "@/app/(app)/admin/domains/security/page";
import CertificatesPage from "@/app/(app)/admin/domains/certificates/page";
import RemoteAccessPage from "@/app/(app)/admin/domains/remote-access/page";
import { MovedAnchorRedirect } from "@/app/(app)/admin/domains/moved-anchor-redirect";
import { MOVED_ANCHORS, movedAnchorHref } from "@/app/(app)/admin/domains/moved-anchors";

/** Each page, by address, and the cards it must draw. */
const PAGES: Record<string, { page: () => Promise<React.ReactElement>; cards: string[] }> = {
    "/admin/domains": { page: DomainsPage, cards: ["DomainsView"] },
    "/admin/domains/remote-access": {
        page: RemoteAccessPage,
        cards: ["BackupAccessCard", "TailscaleCard"]
    },
    "/admin/domains/ports": { page: PortsPage, cards: ["GamePortsCard", "CallPortsCard"] },
    "/admin/domains/certificates": {
        page: CertificatesPage,
        cards: ["LocalCertificate", "CertificateContactCard"]
    },
    "/admin/domains/security": { page: SecurityPage, cards: ["SecurityInventory"] }
};

/** Every anchor the single Domains page had, before it was split. */
const OLD_ANCHORS = [
    "public-address",
    "backup-access",
    "tailscale",
    "dns-records",
    "game-ports",
    "call-ports",
    "certificate-contact",
    "security"
];

/** The card each old anchor belongs to, and the file that declares the anchor. The
 *  file is read, so a renamed anchor fails here rather than in a notification. */
const ANCHOR_OWNERS: Record<string, { card: string; file: string }> = {
    "public-address": { card: "DomainsView", file: `${DOMAINS}/address-follow-card.tsx` },
    "dns-records": { card: "DomainsView", file: `${DOMAINS}/dns-records-card.tsx` },
    "backup-access": { card: "BackupAccessCard", file: `${DOMAINS}/backup-access-card.tsx` },
    tailscale: { card: "TailscaleCard", file: `${DOMAINS}/tailscale-card.tsx` },
    "game-ports": { card: "GamePortsCard", file: `${DOMAINS}/game-ports-card.tsx` },
    "call-ports": { card: "CallPortsCard", file: `${DOMAINS}/call-ports-card.tsx` },
    "certificate-contact": {
        card: "CertificateContactCard",
        file: `${DOMAINS}/certificate-contact-card.tsx`
    },
    security: {
        card: "SecurityInventory",
        file: "src/components/domain-security/security-inventory.tsx"
    }
};

beforeEach(() => {
    session.requireAdmin.mockClear();
    router.replace.mockClear();
});
afterEach(cleanup);

describe("the Domains pages", () => {
    for (const [href, { page, cards }] of Object.entries(PAGES)) {
        it(`${href} draws ${cards.join(", ")} after the admin check`, async () => {
            const markup = renderToStaticMarkup(await page());

            expect(session.requireAdmin).toHaveBeenCalledTimes(1);
            for (const card of cards) expect(markup).toContain(`data-card="${card}"`);
        });

        it(`${href} is refused to anybody who is not an administrator`, async () => {
            session.requireAdmin.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));

            await expect(page()).rejects.toThrow("NEXT_REDIRECT");
        });

        it(`${href} sits under the Domains heading of the Platform rail`, () => {
            const subapp = resolveSubapp(href);
            const section = subapp?.sections.find((entry) => entry.href === href);

            expect(subapp?.id).toBe("admin-platform");
            expect(section?.group).toBe("Domains");
            expect(section?.adminOnly).toBe(true);
        });
    }

    it("lists no page under the Domains heading that does not exist", () => {
        const rail = APP_SUBAPPS.find((subapp) => subapp.id === "admin-platform");
        const listed = rail?.sections.filter((section) => section.group === "Domains");

        expect(listed?.map((section) => section.href).sort()).toEqual(Object.keys(PAGES).sort());
    });

    it("draws each card on exactly one page", async () => {
        const seen: string[] = [];
        for (const { page } of Object.values(PAGES)) {
            const markup = renderToStaticMarkup(await page());
            seen.push(...[...markup.matchAll(/data-card="([^"]+)"/g)].map((match) => match[1]!));
        }

        expect(seen.length).toBe(new Set(seen).size);
    });
});

describe("an old link to /admin/domains#anchor", () => {
    it("knows where every anchor of the old page lives now", () => {
        expect(Object.keys(ANCHOR_OWNERS).sort()).toEqual([...OLD_ANCHORS].sort());
        for (const id of Object.keys(MOVED_ANCHORS)) expect(OLD_ANCHORS).toContain(id);
    });

    for (const id of OLD_ANCHORS) {
        it(`#${id} lands on the page that draws its card`, async () => {
            const owner = ANCHOR_OWNERS[id]!;
            const source = readFileSync(join(process.cwd(), owner.file), "utf8");
            const declared =
                source.includes(`id="${id}"`) || new RegExp(`=\\s*"${id}"`).test(source);

            expect(declared).toBe(true);

            const moved = movedAnchorHref(`#${id}`);
            const href = moved ? moved.split("#")[0]! : "/admin/domains";
            if (moved) expect(moved).toBe(`${href}#${id}`);
            const markup = renderToStaticMarkup(await PAGES[href]!.page());

            expect(markup).toContain(`data-card="${owner.card}"`);
        });
    }

    it("leaves an anchor that did not move, and a stray one, where they are", () => {
        expect(movedAnchorHref("#public-address")).toBeNull();
        expect(movedAnchorHref("#dns-records")).toBeNull();
        expect(movedAnchorHref("")).toBeNull();
        expect(movedAnchorHref("#toString")).toBeNull();
    });

    it("is sent on by the Domains page itself", () => {
        window.history.replaceState(null, "", "/admin/domains#backup-access");
        render(<MovedAnchorRedirect />);

        expect(router.replace).toHaveBeenCalledWith("/admin/domains/remote-access#backup-access");
    });

    it("follows a hash changed on the open page too", () => {
        window.history.replaceState(null, "", "/admin/domains");
        render(<MovedAnchorRedirect />);
        expect(router.replace).not.toHaveBeenCalled();

        window.location.hash = "#certificate-contact";
        window.dispatchEvent(new HashChangeEvent("hashchange"));

        expect(router.replace).toHaveBeenCalledWith(
            "/admin/domains/certificates#certificate-contact"
        );
    });
});
