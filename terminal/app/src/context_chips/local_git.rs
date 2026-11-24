//! Runs the git context chips' queries as plain `git` processes, for sessions whose generator
//! commands already run as processes on this machine.
//!
//! The shell variants in [`super::builtins`] start the session's shell for every refresh. For
//! PowerShell that is `powershell -NoProfile`, which costs far more than the git calls it wraps,
//! and the chips refresh every 30 seconds in every tab. Each query here reproduces the stdout and
//! exit status of its shell variant, so the chips parse both the same way.

use std::time::Duration;

use instant::Instant;

#[cfg(test)]
#[path = "local_git_tests.rs"]
mod tests;

/// How long a directory where a git chip failed is trusted to still not be a repository before
/// the periodic refresh runs git there again. A completed command forgets it sooner.
const FAILED_DIRECTORY_TTL: Duration = Duration::from_secs(5 * 60);

/// A git chip query that can run without a shell. Each one matches a generator in
/// [`super::builtins`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalGitQuery {
    /// `shell_git_branch`: the branch name, or the short sha on a detached HEAD.
    Branch,
    /// `shell_git_branch_status`: the branch plus its ahead/behind counts.
    BranchStatus,
    /// `shell_other_git_branches`: the branch list and the worktree list.
    OtherBranches,
    /// `shell_git_line_changes`: `git diff --shortstat HEAD`.
    LineChanges,
}

/// Remembers the directory a git chip last failed in, so the periodic refresh stops running git
/// in a directory that is not a repository.
///
/// It is forgotten when the directory changes, when a command completes (the command may have
/// been `git init`), and after [`FAILED_DIRECTORY_TTL`], which bounds how long a repository
/// created from outside the session goes unnoticed.
#[derive(Clone, Debug, Default)]
pub struct FailedDirectory {
    entry: Option<(String, Instant)>,
}

impl FailedDirectory {
    pub fn record(&mut self, directory: Option<&str>, now: Instant) {
        self.entry = directory.map(|directory| (directory.to_owned(), now));
    }

    pub fn clear(&mut self) {
        self.entry = None;
    }

    /// Whether a periodic refresh in `directory` can be skipped at `now`.
    pub fn covers(&self, directory: Option<&str>, now: Instant) -> bool {
        match (&self.entry, directory) {
            (Some((failed, failed_at)), Some(directory)) => {
                failed == directory && now.duration_since(*failed_at) < FAILED_DIRECTORY_TTL
            }
            _ => false,
        }
    }
}

/// Formats the branch status line exactly as `shell_git_branch_status` prints it, from the
/// branch name and the output of `git rev-list --left-right --cherry-mark --count HEAD...@{u}`.
#[cfg_attr(not(feature = "local_tty"), allow(dead_code))]
pub(super) fn format_branch_status(branch: &str, counts: &str) -> String {
    let mut parts = counts.split_whitespace();
    let mut next_count = || parts.next().map(str::parse::<u64>);
    let (Some(Ok(ahead)), Some(Ok(behind))) = (next_count(), next_count()) else {
        return branch.to_owned();
    };
    let equivalent = match next_count() {
        Some(Ok(equivalent)) => equivalent,
        Some(Err(_)) => return branch.to_owned(),
        None => 0,
    };

    let mut status = Vec::new();
    if ahead == 0 && behind == 0 && equivalent > 0 {
        status.push("⇅".to_owned());
    } else {
        if ahead > 0 {
            status.push(format!("↑{}", display_count(ahead)));
        }
        if behind > 0 {
            status.push(format!("↓{}", display_count(behind)));
        }
    }

    if status.is_empty() {
        branch.to_owned()
    } else {
        format!("{branch} • {}", status.join(" "))
    }
}

fn display_count(count: u64) -> String {
    if count > 999 {
        "999+".to_owned()
    } else {
        count.to_string()
    }
}

#[cfg(feature = "local_tty")]
mod run {
    use std::collections::HashMap;
    use std::io;

    use command::Output;
    use command::r#async::Command;
    use pterm_completer::completer::{CommandExitStatus, CommandOutput};
    use pterm_core::command::ExitCode;

    use super::{LocalGitQuery, format_branch_status};

    impl LocalGitQuery {
        /// Runs the query in `current_dir` with `environment_variables` (which carry the
        /// session's `PATH`), the same inputs the session's executor would get.
        ///
        /// An `Err` means git could not be started at all, for example because `git` on `PATH`
        /// is a script only a shell can run. The caller then falls back to the shell variant.
        pub async fn run(
            self,
            current_dir: Option<&str>,
            environment_variables: Option<&HashMap<String, String>>,
        ) -> io::Result<CommandOutput> {
            let git = Git {
                current_dir,
                environment_variables,
            };
            match self {
                Self::Branch => git.branch().await.map(Into::into),
                Self::BranchStatus => git.branch_status().await,
                Self::OtherBranches => git.other_branches().await.map(Into::into),
                Self::LineChanges => git
                    .run(&[
                        "-c",
                        "diff.autoRefreshIndex=false",
                        "diff",
                        "--shortstat",
                        "HEAD",
                    ])
                    .await
                    .map(Into::into),
            }
        }
    }

    struct Git<'a> {
        current_dir: Option<&'a str>,
        environment_variables: Option<&'a HashMap<String, String>>,
    }

    impl Git<'_> {
        /// Runs `git` with `args`. `Command` sets `CREATE_NO_WINDOW` on Windows, and dropping
        /// the future (the chip's timeout) kills the process.
        async fn run(&self, args: &[&str]) -> io::Result<Output> {
            let mut command = Command::new("git");
            command.args(args);
            if let Some(environment_variables) = self.environment_variables {
                command.envs(environment_variables);
            }
            command.env("GIT_OPTIONAL_LOCKS", "0");
            if let Some(current_dir) = self.current_dir {
                command.current_dir(current_dir);
            }
            command.kill_on_drop(true).output().await
        }

        /// `git symbolic-ref --short HEAD || git rev-parse --short HEAD`.
        async fn branch(&self) -> io::Result<Output> {
            let symbolic_ref = self.run(&["symbolic-ref", "--short", "HEAD"]).await?;
            if symbolic_ref.status.success() {
                return Ok(symbolic_ref);
            }
            self.run(&["rev-parse", "--short", "HEAD"]).await
        }

        async fn branch_status(&self) -> io::Result<CommandOutput> {
            let branch_output = self.branch().await?;
            if !branch_output.status.success() {
                return Ok(branch_output.into());
            }
            let branch = String::from_utf8_lossy(&branch_output.stdout)
                .trim_end()
                .to_owned();
            if branch.is_empty() {
                return Ok(CommandOutput {
                    stdout: Vec::new(),
                    stderr: branch_output.stderr,
                    status: CommandExitStatus::Failure,
                    exit_code: Some(ExitCode::from(1)),
                });
            }

            let counts = self
                .run(&[
                    "rev-list",
                    "--left-right",
                    "--cherry-mark",
                    "--count",
                    "HEAD...@{u}",
                ])
                .await?;
            let line = if counts.status.success() {
                format_branch_status(&branch, &String::from_utf8_lossy(&counts.stdout))
            } else {
                branch
            };
            Ok(CommandOutput {
                stdout: format!("{line}\n").into_bytes(),
                stderr: Vec::new(),
                status: CommandExitStatus::Success,
                exit_code: Some(ExitCode::from(0)),
            })
        }

        /// The branch list, a record separator line, then the worktree list. The exit status
        /// is the worktree command's, as with the shell variant.
        async fn other_branches(&self) -> io::Result<Output> {
            let branches = self
                .run(&[
                    "--no-optional-locks",
                    "branch",
                    "--no-color",
                    "--sort=-committerdate",
                ])
                .await?;
            let mut worktrees = self
                .run(&["--no-optional-locks", "worktree", "list", "--porcelain"])
                .await?;
            let mut stdout = branches.stdout;
            stdout.extend_from_slice(b"\x1e\n");
            stdout.append(&mut worktrees.stdout);
            worktrees.stdout = stdout;
            Ok(worktrees)
        }
    }
}
