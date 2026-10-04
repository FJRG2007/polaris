/**
 * The frame around a connected extension: greeted by name, the face on the
 * right, the shelf switch only where there is somewhere to switch to, and no
 * email address anywhere.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultStatus } from "../src/lib/messages";
import { initialsInk, tintFor } from "@polaris/core/faces";
import { Face, Home, SectionBar, TopBar, vaultState } from "../src/entrypoints/popup/shell";

const STATUS: VaultStatus = {
    server: "https://polaris.example",
    email: "ada@example.com",
    linked: true,
    linkedAccount: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
    canVault: true,
    connected: true,
    unreachable: false,
    polarisSession: true,
    unlocked: false,
    syncedAt: null,
    timeoutMs: 0,
    accounts: [],
    activeId: null,
    awaitingApproval: false,
    organizations: [],
    shelf: null,
    face: null,
    servers: [
        {
            origin: "https://polaris.example",
            name: null,
            host: "polaris.example",
            active: true,
            accounts: 1
        }
    ]
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 19, 21, 0, 0));
});

afterEach(() => {
    vi.useRealTimers();
});

const bar = (status: VaultStatus) =>
    renderToStaticMarkup(<TopBar status={status} onChange={async () => {}} onOpen={() => {}} />);

describe("the top bar", () => {
    it("greets the account by its first name, by the clock", () => {
        expect(bar(STATUS)).toContain("Good evening, Ada");
    });

    it("never shows the email address", () => {
        expect(bar(STATUS)).not.toContain("ada@example.com");
    });

    it("draws the face, as initials when there is no picture", () => {
        const markup = bar(STATUS);
        expect(markup).toContain("AL");
        expect(markup).toContain("account menu");
    });

    it("draws the picture when there is one", () => {
        expect(bar({ ...STATUS, face: "data:image/png;base64,AQID" })).toContain(
            'src="data:image/png;base64,AQID"'
        );
    });

    it("offers the shelf switch only to an account in an organization", () => {
        expect(bar(STATUS)).not.toContain("Working in");
        const markup = bar({
            ...STATUS,
            organizations: [{ id: "o1", name: "Acme", face: null }],
            shelf: "o1"
        });
        expect(markup).toContain("Working in Acme");
    });
});

describe("the home screen", () => {
    it("lists the vault with what it is doing", () => {
        const markup = renderToStaticMarkup(<Home status={STATUS} onOpen={() => {}} />);
        expect(markup).toContain("Vault");
        expect(markup).toContain("Locked");
    });

    it("says what the vault is doing in every state", () => {
        expect(vaultState({ ...STATUS, canVault: false })).toBe("This account has no vault");
        expect(vaultState({ ...STATUS, connected: false })).toBe("Not connected yet");
        expect(vaultState(STATUS)).toBe("Locked");
        expect(vaultState({ ...STATUS, unlocked: true })).toBe("Open");
        // Signed in, only out of reach: never "not connected", never a sign-in.
        expect(vaultState({ ...STATUS, unreachable: true })).toBe("Polaris can't be reached");
        expect(vaultState({ ...STATUS, unlocked: true, unreachable: true })).toBe(
            "Polaris can't be reached"
        );
    });

    it("does not list the hosts as if they were an app", () => {
        // Which Polaris this is lives in the account menu (host-menu.test.tsx).
        const markup = renderToStaticMarkup(<Home status={STATUS} onOpen={() => {}} />);
        expect(markup).not.toContain("Servers");
        expect(markup).not.toContain("Hosts");
        expect(markup).not.toContain("polaris.example");
        expect(markup.match(/class="section"/g)).toHaveLength(1);
    });
});

describe("a section", () => {
    it("has a way back", () => {
        expect(renderToStaticMarkup(<SectionBar title="Vault" onBack={() => {}} />)).toContain(
            "Back to the home screen"
        );
    });
});

describe("a face with no picture", () => {
    /** An id whose tint needs this ink, found rather than hard-coded. */
    const needing = (ink: string): string => {
        for (let n = 0; n < 10_000; n += 1) {
            if (initialsInk(tintFor(`id-${n}`)) === ink) return `id-${n}`;
        }
        throw new Error(ink);
    };

    it("writes the initials in whichever ink reads on its tint", () => {
        for (const ink of ["#000000", "#ffffff"]) {
            const markup = renderToStaticMarkup(
                <Face image={null} name="Ada Lovelace" tint={needing(ink)} size={30} />
            );
            expect(markup).toContain(`color:${ink}`);
            expect(markup).toContain("AL");
        }
    });
});
