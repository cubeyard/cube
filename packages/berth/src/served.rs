//! Which image a `berth vm` directory serves, so that leaving `--image` out
//! (cube's default) never moves a runner off an image its operator chose.
//! Moving one takes `--change-image`, on `berth vm` or once by `berth image
//! check`; machines keep their layers either way, and nothing is deleted.
//!
//! ```text
//! DIRECTORY/.berth/served.json   {"version":1,"reference":"default"|"<registry/repository@sha256:…>"}
//! ```
//!
//! berth writes the record each time it serves (after the image is pulled
//! and prepared). A directory an earlier berth served has no record; then
//! the images pulled into it (`images/*.json`) say what it served.
//!
//! One kind of image moves without the flag: official Debian alone
//! (`docker.io/library/debian`), which lacks sudo, git, gh, curl and a CA
//! bundle, so keel never called a machine on it ready. A runner an earlier
//! cube set up on it gets cube's default, which is official Debian trixie
//! with those added (debian.rs); `cubed runners init-local` says so when it
//! moves `berth.env`.

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::{
    debian,
    image::{Platform, Reference},
};

const VERSION: u32 = 1;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u32,
    /// `default`, or the reference `--image` gave.
    reference: String,
}

pub fn path(directory: &Path) -> PathBuf {
    directory.join(".berth").join("served.json")
}

/// Whether `reference` (as `--image` takes it) is cube's default image.
pub fn is_default(reference: &str, platform: Platform) -> bool {
    if reference == "default" {
        return true;
    }
    let Ok(parsed) = Reference::parse(reference) else {
        return false;
    };
    let digest = parsed.digest.to_string();
    let plan = debian::plan();
    let index = debian::default_image().digest.to_string();
    digest == index
        || plan
            .platforms
            .get(&platform.to_string())
            .is_some_and(|p| p.manifest == digest)
}

/// Official Debian alone: never ready on keel (module comment).
pub fn is_official_debian(reference: &str) -> bool {
    Reference::parse(reference)
        .is_ok_and(|r| r.registry == "docker.io" && r.repository == "library/debian")
}

/// What the directory served: its record, else the references of the
/// images pulled into it for this platform. Empty for a new directory.
pub fn served(directory: &Path, platform: Platform) -> Result<Vec<String>> {
    let record = path(directory);
    match fs::read(&record) {
        Ok(text) => {
            let record: Record = serde_json::from_slice(&text)
                .with_context(|| format!("{} is not berth's record", record.display()))?;
            return Ok(vec![record.reference]);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e).with_context(|| format!("read {}", record.display())),
    }
    let images = directory.join("images");
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&images) else {
        return Ok(out);
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("sha256:") || !name.ends_with(".json") {
            continue;
        }
        #[derive(Deserialize)]
        struct Pulled {
            reference: String,
            platform: String,
        }
        let Ok(pulled) = serde_json::from_slice::<Pulled>(&fs::read(entry.path())?) else {
            continue;
        };
        if pulled.platform == platform.to_string() {
            out.push(pulled.reference);
        }
    }
    out.sort();
    Ok(out)
}

/// Refuses to serve cube's default where the directory served an image of
/// the operator's own, unless `change` (`--change-image`) says so. An image
/// named by `--image` is the operator's word and is never refused here.
pub fn check(directory: &Path, reference: &str, change: bool, platform: Platform) -> Result<()> {
    if change || !is_default(reference, platform) {
        return Ok(());
    }
    let own: Vec<String> = served(directory, platform)?
        .into_iter()
        .filter(|r| !is_default(r, platform) && !is_official_debian(r))
        .collect();
    if own.is_empty() {
        return Ok(());
    }
    bail!(
        "{} serves {}, an image of its operator's own; without --image (or with --image default) berth would serve cube's default image instead. \
         To keep it, give --image {}. To move this runner to cube's default on purpose, add --change-image \
         (machines keep the layers they were made with; nothing is deleted)",
        directory.display(),
        own.join(", "),
        own[0]
    )
}

/// Records what the directory serves now (written whole, then renamed).
pub fn record(directory: &Path, reference: &str) -> Result<()> {
    let target = path(directory);
    let temporary = target.with_extension(format!("json.tmp-{}", std::process::id()));
    let text = serde_json::to_vec(&Record {
        version: VERSION,
        reference: reference.to_owned(),
    })?;
    fs::write(&temporary, text).with_context(|| format!("write {}", temporary.display()))?;
    fs::rename(&temporary, &target).with_context(|| format!("write {}", target.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn native() -> Platform {
        Platform::native().unwrap()
    }

    const OWN: &str = "ghcr.io/example/guest@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const OLD_DEBIAN: &str = "docker.io/library/debian@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    fn pulled(dir: &Path, reference: &str) {
        fs::create_dir_all(dir.join("images")).unwrap();
        let digest = reference.split('@').nth(1).unwrap();
        fs::write(
            dir.join("images").join(format!("{digest}.json")),
            serde_json::json!({ "reference": reference, "platform": native().to_string() })
                .to_string(),
        )
        .unwrap();
    }

    #[test]
    fn the_default_and_official_debian_are_known() {
        let plan = &debian::plan().platforms[&native().to_string()];
        assert!(is_default("default", native()));
        assert!(is_default(&debian::default_image().to_string(), native()));
        assert!(is_default(
            &format!("docker.io/library/debian@{}", plan.manifest),
            native()
        ));
        assert!(!is_default(OWN, native()) && !is_default(OLD_DEBIAN, native()));
        assert!(
            is_official_debian(OLD_DEBIAN)
                && is_official_debian(
                    "docker.io/debian:trixie@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                )
        );
        assert!(
            !is_official_debian(OWN)
                && !is_official_debian(
                    "ghcr.io/library/debian@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                )
        );
    }

    /// A new directory, or one that served the default: the default needs
    /// no options.
    #[test]
    fn a_new_directory_takes_the_default() {
        let dir = tempfile::tempdir().unwrap();
        check(&dir.path().join("none"), "default", false, native()).unwrap();
        check(dir.path(), "default", false, native()).unwrap();
        fs::create_dir_all(dir.path().join(".berth")).unwrap();
        record(dir.path(), "default").unwrap();
        check(dir.path(), "default", false, native()).unwrap();
    }

    /// B1: a directory an earlier berth served on the operator's own image
    /// (no record, its pull in images/) is not moved by a missing --image;
    /// --image keeps it, --change-image moves it. The same with a record.
    #[test]
    fn an_operators_image_is_never_left_without_the_word() {
        let dir = tempfile::tempdir().unwrap();
        pulled(dir.path(), OWN);
        let refused = check(dir.path(), "default", false, native())
            .unwrap_err()
            .to_string();
        assert!(
            refused.contains(&format!("serves {OWN}, an image of its operator's own")),
            "{refused}"
        );
        assert!(
            refused.contains(&format!("give --image {OWN}"))
                && refused.contains("add --change-image"),
            "{refused}"
        );
        check(dir.path(), OWN, false, native()).unwrap();
        check(dir.path(), "default", true, native()).unwrap();

        let recorded = tempfile::tempdir().unwrap();
        fs::create_dir_all(recorded.path().join(".berth")).unwrap();
        record(recorded.path(), OWN).unwrap();
        assert!(check(recorded.path(), "default", false, native()).is_err());
        // The record wins over images/: once moved on purpose, the default stays.
        record(recorded.path(), "default").unwrap();
        pulled(recorded.path(), OWN);
        check(recorded.path(), "default", false, native()).unwrap();
    }

    /// Official Debian alone never got ready: such a runner takes the
    /// default without the flag (the recovery init-local announces).
    #[test]
    fn official_debian_alone_moves_to_the_default() {
        let dir = tempfile::tempdir().unwrap();
        pulled(dir.path(), OLD_DEBIAN);
        check(dir.path(), "default", false, native()).unwrap();
        // With an image of one's own beside it, the guard holds.
        pulled(dir.path(), OWN);
        assert!(check(dir.path(), "default", false, native()).is_err());
    }
}
