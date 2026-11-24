use ptermui::elements::MouseStateHandle;
use ptermui::{AppContext, Element};

use super::{PtermDriveItem, PtermDriveItemId};
use crate::appearance::Appearance;
use crate::cloud_object::CloudObjectMetadata;
use crate::drive::DriveObjectType;
use crate::drive::index::DriveIndexAction;
use crate::server::ids::ClientId;
use crate::themes::theme::Fill;

#[derive(Clone)]
pub struct PtermDriveMCPServerCollection {
    id: ClientId,
}

impl PtermDriveMCPServerCollection {
    pub fn new(id: ClientId) -> Self {
        Self { id }
    }

    pub fn id(&self) -> ClientId {
        self.id
    }
}

impl PtermDriveItem for PtermDriveMCPServerCollection {
    fn display_name(&self) -> Option<String> {
        Some("MCP Servers".to_string())
    }

    fn metadata(&self) -> Option<&CloudObjectMetadata> {
        None
    }

    fn object_type(&self) -> Option<DriveObjectType> {
        Some(DriveObjectType::MCPServerCollection)
    }

    fn secondary_icon(&self, _color: Option<Fill>) -> Option<Box<dyn Element>> {
        None
    }

    fn click_action(&self) -> Option<DriveIndexAction> {
        Some(DriveIndexAction::OpenMCPServerCollection)
    }

    fn preview(&self, _appearance: &Appearance) -> Option<Box<dyn Element>> {
        None
    }

    fn pterm_drive_id(&self) -> PtermDriveItemId {
        PtermDriveItemId::MCPServerCollection
    }

    fn sync_status_icon(
        &self,
        _sync_queue_is_dequeueing: bool,
        _hover_state: MouseStateHandle,
        _appearance: &Appearance,
    ) -> Option<Box<dyn Element>> {
        None
    }

    fn action_summary(&self, _app: &AppContext) -> Option<String> {
        None
    }

    fn clone_box(&self) -> Box<dyn PtermDriveItem> {
        Box::new(self.clone())
    }
}
