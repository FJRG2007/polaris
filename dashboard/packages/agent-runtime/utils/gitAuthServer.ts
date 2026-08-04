/**
 * ASKPASS-based git authentication server.
 *
 * serves tokens via a localhost HTTP server with per-$git()-call UUID codes.
 * each $git() call gets a unique askpass script with the port+code baked in.
 * the token never appears in subprocess env - only the script file path.
 *
 * lifetime: the code is valid for as long as the $git() invocation is
 * running. multiple askpass calls within one invocation (e.g. git's own
 * fetch/push + a git-lfs pre-push hook that also authenticates) all
 * succeed. $git() calls revoke(code) in finally; subsequent requests for
 * a revoked code trigger immediate token revocation via the GitHub API
 * as a tamper-evidence precaution (an agent replaying the code after the
 * legitimate window has closed is the realistic attack we still catch).
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { log } from "./cli.ts";

type CodeState = "active" | "revoked";

type CodeEntry = {
  token: string;
  state: CodeState;
  // only present once the entry is revoked - bounds the replay-trap window.
  // active entries have no timer because $git() can take arbitrarily long
  // (large LFS pushes, slow networks, `activityTimeout: 0` on the spawn);
  // any wall-clock TTL here would re-introduce the original LFS bug at
  // a different boundary. revoke() is the only way out for an active code.
  timeout?: NodeJS.Timeout;
};

const REVOKED_TRAP_MS = 60_000;

export type GitAuthServer = {
  port: number;
  register: (token: string) => string;
  revoke: (code: string) => void;
  writeAskpassScript: (code: string) => string;
  close: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

function revokeGitHubToken(token: string): void {
  fetch("https://api.github.com/installation/token", {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "polaris",
    },
  }).then(
    (r) => log.info(`token revocation response: ${r.status}`),
    () => log.warning("token revocation request failed")
  );
}

export async function startGitAuthServer(tmpdir: string): Promise<GitAuthServer> {
  const codes = new Map<string, CodeEntry>();

  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }

    const code = req.url?.slice(1);
    if (!code) {
      res.writeHead(400).end();
      return;
    }

    const entry = codes.get(code);
    if (!entry) {
      res.writeHead(404).end();
      return;
    }

    if (entry.state === "active") {
      // legitimate caller (git, git-lfs, or any subprocess of the running
      // $git() call). hand back the token without consuming the code -
      // revoke() in $git's finally is what closes the window.
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(entry.token);
      return;
    }

    // request for a revoked code - the $git() window has closed, so this
    // is an agent replaying the code. revoke the token as a precaution.
    log.info("askpass code used after revoke - revoking token");
    revokeGitHubToken(entry.token);
    if (entry.timeout) clearTimeout(entry.timeout);
    codes.delete(code);
    res.writeHead(409, { "Content-Type": "text/plain" });
    res.end("compromised");
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const rawAddr = server.address();
  if (!rawAddr || typeof rawAddr === "string") {
    throw new Error("git auth server failed to bind");
  }
  const port = rawAddr.port;

  log.debug(`git auth server listening on 127.0.0.1:${port}`);

  function register(token: string): string {
    const code = randomUUID();
    codes.set(code, { token, state: "active" });
    return code;
  }

  function revoke(code: string): void {
    const entry = codes.get(code);
    if (!entry) return;
    entry.state = "revoked";
    // keep the entry around briefly so a replay attempt trips the trap
    // (token revocation) instead of returning an opaque 404.
    entry.timeout = setTimeout(() => codes.delete(code), REVOKED_TRAP_MS);
    entry.timeout.unref();
  }

  function writeAskpassScript(code: string): string {
    const scriptId = randomUUID();
    const scriptName = `askpass-${scriptId}.js`;
    const scriptPath = join(tmpdir, scriptName);

    // standalone node script - no project dependencies.
    // git invokes this once per credential prompt - separate process spawn
    // per prompt: one for "Username for ...", one for "Password for ...".
    // sibling subprocesses (git-lfs pre-push, custom auth-bound hooks)
    // invoke it independently for their own auth, also one spawn per prompt.
    // all succeed as long as the parent $git() is still running, which is
    // why neither the script nor the code is single-use. cleanup happens
    // in $git()'s finally.
    // 409 = code was already revoked by $git()'s finally (replay attempt).
    const content = [
      `#!/usr/bin/env node`,
      `var a=process.argv[2]||"";`,
      `if(/^Username/i.test(a)){process.stdout.write("x-access-token\\n")}`,
      `else{var h=require("http");`,
      `h.get("http://127.0.0.1:${port}/${code}",function(r){`,
      `if(r.statusCode===409){process.stderr.write("askpass-compromised\\n");process.exit(1)}`,
      `if(r.statusCode!==200){process.exit(1)}`,
      `var d="";r.on("data",function(c){d+=c});`,
      `r.on("end",function(){process.stdout.write(d+"\\n")})`,
      `}).on("error",function(){process.exit(1)})}`,
    ].join("\n");

    writeFileSync(scriptPath, content, { mode: 0o700 });
    return scriptPath;
  }

  async function close(): Promise<void> {
    for (const entry of codes.values()) {
      if (entry.timeout) clearTimeout(entry.timeout);
    }
    codes.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    log.debug("git auth server closed");
  }

  return {
    port,
    register,
    revoke,
    writeAskpassScript,
    close,
    [Symbol.asyncDispose]: close,
  };
}
