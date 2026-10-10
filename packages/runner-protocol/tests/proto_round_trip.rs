//! Protocol 4's schema in Rust and TypeScript agree on every message.
//!
//! proto/fixtures holds one proto3-JSON document per message of
//! runner.proto and per oneof case, every field set (derived and checked by
//! packages/server/test/runner-proto-test.ts, which round-trips the same
//! files through the generated TypeScript types). Here each document is
//! parsed into the generated Rust type and written back: the JSON must be
//! the same, so both sides read and write the same bytes.
use std::{collections::BTreeSet, fs, path::Path};

use cube_runner_protocol::proto::{self, egress_policy};
use prost::Message;
use serde::{Serialize, de::DeserializeOwned};

fn round_trip<T: Serialize + DeserializeOwned>(text: &str) -> serde_json::Value {
    let parsed: T = serde_json::from_str(text).expect("parses");
    serde_json::to_value(&parsed).expect("writes")
}

macro_rules! dispatch {
    (@names { $($message:literal => $ty:ty),* $(,)? }) => { [$($message),*] };
    ($name:expr, $text:expr, { $($message:literal => $ty:ty),* $(,)? }) => {
        match $name {
            $($message => Some(round_trip::<$ty>($text)),)*
            _ => None,
        }
    };
}

macro_rules! messages {
    ($mac:ident $($args:tt)*) => {
        $mac!($($args)* {
            "Ref" => proto::Ref,
            "Fence" => proto::Fence,
            "Meta" => proto::Meta,
            "Condition" => proto::Condition,
            "Error" => proto::Error,
            "Empty" => proto::Empty,
            "Open" => proto::Open,
            "StreamAnswer" => proto::StreamAnswer,
            "Hello" => proto::Hello,
            "HelloAnswer" => proto::HelloAnswer,
            "Runner" => proto::Runner,
            "Platform" => proto::Platform,
            "Limits" => proto::Limits,
            "Capacity" => proto::Capacity,
            "Network" => proto::Network,
            "TemplateSummary" => proto::TemplateSummary,
            "Machine" => proto::Machine,
            "MachineSpec" => proto::MachineSpec,
            "Size" => proto::Size,
            "Boot" => proto::Boot,
            "MachineStatus" => proto::MachineStatus,
            "GuestInfo" => proto::GuestInfo,
            "GuestLimits" => proto::GuestLimits,
            "EgressPolicy" => proto::EgressPolicy,
            "EgressPolicy.Rule" => egress_policy::Rule,
            "EgressPolicy.Https" => egress_policy::Https,
            "EgressPolicy.Http" => egress_policy::Http,
            "EgressPolicy.Decide" => egress_policy::Decide,
            "EgressPolicy.Credential" => egress_policy::Credential,
            "Template" => proto::Template,
            "Call" => proto::Call,
            "MachineRef" => proto::MachineRef,
            "MachineCreate" => proto::MachineCreate,
            "MachineStart" => proto::MachineStart,
            "MachineDelete" => proto::MachineDelete,
            "TemplatePublish" => proto::TemplatePublish,
            "TemplateRef" => proto::TemplateRef,
            "CallResult" => proto::CallResult,
            "Machines" => proto::Machines,
            "Templates" => proto::Templates,
            "Diagnosis" => proto::Diagnosis,
            "WatchRequest" => proto::WatchRequest,
            "WatchEvent" => proto::WatchEvent,
            "GuestHeader" => proto::GuestHeader,
            "DialHeader" => proto::DialHeader,
            "CredentialHeader" => proto::CredentialHeader,
            "Header" => proto::Header,
            "ReportHeader" => proto::ReportHeader,
            "EgressReport" => proto::EgressReport,
            "DaemonFrame" => proto::DaemonFrame,
            "DaemonRequest" => proto::DaemonRequest,
            "GuestRequest" => proto::GuestRequest,
            "DaemonAnswer" => proto::DaemonAnswer,
            "MachineSetup" => proto::MachineSetup,
            "Layer" => proto::Layer,
            "ImageConfig" => proto::ImageConfig,
        })
    };
}

/// Every message the schema declares, nested ones as `Outer.Inner`.
fn schema_messages() -> BTreeSet<String> {
    let set = prost_types::FileDescriptorSet::decode(
        &include_bytes!(concat!(env!("OUT_DIR"), "/runner_descriptor.bin"))[..],
    )
    .unwrap();
    fn visit(prefix: &str, message: &prost_types::DescriptorProto, out: &mut BTreeSet<String>) {
        if message.options.as_ref().is_some_and(|o| o.map_entry()) {
            return;
        }
        let name = format!("{prefix}{}", message.name());
        for nested in &message.nested_type {
            visit(&format!("{name}."), nested, out);
        }
        out.insert(name);
    }
    let mut out = BTreeSet::new();
    for file in set.file.iter().filter(|f| f.package() == "cube.runner.v4") {
        for message in &file.message_type {
            visit("", message, &mut out);
        }
    }
    out
}

#[test]
fn every_schema_message_has_a_rust_type() {
    let known: BTreeSet<String> = messages!(dispatch @names)
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(known, schema_messages());
}

#[test]
fn every_fixture_round_trips_unchanged() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("proto/fixtures");
    let schema = schema_messages();
    let mut seen = BTreeSet::new();
    let mut count = 0;
    for entry in fs::read_dir(&directory).unwrap() {
        let path = entry.unwrap().path();
        let file = path.file_name().unwrap().to_str().unwrap().to_owned();
        let stem = file.strip_suffix(".json").expect("json fixture");
        // `Message.json` or `Message.<oneof case>.json`; nested messages
        // have a dot in their own name too.
        let message = schema
            .iter()
            .filter(|name| stem == name.as_str() || stem.starts_with(&format!("{name}.")))
            .max_by_key(|name| name.len())
            .unwrap_or_else(|| panic!("{file} names no message"))
            .clone();
        let text = fs::read_to_string(&path).unwrap();
        let expected: serde_json::Value = serde_json::from_str(&text).unwrap();
        let written = messages!(dispatch message.as_str(), &text,)
            .unwrap_or_else(|| panic!("{message} has no Rust type"));
        assert_eq!(
            written, expected,
            "{file} round-trips through the Rust types"
        );
        seen.insert(message);
        count += 1;
    }
    assert_eq!(seen, schema, "every message has a fixture");
    assert!(count >= 70, "{count} fixtures");
}

#[test]
fn literal_values_read_as_the_schema_says() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("proto/fixtures");
    let machine: proto::Machine =
        serde_json::from_str(&fs::read_to_string(directory.join("Machine.json")).unwrap()).unwrap();
    assert_eq!(machine.fence_epoch, 1005);
    let status = machine.status.unwrap();
    assert_eq!(status.phase(), proto::machine_status::Phase::Failed);
    let guest = status.guest.unwrap();
    assert!(guest.ready);
    assert_eq!(
        guest.hooks.get("hooks-key").map(String::as_str),
        Some("hooks-9")
    );
    let open: proto::Open =
        serde_json::from_str(&fs::read_to_string(directory.join("Open.guest.json")).unwrap())
            .unwrap();
    match open.kind {
        Some(proto::open::Kind::Guest(header)) => assert_eq!(header.op, "op-3"),
        other => panic!("expected a guest header, got {other:?}"),
    }
    // Unknown fields are ignored: a newer guest's hello may say more.
    let guest: proto::GuestInfo =
        serde_json::from_str(r#"{"ready":true,"mood":"fine","epoch":3}"#).unwrap();
    assert_eq!((guest.ready, guest.epoch), (true, 3));
}

/// `berth host` keeps cube-guest's `hello` answer as `status.guest`; this is
/// the line packages/server/guest/cube-guest.py wrote in host mode after an
/// `exec` with lease epoch 7.
#[test]
fn the_guest_helpers_hello_is_a_guest_info() {
    let line = r#"{"version":"1","ready":true,"capabilities":["exec.start","exec.cancel","operation.get","fs.read","fs.write","fs.stat","fs.absolute","services.list","helper.install","portal.configure"],"limits":{"maxFrameBytes":1048576,"requestTimeoutMs":30000,"maxCommandBytes":8192,"maxPathBytes":4096,"maxExecTimeoutMs":1800000,"maxOutputBytes":262144,"outputPageBytes":65536,"maxReadBytes":524288,"maxWriteBytes":524288},"epoch":7,"build":"6d6dfd7cf880b9286d265fc7f62d2cf69938610dd169aa9d6b896b2e2c01c563","os":"linux","kernel":"6.12.111+deb13-cloud-amd64","hooks":{},"bootId":"boot-1"}"#;
    let guest: proto::GuestInfo = serde_json::from_str(line).unwrap();
    assert_eq!(guest.epoch, 7);
    assert_eq!(
        guest.limits,
        Some(proto::GuestLimits {
            max_frame_bytes: 1_048_576,
            request_timeout_ms: 30_000,
            max_command_bytes: 8192,
            max_path_bytes: 4096,
            max_exec_timeout_ms: 1_800_000,
            max_output_bytes: 262_144,
            output_page_bytes: 65_536,
            max_read_bytes: 524_288,
            max_write_bytes: 524_288,
        })
    );
    assert_eq!(guest.boot_id, "boot-1");
    // In a watch event the epoch is proto3 JSON's int64 string.
    let written = serde_json::to_value(&guest).unwrap();
    assert_eq!(written["epoch"], "7");
    assert_eq!(written["limits"]["maxReadBytes"], 524_288);
}
