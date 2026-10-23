// @vitest-environment jsdom

/**
 * The Source card at the top of a service's Settings tab, in each state a
 * service can be in - a GitHub repository, another git host, an uploaded folder,
 * an image, nothing - and the stored source config each one is read from,
 * including a repository address that was saved with a token in it.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { describeServiceSource } from "@/lib/deploy/service-source";

vi.mock("@/app/(app)/apps/deploy/source-actions", () => ({
    serviceSourceAction: vi.fn(async () => ({}))
}));

const { SourceRepositoryView, builderOf } = await import("@/app/(app)/apps/deploy/service-source-cards");

afterEach(cleanup);

const read = (sourceType: string, config: Record<string, unknown>, deployBranch: string | null = null) =>
    describeServiceSource({
        sourceType,
        sourceConfig: JSON.stringify(config),
        deployBranch,
        environmentBranch: null
    });

describe("what the stored source says", () => {
    it("names a GitHub repository by owner/repo and links its page", () => {
        expect(read("dockerfile", { repoUrl: "https://github.com/acme/shop.git", provider: "github", branch: "main" })).toEqual({
            kind: "repository",
            provider: "github",
            name: "acme/shop",
            url: "https://github.com/acme/shop",
            branch: "main"
        });
    });

    it("prefers the auto-deploy branch, and never shows a token typed into the address", () => {
        const source = read("nixpacks", { repoUrl: "https://user:secret-token@git.example.test/team/app.git" }, "release");
        expect(source).toEqual({
            kind: "repository",
            provider: "git",
            name: "git.example.test/team/app",
            url: "https://git.example.test/team/app",
            branch: "release"
        });
        expect(JSON.stringify(source)).not.toContain("secret-token");
    });

    it("links a plain-http repository over http, as stored", () => {
        expect(read("dockerfile", { repoUrl: "http://git.lan/team/app.git" })).toMatchObject({
            url: "http://git.lan/team/app"
        });
    });

    it("tells an upload, an image and no source apart", () => {
        expect(read("nixpacks", {})).toEqual({ kind: "upload", uploaded: false });
        expect(read("image", { imageRef: "nginx:1.27" })).toEqual({ kind: "image", image: "nginx:1.27" });
        expect(read("image", {})).toEqual({ kind: "none" });
        expect(read("compose", {})).toEqual({ kind: "none" });
    });
});

describe("the Source card", () => {
    it("shows the GitHub repository with its link, branch, root directory and push setting", () => {
        render(
            <SourceRepositoryView
                source={{ kind: "repository", provider: "github", name: "acme/shop", url: "https://github.com/acme/shop", branch: "main" }}
                rootDirectory="apps/web"
                autoDeploy={true}
                canConfigure={true}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getByRole("heading", { name: "Repository" })).toBeDefined();
        const link = screen.getByRole("link", { name: /acme\/shop/ });
        expect(link.getAttribute("href")).toBe("https://github.com/acme/shop");
        expect(screen.getByText("main")).toBeDefined();
        expect(screen.getByText("apps/web")).toBeDefined();
        expect(screen.getByText("Enabled")).toBeDefined();
    });

    it("says the default branch and the repository root when none is set", () => {
        render(
            <SourceRepositoryView
                source={{ kind: "repository", provider: "git", name: "git.example.test/team/app", url: null, branch: "" }}
                rootDirectory={null}
                autoDeploy={false}
                canConfigure={true}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.queryByRole("link")).toBeNull();
        expect(screen.getByText("Default branch")).toBeDefined();
        expect(screen.getByText("Repository root")).toBeDefined();
        expect(screen.getByText("Disabled")).toBeDefined();
    });

    it("describes an upload instead of a repository", () => {
        render(<SourceRepositoryView source={{ kind: "upload", uploaded: true }} rootDirectory={null} autoDeploy={false} canConfigure={true} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByRole("heading", { name: "Uploaded folder" })).toBeDefined();
        expect(screen.getByText("Built from a folder you upload. No repository is connected.")).toBeDefined();
    });

    it("offers the drop zone only to someone who can use it", () => {
        render(<SourceRepositoryView source={{ kind: "upload", uploaded: false }} rootDirectory={null} autoDeploy={false} canConfigure={true} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText("Nothing uploaded yet. Drop a folder below to deploy it.")).toBeDefined();
        cleanup();
        render(<SourceRepositoryView source={{ kind: "upload", uploaded: false }} rootDirectory={null} autoDeploy={false} canConfigure={false} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText("Nothing uploaded yet.")).toBeDefined();
    });

    it("says when nothing is connected yet", () => {
        render(<SourceRepositoryView source={{ kind: "none" }} rootDirectory={null} autoDeploy={false} canConfigure={true} />, {
            wrapper: MessagesWrapper
        });
        expect(screen.getByText("No repository, upload or image is connected yet.")).toBeDefined();
    });
});

describe("the builder a service is said to use", () => {
    it("is the Dockerfile at its path inside the root directory", () => {
        expect(builderOf({ sourceType: "dockerfile", rootDirectory: "/apps/web/", dockerfilePath: "" })).toEqual({
            kind: "dockerfile",
            path: "apps/web/Dockerfile"
        });
        expect(builderOf({ sourceType: "nixpacks", rootDirectory: null, dockerfilePath: null })).toEqual({ kind: "auto" });
        expect(builderOf({ sourceType: "image", rootDirectory: null, dockerfilePath: null })).toEqual({ kind: "image" });
    });
});
