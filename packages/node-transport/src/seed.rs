//! The cloud-init NoCloud seed: a small FAT image labelled `CIDATA` holding
//! `meta-data`, `user-data` and `network-config`. cubed builds the documents;
//! the runner only writes them, so runner hosts need no genisoimage/hdiutil.
use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::journal::hex;

/// Upper bound for the three documents together.
pub const MAX_SEED_BYTES: usize = 64 * 1024;
const IMAGE_BYTES: usize = 2 * 1024 * 1024;
pub const LABEL: &[u8; 11] = b"CIDATA     ";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Seed {
    pub meta_data: String,
    pub user_data: String,
    pub network_config: String,
}

impl Seed {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.meta_data.len() + self.user_data.len() + self.network_config.len()
                <= MAX_SEED_BYTES,
            "seed exceeds {MAX_SEED_BYTES} bytes"
        );
        ensure!(
            !self.meta_data.is_empty() && !self.user_data.is_empty(),
            "seed needs meta-data and user-data"
        );
        Ok(())
    }

    /// The first start's seed is kept for the VM's life; later seeds are
    /// ignored (cloud-init does not rerun for the same instance-id anyway).
    pub fn sha256(&self) -> String {
        let mut hasher = Sha256::new();
        for document in [&self.meta_data, &self.user_data, &self.network_config] {
            hasher.update((document.len() as u64).to_be_bytes());
            hasher.update(document.as_bytes());
        }
        hex(&hasher.finalize())
    }

    pub fn image(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut disk = Cursor::new(vec![0u8; IMAGE_BYTES]);
        fatfs::format_volume(
            &mut disk,
            fatfs::FormatVolumeOptions::new()
                .volume_label(*LABEL)
                .fat_type(fatfs::FatType::Fat12),
        )?;
        {
            let fs = fatfs::FileSystem::new(&mut disk, fatfs::FsOptions::new())?;
            {
                let root = fs.root_dir();
                for (name, body) in [
                    ("meta-data", &self.meta_data),
                    ("user-data", &self.user_data),
                    ("network-config", &self.network_config),
                ] {
                    if name == "network-config" && body.is_empty() {
                        continue;
                    }
                    let mut file = root.create_file(name)?;
                    file.truncate()?;
                    file.write_all(body.as_bytes())?;
                    file.flush()?;
                }
            }
            fs.unmount()?;
        }
        Ok(disk.into_inner())
    }

    /// Writes `seed.img` atomically (0600).
    pub fn write(&self, path: &Path) -> Result<()> {
        let image = self.image()?;
        let temporary = path.with_extension("img.tmp");
        let _ = fs::remove_file(&temporary);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(&image)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        if let Some(parent) = path.parent() {
            File::open(parent)?.sync_all()?;
        }
        Ok(())
    }
}

/// Reads one file back from a seed image (tests and diagnostics).
pub fn read_file(image: &[u8], name: &str) -> Result<Option<String>> {
    let fs = fatfs::FileSystem::new(Cursor::new(image.to_vec()), fatfs::FsOptions::new())?;
    let mut file = match fs.root_dir().open_file(name) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(Some(text))
}

pub fn volume_label(image: &[u8]) -> Result<String> {
    let fs = fatfs::FileSystem::new(Cursor::new(image.to_vec()), fatfs::FsOptions::new())?;
    Ok(fs.volume_label())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed() -> Seed {
        Seed {
            meta_data: "instance-id: 0123456789abcdef\nlocal-hostname: cube-01234567\n".into(),
            user_data: format!("#cloud-config\n{}\n", "# padding\n".repeat(2000)),
            network_config:
                "version: 2\nethernets:\n  nic:\n    match: {name: \"e*\"}\n    dhcp4: true\n"
                    .into(),
        }
    }

    #[test]
    fn round_trip() {
        let seed = seed();
        let image = seed.image().unwrap();
        assert_eq!(image.len(), IMAGE_BYTES);
        assert_eq!(volume_label(&image).unwrap(), "CIDATA");
        assert_eq!(
            read_file(&image, "meta-data").unwrap().unwrap(),
            seed.meta_data
        );
        assert_eq!(
            read_file(&image, "user-data").unwrap().unwrap(),
            seed.user_data
        );
        assert_eq!(
            read_file(&image, "network-config").unwrap().unwrap(),
            seed.network_config
        );
        assert_eq!(read_file(&image, "vendor-data").unwrap(), None);
        // Deterministic: the same documents give the same image and hash.
        assert_eq!(image, seed.image().unwrap());
        assert_eq!(seed.sha256(), seed.clone().sha256());
        let mut other = seed.clone();
        other.user_data.push('x');
        assert_ne!(other.sha256(), seed.sha256());
    }

    #[test]
    fn limits() {
        let mut big = seed();
        big.user_data = "x".repeat(MAX_SEED_BYTES);
        assert!(big.image().is_err());
        let mut empty = seed();
        empty.user_data.clear();
        assert!(empty.validate().is_err());
        let mut no_network = seed();
        no_network.network_config.clear();
        let image = no_network.image().unwrap();
        assert_eq!(read_file(&image, "network-config").unwrap(), None);
    }
}
