//! Finds the web page of the current branch on its remote, for the git branch chip.

use std::path::Path;

use command::r#async::Command;

/// Returns the web URL of the branch checked out in `repo_dir` on its remote, or `None` if the
/// branch has no counterpart on a remote or the remote is not a host with branch pages.
///
/// The remote and the branch name come from the branch's upstream; a branch without one falls
/// back to a branch of the same name on `origin`. Either way the remote-tracking ref has to exist,
/// so a branch that was never pushed, or was deleted from the remote, opens nothing.
pub(crate) async fn resolve(repo_dir: &Path) -> Option<String> {
    let head = git(repo_dir, &["symbolic-ref", "--quiet", "HEAD"]).await?;
    let upstream = git(
        repo_dir,
        &[
            "for-each-ref",
            "--format=%(upstream:remotename)%00%(upstream:lstrip=3)",
            &head,
        ],
    )
    .await
    .and_then(|line| {
        let (remote, branch) = line.split_once('\0')?;
        (!remote.is_empty() && !branch.is_empty()).then(|| (remote.to_owned(), branch.to_owned()))
    });
    let (remote, branch) = match upstream {
        Some(upstream) => upstream,
        None => (
            "origin".to_owned(),
            head.strip_prefix("refs/heads/")?.to_owned(),
        ),
    };

    let tracking_ref = format!("refs/remotes/{remote}/{branch}");
    git(
        repo_dir,
        &["rev-parse", "--verify", "--quiet", &tracking_ref],
    )
    .await?;
    let remote_url = git(repo_dir, &["remote", "get-url", &remote]).await?;
    branch_web_url(&remote_url, &branch)
}

/// Runs git in `repo_dir` and returns its trimmed output, or `None` if it failed or printed
/// nothing.
async fn git(repo_dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .args(args)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let trimmed = stdout.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// Turns a remote URL and a branch name into the branch's page on the remote's web interface.
///
/// Accepts the forms git does: `https://host/owner/repo.git`, `ssh://git@host:22/owner/repo.git`
/// and the scp-like `git@host:owner/repo.git`. Credentials and ports are dropped, since the web
/// interface is served elsewhere. Local paths and `file://` remotes have no web page.
pub(crate) fn branch_web_url(remote_url: &str, branch: &str) -> Option<String> {
    let (host, path) = host_and_path(remote_url.trim())?;
    let path = path.trim_matches('/');
    let path = path
        .strip_suffix(".git")
        .unwrap_or(path)
        .trim_end_matches('/');
    if host.is_empty() || path.is_empty() || branch.is_empty() {
        return None;
    }

    let branch = encode_branch(branch);
    let host_lowercase = host.to_ascii_lowercase();
    let url = if host_lowercase == "bitbucket.org" {
        format!("https://{host}/{path}/branch/{branch}")
    } else if host_lowercase == "ssh.dev.azure.com" {
        // Azure DevOps SSH remotes are `v3/<org>/<project>/<repo>`, served on the web at
        // `dev.azure.com/<org>/<project>/_git/<repo>`.
        let mut parts = path.strip_prefix("v3/")?.splitn(3, '/');
        let (org, project, repo) = (parts.next()?, parts.next()?, parts.next()?);
        format!("https://dev.azure.com/{org}/{project}/_git/{repo}?version=GB{branch}")
    } else if host_lowercase == "dev.azure.com" || host_lowercase.ends_with(".visualstudio.com") {
        format!("https://{host}/{path}?version=GB{branch}")
    } else {
        // GitHub, GitLab, Gitea, Forgejo and Codeberg all serve a branch at `/tree/<branch>`.
        format!("https://{host}/{path}/tree/{branch}")
    };
    Some(url)
}

/// Splits a remote URL into its host (without credentials or port) and repository path.
fn host_and_path(remote_url: &str) -> Option<(&str, &str)> {
    if let Some((scheme, rest)) = remote_url.split_once("://") {
        if !matches!(
            scheme.to_ascii_lowercase().as_str(),
            "http" | "https" | "ssh" | "git" | "git+ssh" | "ssh+git"
        ) {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        let host = authority
            .rsplit_once('@')
            .map_or(authority, |(_, host)| host);
        let host = host.split_once(':').map_or(host, |(host, _)| host);
        return Some((host, path));
    }

    // scp-like syntax: `[user@]host:path`. A drive letter (`C:\repo`) or a path before the colon
    // means a local path instead.
    let (authority, path) = remote_url.split_once(':')?;
    if authority.len() <= 1 || authority.contains(['/', '\\']) {
        return None;
    }
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    Some((host, path))
}

/// Percent-encodes the characters of a branch name that would end or change a URL path. Slashes
/// stay as they are: hosts expect `feature/x` in the path, not `feature%2Fx`.
fn encode_branch(branch: &str) -> String {
    let mut encoded = String::with_capacity(branch.len());
    for byte in branch.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
#[path = "branch_web_url_tests.rs"]
mod tests;
