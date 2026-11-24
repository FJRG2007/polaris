use crate::error::UserFacingError;
use crate::schema;

#[derive(cynic::QueryVariables, Debug)]
pub struct ListRookDevImagesVariables {}

#[derive(cynic::QueryFragment, Debug)]
#[cynic(graphql_type = "RootQuery", variables = "ListRookDevImagesVariables")]
pub struct ListRookDevImages {
    #[cynic(rename = "listRookDevImages")]
    pub list_rook_dev_images: ListRookDevImagesResult,
}

#[derive(cynic::QueryFragment, Debug, Clone)]
pub struct ListRookDevImagesOutput {
    pub images: Vec<ImageTag>,
}

#[derive(cynic::QueryFragment, Debug, Clone)]
pub struct ImageTag {
    pub image: String,
    pub repository: String,
    pub tag: String,
}

#[derive(cynic::InlineFragments, Debug)]
pub enum ListRookDevImagesResult {
    ListRookDevImagesOutput(ListRookDevImagesOutput),
    UserFacingError(UserFacingError),
    #[cynic(fallback)]
    Unknown,
}

crate::client::define_operation! {
    ListRookDevImages(ListRookDevImagesVariables) -> ListRookDevImages;
}
