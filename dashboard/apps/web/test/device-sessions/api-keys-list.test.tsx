/**
 * Account > API keys lists only the keys a person made. What a device's app
 * signed in with (the command line, a Stream Deck, a TV) is a session, listed
 * under Account > Sessions, and neither its row nor its edit page is here.
 */

import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

const KEYS = [
    { id: "k-test", name: "test", kind: "key", description: null },
    { id: "k-cli", name: "CLI - DRAGON", kind: "cli", description: "Signed in with plr login." },
    { id: "k-deck", name: "Stream Deck - DRAGON", kind: "streamdeck", description: null },
    { id: "k-tv", name: "TV - Nokia Streaming Box 8000", kind: "tv", description: null }
];

vi.mock("@polaris/auth", () => ({
    listApiKeys: async () => KEYS,
    listAccessGroups: async () => [],
    scopesAvailableTo: async () => []
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "u-1", isAdmin: false }) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/vault/client-key", () => ({ isClientKey: () => false }));
vi.mock("@/lib/vpn/mesh", () => ({ vpnMeshOn: async () => false }));
vi.mock("@/components/vpn/device-keys", () => ({ VpnDeviceKeys: () => null }));
vi.mock("next/navigation", () => ({
    notFound: () => {
        throw new Error("not found");
    }
}));
vi.mock("@/app/(app)/account/api-keys/api-keys-view", () => ({ ApiKeysView: () => null }));
vi.mock("@/app/(app)/account/api-keys/key-form", () => ({ KeyForm: () => null }));

/** The props a server page handed the element of `type`, wherever it sits. */
function propsOf(node: unknown, name: string): Record<string, unknown> | null {
    if (!isValidElement(node)) return null;
    const element = node as ReactElement<Record<string, unknown>>;
    if (typeof element.type === "function" && element.type.name === name) return element.props;
    const children = element.props["children"];
    for (const child of Array.isArray(children) ? children : [children]) {
        const found = propsOf(child, name);
        if (found) return found;
    }
    return null;
}

describe("Account > API keys", () => {
    it("lists the key a person made and none of the devices' sign-ins", async () => {
        const { default: Page } = await import("@/app/(app)/account/api-keys/page");
        const props = propsOf(await Page(), "ApiKeysView");
        expect((props?.["keys"] as { id: string }[]).map((key) => key.id)).toEqual(["k-test"]);
    });

    it("has no edit page for a device's sign-in", async () => {
        const { default: Edit } = await import("@/app/(app)/account/api-keys/[keyId]/page");
        await expect(Edit({ params: Promise.resolve({ keyId: "k-deck" }) })).rejects.toThrow(
            "not found"
        );
        await expect(Edit({ params: Promise.resolve({ keyId: "k-test" }) })).resolves.toBeTruthy();
    });
});
