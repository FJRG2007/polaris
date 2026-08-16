/**
 * What the ARK Rules and Mods screens show before anything has been read.
 *
 * Both of them ask the server's container for a file, which on a loading ARK
 * server is not a fast question. So neither may hold its own page back: the
 * heading, the explanation of when a change takes effect and the shape of the list
 * are all in Polaris and belong on screen immediately, with a skeleton only where
 * the answer will go.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const INSTALL = "aaaaaaaa-1111-4111-8111-111111111111";

// Both screens reach modules that read Polaris' configuration as they are
// imported. A running server has all of this; a test process has to say so.
vi.stubEnv("POLARIS_DATABASE_URL", "postgresql://polaris:polaris@localhost:5432/polaris");
vi.stubEnv("POLARIS_AUTH_SECRET", "a-long-enough-string-for-the-schema");
vi.stubEnv("POLARIS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));

// Server actions, which these screens only call from an effect or an event
// handler. Rendering must not drag the database and the session into the test.
vi.mock("@/app/(app)/apps/installed/[id]/ark-actions", () => ({}));

const { ArkRules } = await import("@/app/(app)/apps/installed/[id]/ark-rules");
const { ArkMods } = await import("@/app/(app)/apps/installed/[id]/ark-mods");

describe("the ARK rules screen", () => {
    const markup = renderToStaticMarkup(
        <ArkRules installedAppId={INSTALL} canManage running />
    );

    it("says when a change takes effect before it has read anything", () => {
        // The one thing somebody has to know before they touch a switch: ARK reads
        // all of this at start, and nothing here moves a running world.
        expect(markup).toContain("the next time it does");
    });

    it("says what the game cannot do, rather than leaving somebody looking for it", () => {
        expect(markup).toContain("no setting for showing everyone on the map");
    });

    it("renders for somebody who may only look", () => {
        expect(() =>
            renderToStaticMarkup(<ArkRules installedAppId={INSTALL} canManage={false} running={false} />)
        ).not.toThrow();
    });
});

describe("the ARK mods screen", () => {
    const markup = renderToStaticMarkup(<ArkMods installedAppId={INSTALL} canManage running />);

    it("answers the question everybody asks about a modded server", () => {
        // Whether the people joining have to do anything. They do not.
        expect(markup).toContain("nobody has to subscribe to anything first");
    });

    it("takes a Workshop link without anything being configured first", () => {
        expect(markup).toContain("Paste a Workshop link");
    });

    it("does not offer the add box to somebody who may only look", () => {
        const readOnly = renderToStaticMarkup(
            <ArkMods installedAppId={INSTALL} canManage={false} running={false} />
        );
        expect(readOnly).not.toContain("Paste a Workshop link");
    });
});
