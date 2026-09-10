//! Private networks for deployed services.
//!
//! Every deployed service used to join one shared network, so any container
//! Polaris ran could reach any other by name - a database in one project was one
//! connection string away from an application in another. A private network is
//! the fix: the services of one environment (or of one link on its canvas) join a
//! network of their own, and only those services can reach each other on it.
//!
//! Compose cannot create these itself. A deploy is one compose project per
//! service, a network compose creates belongs to the project that created it, and
//! a second project that names the same network is refused - the same reason the
//! shared proxy network is declared external. So the daemon creates each private
//! network the first time a spec names it, before `compose up` runs.
//!
//! Only names under the private prefix are ever created, and the only other thing
//! done to one is attaching Polaris's own containers to it - the dashboard (found
//! by the `polaris.role=edge` label the stack gives it) and the edge and guard of
//! the same compose project - so the data browser can still open a database that
//! has left the shared network, and the edge can still dial a service by name.
//! Nothing an app sends can name any other container or any other network.

use std::process::{Command, Stdio};

/// The prefix every private network carries, and the only names this module acts on.
const PREFIX: &str = "polaris-net-";

/// The label every private network is created with, so unused ones can be pruned
/// without touching anybody else's networks.
const LABEL: &str = "polaris.network=private";

/// The address range tried when Docker's own pools are exhausted. A default daemon
/// has room for about thirty bridge networks, and each isolated environment takes
/// one; past that, `/24`s from this range are handed out instead.
const FALLBACK_OCTET_A: u8 = 10;
const FALLBACK_OCTET_B: u8 = 211;

/// How many fallback `/24`s are tried before giving up.
const FALLBACK_ATTEMPTS: u32 = 32;

/// A private network name as the dashboard mints them: the prefix, one letter for
/// what it scopes (`e` an environment, `s` a service), and ten hex characters.
pub fn is_private_network(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(PREFIX) else {
        return false;
    };
    let mut chars = rest.chars();
    matches!(chars.next(), Some('e' | 's'))
        && rest.len() == 11
        && chars.all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// FNV-1a over the name, so a network asks for the same fallback range every time
/// it is recreated rather than wandering.
fn name_hash(name: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in name.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// The fallback subnet a network tries on its `attempt`th go.
pub fn fallback_subnet(name: &str, attempt: u32) -> String {
    let third = (name_hash(name).wrapping_add(attempt)) % 256;
    format!("{FALLBACK_OCTET_A}.{FALLBACK_OCTET_B}.{third}.0/24")
}

/// Whether Docker refused a network because its address pools are used up, which
/// is the one refusal worth retrying with an explicit subnet.
pub fn pool_exhausted(said: &str) -> bool {
    let said = said.to_ascii_lowercase();
    said.contains("fully subnetted") || said.contains("non-overlapping")
}

/// Whether a subnet it was given is already in use, which moves on to the next.
fn subnet_taken(said: &str) -> bool {
    said.to_ascii_lowercase().contains("overlap")
}

/// The arguments that create one private network.
pub fn create_args(name: &str, swarm: bool, subnet: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "network".to_string(),
        "create".to_string(),
        "--label".to_string(),
        LABEL.to_string(),
    ];
    if swarm {
        // A stack's services run as swarm tasks, which can only join an overlay;
        // attachable so the dashboard's plain container can join it too.
        args.extend(["--driver", "overlay", "--attachable"].map(String::from));
    } else {
        args.extend(["--driver", "bridge"].map(String::from));
    }
    if let Some(subnet) = subnet {
        args.push("--subnet".to_string());
        args.push(subnet.to_string());
    }
    args.push(name.to_string());
    args
}

/// Run `docker` with these arguments and answer whether it worked and what it said.
fn docker(args: &[String]) -> (bool, String) {
    match Command::new("docker")
        .args(args)
        .stdin(Stdio::null())
        .output()
    {
        Ok(output) => {
            let mut said = String::from_utf8_lossy(&output.stderr).to_string();
            said.push_str(&String::from_utf8_lossy(&output.stdout));
            (output.status.success(), said)
        }
        Err(error) => (false, error.to_string()),
    }
}

fn exists(name: &str) -> bool {
    docker(&[
        "network".to_string(),
        "inspect".to_string(),
        name.to_string(),
    ])
    .0
}

/// Create one network, falling back to explicit subnets when Docker has none left.
fn create(name: &str, swarm: bool) -> Result<(), String> {
    let (ok, said) = docker(&create_args(name, swarm, None));
    if ok || exists(name) {
        return Ok(());
    }
    if !pool_exhausted(&said) {
        return Err(format!("could not create network {name}: {}", said.trim()));
    }
    // Room first: a network left behind by an environment that no longer runs
    // anything is holding a range for nobody.
    let _ = docker(&[
        "network".to_string(),
        "prune".to_string(),
        "-f".to_string(),
        "--filter".to_string(),
        format!("label={LABEL}"),
    ]);
    let (ok, _) = docker(&create_args(name, swarm, None));
    if ok {
        return Ok(());
    }
    for attempt in 0..FALLBACK_ATTEMPTS {
        let subnet = fallback_subnet(name, attempt);
        let (ok, said) = docker(&create_args(name, swarm, Some(&subnet)));
        if ok {
            return Ok(());
        }
        if !subnet_taken(&said) {
            return Err(format!("could not create network {name}: {}", said.trim()));
        }
    }
    Err(format!(
        "could not create network {name}: this server has no address range left for another network"
    ))
}

/// The services of Polaris's own stack that have to reach what is on a private
/// network: the dashboard (its data browser opens databases by name), the edge
/// that routes to services with no published port, and the guard in front of it.
const STACK_SERVICES: &[&str] = &["web", "traefik", "edge-guard"];

/// Container ids as `docker ps -q` prints them, and nothing else.
fn ids_of(printed: &str) -> Vec<String> {
    printed
        .split_whitespace()
        .filter(|id| !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(String::from)
        .collect()
}

/// A compose project name as compose writes it into its label.
fn valid_compose_project(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// The containers of Polaris's own stack on this machine: the dashboard, found by
/// the label the stack gives it, and the edge and guard of the same compose
/// project. Found by the dashboard's project rather than by name, because an
/// install names its containers after whatever directory it was started from.
fn stack_container_ids() -> Vec<String> {
    let (ok, printed) = docker(&[
        "ps".to_string(),
        "-q".to_string(),
        "--filter".to_string(),
        "label=polaris.role=edge".to_string(),
    ]);
    if !ok {
        return Vec::new();
    }
    let mut ids = ids_of(&printed);
    let Some(dashboard) = ids.first().cloned() else {
        return ids;
    };
    let (ok, project) = docker(&[
        "inspect".to_string(),
        "--format".to_string(),
        "{{index .Config.Labels \"com.docker.compose.project\"}}".to_string(),
        dashboard,
    ]);
    let project = project.trim().to_string();
    if !ok || !valid_compose_project(&project) {
        return ids;
    }
    for service in STACK_SERVICES {
        let (ok, printed) = docker(&[
            "ps".to_string(),
            "-q".to_string(),
            "--filter".to_string(),
            format!("label=com.docker.compose.project={project}"),
            "--filter".to_string(),
            format!("label=com.docker.compose.service={service}"),
        ]);
        if ok {
            for id in ids_of(&printed) {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
    }
    ids
}

/// Attach Polaris's own containers to a network. Already attached is fine, and so
/// is there being none - an install whose dashboard is elsewhere attaches nothing.
fn attach_stack(name: &str, stack: &[String]) {
    for id in stack {
        let _ = docker(&[
            "network".to_string(),
            "connect".to_string(),
            name.to_string(),
            id.clone(),
        ]);
    }
}

/// Make sure every private network a spec names exists, before compose is asked
/// to join it. Names that are not private are left alone: the shared networks are
/// created by the daemon at startup or by the stack itself.
pub fn ensure(networks: &[String], swarm: bool) -> Result<(), String> {
    let private: Vec<&String> = networks
        .iter()
        .filter(|name| is_private_network(name))
        .collect();
    if private.is_empty() {
        return Ok(());
    }
    let stack = stack_container_ids();
    for name in private {
        if !exists(name) {
            create(name, swarm)?;
        }
        attach_stack(name, &stack);
    }
    Ok(())
}

/// What a reconcile did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Reconciled {
    pub kept: usize,
    pub removed: usize,
}

/// Which private networks on this machine are no longer wanted: every one not
/// named in `keep`. Pure, so the one decision here that removes something is the
/// part that is tested.
pub fn unwanted<'a>(present: &'a [String], keep: &[String]) -> Vec<&'a String> {
    present
        .iter()
        .filter(|name| is_private_network(name) && !keep.contains(name))
        .collect()
}

/// Whether every container on a network is one of Polaris's own - the one case in
/// which a network nothing wants can go. A network an application is still on is
/// left exactly as it is, stack attachments included, because that application
/// has not been redeployed onto its new networks yet and is still reached there.
pub fn only_stack_attached(attached: &[String], stack: &[String]) -> bool {
    attached.iter().all(|id| {
        stack
            .iter()
            .any(|own| own.starts_with(id.as_str()) || id.starts_with(own.as_str()))
    })
}

/// The ids of the containers on a network, or None when Docker would not say.
fn attached_ids(name: &str) -> Option<Vec<String>> {
    let (ok, printed) = docker(&[
        "network".to_string(),
        "inspect".to_string(),
        "--format".to_string(),
        "{{range $id, $c := .Containers}}{{$id}} {{end}}".to_string(),
        name.to_string(),
    ]);
    ok.then(|| ids_of(&printed))
}

/// Bring this machine's private networks in line with the ones Polaris still has a
/// use for: Polaris's own containers are attached to every wanted one - the edge
/// loses its attachments whenever it is recreated by an update - and a network
/// nothing wants any more, and that nothing but Polaris's own containers is on, is
/// detached from them and removed.
pub fn reconcile(keep: &[String]) -> Reconciled {
    let (ok, printed) = docker(&[
        "network".to_string(),
        "ls".to_string(),
        "--filter".to_string(),
        format!("label={LABEL}"),
        "--format".to_string(),
        "{{.Name}}".to_string(),
    ]);
    if !ok {
        return Reconciled::default();
    }
    let present: Vec<String> = printed
        .split_whitespace()
        .filter(|name| is_private_network(name))
        .map(String::from)
        .collect();
    let stack = stack_container_ids();
    let mut report = Reconciled::default();
    let gone = unwanted(&present, keep);
    for name in &present {
        let removable = gone.contains(&name)
            && attached_ids(name).is_some_and(|attached| only_stack_attached(&attached, &stack));
        if removable {
            for id in &stack {
                let _ = docker(&[
                    "network".to_string(),
                    "disconnect".to_string(),
                    "-f".to_string(),
                    name.clone(),
                    id.clone(),
                ]);
            }
            if docker(&["network".to_string(), "rm".to_string(), name.clone()]).0 {
                report.removed += 1;
            }
        } else {
            attach_stack(name, &stack);
            report.kept += 1;
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_minted_shape_is_private() {
        assert!(is_private_network("polaris-net-e0123456789"));
        assert!(is_private_network("polaris-net-sabcdef0123"));
        for other in [
            "polaris-proxy",
            "polaris-net-",
            "polaris-net-x0123456789",
            "polaris-net-e012345678",
            "polaris-net-e0123456789a",
            "polaris-net-eABCDEF0123",
            "bridge",
            "host",
        ] {
            assert!(!is_private_network(other), "{other}");
        }
    }

    #[test]
    fn a_fallback_range_is_stable_and_moves_on() {
        let first = fallback_subnet("polaris-net-e0123456789", 0);
        assert_eq!(first, fallback_subnet("polaris-net-e0123456789", 0));
        assert_ne!(first, fallback_subnet("polaris-net-e0123456789", 1));
        assert!(first.starts_with("10.211.") && first.ends_with(".0/24"));
    }

    #[test]
    fn reads_docker_saying_it_has_no_room() {
        assert!(pool_exhausted(
            "Error response from daemon: all predefined address pools have been fully subnetted"
        ));
        assert!(pool_exhausted(
            "could not find an available, non-overlapping IPv4 address pool among the defaults"
        ));
        assert!(!pool_exhausted(
            "Error response from daemon: network with name x already exists"
        ));
    }

    #[test]
    fn builds_the_arguments_for_either_engine() {
        assert_eq!(
            create_args("polaris-net-e0123456789", false, None),
            [
                "network",
                "create",
                "--label",
                "polaris.network=private",
                "--driver",
                "bridge",
                "polaris-net-e0123456789"
            ]
        );
        let swarm = create_args("polaris-net-e0123456789", true, Some("10.211.4.0/24"));
        assert!(swarm.contains(&"overlay".to_string()));
        assert!(swarm.contains(&"--attachable".to_string()));
        assert!(swarm.contains(&"10.211.4.0/24".to_string()));
        assert_eq!(swarm.last().unwrap(), "polaris-net-e0123456789");
    }

    #[test]
    fn removes_only_private_networks_nobody_wants() {
        let present = vec![
            "polaris-net-e0123456789".to_string(),
            "polaris-net-eabcdefabcd".to_string(),
            "polaris-proxy".to_string(),
        ];
        let keep = vec!["polaris-net-e0123456789".to_string()];
        assert_eq!(unwanted(&present, &keep), vec![&present[1]]);
        // Nothing is wanted: still never the shared network.
        assert_eq!(unwanted(&present, &[]).len(), 2);
    }

    #[test]
    fn keeps_a_network_an_application_is_still_on() {
        let stack = vec!["aaaaaaaaaaaa".to_string(), "bbbbbbbbbbbb".to_string()];
        // Docker inspect prints full ids, ps prints short ones; either matches.
        assert!(only_stack_attached(
            &["aaaaaaaaaaaa0123456789".to_string()],
            &stack
        ));
        assert!(only_stack_attached(&[], &stack));
        assert!(!only_stack_attached(
            &["aaaaaaaaaaaa".to_string(), "cccccccccccc".to_string()],
            &stack
        ));
    }

    #[test]
    fn reads_only_container_ids_out_of_docker_ps() {
        assert_eq!(
            ids_of("3f2a1b\nzz-not-an-id\n0123abcd ; rm -rf /\n"),
            vec!["3f2a1b", "0123abcd"]
        );
        assert!(valid_compose_project("polaris"));
        assert!(!valid_compose_project("Polaris; x"));
    }

    #[test]
    fn leaves_names_that_are_not_private_alone() {
        // Nothing runs for these: the loop filters them out before any docker call.
        assert!(ensure(
            &["polaris-proxy".to_string(), "polaris-hub".to_string()],
            false
        )
        .is_ok());
    }
}
