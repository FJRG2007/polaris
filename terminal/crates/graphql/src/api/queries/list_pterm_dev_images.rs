use crate::error::UserFacingError;
use crate::schema;

#[derive(cynic::QueryVariables, Debug)]
pub struct ListPtermDevImagesVariables {}

#[derive(cynic::QueryFragment, Debug)]
#[cynic(graphql_type = "RootQuery", variables = "ListPtermDevImagesVariables")]
pub struct ListPtermDevImages {
    #[cynic(rename = "listPtermDevImages")]
    pub list_pterm_dev_images: ListPtermDevImagesResult,
}

#[derive(cynic::QueryFragment, Debug, Clone)]
pub struct ListPtermDevImagesOutput {
    pub images: Vec<ImageTag>,
}

#[derive(cynic::QueryFragment, Debug, Clone)]
pub struct ImageTag {
    pub image: String,
    pub repository: String,
    pub tag: String,
}

#[derive(cynic::InlineFragments, Debug)]
pub enum ListPtermDevImagesResult {
    ListPtermDevImagesOutput(ListPtermDevImagesOutput),
    UserFacingError(UserFacingError),
    #[cynic(fallback)]
    Unknown,
}

crate::client::define_operation! {
    ListPtermDevImages(ListPtermDevImagesVariables) -> ListPtermDevImages;
}
