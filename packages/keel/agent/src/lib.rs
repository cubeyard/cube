//! cube-agent: keel's guest agent (packages/keel/README.md). It runs in the
//! base root as root, started (and started again) by cube-init, speaks
//! protocol 4's `DaemonFrame` on the virtio-serial port `cube.0`, assembles
//! the workload root on `machine_setup` and keeps `OPERATIONS` as cube-guest
//! does. cubed keeps the agent loop and every secret; nothing in this
//! machine holds one. Linux only: it runs in a keel guest.
#![cfg(target_os = "linux")]
pub mod agent;
pub mod channel;
pub mod cli;
pub mod domain;
pub mod fileops;
pub mod files;
pub mod journal;
pub mod ops;
pub mod paths;
pub mod services;
pub mod setup;
pub mod wrap;

/// The PATH commands get, and where the workload's tools are looked for.
pub const STANDARD_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
