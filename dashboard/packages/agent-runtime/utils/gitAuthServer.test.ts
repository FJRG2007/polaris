import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type GitAuthServer, startGitAuthServer } from "./gitAuthServer.ts";

let server: GitAuthServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

function makeTmpdir(): string {
  return mkdtempSync(join(tmpdir(), "askpass-test-"));
}

describe("git auth server lifecycle", () => {
  it("starts and listens on a port", async () => {
    const tmp = makeTmpdir();
    server = await startGitAuthServer(tmp);
    expect(server.port).toBeGreaterThan(0);
  });

  it("closes cleanly", async () => {
    const tmp = makeTmpdir();
    server = await startGitAuthServer(tmp);
    const port = server.port;
    await server.close();
    server = undefined;

    // port should no longer accept connections
    const err = await fetch(`http://127.0.0.1:${port}/test`).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("token delivery", () => {
  it("returns token on first request with valid code", async () => {
    const tmp = makeTmpdir();
    server = await startGitAuthServer(tmp);
    const code = server.register("ghs_test_token_12345");

    const res = await fetch(`http://127.0.0.1:${server.port}/${code}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe("ghs_test_token_12345");
  });

  it("returns 404 for unknown code", async () => {
    const tmp = makeTmpdir();
    server = await startGitAuthServer(tmp);

    const res = await fetch(`http://127.0.0.1:${server.port}/nonexistent-code`);
    expect(res.status).toBe(404);
  });

  it("returns 400 for empty code", async () => {
    const tmp = makeTmpdir();
    server = await startGitAuthServer(tmp);

    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(400);
  });

  it("returns 405 for non-GET methods", async () => {
    const tmp = makeTmpdir();
    server = await startGitAuthServer(tmp);
    const code = server.register("token");

    const res = await fetch(`http://127.0.0.1:${server.port}/${code}`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("code lifecycle (tamper detection)", () => {
  it("returns the token on repeated use while the code is active", async () => {
    // a single $git() call can produce multiple legitimate askpass requests:
    // git itself (username + password), git-lfs pre-push hook, custom hooks.
    // they must all succeed until $git()'s finally calls revoke().
    const tmp = makeTmpdir();
    server = await startGitAuthServer(tmp);
    const code = server.register("ghs_active_test");

    for (let i = 0; i < 5; i++) {
      const res = await fetch(`http://127.0.0.1:${server.port}/${code}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ghs_active_test");
    }
  });

  it("returns 409 after revoke (replay-after-call trap)", async () => {
    const tmp = makeTmpdir();
    server = await startGitAuthServer(tmp);
    const code = server.register("ghs_tamper_test");

    const first = await fetch(`http://127.0.0.1:${server.port}/${code}`);
    expect(first.status).toBe(200);

    server.revoke(code);

    const replay = await fetch(`http://127.0.0.1:${server.port}/${code}`);
    expect(replay.status).toBe(409);
    expect(await replay.text()).toBe("compromised");
  });

  it("revoke() on an unknown code is a no-op", async () => {
    const tmp = makeTmpdir();
    server = await startGitAuthServer(tmp);
    expect(() => server!.revoke("nonexistent")).not.toThrow();
  });

  it("each register() call produces an independent code", async () => {
    const tmp = makeTmpdir();
    server = await startGitAuthServer(tmp);
    const code1 = server.register("token-a");
    const code2 = server.register("token-b");

    expect(code1).not.toBe(code2);

    const res1 = await fetch(`http://127.0.0.1:${server.port}/${code1}`);
    expect(await res1.text()).toBe("token-a");

    const res2 = await fetch(`http://127.0.0.1:${server.port}/${code2}`);
    expect(await res2.text()).toBe("token-b");
  });
});

describe("askpass script generation", () => {
  it("writes an executable script file", async () => {
    const tmp = makeTmpdir();
    server = await startGitAuthServer(tmp);
    const code = server.register("ghs_script_test");
    const scriptPath = server.writeAskpassScript(code);

    expect(existsSync(scriptPath)).toBe(true);
    expect(scriptPath.startsWith(tmp)).toBe(true);

    const content = readFileSync(scriptPath, "utf-8");
    expect(content).toContain("#!/usr/bin/env node");
    expect(content).toContain(String(server.port));
    expect(content).toContain(code);
    // token should NOT be in the script - only port and code
    expect(content).not.toContain("ghs_script_test");
  });

  it("script handles Username prompt locally (no server call)", async () => {
    const tmp = makeTmpdir();
    server = await startGitAuthServer(tmp);
    const code = server.register("ghs_username_test");
    const scriptPath = server.writeAskpassScript(code);
    const content = readFileSync(scriptPath, "utf-8");

    // script checks for /^Username/i and returns "x-access-token" without HTTP
    expect(content).toContain("Username");
    expect(content).toContain("x-access-token");
  });
});
