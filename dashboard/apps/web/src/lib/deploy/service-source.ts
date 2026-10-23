/**
 * Where a service's code or image comes from, as its Settings tab shows it: the
 * repository (and which host it is on), an uploaded folder, or an image.
 *
 * Read from the stored source config and nothing else, so the card says only
 * what Polaris actually knows. A repository address is shown without any
 * credentials that were typed into it, and is linked only when it is a web page.
 */

import { trackedBranch } from "./branches";
import { uploadedSourceOf } from "./source-upload";
import { parseGithubRepo } from "@/lib/repo-reference";

export type ServiceSourceView =
    | {
          readonly kind: "repository";
          readonly provider: "github" | "git";
          /** `owner/repo` on GitHub; host and path for any other host. */
          readonly name: string;
          /** The repository's page, when it has one to open. */
          readonly url: string | null;
          /** The branch it follows; "" when it follows the repository's default. */
          readonly branch: string;
      }
    | { readonly kind: "upload"; readonly uploaded: boolean }
    | { readonly kind: "image"; readonly image: string }
    | { readonly kind: "none" };

/** A repository address with any user name or token taken out. */
function withoutCredentials(address: string): string {
    const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(address);
    if (scp) return `${scp[1]}/${scp[2]}`;
    try {
        const url = new URL(address);
        return `${url.host}${url.pathname}`.replace(/\.git$/, "").replace(/\/+$/, "");
    } catch {
        return address.replace(/^[^@/]+@/, "");
    }
}

/** What the Settings tab says about a service's source. */
export function describeServiceSource(app: {
    sourceType: string;
    sourceConfig: string;
    deployBranch: string | null;
    environmentBranch: string | null;
}): ServiceSourceView {
    let source: Record<string, unknown>;
    try {
        source = JSON.parse(app.sourceConfig || "{}") as Record<string, unknown>;
    } catch {
        source = {};
    }
    const repoUrl = typeof source.repoUrl === "string" ? source.repoUrl.trim() : "";
    if (repoUrl) {
        const branch = trackedBranch(
            { deployBranch: app.deployBranch, sourceConfig: app.sourceConfig },
            { branch: app.environmentBranch }
        );
        const github =
            source.provider === "github" || /(^|[@/.])github\.com[:/]/i.test(repoUrl)
                ? parseGithubRepo(repoUrl)
                : null;
        if (github) {
            const name = `${github.owner}/${github.repo}`;
            return { kind: "repository", provider: "github", name, url: `https://github.com/${name}`, branch };
        }
        const name = withoutCredentials(repoUrl);
        const scheme = /^(https?):\/\//i.exec(repoUrl)?.[1]?.toLowerCase();
        const url = scheme ? `${scheme}://${name}` : null;
        return { kind: "repository", provider: "git", name, url, branch };
    }
    if (app.sourceType === "image") {
        const image = typeof source.imageRef === "string" ? source.imageRef.trim() : "";
        return image ? { kind: "image", image } : { kind: "none" };
    }
    if (app.sourceType === "dockerfile" || app.sourceType === "nixpacks") {
        return { kind: "upload", uploaded: uploadedSourceOf(source) !== null };
    }
    return { kind: "none" };
}
