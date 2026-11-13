//! Holding the call's keys system-wide while a window is in a call
//! (`desktop/src/main/call-hotkeys.ts`), through
//! `tauri-plugin-global-shortcut`.
//!
//! One window holds them at a time - the one that asked last - because two
//! holders of the same key would each toggle and a press would undo itself.
//! They are let go when that window says the call ended or closes.

use polaris_client::hotkeys::{
    call_accelerators, shortcut_spelling, CallHotkeys, CallHotkeysResult,
};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// The event a press is handed to the holding window under, with `"mic"` or
/// `"deafen"`.
pub const CALL_HOTKEY_EVENT: &str = "polaris://call-hotkey";

/// Which window holds the keys, and the accelerators it holds.
#[derive(Default)]
pub struct CallKeys(Mutex<Option<(String, Vec<String>)>>);

fn release(app: &AppHandle, keys: &CallKeys) {
    let held = keys
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    for accelerator in held.map(|(_, held)| held).unwrap_or_default() {
        // Already gone with the window.
        let _ = app.global_shortcut().unregister(accelerator.as_str());
    }
}

/// Take the keys for `window`, or let them go with `null`. Says which controls
/// the system gave: a key another program already holds is not taken.
#[tauri::command]
pub fn set_call_hotkeys(
    app: AppHandle,
    window: WebviewWindow,
    keys: State<'_, CallKeys>,
    input: Option<CallHotkeys>,
) -> Result<CallHotkeysResult, String> {
    let label = window.label().to_owned();
    let holder = keys
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .map(|(holder, _)| holder.clone());
    if input.is_none() && holder.as_ref().is_some_and(|holder| *holder != label) {
        return Ok(CallHotkeysResult::default());
    }
    release(&app, &keys);
    let Some(input) = input else {
        return Ok(CallHotkeysResult::default());
    };
    let input = input.checked().map_err(str::to_owned)?;
    let mut result = CallHotkeysResult::default();
    let mut held = Vec::new();
    for (accelerator, which) in call_accelerators(&input) {
        let spelling = shortcut_spelling(&accelerator);
        let target = label.clone();
        let taken = app
            .global_shortcut()
            .on_shortcut(spelling.as_str(), move |app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = app.emit_to(target.as_str(), CALL_HOTKEY_EVENT, which);
                }
            })
            .is_ok();
        if !taken {
            continue;
        }
        held.push(spelling);
        match which {
            polaris_client::hotkeys::CallHotkey::Mic => result.mic = true,
            polaris_client::hotkeys::CallHotkey::Deafen => result.deafen = true,
        }
    }
    *keys
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((label.clone(), held));
    // A window that closes mid-call leaves nobody to hear.
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let keys = handle.state::<CallKeys>();
            let holds = keys
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_ref()
                .is_some_and(|(holder, _)| *holder == label);
            if holds {
                release(&handle, &keys);
            }
        }
    });
    Ok(result)
}
