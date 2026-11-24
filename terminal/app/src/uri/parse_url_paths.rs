use url::Url;

use crate::ChannelState;
use crate::cloud_object::extract_server_id_and_object_type_from_rook_drive_link;
use crate::drive::OpenRookDriveObjectArgs;

#[derive(PartialEq, Debug)]
pub enum RookWebLink {
    Session,
    DriveObject(Box<OpenRookDriveObjectArgs>),
}

pub fn get_item_data_from_rook_link(url: &Url) -> Option<RookWebLink> {
    if url.origin() == ChannelState::server_root_domain() {
        url.path_segments().and_then(|mut path_segments| {
            path_segments.next().and_then(|segment| match segment {
                "drive" => extract_server_id_and_object_type_from_rook_drive_link(url)
                    .map(|args| RookWebLink::DriveObject(Box::new(args))),
                "session" => Some(RookWebLink::Session),
                _ => None,
            })
        })
    } else {
        None
    }
}
