use crate::channel::ChannelState;

pub const USER_DOCS_URL: &str = "https://docs.rook.dev/";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const GITHUB_ISSUES_URL: &str = "https://github.com/FJRG2007/rook/issues";
pub const DISCORD_URL: &str = "https://tpe.li/dsc";
pub const PRIVACY_POLICY_URL: &str = "https://www.rook.dev/privacy";

pub fn feedback_form_url() -> String {
    let mut url = url::Url::parse("https://github.com/FJRG2007/rook/issues/new/choose")
        .expect("Should not fail to parse");
    if let Some(version) = ChannelState::app_version() {
        url.query_pairs_mut().append_pair("rook-version", version);
    }
    url.query_pairs_mut()
        .append_pair("os-version", &os_info::get().version().to_string());
    url.to_string()
}
