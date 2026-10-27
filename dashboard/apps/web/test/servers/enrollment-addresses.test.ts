/**
 * The addresses an enrolling Linux machine reports, actually run.
 *
 * A machine on cable and WiFi in the same network holds two addresses there, and
 * Polaris keeps the first one that answers with the committed key. So the address
 * the machine reaches its router by has to come first, whatever order the
 * interfaces are listed in - and the list must stay within what a claim accepts.
 */

import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { enrollmentScript } from "../../src/lib/enrollment-script";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

const script = enrollmentScript({
    baseUrl: "https://polaris.example.com",
    token: "tok",
    username: "polaris",
    publicKey: "ssh-ed25519 AAAAC3Nz polaris-server"
});

/** From the address candidates to the end of the loop that quotes them. */
const addressSection = (() => {
    const start = script.indexOf("# Candidates only");
    const loop = script.indexOf("ADDRESSES=", start);
    const end = script.indexOf("\ndone", loop) + "\ndone".length;
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(loop);
    return script.slice(start, end);
})();

let shell = true;
try {
    execFileSync("sh", ["-c", "exit 0"], { stdio: "ignore" });
} catch {
    shell = false;
}

let dir = "";
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polaris-enroll-addr-"));
    mkdirSync(join(dir, "bin"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Run the section on a simulated Linux machine and return what it would post. */
function reported(addrShow: string, routeSrc: string | null): string {
    const ip = `#!/bin/sh
if [ "$2" = "route" ]; then
    ${routeSrc ? `echo "1.1.1.1 via 192.168.1.1 dev br0 src ${routeSrc} uid 0"` : "exit 2"}
else
    printf '%s\\n' ${addrShow
        .split("\n")
        .map((line) => `'${line}'`)
        .join(" ")}
fi
`;
    writeFileSync(join(dir, "bin", "ip"), ip);
    chmodSync(join(dir, "bin", "ip"), 0o755);
    writeFileSync(join(dir, "bin", "hostname"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(dir, "bin", "hostname"), 0o755);
    const harness = join(dir, "run.sh");
    writeFileSync(harness, `PLATFORM=linux\n${addressSection}\necho "$ADDRESSES"\n`);
    return execFileSync("sh", [harness], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${join(dir, "bin")}${delimiter}${process.env.PATH}` }
    }).trim();
}

describe.skipIf(!shell)("enrollment address report", () => {
    const twoOnOneNetwork = [
        "3: wlp2s0    inet 192.168.1.149/24 brd 192.168.1.255 scope global wlp2s0",
        "4: br0    inet 192.168.1.142/24 brd 192.168.1.255 scope global br0",
        "5: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0"
    ].join("\n");

    it("puts the default route's address first when WiFi is listed before cable", () => {
        expect(reported(twoOnOneNetwork, "192.168.1.142")).toBe(
            '"192.168.1.142","192.168.1.149","172.17.0.1"'
        );
    });

    it("keeps the listed order when there is no route", () => {
        expect(reported(twoOnOneNetwork, null)).toBe(
            '"192.168.1.149","192.168.1.142","172.17.0.1"'
        );
    });

    it("never reports more than a claim accepts", () => {
        const many = Array.from(
            { length: 20 },
            (_, i) => `${i}: br-${i}    inet 172.${18 + i}.0.1/16 scope global br-${i}`
        ).join("\n");
        expect(reported(many, "192.168.1.142").split(",")).toHaveLength(16);
    });
});
