//! Generates the protocol-4 types from proto/runner.proto: prost messages
//! with pbjson's proto3-JSON serde. No system protoc: protox parses the file.
use std::{env, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=proto/runner.proto");
    let out = PathBuf::from(env::var("OUT_DIR")?);
    let descriptors = protox::compile(["proto/runner.proto"], ["proto"])?;
    let set = out.join("runner_descriptor.bin");
    std::fs::write(&set, prost::Message::encode_to_vec(&descriptors))?;
    prost_build::Config::new()
        .file_descriptor_set_path(&set)
        .skip_protoc_run()
        .compile_well_known_types()
        // pbjson-types writes timestamps as `+00:00`; proto3 JSON (and
        // protobuf-es) writes `Z`.
        .extern_path(".google.protobuf.Timestamp", "crate::p4::Timestamp")
        .extern_path(".google.protobuf", "::pbjson_types")
        .btree_map(["."])
        .compile_protos(&["proto/runner.proto"], &["proto"])?;
    pbjson_build::Builder::new()
        .register_descriptors(&std::fs::read(&set)?)?
        .btree_map([".".to_string()])
        .ignore_unknown_fields()
        .build(&[".cube.runner.v4"])?;
    Ok(())
}
