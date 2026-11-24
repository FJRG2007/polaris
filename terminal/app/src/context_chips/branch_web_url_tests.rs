use super::*;

#[test]
fn github_https_remote() {
    assert_eq!(
        branch_web_url("https://github.com/owner/repo.git", "main").as_deref(),
        Some("https://github.com/owner/repo/tree/main")
    );
}

#[test]
fn scp_like_remote_keeps_slashes_in_branch() {
    assert_eq!(
        branch_web_url("git@github.com:owner/repo.git", "feature/login").as_deref(),
        Some("https://github.com/owner/repo/tree/feature/login")
    );
}

#[test]
fn ssh_remote_drops_user_and_port() {
    assert_eq!(
        branch_web_url(
            "ssh://git@gitlab.example.com:2222/group/sub/repo.git",
            "dev"
        )
        .as_deref(),
        Some("https://gitlab.example.com/group/sub/repo/tree/dev")
    );
}

#[test]
fn https_remote_drops_credentials() {
    assert_eq!(
        branch_web_url("https://user:token@github.com/owner/repo", "main").as_deref(),
        Some("https://github.com/owner/repo/tree/main")
    );
}

#[test]
fn bitbucket_uses_branch_path() {
    assert_eq!(
        branch_web_url("git@bitbucket.org:team/repo.git", "fix").as_deref(),
        Some("https://bitbucket.org/team/repo/branch/fix")
    );
}

#[test]
fn azure_devops_ssh_remote() {
    assert_eq!(
        branch_web_url("git@ssh.dev.azure.com:v3/org/project/repo", "main").as_deref(),
        Some("https://dev.azure.com/org/project/_git/repo?version=GBmain")
    );
    assert_eq!(
        branch_web_url("https://dev.azure.com/org/project/_git/repo", "main").as_deref(),
        Some("https://dev.azure.com/org/project/_git/repo?version=GBmain")
    );
}

#[test]
fn branch_characters_that_break_urls_are_encoded() {
    assert_eq!(
        branch_web_url("https://github.com/o/r.git", "fix#12 a?b%").as_deref(),
        Some("https://github.com/o/r/tree/fix%2312%20a%3Fb%25")
    );
}

#[test]
fn local_remotes_have_no_web_page() {
    assert_eq!(branch_web_url(r"C:\repos\project", "main"), None);
    assert_eq!(branch_web_url("/srv/git/project.git", "main"), None);
    assert_eq!(branch_web_url("file:///srv/git/project.git", "main"), None);
    assert_eq!(branch_web_url("../project", "main"), None);
}

#[test]
fn empty_parts_have_no_web_page() {
    assert_eq!(branch_web_url("https://github.com/", "main"), None);
    assert_eq!(branch_web_url("https://github.com/o/r", ""), None);
}
