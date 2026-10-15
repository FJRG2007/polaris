/**
 * Managing who can sign in to a server with a key. Pinned here: fingerprints
 * match OpenSSH's, the file is changed without touching anyone else's line, the
 * scripts never interpolate what a person typed, a write refuses when the file
 * changed meanwhile, and the key Polaris signs in with cannot be removed.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const actualSsh = await vi.importActual<typeof import("@polaris/ssh")>("@polaris/ssh");
const polarisPair = actualSsh.generateSshKeyPair("polaris@host");

let connection = { username: "polaris", sudo: false };
let file = "";
let commands: string[] = [];
let editedMeanwhile = false;

vi.mock("@/lib/connection-pool", () => ({
    borrowSsh: async () => ({ client: {}, release: () => {} })
}));
vi.mock("@/lib/github-access", () => ({ githubCredentialsForUser: async () => [] }));
vi.mock("@/lib/host-service", () => ({
    getHostConnection: async () => ({
        id: "h1",
        name: "box",
        address: "203.0.113.10",
        port: 22,
        auth: { method: "key", privateKey: polarisPair.privateKey },
        ...connection
    })
}));
vi.mock("@polaris/ssh", async () => ({
    ...(await vi.importActual<object>("@polaris/ssh")),
    execCommand: async (
        _client: unknown,
        command: string,
        options: {
            input?: string;
            onStdout?: (chunk: Buffer) => void;
            onStderr?: (chunk: Buffer) => void;
        }
    ) => {
        commands.push(command);
        if (command.includes("getent passwd |")) {
            options.onStdout?.(
                Buffer.from(
                    "root:0:/root:/bin/bash\ndaemon:1:/usr/sbin:/usr/sbin/nologin\npolaris:1000:/home/polaris:/bin/bash\nana:1001:/home/ana:/bin/zsh\n"
                )
            );
            return { code: 0 };
        }
        if (command.includes("cat > ")) {
            const expected = command.trim().split(" ").pop();
            const now = createHash("sha256").update(file, "utf8").digest("hex");
            if (editedMeanwhile || expected !== now) return { code: 4 };
            file = options.input ?? "";
            return { code: 0 };
        }
        // Delivered in two chunks split inside a multi-byte character.
        const bytes = Buffer.from(file, "utf8");
        const cut = Math.max(0, bytes.indexOf(Buffer.from("\u00e9")) + 1);
        options.onStdout?.(bytes.subarray(0, cut));
        options.onStdout?.(bytes.subarray(cut));
        return { code: 0 };
    }
}));

const keys = await import("@/lib/server-ssh-keys");

const OTHER =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC6nfRyrF9ZLkhQiv1Ro3kMlqLi+nRMTsd23qHItoXrp you@laptop";
const OTHER_FP = "SHA256:ldyE9kHjXMW/ahlFok/HS1FocCoEh2wAhdwTchkT2Ik";
const COMMENT = "Jos\u00e9 laptop";

beforeEach(() => {
    connection = { username: "polaris", sudo: false };
    commands = [];
    editedMeanwhile = false;
    file = `# managed by hand\n${polarisPair.publicKey}\nfrom="10.0.0.0/8" ${OTHER.replace(" you@laptop", "")} ${COMMENT}\n`;
});

describe("authorized_keys parsing", () => {
    it("fingerprints a key exactly as ssh-keygen -l does", () => {
        expect(keys.parseAuthorizedKeyLine(OTHER)?.fingerprint).toBe(OTHER_FP);
    });

    it("reads options, comments and skips what is not a key", () => {
        const listed = keys.parseAuthorizedKeys(file, null);
        expect(listed).toHaveLength(2);
        expect(listed[1]).toMatchObject({
            type: "ssh-ed25519",
            options: 'from="10.0.0.0/8"',
            comment: COMMENT
        });
        expect(keys.parseAuthorizedKeys("garbage\n\n#x\n", null)).toEqual([]);
    });

    it("adds without doubling and removes only the one key", () => {
        expect(keys.withKeys(file, [OTHER, OTHER]).added).toBe(0);
        const removed = keys.withoutKey(file, OTHER_FP);
        expect(removed).toContain("# managed by hand");
        expect(removed).toContain(polarisPair.publicKey);
        expect(removed).not.toContain(COMMENT);
        expect(keys.withKeys("", [OTHER]).text).toBe(`${OTHER}\n`);
    });

    it("offers real logins, never system ones, with Polaris's own first", () => {
        const listing =
            "root:0:/root:/bin/bash\nbin:2:/bin:/usr/sbin/nologin\nana:1001:/h:/bin/sh\nx y:1002:/h:/bin/sh\npolaris:1000:/h:/bin/sh";
        expect(keys.loginsFrom(listing, "polaris", 1000).map((entry) => entry.name)).toEqual([
            "polaris",
            "ana",
            "root"
        ]);
    });

    it("keeps the scripts free of single quotes and runs others through sudo", () => {
        for (const script of [keys.LIST_LOGINS, keys.READ_KEYS, keys.WRITE_KEYS])
            expect(script).not.toContain("'");
        expect(keys.WRITE_KEYS).not.toContain("chown");
        expect(keys.scriptCommand("echo", "polaris", "polaris")).toBe("sh -c 'echo' sh polaris");
        expect(keys.scriptCommand("echo", "ana", "polaris", ["abc"])).toBe(
            "sudo -n -u ana sh -c 'echo' sh ana abc"
        );
        expect(() => keys.scriptCommand("echo 'x'", "ana", "polaris")).toThrow();
    });
});

describe("server key operations", () => {
    it("lists Polaris's login only without root, marking its own key", async () => {
        const view = await keys.listServerKeys("h1", "u1");
        expect(view.root).toBe(false);
        expect(view.logins).toEqual([{ name: "polaris", self: true }]);
        expect(view.keys.map((key) => key.polaris)).toEqual([true, false]);
        expect(view.keys[1]?.comment).toBe(COMMENT);
    });

    it("lists every real login with root and asks for another's file through sudo", async () => {
        connection = { username: "polaris", sudo: true };
        const view = await keys.listServerKeys("h1", "u1", "ana");
        expect(view.logins.map((entry) => entry.name)).toEqual(["polaris", "ana", "root"]);
        expect(view.login).toBe("ana");
        // Another login's file does not keep Polaris in, so nothing is protected there.
        expect(view.keys.some((key) => key.polaris)).toBe(false);
        expect(commands.at(-1)).toMatch(/^sudo -n -u ana sh -c '[^']*' sh ana$/);
    });

    it("refuses another login's keys without root", async () => {
        await expect(keys.addServerKeys("h1", "u1", "ana", [OTHER])).rejects.toMatchObject({
            problem: "needsRoot"
        });
    });

    it("removes a key and refuses the one Polaris signs in with", async () => {
        await keys.removeServerKey("h1", "u1", "polaris", OTHER_FP);
        expect(file).not.toContain(COMMENT);
        expect(file).toContain(polarisPair.publicKey);
        const own = keys.parseAuthorizedKeyLine(polarisPair.publicKey)!.fingerprint;
        await expect(keys.removeServerKey("h1", "u1", "polaris", own)).rejects.toMatchObject({
            problem: "protectedKey"
        });
        await expect(keys.removeServerKey("h1", "u1", "polaris", OTHER_FP)).rejects.toMatchObject({
            problem: "notFound"
        });
    });

    it("refuses to write over a file somebody changed meanwhile", async () => {
        editedMeanwhile = true;
        await expect(keys.removeServerKey("h1", "u1", "polaris", OTHER_FP)).rejects.toMatchObject({
            problem: "changedMeanwhile"
        });
    });

    it("mints a pair, installs only the public half and never sends the private one", async () => {
        const minted = await keys.generateServerKey("h1", "u1", "polaris", "ci runner");
        expect(minted.privateKey).toContain("OPENSSH PRIVATE KEY");
        expect(file).toContain(minted.publicKey.split(" ").slice(0, 2).join(" "));
        expect(file).toContain("ci-runner");
        expect(file).not.toContain("PRIVATE");
        expect(commands.join("\n")).not.toContain(minted.privateKey);
        expect(minted.fingerprint).toMatch(/^SHA256:/);
    });

    it("answers no GitHub link with null", async () => {
        expect(await keys.githubKeys("u1")).toBeNull();
    });
});
