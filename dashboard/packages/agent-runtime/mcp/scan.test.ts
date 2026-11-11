import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OUTPUT_MAX, SCANNER_IDS, SCANNERS, cleanPaths, fetchVerified, plan, tidy } from "./scan.ts";

describe("cleanPaths", () => {
  it("keeps repository-relative paths and refuses the ones that leave it", () => {
    const { ok, refused } = cleanPaths([
      "src/a.ts",
      "./src/a.ts",
      "../etc/passwd",
      "/etc/passwd",
      "C:/x",
      "a/../../b",
      "bad\nname",
      "",
    ]);
    expect(ok).toEqual(["src/a.ts"]);
    expect(refused).toEqual(["../etc/passwd", "/etc/passwd", "C:/x", "a/../../b", "bad\nname", ""]);
  });
});

describe("plan", () => {
  it("hands each scanner only the files it reads", () => {
    const files = [
      "scripts/install.sh",
      "Dockerfile",
      "docker/web.Dockerfile",
      ".github/workflows/ci.yml",
      ".github/actions/setup/action.yml",
      "apps/web/package-lock.json",
      "src/index.ts",
    ];
    const out = plan(files, SCANNER_IDS);
    expect(out.get("gitleaks")).toEqual(files);
    expect(out.get("shellcheck")).toEqual(["scripts/install.sh"]);
    expect(out.get("hadolint")).toEqual(["Dockerfile", "docker/web.Dockerfile"]);
    expect(out.get("actionlint")).toEqual([".github/workflows/ci.yml"]);
    expect(out.get("zizmor")).toEqual([".github/workflows/ci.yml", ".github/actions/setup/action.yml"]);
    expect(out.get("osv-scanner")).toEqual(["apps/web/package-lock.json"]);
  });

  it("runs only the scanners asked for", () => {
    expect([...plan(["a.sh"], ["shellcheck"]).keys()]).toEqual(["shellcheck"]);
  });
});

describe("the pinned assets", () => {
  it("pins every scanner to a GitHub release and a sha256 on both architectures", () => {
    for (const id of SCANNER_IDS) {
      for (const asset of Object.values(SCANNERS[id].assets)) {
        expect(asset.url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/v[\d.]+\//);
        expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

describe("fetchVerified", () => {
  const body = Buffer.from("binary");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const respond = () => vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

  it("returns a download whose digest is the pinned one", async () => {
    expect((await fetchVerified({ url: "https://example.test/x", sha256 }, respond())).toString()).toBe("binary");
  });

  it("refuses one that is not", async () => {
    await expect(fetchVerified({ url: "https://example.test/x", sha256: "0".repeat(64) }, respond())).rejects.toThrow(
      /pinned sha256/
    );
  });

  it("refuses a failed download", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchVerified({ url: "https://example.test/x", sha256 }, fetcher)).rejects.toThrow(/404/);
  });
});

describe("tidy", () => {
  it("takes the scratch directory out of the paths and caps the length", () => {
    expect(tidy("/tmp/s/work-1/src/a.ts:3 leak", "/tmp/s/work-1")).toBe("src/a.ts:3 leak");
    const long = tidy("x".repeat(OUTPUT_MAX + 10), null);
    expect(long.startsWith("x".repeat(OUTPUT_MAX))).toBe(true);
    expect(long).toContain("cut at");
  });
});
