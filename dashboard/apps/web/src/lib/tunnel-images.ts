/**
 * The images every tunnel sidecar runs, pinned by version and digest.
 *
 * A floating `latest` meant each host ran whatever copy it happened to pull,
 * scanned with that copy's vulnerabilities, and a new agent reached a running
 * tunnel without anybody choosing it. Pinned, a new agent arrives with a Polaris
 * update, the same one on every host. Moving one is editing its line here, with
 * the digest Docker Hub lists for the new tag.
 *
 * ngrok runs its Alpine variant: the same agent as the default Debian one, on a
 * base with a fraction of the packages (about 16 MB against 77 MB), which is
 * where the Debian variant's reported vulnerabilities were. cloudflared's image
 * is already a single binary on a distroless base.
 */

/** cloudflared 2026.10.7 (multi-arch index). */
export const CLOUDFLARED_IMAGE =
    "cloudflare/cloudflared:2026.10.7@sha256:4955524aeaa379e154023d5a027c250f7b35041a2e7e950cf13f144bc9b9c5ba";

/** ngrok agent 3.39.13, Alpine variant (multi-arch index). */
export const NGROK_IMAGE =
    "ngrok/ngrok:3.39.13-alpine@sha256:a51a7637a70be573615b01852af0419c4ab9dc857601b3d61ea2a082be3ec0d3";
