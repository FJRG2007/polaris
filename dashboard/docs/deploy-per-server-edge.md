# Per-server edge routing (Dokploy/Coolify model)

Deployed apps must keep serving even if the Polaris control plane is down, so each
connected server runs its **own edge** (Traefik) and a remote app's domain points
**directly at that server's IP**. Polaris orchestrates over SSH but is never in the
request path. See the `deploy-topology-routing` note for the rationale.

The router is modular: `apps/web/src/lib/deploy/router.ts` defines a `Router`
seam and `renderDynamicConfig()` (shared YAML), with `LocalRouter` writing the
Polaris host's own edge.

## Phase 1 - done

- `Router` interface + `renderDynamicConfig()` + `LocalRouter` (`deploy/router.ts`).
- `syncAppRoutes()` groups enabled domains by their app's target server. Local-target
  apps route through `LocalRouter` exactly as before; remote-target apps are excluded
  from the local edge (never funnelled through Polaris) and logged pending their own edge.
- `resolveAutoDomain(name, override?)` is target-aware: a remote app's auto subdomain
  embeds the remote server's IP (`DeployTarget.host.address`) and picks its cert from
  that IP's reachability (public -> Let's Encrypt, private -> internal/LAN), instead of
  inheriting the Polaris host's IP/mode.

## Phase 2 - remote edge (todo)

1. **Provision Traefik on a remote host.** When the first app is deployed to a remote
   server, bring up a Traefik edge there via the existing SSH/compose path
   (`deploy/ports-ssh.ts`, `REMOTE_DEPLOY_ROOT`): same static flags as the local edge
   (docker + file providers, Let's Encrypt httpchallenge, accesslog), a `/dynamic`
   dir on the remote host, and the `polaris-proxy` network. Idempotent (skip if up).
2. **RemoteRouter.** Implement `Router` by writing `renderDynamicConfig(routes)` to the
   remote host's `/dynamic/polaris-apps.yml` over SSH/SFTP. `dialHost` for a remote
   route is the app's origin as seen from that host (its own published port on
   127.0.0.1 / the host IP), not the Polaris host.
3. **Dispatch in `syncAppRoutes`.** Build one `Router` per distinct server from the
   grouped domains (LocalRouter for the local target, a RemoteRouter per remote host)
   and `sync()` each with its own route set. Replace the Phase-1 "log and skip".
4. **Cert / hostname.** A remote edge issues its own Let's Encrypt cert (the domain's
   DNS points at that server). The custom-domain UI should let the operator confirm the
   DNS target is the remote server's IP, and surface the resilience trade-off.
5. **Health / teardown.** Detect a remote edge that is down; tear it down when the last
   app leaves a server. Optionally let the operator place the entry edge on a stable
   remote server for a home-lab Polaris (operator choice).
