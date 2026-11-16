/**
 * yjs keeps one copy per process. Bundled into the server build, every chunk
 * that reached it carried its own: yjs warned "Yjs was already imported" on boot
 * and a Y.Doc built by one copy failed `instanceof` in another. Loading it from
 * node_modules at runtime is what keeps it single.
 */

import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.mjs";

describe("yjs on the server", () => {
    it("is loaded from node_modules, not copied into each chunk", () => {
        expect(nextConfig.serverExternalPackages).toContain("yjs");
    });
});
