/** Any website can start a polaris:// link, so what one may ask for is narrow. */

import { describe, expect, it } from "vitest";
import { deepLinkIn, readDeepLink } from "../../src/shared/deep-link";

const link = (server: string, path: string) =>
    `polaris://open?server=${encodeURIComponent(server)}&path=${encodeURIComponent(path)}`;

describe("a deep link", () => {
    it("names a server and a page", () => {
        expect(readDeepLink(link("https://polaris.example:8443/x", "/chat?a=1"))).toEqual({
            server: "https://polaris.example:8443",
            path: "/chat?a=1"
        });
    });

    it.each([
        ["another scheme", "https://open?server=https://a.example"],
        ["another action", "polaris://run?server=https%3A%2F%2Fa.example"],
        ["no server", "polaris://open?path=%2Fchat"],
        ["a server that is not a website", link("file:///etc/passwd", "/")],
        ["credentials in the server", link("https://user:pw@a.example", "/")],
        ["a path to another site", link("https://a.example", "//b.example")],
        ["a backslash path", link("https://a.example", "/\\b.example")],
        ["a path with no slash", link("https://a.example", "javascript:alert(1)")]
    ])("refuses %s", (_name, value) => {
        expect(readDeepLink(value)).toBeNull();
    });

    it("is found among a process's arguments", () => {
        const argv = ["polaris.exe", "--flag", link("https://a.example", "/home")];
        expect(deepLinkIn(argv)).toEqual({ server: "https://a.example", path: "/home" });
        expect(deepLinkIn(["polaris.exe"])).toBeNull();
    });
});
