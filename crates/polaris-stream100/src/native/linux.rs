//! Linux: per-app volume over the PulseAudio protocol, which PipeWire serves
//! too (`pipewire-pulse`), spoken natively over its socket - no libpulse and
//! no `pactl` process. Sessions are sink inputs; the output is the default sink.

use crate::audio::{AudioError, AudioSessions, Session};
use crate::ownership::Observed;
use pulseaudio::protocol::{self, ChannelVolume, Command, Prop, Volume};
use std::ffi::CString;
use std::io::BufReader;
use std::os::unix::net::UnixStream;

fn backend(error: impl ToString) -> AudioError {
    AudioError::Backend(error.to_string())
}

pub struct Pulse {
    socket: BufReader<UnixStream>,
    version: u16,
    sequence: u32,
}

fn level(volume: &ChannelVolume) -> u8 {
    let loudest = volume
        .channels()
        .iter()
        .map(Volume::as_u32)
        .max()
        .unwrap_or(0);
    (u64::from(loudest) * 100 / u64::from(Volume::NORM.as_u32())).min(100) as u8
}

fn scaled(channels: usize, percent: u8) -> ChannelVolume {
    let raw = u64::from(Volume::NORM.as_u32()) * u64::from(percent.min(100)) / 100;
    let mut volume = ChannelVolume::empty();
    for _ in 0..channels.max(1) {
        volume.push(Volume::from_u32_clamped(raw as u32));
    }
    volume
}

fn text(bytes: Option<&[u8]>) -> String {
    let bytes = bytes.unwrap_or_default();
    let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

impl Pulse {
    pub fn open() -> Result<Self, AudioError> {
        let path = pulseaudio::socket_path_from_env().ok_or(AudioError::Unsupported)?;
        let stream = UnixStream::connect(path).map_err(|_| AudioError::Unsupported)?;
        let mut pulse = Self {
            socket: BufReader::new(stream),
            version: protocol::MAX_VERSION,
            sequence: 0,
        };
        let cookie = pulseaudio::cookie_path_from_env()
            .and_then(|path| std::fs::read(path).ok())
            .unwrap_or_default();
        let auth = protocol::AuthParams {
            version: protocol::MAX_VERSION,
            supports_shm: false,
            supports_memfd: false,
            cookie,
        };
        let reply: protocol::AuthReply = pulse.request(&Command::Auth(auth))?;
        pulse.version = protocol::MAX_VERSION.min(reply.version);
        let mut props = protocol::Props::new();
        props.set(
            Prop::ApplicationName,
            CString::new("Polaris").unwrap_or_default(),
        );
        let _: protocol::SetClientNameReply = pulse.request(&Command::SetClientName(props))?;
        Ok(pulse)
    }

    fn send(&mut self, command: &Command) -> Result<(), AudioError> {
        self.sequence = self.sequence.wrapping_add(1);
        protocol::write_command_message(self.socket.get_mut(), self.sequence, command, self.version)
            .map_err(backend)
    }

    fn request<T: protocol::CommandReply>(&mut self, command: &Command) -> Result<T, AudioError> {
        self.send(command)?;
        let (_, reply) =
            protocol::read_reply_message::<T>(&mut self.socket, self.version).map_err(backend)?;
        Ok(reply)
    }

    fn ack(&mut self, command: &Command) -> Result<(), AudioError> {
        self.send(command)?;
        protocol::read_ack_message(&mut self.socket)
            .map(|_| ())
            .map_err(backend)
    }

    fn index(id: &str) -> Result<u32, AudioError> {
        id.parse().map_err(|_| AudioError::Gone)
    }

    fn default_sink(&mut self) -> Result<protocol::SinkInfo, AudioError> {
        let server: protocol::ServerInfo = self.request(&Command::GetServerInfo)?;
        let name = server.default_sink_name.ok_or(AudioError::Gone)?;
        self.request(&Command::GetSinkInfo(protocol::GetSinkInfo {
            index: None,
            name: Some(name),
        }))
    }
}

impl AudioSessions for Pulse {
    fn sessions(&mut self) -> Result<Vec<Session>, AudioError> {
        let inputs: protocol::SinkInputInfoList = self.request(&Command::GetSinkInputInfoList)?;
        Ok(inputs
            .into_iter()
            .filter(|input| input.has_volume)
            .map(|input| {
                let binary = text(input.props.get(Prop::ApplicationProcessBinary));
                let program = if binary.is_empty() {
                    text(input.props.get(Prop::ApplicationName))
                } else {
                    binary
                };
                Session {
                    id: input.index.to_string(),
                    pid: text(input.props.get(Prop::ApplicationProcessId))
                        .parse()
                        .unwrap_or(0),
                    system: text(input.props.get(Prop::MediaRole)) == "event",
                    volume: level(&input.cvolume),
                    muted: input.muted,
                    program,
                }
            })
            .collect())
    }

    fn set_volume(&mut self, id: &str, volume: u8) -> Result<(), AudioError> {
        let index = Self::index(id)?;
        let input: protocol::SinkInputInfo = self.request(&Command::GetSinkInputInfo(index))?;
        let volume = scaled(input.cvolume.channels().len(), volume);
        self.ack(&Command::SetSinkInputVolume(
            protocol::SetStreamVolumeParams { index, volume },
        ))
    }

    fn set_muted(&mut self, id: &str, muted: bool) -> Result<(), AudioError> {
        let index = Self::index(id)?;
        self.ack(&Command::SetSinkInputMute(protocol::SetStreamMuteParams {
            index,
            mute: muted,
        }))
    }

    fn output_volume(&mut self) -> Result<(u8, bool), AudioError> {
        let sink = self.default_sink()?;
        Ok((level(&sink.cvolume), sink.muted))
    }

    fn set_output_volume(&mut self, volume: u8) -> Result<(), AudioError> {
        let sink = self.default_sink()?;
        let volume = scaled(sink.cvolume.channels().len(), volume);
        self.ack(&Command::SetSinkVolume(protocol::SetDeviceVolumeParams {
            device_index: Some(sink.index),
            device_name: None,
            volume,
        }))
    }

    fn set_output_muted(&mut self, muted: bool) -> Result<(), AudioError> {
        let sink = self.default_sink()?;
        self.ack(&Command::SetSinkMute(protocol::SetDeviceMuteParams {
            device_index: Some(sink.index),
            device_name: None,
            mute: muted,
        }))
    }
}

/// On Linux only a udev rule stands between Polaris and the device.
pub fn observe() -> Observed {
    Observed {
        os: "linux".into(),
        present: true,
        ..Default::default()
    }
}
