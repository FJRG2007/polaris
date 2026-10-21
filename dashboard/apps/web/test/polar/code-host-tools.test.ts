/**
 * Polar's repository tools against a stand-in for GitHub's and gitlab.com's
 * APIs: what each reads, as whom, and what it says when the host refuses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = { token: null as string | null };

vi.mock("@/lib/github-access", () => ({
    githubTokenForUser: async () => state.token
}));

const { polarRepoTools, fileWindow, pathMatches, textOf, FILE_CHARS } =
    await import("@/lib/polar/code-host-tools");

interface Seen {
    url: string;
    auth: string | null;
}

type Reply = { status?: number; body?: unknown; raw?: string; headers?: Record<string, string> };
type Route = [
    match: string | ((url: string, auth: string | null) => boolean),
    reply: Reply | ((auth: string | null) => Reply)
];

let routes: Route[] = [];
let seen: Seen[] = [];

function respond(reply: Reply): Response {
    const text = reply.raw ?? JSON.stringify(reply.body ?? {});
    return new Response(text, { status: reply.status ?? 200, headers: reply.headers ?? {} });
}

beforeEach(() => {
    state.token = null;
    routes = [];
    seen = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string, init?: { headers?: Record<string, string> }) => {
            const url = String(input);
            const auth = init?.headers?.Authorization ?? null;
            seen.push({ url, auth });
            for (const [match, reply] of routes) {
                const hit = typeof match === "string" ? url === match : match(url, auth);
                if (hit) return respond(typeof reply === "function" ? reply(auth) : reply);
            }
            return respond({ status: 404, body: { message: "Not Found" } });
        })
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const GH = "https://api.github.com/repos/acme/backend";
const GL = "https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject";
const OPTIONS = { toolCallId: "call-1", messages: [] };

async function run(
    name: string,
    input: Record<string, unknown>
): Promise<{ ok: boolean; text: string; [key: string]: unknown }> {
    const tools = polarRepoTools("user-1");
    return (await tools[name]!.execute!(input as never, OPTIONS as never)) as never;
}

function b64(text: string | Uint8Array): string {
    return Buffer.from(text).toString("base64");
}

const COMPOSER = '{\n  "require": {\n    "php": "^8.2"\n  }\n}\n';

describe("a GitHub repository", () => {
    it("gives an overview with languages, top level and README, anonymously", async () => {
        routes = [
            [
                GH,
                {
                    body: {
                        full_name: "acme/backend",
                        default_branch: "master",
                        description: "API",
                        stargazers_count: 3,
                        language: "PHP"
                    }
                }
            ],
            [`${GH}/languages`, { body: { PHP: 800, Dockerfile: 200 } }],
            [`${GH}/readme?ref=master`, { raw: "# Backend\nRuns on Laravel." }],
            [
                `${GH}/contents?ref=master`,
                {
                    body: [
                        { name: "composer.json", path: "composer.json", type: "file" },
                        { name: "app", path: "app", type: "dir" }
                    ]
                }
            ]
        ];
        const result = await run("repo_overview", {
            repository: "https://github.com/acme/backend/tree/master"
        });
        expect(result.ok).toBe(true);
        expect(result.text).toContain("default branch: master");
        expect(result.text).toContain("PHP 80.0%, Dockerfile 20.0%");
        expect(result.text).toContain("app/\ncomposer.json");
        expect(result.text).toContain("Runs on Laravel.");
        expect(result.text).toMatch(
            /^<untrusted_web_content source="https:\/\/github.com\/acme\/backend\/tree\/master">/
        );
        expect(seen.every((call) => call.auth === null)).toBe(true);
    });

    it("reads a file, decoding it, and links it", async () => {
        routes = [
            [
                `${GH}/contents/composer.json`,
                {
                    body: {
                        type: "file",
                        path: "composer.json",
                        size: COMPOSER.length,
                        encoding: "base64",
                        content: b64(COMPOSER)
                    }
                }
            ]
        ];
        const result = await run("repo_read_file", {
            repository: "acme/backend",
            path: "composer.json"
        });
        expect(result.ok).toBe(true);
        expect(result.text).toContain('"php": "^8.2"');
        expect(result.text).toContain("composer.json at the default branch: 5 lines.");
        expect(result.url).toBe("https://github.com/acme/backend/blob/HEAD/composer.json");
    });

    it("works out a ref holding a slash from a link into it", async () => {
        routes = [
            [`${GH}/commits?per_page=1&sha=release`, { status: 404, body: {} }],
            [`${GH}/commits?per_page=1&sha=release%2F2.x`, { body: [] }],
            [
                `${GH}/contents/composer.json?ref=release%2F2.x`,
                {
                    body: {
                        type: "file",
                        path: "composer.json",
                        size: 5,
                        encoding: "base64",
                        content: b64("hello")
                    }
                }
            ]
        ];
        const result = await run("repo_read_file", {
            repository: "https://github.com/acme/backend/blob/release/2.x/composer.json"
        });
        expect(result).toMatchObject({ ok: true, ref: "release/2.x", path: "composer.json" });
        expect(result.text).toContain("hello");
    });

    it("reads as the person's linked account, so a private repository they see reads too", async () => {
        state.token = "tok-1";
        routes = [
            [
                (url, auth) =>
                    url.startsWith(`${GH}/contents/Dockerfile`) && auth === "Bearer tok-1",
                {
                    body: {
                        type: "file",
                        path: "Dockerfile",
                        size: 20,
                        encoding: "base64",
                        content: b64("FROM php:8.2-fpm\n")
                    }
                }
            ]
        ];
        const result = await run("repo_read_file", {
            repository: "acme/backend",
            path: "Dockerfile"
        });
        expect(result.text).toContain("FROM php:8.2-fpm");
    });

    it("carries on anonymously when the linked account's token stopped working", async () => {
        state.token = "stale";
        routes = [
            [(url, auth) => auth !== null, { status: 401, body: {} }],
            [
                `${GH}/contents/README.md`,
                {
                    body: {
                        type: "file",
                        path: "README.md",
                        size: 2,
                        encoding: "base64",
                        content: b64("hi")
                    }
                }
            ]
        ];
        const result = await run("repo_read_file", {
            repository: "acme/backend",
            path: "README.md"
        });
        expect(result.ok).toBe(true);
        expect(seen.map((call) => call.auth)).toEqual(["Bearer stale", null]);
    });

    it("says how to read a private repository when one is not found without an account", async () => {
        const result = await run("repo_overview", { repository: "acme/Secret" });
        expect(result.ok).toBe(false);
        expect(result.text).toContain("If the repository is private");
        expect(result.text).toContain("Connected accounts (/account/connections)");
    });

    it("says the linked account cannot see it when signed in", async () => {
        state.token = "tok";
        const result = await run("repo_overview", { repository: "acme/Secret" });
        expect(result.text).toContain("linked GitHub account cannot see it");
        expect(result.text).not.toContain("/account/connections");
    });

    it("names the anonymous limit when it is used up, and when it resets", async () => {
        routes = [
            [
                () => true,
                {
                    status: 403,
                    body: { message: "API rate limit exceeded" },
                    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1767225600" }
                }
            ]
        ];
        const result = await run("repo_overview", { repository: "acme/backend" });
        expect(result.ok).toBe(false);
        expect(result.text).toContain("60 an hour");
        expect(result.text).toContain("00:00 UTC");
        expect(result.text).toContain("/account/connections");
    });

    it("names the linked account's limit on a 429", async () => {
        state.token = "tok";
        routes = [[() => true, { status: 429, body: {}, headers: { "retry-after": "30" } }]];
        const result = await run("repo_list_files", { repository: "acme/backend" });
        expect(result.text).toContain("linked account is used up");
        expect(result.text).toContain("30 seconds");
    });

    it("refuses a file over the size Polar reads", async () => {
        routes = [
            [
                `${GH}/contents/dump.sql`,
                {
                    body: {
                        type: "file",
                        path: "dump.sql",
                        size: 5 * 1024 * 1024,
                        encoding: "none",
                        content: ""
                    }
                }
            ]
        ];
        const result = await run("repo_read_file", {
            repository: "acme/backend",
            path: "dump.sql"
        });
        expect(result).toMatchObject({ ok: false });
        expect(result.text).toBe("dump.sql is 5.0 MB, more than the 1.0 MB Polar reads.");
    });

    it("refuses a binary file", async () => {
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]);
        routes = [
            [
                `${GH}/contents/logo.png`,
                {
                    body: {
                        type: "file",
                        path: "logo.png",
                        size: 8,
                        encoding: "base64",
                        content: b64(png)
                    }
                }
            ]
        ];
        const result = await run("repo_read_file", {
            repository: "acme/backend",
            path: "logo.png"
        });
        expect(result.text).toContain("is a binary file");
    });

    it("sends a long file in parts and says where to carry on", async () => {
        const long = Array.from(
            { length: 1500 },
            (_, index) => `line ${index + 1} ${"x".repeat(20)}`
        ).join("\n");
        routes = [
            [
                (url) => url.startsWith(`${GH}/contents/big.txt`),
                {
                    body: {
                        type: "file",
                        path: "big.txt",
                        size: long.length,
                        encoding: "base64",
                        content: b64(long)
                    }
                }
            ]
        ];
        const first = await run("repo_read_file", {
            repository: "acme/backend",
            path: "big.txt"
        });
        expect(first.truncated).toBe(true);
        const next = /fromLine (\d+)/.exec(first.text)?.[1];
        expect(next).toBeTruthy();
        const second = await run("repo_read_file", {
            repository: "acme/backend",
            path: "big.txt",
            fromLine: Number(next)
        });
        expect(second.text).toContain(`line ${next} `);
        expect(second.truncated).toBe(false);
    });

    it("lists a folder, and points a folder read at the listing", async () => {
        routes = [
            [
                `${GH}/contents/app`,
                {
                    body: [
                        { name: "Http", path: "app/Http", type: "dir" },
                        { name: "helpers.php", path: "app/helpers.php", type: "file" }
                    ]
                }
            ]
        ];
        const listed = await run("repo_list_files", {
            repository: "acme/backend",
            path: "/app/"
        });
        expect(listed.text).toContain("Http/\nhelpers.php");
        const read = await run("repo_read_file", { repository: "acme/backend", path: "app" });
        expect(read.text).toBe("app is a folder: list it with repo_list_files.");
    });

    it("finds files by path, and says searching inside them needs an account", async () => {
        routes = [
            [
                `${GH}/commits?per_page=1`,
                { body: [{ sha: "c1", commit: { message: "m", tree: { sha: "t1" } } }] }
            ],
            [
                `${GH}/git/trees/t1?recursive=1`,
                {
                    body: {
                        tree: [
                            { path: "composer.json", type: "blob" },
                            { path: "src/package.json", type: "blob" },
                            { path: "src", type: "tree" },
                            { path: "Dockerfile", type: "blob" }
                        ]
                    }
                }
            ]
        ];
        const result = await run("repo_search", {
            repository: "acme/backend",
            query: "*.json",
            inContents: true
        });
        expect(result.text).toContain('paths matching "*.json" at the default branch: 2');
        expect(result.text).toContain("composer.json\nsrc/package.json");
        expect(result.text).toContain("needs a signed-in account");
    });

    it("searches inside files as the linked account", async () => {
        state.token = "tok";
        routes = [
            [
                `${GH}/commits?per_page=1`,
                { body: [{ sha: "c1", commit: { message: "m", tree: { sha: "t1" } } }] }
            ],
            [`${GH}/git/trees/t1?recursive=1`, { body: { tree: [] } }],
            [
                (url) => url.startsWith("https://api.github.com/search/code?"),
                {
                    body: {
                        total_count: 1,
                        items: [
                            {
                                path: "config/app.php",
                                text_matches: [{ fragment: "'php' => '8.2'" }]
                            }
                        ]
                    }
                }
            ]
        ];
        const result = await run("repo_search", {
            repository: "acme/backend",
            query: "php",
            inContents: true
        });
        expect(result.text).toContain("config/app.php");
        expect(result.text).toContain("'php' => '8.2'");
        expect(seen.find((call) => call.url.includes("/search/code"))?.url).toContain(
            encodeURIComponent("php repo:acme/backend")
        );
    });

    it("still searches inside files when the tree is too big to read", async () => {
        state.token = "tok";
        routes = [
            [
                `${GH}/commits?per_page=1`,
                { body: [{ sha: "c1", commit: { message: "m", tree: { sha: "t1" } } }] }
            ],
            [
                `${GH}/git/trees/t1?recursive=1`,
                { body: {}, headers: { "content-length": String(64 * 1024 * 1024) } }
            ],
            [
                (url) => url.startsWith("https://api.github.com/search/code?"),
                { body: { total_count: 1, items: [{ path: "src/a.ts", text_matches: [] }] } }
            ]
        ];
        const result = await run("repo_search", {
            repository: "acme/backend",
            query: "a",
            inContents: true
        });
        expect(result.ok).toBe(true);
        expect(result.truncated).toBe(true);
        expect(result.text).toContain("too big to list whole");
        expect(result.text).toContain("src/a.ts");
    });

    it("keeps the path of the address when a ref is also given", async () => {
        routes = [
            [
                `${GH}/contents/src/a.ts?ref=main`,
                {
                    body: {
                        type: "file",
                        path: "src/a.ts",
                        size: 4,
                        encoding: "base64",
                        content: b64("x=1\n")
                    }
                }
            ]
        ];
        const result = await run("repo_read_file", {
            repository: "https://github.com/acme/backend/blob/main/src/a.ts",
            ref: "main"
        });
        expect(result.ok).toBe(true);
        expect(result.text).toContain("x=1");
    });

    it("says an empty repository is empty instead of a missing branch", async () => {
        routes = [
            [GH, { body: { full_name: "acme/backend", default_branch: "main" } }],
            [
                (url) => url.startsWith(`${GH}/contents`),
                { status: 404, body: { message: "This repository is empty." } }
            ]
        ];
        const overview = await run("repo_overview", { repository: "acme/backend" });
        expect(overview.ok).toBe(true);
        expect(overview.text).toContain("top level at main:\n(empty)");
        const list = await run("repo_list_files", { repository: "acme/backend" });
        expect(list.ok).toBe(false);
        expect(list.text).toBe("That repository is empty.");
    });

    it("lists the latest commits", async () => {
        routes = [
            [
                `${GH}/commits?per_page=2`,
                {
                    body: [
                        {
                            sha: "abcdef1234",
                            commit: {
                                message: "Bump PHP\n\nbody",
                                author: { name: "Ann", date: "2026-10-01T00:00:00Z" }
                            }
                        }
                    ]
                }
            ]
        ];
        const result = await run("repo_commits", { repository: "acme/backend", limit: 2 });
        expect(result.text).toContain("abcdef1 2026-10-01 Ann: Bump PHP");
    });

    it("refuses an address that is not a repository, and a path that climbs out", async () => {
        expect(
            (await run("repo_overview", { repository: "https://example.com/a/b" })).text
        ).toContain("not a GitHub or gitlab.com repository");
        expect(
            (await run("repo_read_file", { repository: "a/b", path: "../etc/passwd" })).text
        ).toContain("cannot contain");
        expect(seen).toEqual([]);
    });
});

describe("a gitlab.com project", () => {
    it("addresses a project in nested groups by its encoded path", async () => {
        routes = [
            [
                GL,
                {
                    body: {
                        path_with_namespace: "group/sub/project",
                        default_branch: "main",
                        readme_url: "https://gitlab.com/group/sub/project/-/blob/main/README.md",
                        star_count: 1
                    }
                }
            ],
            [`${GL}/languages`, { body: { Go: 90.5, Shell: 9.5 } }],
            [
                `${GL}/repository/tree?per_page=100&ref=main`,
                {
                    body: [
                        { name: "go.mod", path: "go.mod", type: "blob" },
                        { name: "README.md", path: "README.md", type: "blob" }
                    ]
                }
            ],
            [`${GL}/repository/files/README.md/raw?ref=main`, { raw: "# Project" }]
        ];
        const result = await run("repo_overview", {
            repository: "https://gitlab.com/group/sub/project"
        });
        expect(result.ok).toBe(true);
        expect(result.text).toContain("on gitlab.com");
        expect(result.text).toContain("Go 90.5%");
        expect(result.text).toContain("# Project");
    });

    it("reads a file at the ref in the link", async () => {
        routes = [
            [
                `${GL}/repository/files/go.mod?ref=v1`,
                {
                    body: {
                        file_path: "go.mod",
                        size: 10,
                        encoding: "base64",
                        content: b64("go 1.23\n")
                    }
                }
            ]
        ];
        const result = await run("repo_read_file", {
            repository: "https://gitlab.com/group/sub/project/-/blob/v1/go.mod"
        });
        expect(result.text).toContain("go 1.23");
        expect(result.url).toBe("https://gitlab.com/group/sub/project/-/blob/v1/go.mod");
    });

    it("says only public projects are read when one is not found", async () => {
        const result = await run("repo_overview", {
            repository: "https://gitlab.com/group/hidden"
        });
        expect(result.text).toContain("public GitLab projects only");
    });

    it("searches paths across pages and says searching inside needs an account", async () => {
        routes = [
            [GL, { body: { path_with_namespace: "group/sub/project", default_branch: "main" } }],
            [
                `${GL}/repository/tree?recursive=true&per_page=100&page=1&ref=main`,
                {
                    body: [{ name: "a.go", path: "cmd/a.go", type: "blob" }],
                    headers: { "x-next-page": "2" }
                }
            ],
            [
                `${GL}/repository/tree?recursive=true&per_page=100&page=2&ref=main`,
                { body: [{ name: "b.go", path: "pkg/b.go", type: "blob" }] }
            ],
            [(url) => url.startsWith(`${GL}/search?`), { status: 401, body: {} }]
        ];
        const result = await run("repo_search", {
            repository: "https://gitlab.com/group/sub/project",
            query: "*.go",
            inContents: true
        });
        expect(result.text).toContain("cmd/a.go\npkg/b.go");
        expect(result.text).toContain("only searches inside files for a signed-in account");
    });

    it("names gitlab.com's limit", async () => {
        routes = [[() => true, { status: 429, body: {}, headers: { "retry-after": "12" } }]];
        const result = await run("repo_commits", {
            repository: "https://gitlab.com/group/sub/project",
            limit: 5
        });
        expect(result.text).toContain(
            "limiting requests from this server. Try again in 12 seconds."
        );
    });
});

describe("the pieces", () => {
    it("tells text from binary", () => {
        expect(textOf(new TextEncoder().encode("héllo"))).toBe("héllo");
        expect(textOf(new Uint8Array([104, 0, 105]))).toBeNull();
        expect(textOf(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
    });

    it("cuts a file at whole lines", () => {
        const window = fileWindow("a\nb\nc\n", 2);
        expect(window).toEqual({ text: "b\nc", first: 2, last: 3, lines: 3, truncated: false });
        const big = fileWindow(`${"x".repeat(FILE_CHARS - 5)}\nnext\nmore`);
        expect(big).toMatchObject({ last: 1, truncated: true });
    });

    it("matches paths by words or a pattern", () => {
        expect(pathMatches("docker/php/Dockerfile", "dockerfile")).toBe(true);
        expect(pathMatches("src/app.ts", "app src")).toBe(true);
        expect(pathMatches("a/b.csproj", "*.csproj")).toBe(true);
        expect(pathMatches("a/b.csproj.user", "*.csproj")).toBe(false);
        expect(pathMatches("Dockerfile.prod", "Dockerfile*")).toBe(true);
    });
});
