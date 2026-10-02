# Per-server edge routing (Dokploy/Coolify model)

Deployed apps must keep serving even if the Polaris control plane is down, so each
connected server runs its **own edge** (Traefik + the `polaris-edge-guard` sidecar)
and a remote app's domain points **directly at that server's IP**. Polaris
orchestrates over SSH but is never in the request path. See the `deploy-topology-routing`
note for the rationale.

The router is modular: `apps/web/src/lib/deploy/router.ts` defines a `Router`
seam and `renderDynamicConfig()` (shared YAML), with `LocalRouter` writing the
Polaris host's own edge and `RemoteRouter` (`deploy/router-remote.ts`) writing a
remote host's over SSH. Both are driven from `publishAppRoutes()` /
`pushRemoteRoutes()` in `deploy-service.ts`, which group enabled domains by their
app's target server.

## Routing

- `Router` interface + `renderDynamicConfig()` + `LocalRouter` (`deploy/router.ts`).
  `LocalRouter` writes through `writeDynamicFile` (`lib/traefik-dynamic.ts`), which
  renames a temp file over the target instead of truncating it in place, so a failed
  write leaves the previous routes serving instead of an empty file.
- `syncAppRoutes()` / `pushRemoteRoutes()` group enabled domains by their app's target
  server. Local-target apps route through `LocalRouter`; remote-target apps are built
  into their own `RemoteRouter` and written to `/dynamic/polaris-apps.yml` on that
  server over SSH/SFTP - the same temp-file-then-rename write as `LocalRouter`, so a
  dropped SSH session mid-transfer cannot leave that edge with an empty routing file
  either. `dialHost` for a remote route is the app's own published port on that host,
  not the Polaris host.
- `resolveAutoDomain(name, override?)` is target-aware: a remote app's auto subdomain
  embeds the remote server's IP (`DeployTarget.host.address`) and picks its cert from
  that IP's reachability (public -> Let's Encrypt, private -> internal/LAN), instead of
  inheriting the Polaris host's IP/mode.
- Provisioning a remote edge (bringing up Traefik + `polaris-edge-guard` the first
  time an app is deployed to a server) is `onboardingScript()` in
  `packages/deploy/src/onboarding.ts`: same static flags as the local edge (docker +
  file providers, Let's Encrypt httpchallenge, accesslog), a `/dynamic` dir, the
  `polaris-proxy` network, and the guard's `EDGE_INTEL_DIR` volume (below). Idempotent
  (skip if up). A server with nothing deployed to it any more is handed an empty
  route set (`remoteClearScript()`), and `EdgePanel` (`apps/servers/edge-panel.tsx`)
  reports whether that server's Traefik and guard are reachable and current.

## DNS and certificates follow the serving server, not Polaris

- **DNS.** `provisionHostnameDns()` (`lib/domain-dns.ts`) points a custom domain's A
  record at whichever machine's edge actually answers for it: the remote server's
  public IPv4 when the domain's app is on a remote target and served by that
  server's own edge, and Polaris's own detected IP only for a domain served by
  Polaris (`servedBy: "polaris"`, or a local app). Pointing a remote app's domain at
  Polaris would be wrong twice over - this edge does not route a name another server
  serves, and even if it did, every request would then depend on the control plane
  being up. A remote server with no public IPv4 Polaris can see is left for the
  operator to point by hand (`dnsAddressFor`) rather than guessed.
- **Certificates.** Only a **wildcard** that covers a remote server's name is handed
  to it (`needsHandedCertificate`, `managed-cert-plan.ts`); an exact hostname
  (`example.com`, `api.example.com`) is left to renew on that server's own Traefik
  over its own Let's Encrypt HTTP challenge, with nothing from Polaris. That is what
  keeps an exact name valid for as long as the remote server is up, independent of
  how long Polaris has been off - handing it a wildcard instead would tie its renewal
  to a certificate only Polaris can renew.

## While the control plane is down

- **Signing in.** Polaris mints an edge login token with Ed25519 (`edge-signing-key.ts`
  holds the private half, sealed with the master key; the public half rides in every
  login-protected route's rule as `k`) as well as the legacy HMAC token, so a route's
  guard verifies a new login with nothing that could mint one. A visitor with a valid
  token keeps access until the token's hard expiry (`EDGE_TOKEN_TTL_SECONDS`, 12
  hours); the 30-minute membership freshness backstop stands down since there is
  nowhere to refresh a claim. A visitor who needs to sign in, holds an expired token,
  or whose account Polaris re-decided while it was gone gets a 503 "sign-in
  unavailable" page instead of a redirect to a login that does not answer
  (`control-plane.ts`, `signin-unavailable.ts`). See `services/edge-guard/README.md`
  for the guard-side detail.
- **Bans, Tor exits, revoked sessions.** `waf-intel-service.ts` pushes the same
  snapshot the local guard reads to every remote server's `EDGE_INTEL_DIR` over SSH
  (`RemoteRouter.pushIntel`, fire-and-forget, one push per server per change - a
  server that is asleep costs nothing but its own warning). Each server's guard reads
  its own copy from disk, so a ban still ends on time and a revoked session still
  locks out its holder while Polaris is unreachable.

## Framing protection (clickjacking)

A route whose WAF rule has framing protection on carries the allowed origins (`f` in
the guard rule). The guard's proxy merges `Content-Security-Policy: frame-ancestors`
into the app's own response without replacing its policy (`protectFrameHeaders`,
`@polaris/core/frame-protection`); a route the proxy is not already fronting (no
guard reachable, or more than one dial host) gets the blind fallback header instead
(`fallbackFrameHeaders`) from Traefik's labels/dynamic config directly, with the
app's own `X-Frame-Options`/`frame-ancestors` always winning when present.
