//! A folder on this computer, zipped the way the dashboard's "Upload a folder"
//! expects it: every entry under the folder's own name, `node_modules` and `.git`
//! left out (see `zip_rules`). Mirrors `desktop/src/main/folder-zip.ts`.
//!
//! Walked here so skipped folders are pruned without being opened, and streamed:
//! each file is read in chunks straight into the zip, which is written to the
//! caller's writer (a file, or a buffer) and refused the moment it passes
//! `MAX_ZIP`, so neither the folder nor more than the ceiling is ever held.
//!
//! A link is followed only when it leads to somewhere inside the picked folder:
//! the zip is sent to a server, and a link to somewhere else on the disk would
//! send that too. Followed at all because Windows reports a file OneDrive keeps
//! online-only as a link. A link back into a folder it sits in, or to a folder
//! already walked through a link, is skipped, so a loop of links ends.

use crate::zip_rules::{
    folder_too_large, skipped, zip_too_large, EMPTY_FOLDER, MAX_FOLDER, MAX_ZIP,
};
use std::fs;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use zip::write::SimpleFileOptions;

/// Shown when the folder could not be read at all (as the Electron app's IPC says).
pub const UNREADABLE: &str = "Could not read that folder. Check that this app may open it.";

/// Why a folder was not zipped. `Display` is the sentence for the person who
/// picked it; an I/O failure keeps its cause for the log only.
#[derive(Debug, thiserror::Error)]
pub enum FolderError {
    #[error("{0}")]
    Refusal(String),
    #[error("{UNREADABLE}")]
    Io(#[from] io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderEntry {
    /// Inside the zip: `folder/src/index.ts`.
    pub path: String,
    pub file: PathBuf,
    pub size: u64,
    pub modified: Option<SystemTime>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZippedFolder {
    pub name: String,
    pub files: usize,
}

/// The folder's own name, as the zip's top entry.
pub fn folder_name(root: &Path) -> String {
    root.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

struct Walk {
    top: PathBuf,
    linked: Vec<PathBuf>,
    entries: Vec<FolderEntry>,
    total: u64,
}

impl Walk {
    fn add(&mut self, path: String, file: PathBuf, info: &fs::Metadata) -> Result<(), FolderError> {
        self.total = self.total.saturating_add(info.len());
        if self.total > MAX_FOLDER {
            return Err(FolderError::Refusal(folder_too_large()));
        }
        self.entries.push(FolderEntry {
            path,
            file,
            size: info.len(),
            modified: info.modified().ok(),
        });
        Ok(())
    }

    /// `chain` holds the real path of every folder on the way down, `dir`'s last.
    fn walk(&mut self, dir: &Path, prefix: &str, chain: &[PathBuf]) -> Result<(), FolderError> {
        let mut children: Vec<fs::DirEntry> = fs::read_dir(dir)?.collect::<Result<_, _>>()?;
        children.sort_by_key(fs::DirEntry::file_name);
        for entry in children {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = format!("{prefix}/{name}");
            if skipped(&path) {
                continue;
            }
            let file = entry.path();
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                let Ok(target) = fs::canonicalize(&file) else {
                    continue;
                };
                if !target.starts_with(&self.top) {
                    continue;
                }
                let info = fs::metadata(&target)?;
                if info.is_file() {
                    self.add(path, target, &info)?;
                } else if info.is_dir() {
                    let looped = chain.iter().any(|folder| folder.starts_with(&target));
                    if self.linked.contains(&target) || looped {
                        continue;
                    }
                    self.linked.push(target.clone());
                    let mut deeper = chain.to_vec();
                    deeper.push(target.clone());
                    self.walk(&target, &path, &deeper)?;
                }
            } else if kind.is_dir() {
                let parent = chain.last().unwrap_or(&self.top);
                let mut deeper = chain.to_vec();
                deeper.push(parent.join(&name));
                self.walk(&file, &path, &deeper)?;
            } else if kind.is_file() {
                let info = fs::symlink_metadata(&file)?;
                self.add(path, file, &info)?;
            }
        }
        Ok(())
    }
}

/// Every file that goes into the zip, refusing a folder that holds too much.
pub fn list_folder(root: &Path) -> Result<Vec<FolderEntry>, FolderError> {
    let name = folder_name(root);
    if skipped(&name) {
        return Err(FolderError::Refusal(EMPTY_FOLDER.to_owned()));
    }
    let top = fs::canonicalize(root)?;
    let mut walk = Walk {
        top: top.clone(),
        linked: Vec::new(),
        entries: Vec::new(),
        total: 0,
    };
    walk.walk(root, &name, &[top])?;
    if walk.entries.is_empty() {
        return Err(FolderError::Refusal(EMPTY_FOLDER.to_owned()));
    }
    Ok(walk.entries)
}

/// A writer that refuses to grow past `MAX_ZIP`.
struct Capped<W> {
    inner: W,
    position: u64,
    over: bool,
}

impl<W: Write> Write for Capped<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // Past the ceiling nothing more is written; the zip is refused after,
        // and what the writer still adds while it closes is let go quietly.
        if self.over || self.position.saturating_add(bytes.len() as u64) > MAX_ZIP {
            self.over = true;
            return Ok(bytes.len());
        }
        let written = self.inner.write(bytes)?;
        self.position += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl<W: Seek> Seek for Capped<W> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.position = self.inner.seek(to)?;
        Ok(self.position)
    }
}

/// A zip entry time from a file's: the zip format keeps no time zone, and this
/// writes UTC.
fn zip_time(modified: Option<SystemTime>) -> zip::DateTime {
    let seconds = modified
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_secs());
    let rest = seconds % 86_400;
    let (year, month, day) = crate::game_detect::civil(seconds / 86_400);
    let narrow = |value: u64| u8::try_from(value).unwrap_or(0);
    zip::DateTime::from_date_and_time(
        u16::try_from(year).unwrap_or(1980),
        narrow(month),
        narrow(day),
        narrow(rest / 3600),
        narrow(rest % 3600 / 60),
        narrow(rest % 60),
    )
    .unwrap_or_default()
}

/// The files, deflated into one zip written to `out` as it is made - never more
/// than `MAX_ZIP`. Answers the writer back, finished.
pub fn zip_entries<W: Write + Seek>(entries: &[FolderEntry], out: W) -> Result<W, FolderError> {
    let mut zip = zip::ZipWriter::new(Capped {
        inner: out,
        position: 0,
        over: false,
    });
    let too_large = || FolderError::Refusal(zip_too_large());
    let result = (|| -> Result<(), FolderError> {
        for entry in entries {
            let options = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .compression_level(Some(6))
                .last_modified_time(zip_time(entry.modified));
            zip.start_file(entry.path.as_str(), options)
                .map_err(io::Error::other)?;
            let mut file = fs::File::open(&entry.file)?;
            let mut chunk = vec![0u8; 64 * 1024];
            loop {
                let read = file.read(&mut chunk)?;
                if read == 0 {
                    break;
                }
                zip.write_all(&chunk[..read])?;
                if zip.get_ref().is_some_and(|capped| capped.over) {
                    return Ok(());
                }
            }
        }
        Ok(())
    })();
    if zip.get_ref().is_some_and(|capped| capped.over) {
        return Err(too_large());
    }
    result?;
    let finished = zip.finish();
    match finished {
        Ok(capped) if !capped.over => Ok(capped.inner),
        Ok(_) => Err(too_large()),
        Err(error) => Err(FolderError::Io(io::Error::other(error))),
    }
}

/// A picked folder, zipped into `out`.
pub fn zip_folder<W: Write + Seek>(root: &Path, out: W) -> Result<(ZippedFolder, W), FolderError> {
    let entries = list_folder(root)?;
    let out = zip_entries(&entries, out)?;
    Ok((
        ZippedFolder {
            name: folder_name(root),
            files: entries.len(),
        },
        out,
    ))
}
