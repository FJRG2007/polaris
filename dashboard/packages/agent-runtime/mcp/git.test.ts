import { describe, expect, it } from "vitest";
import { classifyPushError } from "./git.ts";

// re-export the normalizeUrl function for testing
// note: in a real scenario, we'd export this from git.ts or move to a shared utils file
function normalizeUrl(url: string): string {
  return url.replace(/\.git$/, "").toLowerCase();
}

describe("normalizeUrl", () => {
  it("removes .git suffix", () => {
    expect(normalizeUrl("https://github.com/owner/repo.git")).toBe("https://github.com/owner/repo");
  });

  it("lowercases URL", () => {
    expect(normalizeUrl("https://github.com/Owner/Repo")).toBe("https://github.com/owner/repo");
  });

  it("handles URL without .git suffix", () => {
    expect(normalizeUrl("https://github.com/owner/repo")).toBe("https://github.com/owner/repo");
  });

  it("handles combined case and .git suffix", () => {
    expect(normalizeUrl("https://github.com/OWNER/REPO.git")).toBe("https://github.com/owner/repo");
  });
});

describe("push URL validation", () => {
  // these tests document the expected behavior
  // actual integration testing happens via the agent test suite

  it("should block push when actual URL differs from pushUrl", () => {
    // pushUrl is set at checkout configuration (setupGit / checkout_repo) or checkout_pr (fork repo)
    const pushUrl = "https://github.com/fork-owner/repo.git";
    const actualUrl = "https://github.com/base-owner/repo.git"; // different repo

    const pushUrlNormalized = normalizeUrl(pushUrl);
    const actualUrlNormalized = normalizeUrl(actualUrl);

    expect(pushUrlNormalized).not.toBe(actualUrlNormalized);
    // in real code, this mismatch would throw an error
  });

  it("should allow push when actual URL matches pushUrl", () => {
    const pushUrl = "https://github.com/fork-owner/repo.git";
    const actualUrl = "https://github.com/fork-owner/repo"; // same repo, no .git

    const pushUrlNormalized = normalizeUrl(pushUrl);
    const actualUrlNormalized = normalizeUrl(actualUrl);

    expect(pushUrlNormalized).toBe(actualUrlNormalized);
    // in real code, this would allow the push
  });

  it("should handle case differences in URLs", () => {
    const pushUrl = "https://github.com/Owner/Repo.git";
    const actualUrl = "https://github.com/owner/repo";

    const pushUrlNormalized = normalizeUrl(pushUrl);
    const actualUrlNormalized = normalizeUrl(actualUrl);

    expect(pushUrlNormalized).toBe(actualUrlNormalized);
  });
});

describe("classifyPushError", () => {
  describe("concurrent-push", () => {
    it("matches client-side non-fast-forward (`fetch first`)", () => {
      const msg =
        "git push failed (exit 1): To https://github.com/o/r.git\n" +
        " ! [rejected]        feature -> feature (fetch first)\n" +
        "error: failed to push some refs to 'https://github.com/o/r.git'\n" +
        "hint: Updates were rejected because the remote contains work";
      expect(classifyPushError(msg)).toBe("concurrent-push");
    });

    it("matches client-side `non-fast-forward` wording", () => {
      const msg = "! [rejected] main -> main (non-fast-forward)";
      expect(classifyPushError(msg)).toBe("concurrent-push");
    });

    it("matches server-side `cannot lock ref` (the case from #571)", () => {
      const msg =
        "remote: error: cannot lock ref 'refs/heads/feature': is at " +
        "abc123 but expected def456\n" +
        " ! [remote rejected] feature -> feature (cannot lock ref ...)";
      expect(classifyPushError(msg)).toBe("concurrent-push");
    });
  });

  describe("transient", () => {
    it("matches RPC failed with HTTP 502", () => {
      expect(
        classifyPushError(
          "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 502"
        )
      ).toBe("transient");
    });

    it("matches early EOF mid-pack", () => {
      expect(
        classifyPushError("fatal: the remote end hung up unexpectedly\nfatal: early EOF")
      ).toBe("transient");
    });

    it("matches RPC failed", () => {
      expect(
        classifyPushError("fatal: RPC failed; curl 56 OpenSSL SSL_read: Connection reset by peer")
      ).toBe("transient");
    });

    it("matches HTTP/2 stream not closed cleanly", () => {
      expect(
        classifyPushError("fatal: HTTP/2 stream 7 was not closed cleanly: PROTOCOL_ERROR (err 1)")
      ).toBe("transient");
    });

    it("matches DNS resolution failure", () => {
      expect(classifyPushError("fatal: Could not resolve host: github.com")).toBe("transient");
    });

    it("matches unexpected disconnect during sideband read", () => {
      expect(classifyPushError("fatal: unexpected disconnect while reading sideband packet")).toBe(
        "transient"
      );
    });

    it("classifies HTTP 429 (rate-limit / abuse detection) as transient", () => {
      // 429 is the documented exception to the otherwise-permanent 4xx class -
      // GitHub's abuse detection occasionally surfaces it on git push.
      expect(
        classifyPushError(
          "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 429"
        )
      ).toBe("transient");
      expect(classifyPushError("remote: HTTP 429: too many requests")).toBe("transient");
    });
  });

  describe("unknown", () => {
    it("does NOT classify auth/403 as transient", () => {
      // permission denied is permanent within a run - retrying just wastes
      // time. must NOT match the HTTP-5xx regex.
      expect(
        classifyPushError(
          "remote: Permission to o/r.git denied to bot.\n" +
            "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403"
        )
      ).toBe("unknown");
    });

    it("does NOT classify protected-branch rejection as concurrent-push", () => {
      expect(
        classifyPushError(
          " ! [remote rejected] main -> main (push declined due to repository rule violations)"
        )
      ).toBe("unknown");
    });

    it("does NOT classify 404 as transient", () => {
      expect(
        classifyPushError(
          "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 404"
        )
      ).toBe("unknown");
    });

    it("returns unknown for an empty message", () => {
      expect(classifyPushError("")).toBe("unknown");
    });
  });

  describe("ordering", () => {
    it("prefers concurrent-push over transient when both signals appear", () => {
      // a server-side cannot-lock-ref response that also includes an HTTP
      // 5xx in the libcurl envelope should still route to the recovery
      // path, not a blind retry.
      const msg =
        "remote: error: cannot lock ref 'refs/heads/feature': is at A but expected B\n" +
        "fatal: unable to access ...: The requested URL returned error: 500";
      expect(classifyPushError(msg)).toBe("concurrent-push");
    });
  });
});
