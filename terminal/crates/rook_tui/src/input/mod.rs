//! TUI input view.
//!
//! The key types are:
//! - [`view::TuiInputView`] — ratatui-rendered view implementing [`TuiView`], backed
//!   by a [`rook::editor::CodeEditorModel`] in char-cell mode
//! - [`view::TuiInputViewEvent`] — events emitted by the view (e.g. `Submitted`)
//!
//! TUI-specific prompt policy lives on the view.

pub mod view;
pub use view::{TuiInputView, TuiInputViewEvent, init};
