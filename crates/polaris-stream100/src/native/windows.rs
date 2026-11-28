//! Windows: Core Audio sessions for per-app volume, SetupAPI and a process
//! snapshot for who holds the controller.
//!
//! Sessions are read from every active render endpoint, not only the default
//! one: an app routed to a headset or a virtual mixer (SteelSeries Sonar,
//! VoiceMeeter) plays on its own endpoint and would otherwise never be found.
//! A session id is `<endpoint id>|<session instance id>`, stable while the
//! session lives. COM objects stay on the thread that made them; the backend
//! is created and used on one thread.
//!
//! Each read of the sessions keeps every session's volume handle by id, and
//! the default output's, so a volume change is one call on a handle already
//! held instead of walking every output and session again. The handles are
//! replaced on the next read ([`crate::audio::Cached`] asks again at most
//! every [`crate::audio::AUDIO_FRESH`]); one that fails is dropped and looked
//! up afresh.

use crate::audio::{AudioError, AudioSessions, Session};
use crate::ownership::{Observed, STREAM_CONTROL_PROCESS};
use std::collections::HashMap;
use windows::core::{Interface, PCWSTR, PWSTR};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
    SetupDiGetDeviceInstanceIdW, SetupDiGetDeviceRegistryPropertyW, DIGCF_ALLCLASSES,
    DIGCF_PRESENT, SPDRP_SERVICE, SP_DEVINFO_DATA,
};
use windows::Win32::Foundation::{CloseHandle, S_OK};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use windows::Win32::Media::Audio::{
    eConsole, eRender, AudioSessionStateExpired, IAudioSessionControl2, IAudioSessionManager2,
    IMMDevice, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

fn backend(error: windows::core::Error) -> AudioError {
    AudioError::Backend(error.message())
}

unsafe fn take(text: PWSTR) -> String {
    let out = text.to_string().unwrap_or_default();
    CoTaskMemFree(Some(text.0 as _));
    out
}

fn process_name(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buffer[..size as usize]);
        path.rsplit('\\').next().unwrap_or(&path).to_owned()
    }
}

pub struct CoreAudio {
    enumerator: IMMDeviceEnumerator,
    /// Each session's volume, by session id, from the last read.
    volumes: HashMap<String, ISimpleAudioVolume>,
    /// The default output's volume, until the next read of the sessions.
    output: Option<IAudioEndpointVolume>,
    /// Each session's peak meter, by session id, from the last read.
    meters: HashMap<String, IAudioMeterInformation>,
    /// The default output's peak meter, until the next read of the sessions.
    output_meter: Option<IAudioMeterInformation>,
}

impl CoreAudio {
    pub fn open() -> Result<Self, AudioError> {
        unsafe {
            // Already initialised on this thread in another mode is fine.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let enumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(backend)?;
            Ok(Self {
                enumerator,
                volumes: HashMap::new(),
                output: None,
                meters: HashMap::new(),
                output_meter: None,
            })
        }
    }

    fn endpoints(&self) -> Result<Vec<(String, IMMDevice)>, AudioError> {
        unsafe {
            let devices = self
                .enumerator
                .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
                .map_err(backend)?;
            let mut out = Vec::new();
            for index in 0..devices.GetCount().map_err(backend)? {
                let device = devices.Item(index).map_err(backend)?;
                out.push((take(device.GetId().map_err(backend)?), device));
            }
            Ok(out)
        }
    }

    /// The session's volume handle: the one kept from the last read, or
    /// looked up now (and kept).
    fn volume(&mut self, id: &str) -> Result<ISimpleAudioVolume, AudioError> {
        if let Some(simple) = self.volumes.get(id) {
            return Ok(simple.clone());
        }
        let simple = self.volume_of(id)?;
        self.volumes.insert(id.to_owned(), simple.clone());
        Ok(simple)
    }

    /// Runs `change` on the session's kept handle; when that handle fails
    /// (the session or its output went away), once more on a fresh lookup.
    fn on_session(
        &mut self,
        id: &str,
        change: impl Fn(&ISimpleAudioVolume) -> windows::core::Result<()>,
    ) -> Result<(), AudioError> {
        if change(&self.volume(id)?).is_ok() {
            return Ok(());
        }
        self.volumes.remove(id);
        change(&self.volume(id)?).map_err(backend)
    }

    /// The default output's volume handle, kept until the next read.
    fn on_output<T>(
        &mut self,
        use_it: impl Fn(&IAudioEndpointVolume) -> windows::core::Result<T>,
    ) -> Result<T, AudioError> {
        if let Some(output) = &self.output {
            if let Ok(value) = use_it(output) {
                return Ok(value);
            }
        }
        let output = self.output()?;
        let value = use_it(&output).map_err(backend);
        self.output = value.is_ok().then_some(output);
        value
    }

    fn volume_of(&self, id: &str) -> Result<ISimpleAudioVolume, AudioError> {
        let (endpoint, instance) = id.split_once('|').ok_or(AudioError::Gone)?;
        unsafe {
            for (endpoint_id, device) in self.endpoints()? {
                if endpoint_id != endpoint {
                    continue;
                }
                let manager: IAudioSessionManager2 =
                    device.Activate(CLSCTX_ALL, None).map_err(backend)?;
                let sessions = manager.GetSessionEnumerator().map_err(backend)?;
                for index in 0..sessions.GetCount().map_err(backend)? {
                    let control = sessions.GetSession(index).map_err(backend)?;
                    let control2: IAudioSessionControl2 = control.cast().map_err(backend)?;
                    if take(control2.GetSessionInstanceIdentifier().map_err(backend)?) == instance {
                        return control.cast().map_err(backend);
                    }
                }
            }
        }
        Err(AudioError::Gone)
    }

    fn output(&self) -> Result<IAudioEndpointVolume, AudioError> {
        unsafe {
            let device = self
                .enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(backend)?;
            device.Activate(CLSCTX_ALL, None).map_err(backend)
        }
    }
}

fn scalar(volume: u8) -> f32 {
    f32::from(volume.min(100)) / 100.0
}

fn percent(level: f32) -> u8 {
    (level.clamp(0.0, 1.0) * 100.0).round() as u8
}

impl AudioSessions for CoreAudio {
    fn sessions(&mut self) -> Result<Vec<Session>, AudioError> {
        let mut out = Vec::new();
        let mut volumes = HashMap::new();
        let mut meters = HashMap::new();
        // The default output may have changed since: look it up again on use.
        self.output = None;
        self.output_meter = None;
        unsafe {
            for (endpoint, device) in self.endpoints()? {
                let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else {
                    continue;
                };
                let sessions = manager.GetSessionEnumerator().map_err(backend)?;
                for index in 0..sessions.GetCount().map_err(backend)? {
                    let control = sessions.GetSession(index).map_err(backend)?;
                    if control.GetState().map_err(backend)? == AudioSessionStateExpired {
                        continue;
                    }
                    let control2: IAudioSessionControl2 = control.cast().map_err(backend)?;
                    let simple: ISimpleAudioVolume = control.cast().map_err(backend)?;
                    let pid = control2.GetProcessId().unwrap_or(0);
                    let system = control2.IsSystemSoundsSession() == S_OK;
                    let instance = take(control2.GetSessionInstanceIdentifier().map_err(backend)?);
                    let id = format!("{endpoint}|{instance}");
                    volumes.insert(id.clone(), simple.clone());
                    if let Ok(meter) = control.cast::<IAudioMeterInformation>() {
                        meters.insert(id.clone(), meter);
                    }
                    out.push(Session {
                        id,
                        program: if system {
                            String::new()
                        } else {
                            process_name(pid)
                        },
                        pid,
                        system,
                        volume: percent(simple.GetMasterVolume().map_err(backend)?),
                        muted: simple.GetMute().map_err(backend)?.as_bool(),
                    });
                }
            }
        }
        self.volumes = volumes;
        self.meters = meters;
        Ok(out)
    }

    fn peaks(&mut self) -> Result<Vec<(String, f32)>, AudioError> {
        // SAFETY: COM calls on live meter handles; a session that went away
        // since answers an error and is left out.
        Ok(self
            .meters
            .iter()
            .filter_map(|(id, meter)| {
                unsafe { meter.GetPeakValue() }
                    .ok()
                    .map(|peak| (id.clone(), peak))
            })
            .collect())
    }

    fn output_peak(&mut self) -> Result<Option<f32>, AudioError> {
        if self.output_meter.is_none() {
            // SAFETY: COM calls on the live device enumerator.
            self.output_meter = unsafe {
                self.enumerator
                    .GetDefaultAudioEndpoint(eRender, eConsole)
                    .and_then(|device| device.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None))
                    .ok()
            };
        }
        // SAFETY: a COM call on a live meter handle.
        Ok(self
            .output_meter
            .as_ref()
            .and_then(|meter| unsafe { meter.GetPeakValue() }.ok()))
    }

    fn set_volume(&mut self, id: &str, volume: u8) -> Result<(), AudioError> {
        // SAFETY: a COM call on a live session volume handle.
        self.on_session(id, |simple| unsafe {
            simple.SetMasterVolume(scalar(volume), std::ptr::null())
        })
    }

    fn set_muted(&mut self, id: &str, muted: bool) -> Result<(), AudioError> {
        // SAFETY: a COM call on a live session volume handle.
        self.on_session(id, |simple| unsafe {
            simple.SetMute(muted, std::ptr::null())
        })
    }

    fn output_volume(&mut self) -> Result<(u8, bool), AudioError> {
        // SAFETY: COM calls on a live endpoint volume handle.
        self.on_output(|output| unsafe {
            let level = output.GetMasterVolumeLevelScalar()?;
            let muted = output.GetMute()?.as_bool();
            Ok((percent(level), muted))
        })
    }

    fn set_output_volume(&mut self, volume: u8) -> Result<(), AudioError> {
        // SAFETY: a COM call on a live endpoint volume handle.
        self.on_output(|output| unsafe {
            output.SetMasterVolumeLevelScalar(scalar(volume), std::ptr::null())
        })
    }

    fn set_output_muted(&mut self, muted: bool) -> Result<(), AudioError> {
        // SAFETY: a COM call on a live endpoint volume handle.
        self.on_output(|output| unsafe { output.SetMute(muted, std::ptr::null()) })
    }
}

fn wide_to_string(wide: &[u16]) -> String {
    let end = wide.iter().position(|c| *c == 0).unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..end])
}

/// The service bound to the controller's device node, read-only; `None` for
/// the service when the node has none, and `present: false` when no node of
/// the controller is plugged in.
fn device_service() -> (bool, Option<String>) {
    let wanted = format!(
        "USB\\VID_{:04X}&PID_{:04X}\\",
        crate::VENDOR_ID,
        crate::PRODUCT_ID
    );
    unsafe {
        let Ok(set) =
            SetupDiGetClassDevsW(None, PCWSTR::null(), None, DIGCF_PRESENT | DIGCF_ALLCLASSES)
        else {
            return (false, None);
        };
        let mut result = (false, None);
        let mut index = 0;
        loop {
            let mut data = SP_DEVINFO_DATA {
                cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
                ..Default::default()
            };
            if SetupDiEnumDeviceInfo(set, index, &mut data).is_err() {
                break;
            }
            index += 1;
            let mut id = [0u16; 512];
            if SetupDiGetDeviceInstanceIdW(set, &data, Some(&mut id), None).is_err() {
                continue;
            }
            // The device itself, not one of its interfaces (`&MI_xx`).
            if !wide_to_string(&id)
                .to_ascii_uppercase()
                .starts_with(&wanted)
            {
                continue;
            }
            let mut service = [0u8; 512];
            let named = SetupDiGetDeviceRegistryPropertyW(
                set,
                &data,
                SPDRP_SERVICE,
                None,
                Some(&mut service),
                None,
            )
            .is_ok();
            let wide: Vec<u16> = service
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            result = (
                true,
                named
                    .then(|| wide_to_string(&wide))
                    .filter(|s| !s.is_empty()),
            );
            break;
        }
        let _ = SetupDiDestroyDeviceInfoList(set);
        result
    }
}

pub(crate) fn stream_control_running() -> bool {
    let wanted = format!("{}.exe", STREAM_CONTROL_PROCESS).to_ascii_lowercase();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return false;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = false;
        let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
        while more {
            if wide_to_string(&entry.szExeFile).to_ascii_lowercase() == wanted {
                found = true;
                break;
            }
            more = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
        found
    }
}

pub fn observe() -> Observed {
    let (present, service) = device_service();
    Observed {
        os: "windows".into(),
        service,
        stream_control_running: present && stream_control_running(),
        present,
    }
}
