use url::Url;

use crate::ChannelState;
use crate::cloud_object::extract_server_id_and_object_type_from_pterm_drive_link;
use crate::drive::OpenPtermDriveObjectArgs;

#[derive(PartialEq, Debug)]
pub enum PtermWebLink {
    Session,
    DriveObject(Box<OpenPtermDriveObjectArgs>),
}

pub fn get_item_data_from_pterm_link(url: &Url) -> Option<PtermWebLink> {
    if url.origin() == ChannelState::server_root_domain() {
        url.path_segments().and_then(|mut path_segments| {
            path_segments.next().and_then(|segment| match segment {
                "drive" => extract_server_id_and_object_type_from_pterm_drive_link(url)
                    .map(|args| PtermWebLink::DriveObject(Box::new(args))),
                "session" => Some(PtermWebLink::Session),
                _ => None,
            })
        })
    } else {
        None
    }
}
