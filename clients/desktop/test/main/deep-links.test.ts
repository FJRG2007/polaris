/** A link always ends with something on screen, and never leaves a Polaris unasked. */

import { describe, expect, it } from "vitest";
import { DeepLinks, deepLinkRoute, type DeepLinkSteps } from "../../src/main/deep-links";

const HERE = "https://here.example";
const KEPT = "https://kept.example";
const UNKNOWN = "https://unknown.example";

function harness(options: { current?: string | null; yes?: boolean; switches?: boolean; } = {}) {
    const said: string[] = [];
    const { current = HERE, yes = true, switches = true } = options;
    let answer: (yes: boolean) => void = () => undefined;
    const held = new Promise<boolean>((resolve) => {
        answer = resolve;
    });
    const steps: DeepLinkSteps = {
        current: () => current,
        saved: () => [HERE, KEPT],
        show: (path) => void said.push(`show ${path ?? ""}`.trim()),
        confirmSwitch: (server) => {
            said.push(`ask ${server}`);
            return options.yes === undefined ? held : Promise.resolve(yes);
        },
        switchTo: async (server) => {
            said.push(`switch ${server}`);
            return switches;
        },
        openInBrowser: (url) => void said.push(`browser ${url}`)
    };
    return { said, steps, answer };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe("where a link goes", () => {
    const link = (server: string) => ({ server, path: "/chat" });

    it("opens a link for the Polaris in use (a mailto) there", () => {
        expect(deepLinkRoute({ server: null, path: "/mail/compose" }, HERE, [HERE])).toBe("here");
        expect(deepLinkRoute({ server: null, path: "/mail/compose" }, null, [])).toBe("here");
    });

    it("follows what this app knows", () => {
        expect(deepLinkRoute(link(HERE), HERE, [HERE, KEPT])).toBe("here");
        expect(deepLinkRoute(link(KEPT), HERE, [HERE, KEPT])).toBe("switch");
        expect(deepLinkRoute(link(KEPT), null, [KEPT])).toBe("switch");
        expect(deepLinkRoute(link(UNKNOWN), HERE, [HERE, KEPT])).toBe("browser");
    });
});

describe("a link reaching the app", () => {
    it("opens at once on the Polaris in use, with or without a window", () => {
        const { said, steps } = harness();
        const links = new DeepLinks(steps, null);
        links.opened();
        links.arrive({ server: HERE, path: "/chat" });
        expect(said).toEqual(["show /chat"]);
    });

    it("waits for the app to open, and the newest one wins", () => {
        const { said, steps } = harness();
        const links = new DeepLinks(steps, { server: HERE, path: "/first" });
        links.arrive({ server: HERE, path: "/second" });
        expect(said).toEqual([]);
        links.opened();
        expect(said).toEqual(["show /second"]);
    });

    it("hands one this app does not know to the browser", () => {
        const { said, steps } = harness();
        const links = new DeepLinks(steps, { server: UNKNOWN, path: "/chat?a=1" });
        links.opened();
        expect(said).toEqual([`browser ${UNKNOWN}/chat?a=1`]);
    });

    it("switches to a kept server only after a yes", async () => {
        const { said, steps } = harness({ yes: true });
        const links = new DeepLinks(steps, null);
        links.opened();
        links.arrive({ server: KEPT, path: "/chat" });
        await settle();
        expect(said).toEqual(["show", `ask ${KEPT}`, `switch ${KEPT}`, "show /chat"]);
    });

    it("has a window up before it asks, so a no leaves the app on screen", async () => {
        const { said, steps } = harness({ yes: false });
        const links = new DeepLinks(steps, null);
        links.opened();
        links.arrive({ server: KEPT, path: "/chat" });
        expect(said[0]).toBe("show");
        await settle();
        expect(said).toEqual(["show", `ask ${KEPT}`]);
    });

    it("does not show the page when the switch failed", async () => {
        const { said, steps } = harness({ yes: true, switches: false });
        const links = new DeepLinks(steps, null);
        links.opened();
        links.arrive({ server: KEPT, path: "/chat" });
        await settle();
        expect(said).toEqual(["show", `ask ${KEPT}`, `switch ${KEPT}`]);
    });

    it("asks one question at a time", async () => {
        const { said, steps, answer } = harness();
        const links = new DeepLinks(steps, null);
        links.opened();
        links.arrive({ server: KEPT, path: "/one" });
        links.arrive({ server: KEPT, path: "/two" });
        answer(false);
        await settle();
        expect(said.filter((line) => line.startsWith("ask"))).toHaveLength(1);
        links.arrive({ server: KEPT, path: "/three" });
        expect(said.filter((line) => line.startsWith("ask"))).toHaveLength(1 + 1);
    });
});
