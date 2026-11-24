//! Tips for cloud mode loading screen.

use ptermui::AppContext;
use ptermui::keymap::Keystroke;

use crate::ai::agent_tips::AITip;

/// A cloud mode tip with text and optional link.
#[derive(Clone, Debug)]
pub struct CloudModeTip {
    text: String,
    link: Option<String>,
}

impl CloudModeTip {
    pub fn new(text: impl Into<String>, link: Option<impl Into<String>>) -> Self {
        Self {
            text: text.into(),
            link: link.map(|l| l.into()),
        }
    }
}

impl AITip for CloudModeTip {
    fn keystroke(&self, _app: &AppContext) -> Option<Keystroke> {
        None
    }

    fn link(&self) -> Option<String> {
        self.link.clone()
    }

    fn description(&self) -> &str {
        &self.text
    }

    // Uses the default implementation which adds "Tip: " prefix and parses backticks as inline code
}

/// Returns a collection of tips for the cloud mode loading screen.
pub fn get_cloud_mode_tips() -> Vec<CloudModeTip> {
    vec![
        CloudModeTip::new(
            "Install the Oz Slack integration to trigger agents from any channel or DM.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Build programmatic agents using Oz's TypeScript and Python SDKs.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Set team or personal secrets for agents using the `oz secret` command.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "View all your agent runs and their status in the Oz web app.",
            Some("https://oz.polaris-terminal.invalid"),
        ),
        CloudModeTip::new(
            "Join any Oz cloud agent run in real-time using Agent Session Sharing.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Set up recurring agents that run on cron schedules for automated maintenance.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Create agents that automatically fix bugs when issues are filed in Linear.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Build agents that respond to CI failures and attempt automatic fixes.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Run agents from GitHub Actions using the `oz-agent-action`.",
            Some("https://github.com/warpdotdev/oz-agent-action"),
        ),
        CloudModeTip::new(
            "Call the Oz REST API to trigger agents from any backend service or internal tool.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Create reusable environments with Docker images for consistent agent execution.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Share agent session links with your team for collaborative debugging.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Use the `--share` flag with the Oz CLI to enable session sharing from anywhere.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Fork a completed Oz cloud agent session into Polaris Terminal to continue the work locally.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Build internal tools that use agents to answer questions from your databases.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Create a scheduled agent to clean up stale feature flags every week.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Tag @Oz in Linear issues to automatically investigate and propose fixes.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Run agents on remote dev boxes or CI runners using the Oz CLI.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Configure MCP servers to give Oz cloud agents access to GitHub, Linear, and Sentry.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Use `oz agent run` to kick off tasks without opening the Polaris Terminal terminal.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "View your teammates' agent runs in the Oz web app for shared visibility.",
            Some("https://oz.polaris-terminal.invalid"),
        ),
        CloudModeTip::new(
            "Build agents that automatically triage and label incoming GitHub issues.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Set up an agent to generate daily summaries of newly opened issues.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Create an agent that automatically reviews PRs and suggests improvements.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Use `oz environment create` to define reproducible execution contexts.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Trigger agents from webhooks to respond to production incidents.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Build an agent that restarts services or scales deployments when alerts fire.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Use personal secrets for credentials that should only be used by your agents.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Use team secrets for shared infrastructure credentials across all agents.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Create an agent that runs nightly to check for dependency updates.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Build an agent that automatically formats and lints code on a schedule.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Use `oz schedule create` to set up cron-triggered agents.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Pause and resume scheduled agents without deleting them using `oz schedule pause`.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Use `oz mcp list` to see which MCP servers are available to your agents.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Build an internal Slack bot that delegates coding tasks to Oz agents.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Create an agent that responds to @mentions in Slack threads with full context.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Use the Oz TypeScript SDK to build custom automation pipelines.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Use the Oz Python SDK to integrate agents into your data pipelines.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Monitor agent success rates and runtimes using the Oz API.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
        CloudModeTip::new(
            "Build a dashboard that tracks all agent activity across your team.",
            Some("https://github.com/FJRG2007/polaris/tree/main/terminal#readme"),
        ),
    ]
}
