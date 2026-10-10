//! The crate from the command line, for measurements and manual checks
//! (`scripts/keel-layer-bench.ts` drives it). Not part of any runner.
//!
//! ```text
//! layers convert MKFS f|i MEDIA_TYPE DIFF_ID BLOB CACHE_DIR
//!     converts BLOB into CACHE_DIR, prints one JSON line
//! layers disk MACHINE_DIR LAYER...
//!     writes MACHINE_DIR/layers.vmdk for the EROFS files, prints JSON
//! ```

use std::fs::File;
use std::path::PathBuf;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use keel_layers::DiffId;
use keel_layers::cache::LayerCache;
use keel_layers::convert::{Compression, Mkfs, TarMode};
use keel_layers::disk;

fn main() -> Result<()> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    match arguments
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["convert", mkfs, mode, media_type, diff_id, blob, cache] => {
            let mode = match *mode {
                "f" => TarMode::Full,
                "i" => TarMode::Index,
                other => bail!("mode is f or i, not {other}"),
            };
            let diff_id: DiffId = diff_id.parse()?;
            let cache = LayerCache::open(PathBuf::from(cache))?;
            let started = Instant::now();
            let (path, converted) = cache.get_or_convert(
                &diff_id,
                &Mkfs::new(*mkfs),
                mode,
                Compression::from_media_type(media_type)?,
                || File::open(blob).with_context(|| format!("open {blob}")),
            )?;
            let seconds = started.elapsed().as_secs_f64();
            let converted = converted.context("already cached; use an empty cache directory")?;
            println!(
                "{{\"diffId\":\"{diff_id}\",\"tarBytes\":{},\"imageBytes\":{},\"seconds\":{seconds:.3},\"path\":{:?}}}",
                converted.tar_bytes,
                converted.image_bytes,
                path.display().to_string()
            );
        }
        ["disk", machine, layers @ ..] => {
            let layers: Vec<disk::Layer> = layers
                .iter()
                .map(|path| {
                    let path = std::fs::canonicalize(path)?;
                    let name: String = path
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .chars()
                        .take(36)
                        .collect();
                    Ok(disk::Layer { path, name })
                })
                .collect::<Result<_>>()?;
            let written = disk::write(&PathBuf::from(machine), &layers)?;
            let partitions: Vec<String> = written
                .partitions
                .iter()
                .map(|p| {
                    format!(
                        "{{\"number\":{},\"firstLba\":{},\"sectors\":{}}}",
                        p.number, p.first_lba, p.sectors
                    )
                })
                .collect();
            println!(
                "{{\"descriptor\":{:?},\"sectors\":{},\"partitions\":[{}]}}",
                written.descriptor.display().to_string(),
                written.sectors,
                partitions.join(",")
            );
        }
        _ => bail!(
            "usage: layers convert MKFS f|i MEDIA_TYPE DIFF_ID BLOB CACHE_DIR | layers disk MACHINE_DIR LAYER..."
        ),
    }
    Ok(())
}
