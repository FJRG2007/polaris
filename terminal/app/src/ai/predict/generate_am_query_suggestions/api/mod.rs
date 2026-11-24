//! This module contains Rust types for the GenerateAMQuerySuggestions endpoint in rook-server that
//! serves Agent Mode.
//!
//! These types are manually transposed from the API schema defined in go
//! (rook-server/model/types/generate_am_query_suggestions/(request.go|response.go|common.go)).
//!
//! Documentation on the types here is directly borrowed from the documentation on the go schema;
//! see the go schema for the source-of-truth.
mod request;
mod response;

pub use request::*;
pub use response::*;
