//! Templates on `berth vm` (masterplan B-8) in process: a runner over a
//! directory with a pulled image's record and layer files and a stand-in
//! keel release, no QEMU. What needs a guest (the agent's scrub and its
//! `template_publish`) is the host gates' (runner-vm-test.ts V10); here the
//! agent's layer on vdd is written by the test, then the runner's side runs
//! as after the agent's `done` (`keep_template`).
use super::*;
use keel_layers::{DiffId, cache::LayerCache};
use std::os::unix::fs::PermissionsExt;

const OWNER: &str = "thread-1";
const BUILD: &str = "00000000000000b1";
const USER: &str = "00000000000000c1";

fn plenty(_: &Path) -> std::io::Result<u64> {
    Ok(u64::MAX)
}

/// 3 GiB free: a 1 GiB template disk needs 1 + 2 (B-8 C2).
fn three_gib(_: &Path) -> std::io::Result<u64> {
    Ok(3 << 30)
}

/// A byte short of that.
fn short_of_three_gib(_: &Path) -> std::io::Result<u64> {
    Ok((3 << 30) - 1)
}

fn diff_id(n: u8) -> DiffId {
    DiffId::from_bytes([n; 32])
}

/// An image (manifest `sha256:m<n>`) whose layers are `layers`, pulled into
/// `dir` as `berth image pull` leaves it: its record and layer files.
fn pull(dir: &Path, n: u8, layers: &[u8]) -> image::Reference {
    let reference = image::Reference::parse(&format!(
        "registry.test/o/image{n}@{}",
        DiffId::from_bytes([0xa0 + n; 32])
    ))
    .unwrap();
    let cache = LayerCache::open(image::layer_dir(dir)).unwrap();
    for layer in layers {
        if cache.get(&diff_id(*layer)).unwrap().is_none() {
            cache
                .publish(&diff_id(*layer), |out| {
                    Ok(std::fs::write(out, vec![*layer; 4096])?)
                })
                .unwrap();
        }
    }
    let descriptor = |digest: String| image::Descriptor {
        media_type: "m".into(),
        digest,
        size: 1,
    };
    let record = image::ImageRecord {
        version: 1,
        reference: reference.to_string(),
        registry: reference.registry.clone(),
        repository: reference.repository.clone(),
        digest: reference.digest.to_string(),
        platform: image::Platform::native().unwrap().to_string(),
        manifest: descriptor(format!("sha256:m{n}")),
        config: descriptor("sha256:c".into()),
        env: vec![],
        layers: layers
            .iter()
            .map(|layer| image::LayerRecord {
                diff_id: diff_id(*layer).to_string(),
                blob: descriptor("sha256:b".into()),
                file: format!("layers/1/{}.erofs", diff_id(*layer)),
                erofs_bytes: 4096,
                tar_bytes: None,
            })
            .collect(),
        layer_format: 1,
        mkfs: "/m".into(),
        mkfs_version: "mkfs.erofs 1".into(),
        resolved_at: 0,
    };
    let store = image::Store::open(dir).unwrap();
    std::fs::write(
        store.record_path(&reference.digest),
        serde_json::to_vec(&record).unwrap(),
    )
    .unwrap();
    reference
}

struct Lab {
    dir: tempfile::TempDir,
    keel: tempfile::TempDir,
}

impl Lab {
    fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("b8")
            .tempdir_in("/tmp")
            .unwrap();
        std::fs::create_dir_all(dir.path().join(".berth")).unwrap();
        let keel = tempfile::tempdir().unwrap();
        std::fs::write(keel.path().join("vmlinuz"), b"kernel").unwrap();
        std::fs::write(keel.path().join("base.erofs"), b"base").unwrap();
        Self { dir, keel }
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    async fn runner(
        &self,
        image: image::Reference,
        cache_bytes: u64,
        free_space: fn(&Path) -> std::io::Result<u64>,
    ) -> Arc<VmRunner> {
        let options = VmOptions {
            directory: self.path().to_owned(),
            node_id: "node-test".into(),
            network: "loopback".into(),
            max_machines: 8,
            labels: BTreeMap::new(),
            qemu: "/nonexistent/qemu".into(),
            qemu_img: "/nonexistent/qemu-img".into(),
            keel: self.keel.path().to_owned(),
            accel: Accel::Tcg,
            image,
            mkfs: "/nonexistent/mkfs.erofs".into(),
            mkfs_version: "mkfs.erofs 1".into(),
            layer_cache_bytes: cache_bytes,
            free_space,
        };
        let floor = Floor {
            version: "11.1.2".into(),
            machine_types: vec!["pc-q35-11.1".into()],
            missing: vec![],
        };
        VmRunner::open(options, floor).await.unwrap()
    }
}

fn reference(id: &str) -> proto::Ref {
    proto::Ref {
        owner: OWNER.into(),
        id: id.into(),
    }
}

fn fence(epoch: i64) -> Option<proto::Fence> {
    Some(proto::Fence { epoch })
}

/// A machine as cubed asks for one (1 GiB disk). The writable disk is put
/// there first, so no qemu-img runs.
async fn create(
    runner: &Arc<VmRunner>,
    id: &str,
    source: proto::machine_spec::Source,
    build: bool,
) -> Answer<proto::Machine> {
    let dir = runner.machine_dir(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(qemu::RW_DISK), b"").unwrap();
    runner
        .create(proto::MachineCreate {
            r#ref: Some(reference(id)),
            fence: fence(1),
            spec: Some(proto::MachineSpec {
                source: Some(source),
                size: Some(proto::Size {
                    vcpus: 1,
                    memory_mib: 512,
                    disk_gib: 1,
                }),
                boot: None,
                build,
            }),
        })
        .await
}

fn base() -> proto::machine_spec::Source {
    proto::machine_spec::Source::Base(true)
}

fn from(id: &str) -> proto::machine_spec::Source {
    proto::machine_spec::Source::TemplateId(id.into())
}

fn reason(error: proto::Error) -> (Code, String) {
    (Code::try_from(error.code).unwrap(), error.reason)
}

/// What the agent's `template_publish` leaves on vdd: an EROFS image of
/// `blocks` 4 KiB blocks at the start of the (sparse) disk.
fn write_layer(runner: &VmRunner, id: &str, blocks: u32) {
    use std::os::unix::fs::FileExt;
    let mut first = vec![0u8; 4096];
    first[1024..1028].copy_from_slice(&0xE0F5_E1E2u32.to_le_bytes());
    first[1024 + 12] = 12;
    first[1024 + 36..1024 + 40].copy_from_slice(&blocks.to_le_bytes());
    let disk = std::fs::OpenOptions::new()
        .write(true)
        .open(runner.machine_dir(id).join(template::DISK))
        .unwrap();
    disk.write_all_at(&first, 0).unwrap();
}

/// The runner's side of a publication, as after the agent's `done`.
fn keep(runner: &VmRunner, id: &str) -> Answer<proto::Template> {
    let mut state = runner.state.lock().unwrap();
    runner.keep_template(&mut state, id, "key-1", "{\"setup\":1}")
}

/// A build machine, published as template BUILD.
async fn published(runner: &Arc<VmRunner>) -> proto::Template {
    create(runner, BUILD, base(), true).await.unwrap();
    write_layer(runner, BUILD, 3);
    keep(runner, BUILD).unwrap()
}

#[tokio::test]
async fn only_a_build_machine_gets_a_template_disk() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1, 2]);
    let runner = lab.runner(image, 16 << 30, plenty).await;
    let build = create(&runner, BUILD, base(), true).await.unwrap();
    assert!(build.spec.as_ref().unwrap().build);
    let vdd = runner.machine_dir(BUILD).join(template::DISK);
    let meta = std::fs::metadata(&vdd).unwrap();
    assert_eq!(meta.len(), 1 << 30, "size.disk_gib");
    {
        use std::os::unix::fs::MetadataExt;
        assert!(
            meta.blocks() * 512 < 1 << 20,
            "sparse: {} blocks",
            meta.blocks()
        );
    }
    let ordinary = create(&runner, USER, base(), false).await.unwrap();
    assert!(!ordinary.spec.as_ref().unwrap().build);
    assert!(!runner.machine_dir(USER).join(template::DISK).exists());
    let state = runner.state.lock().unwrap();
    assert!(state.machines[BUILD].record.build && !state.machines[USER].record.build);
    // The record on disk says so, and only for the build machine.
    let text =
        |id: &str| std::fs::read_to_string(runner.machine_dir(id).join(record::RECORD)).unwrap();
    assert!(text(BUILD).contains("\"build\": true"));
    assert!(!text(USER).contains("\"build\""));
}

#[tokio::test]
async fn a_build_machine_is_made_from_the_base_and_needs_room_for_its_disk() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1]);
    let runner = lab
        .runner(image.clone(), 16 << 30, short_of_three_gib)
        .await;
    let refused = create(&runner, BUILD, base(), true).await.unwrap_err();
    assert_eq!(
        reason(refused.clone()),
        (Code::ResourceExhausted, "disk_space".into())
    );
    assert!(
        refused
            .message
            .contains("its size + 2 GiB = 3221225472 bytes"),
        "{}",
        refused.message
    );
    assert!(!runner.machine_dir(BUILD).join(template::DISK).exists());
    assert!(!runner.state.lock().unwrap().machines.contains_key(BUILD));
    // An ordinary machine has no template disk, so no such check.
    create(&runner, USER, base(), false).await.unwrap();
    drop(runner);
    let runner = lab.runner(image, 16 << 30, three_gib).await;
    create(&runner, BUILD, base(), true).await.unwrap();
    // Not from a template (no templates on templates).
    let refused = create(&runner, "00000000000000d1", from(BUILD), true)
        .await
        .unwrap_err();
    assert_eq!(reason(refused), (Code::InvalidArgument, "build".into()));
    assert!(build_room(3 << 30, 1).is_ok() && build_room((3 << 30) - 1, 1).is_err());
    // 1 × the disk + 2 GiB, not B-7's 3 × + 2: a 32 GiB disk needs 34 GiB.
    assert!(build_room(34 << 30, 32).is_ok());
    let short = build_room((34 << 30) - 1, 32).unwrap_err();
    assert_eq!(
        reason(short.clone()),
        (Code::ResourceExhausted, "disk_space".into())
    );
    assert!(
        short.message.contains(&format!("= {} bytes", 34u64 << 30)),
        "{}",
        short.message
    );
}

#[tokio::test]
async fn a_published_layer_becomes_a_ready_template_and_its_build_machine_goes() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1, 2]);
    let runner = lab.runner(image, 16 << 30, plenty).await;
    let mut events = runner.events.subscribe();
    let template = published(&runner).await;
    assert_eq!(template.id, BUILD);
    assert_eq!(template.state, proto::template::State::Ready as i32);
    assert_eq!(
        (template.bytes, template.disk_gib, template.users),
        (3 * 4096, 1, 0)
    );
    assert_eq!(
        (template.key.as_str(), template.meta.as_str()),
        ("key-1", "{\"setup\":1}")
    );
    // The layer: moved, cut to the superblock's size, read-only.
    let layer = template::layer(lab.path(), BUILD);
    let meta = std::fs::metadata(&layer).unwrap();
    assert_eq!(meta.len(), 3 * 4096);
    assert_eq!(meta.permissions().mode() & 0o777, 0o444);
    // The build machine is deleted (its id never comes back).
    assert!(!runner.machine_dir(BUILD).exists());
    let state = runner.state.lock().unwrap();
    assert!(state.deleted.contains_key(BUILD));
    let kept = &state.templates[BUILD];
    assert_eq!(kept.owner, OWNER);
    assert_eq!(kept.image.manifest, "sha256:m1");
    assert_eq!(
        kept.image.diff_ids,
        [diff_id(1).to_string(), diff_id(2).to_string()]
    );
    assert_eq!(kept.sha256, qemu::sha256_file(&layer).unwrap());
    // Hello, runner.get and watch: the summary.
    let summary = &runner.runner(&state).templates;
    assert_eq!(summary.len(), 1);
    assert_eq!(summary[0].state, proto::template::State::Ready as i32);
    drop(state);
    let mut seen = vec![];
    while let Ok(event) = events.try_recv() {
        seen.push(match event.resource {
            Some(watch_event::Resource::Template(t)) => {
                format!("template {} {}", event.r#type, t.id)
            }
            Some(watch_event::Resource::Machine(m)) => {
                format!("machine {} {}", event.r#type, m.r#ref.unwrap().id)
            }
            _ => continue,
        });
    }
    assert!(seen.contains(&format!("template 1 {BUILD}")), "{seen:?}");
    assert!(seen.contains(&format!("machine 2 {BUILD}")), "{seen:?}");
    assert_eq!(runner.list_templates().items, vec![template]);
}

#[tokio::test]
async fn a_publication_asked_again_gets_its_template_and_other_machines_are_refused() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1]);
    let runner = lab.runner(image, 16 << 30, plenty).await;
    create(&runner, USER, base(), false).await.unwrap();
    let ask = |id: &str, epoch: i64, key: &str| proto::TemplatePublish {
        from: Some(reference(id)),
        fence: fence(epoch),
        key: key.into(),
        meta: "{\"setup\":1}".into(),
    };
    // An ordinary machine never publishes; a build machine only while it runs.
    let refused = runner.publish(ask(USER, 1, "key-1")).await.unwrap_err();
    assert_eq!(
        reason(refused),
        (Code::FailedPrecondition, "not_build".into())
    );
    create(&runner, BUILD, base(), true).await.unwrap();
    let refused = runner.publish(ask(BUILD, 2, "key-1")).await.unwrap_err();
    assert_eq!(reason(refused), (Code::Unavailable, "not_running".into()));
    for bad in [ask(BUILD, 2, ""), ask(BUILD, 2, "a key")] {
        assert_eq!(reason(runner.publish(bad).await.unwrap_err()).1, "key");
    }
    let template = {
        write_layer(&runner, BUILD, 2);
        keep(&runner, BUILD).unwrap()
    };
    // Again (cubed's call timed out): the same template.
    assert_eq!(
        runner.publish(ask(BUILD, 2, "key-1")).await.unwrap(),
        template
    );
    let other = runner.publish(ask(BUILD, 2, "key-2")).await.unwrap_err();
    assert_eq!(reason(other), (Code::AlreadyExists, "template".into()));
    let stale = runner.publish(ask(BUILD, 1, "key-1")).await.unwrap_err();
    assert_eq!(
        reason(stale),
        (Code::FailedPrecondition, "stale_epoch".into())
    );
    let stranger = proto::TemplatePublish {
        from: Some(proto::Ref {
            owner: "thread-2".into(),
            id: BUILD.into(),
        }),
        ..ask(BUILD, 9, "key-1")
    };
    assert_eq!(
        reason(runner.publish(stranger).await.unwrap_err()).1,
        "machine"
    );
}

#[tokio::test]
async fn a_disk_without_a_layer_is_refused_and_nothing_is_kept() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1]);
    let runner = lab.runner(image, 16 << 30, plenty).await;
    create(&runner, BUILD, base(), true).await.unwrap();
    // The agent wrote nothing (blank vdd), then a superblock that claims
    // more than the disk holds.
    for blocks in [None, Some(u32::MAX)] {
        if let Some(blocks) = blocks {
            write_layer(&runner, BUILD, blocks);
        }
        let refused = keep(&runner, BUILD).unwrap_err();
        assert_eq!(
            reason(refused),
            (Code::FailedPrecondition, "template_disk".into())
        );
        assert!(
            runner.machine_dir(BUILD).join(template::DISK).is_file(),
            "the machine keeps its disk"
        );
        assert!(runner.state.lock().unwrap().machines.contains_key(BUILD));
        assert!(runner.list_templates().items.is_empty());
        let left: Vec<_> = std::fs::read_dir(template::dir(lab.path()))
            .unwrap()
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }
}

#[tokio::test]
async fn a_machine_from_a_template_has_it_above_the_images_layers() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1, 2]);
    let runner = lab.runner(image, 16 << 30, plenty).await;
    published(&runner).await;
    let machine = create(&runner, USER, from(BUILD), false).await.unwrap();
    assert_eq!(machine.spec.unwrap().source, Some(from(BUILD)));
    let setup = runner.setup(USER);
    let layers: Vec<(u32, Option<proto::layer::Source>)> = setup
        .layers
        .into_iter()
        .map(|l| (l.partition, l.source))
        .collect();
    assert_eq!(
        layers,
        [
            (3, Some(proto::layer::Source::TemplateId(BUILD.into()))),
            (
                2,
                Some(proto::layer::Source::DiffId(diff_id(2).to_string()))
            ),
            (
                1,
                Some(proto::layer::Source::DiffId(diff_id(1).to_string()))
            ),
        ]
    );
    // The layer disk's third extent is the template's file, read in place.
    let descriptor =
        std::fs::read_to_string(runner.machine_dir(USER).join(keel_layers::disk::DESCRIPTOR))
            .unwrap();
    let extents: Vec<&str> = descriptor
        .lines()
        .filter(|l| l.contains(".erofs"))
        .collect();
    assert_eq!(extents.len(), 3, "{descriptor}");
    assert!(extents[2].contains(&template::layer(lab.path(), BUILD).display().to_string()));
    assert_eq!(runner.list_templates().items[0].users, 1);
    // An ordinary machine's setup has no template.
    create(&runner, "00000000000000c2", base(), false)
        .await
        .unwrap();
    assert_eq!(runner.setup("00000000000000c2").layers.len(), 2);
    let missing = create(&runner, "00000000000000c3", from("00000000000000ff"), false)
        .await
        .unwrap_err();
    assert_eq!(reason(missing), (Code::NotFound, "template".into()));
}

async fn delete(runner: &Arc<VmRunner>, id: &str, retain: bool) {
    runner
        .delete(proto::MachineDelete {
            r#ref: Some(reference(id)),
            fence: fence(1),
            retain,
        })
        .await
        .unwrap();
}

fn delete_template(runner: &VmRunner, id: &str) -> Answer<proto::Template> {
    runner.delete_template(proto::TemplateRef { id: id.into() })
}

#[tokio::test]
async fn a_deleted_template_goes_with_its_last_machine_retained_ones_too() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1]);
    let runner = lab.runner(image, 16 << 30, plenty).await;
    published(&runner).await;
    create(&runner, USER, from(BUILD), false).await.unwrap();
    create(&runner, "00000000000000c2", from(BUILD), false)
        .await
        .unwrap();
    let removing = delete_template(&runner, BUILD).unwrap();
    assert_eq!(removing.state, proto::template::State::Removing as i32);
    assert_eq!(removing.users, 2);
    let layer = template::layer(lab.path(), BUILD);
    assert!(layer.is_file());
    let refused = create(&runner, "00000000000000c3", from(BUILD), false)
        .await
        .unwrap_err();
    assert_eq!(
        reason(refused),
        (Code::FailedPrecondition, "template_removing".into())
    );
    // Asked again: the same answer.
    assert_eq!(
        delete_template(&runner, BUILD).unwrap().state,
        removing.state
    );
    delete(&runner, USER, false).await;
    assert!(layer.is_file(), "one user is left");
    // Retained: still a user, its disk names the template's file.
    delete(&runner, "00000000000000c2", true).await;
    assert!(layer.is_file());
    assert_eq!(runner.list_templates().items[0].users, 1);
    runner
        .discard(proto::MachineRef {
            r#ref: Some(reference("00000000000000c2")),
            fence: fence(1),
        })
        .await
        .unwrap();
    assert!(!layer.exists());
    assert!(runner.list_templates().items.is_empty());
    assert!(
        std::fs::read_dir(template::dir(lab.path()))
            .unwrap()
            .next()
            .is_none()
    );
    let gone = delete_template(&runner, BUILD).unwrap_err();
    assert_eq!(reason(gone), (Code::NotFound, "template".into()));
    // Without users it goes at once.
    create(&runner, "00000000000000b2", base(), true)
        .await
        .unwrap();
    write_layer(&runner, "00000000000000b2", 2);
    keep(&runner, "00000000000000b2").unwrap();
    assert_eq!(
        delete_template(&runner, "00000000000000b2").unwrap().users,
        0
    );
    assert!(runner.list_templates().items.is_empty());
}

#[tokio::test]
async fn a_template_survives_a_restart_and_is_refused_on_another_image() {
    let lab = Lab::new();
    let first = pull(lab.path(), 1, &[1, 2]);
    let second = pull(lab.path(), 2, &[3]);
    let runner = lab.runner(first.clone(), 16 << 30, plenty).await;
    let template = published(&runner).await;
    create(&runner, USER, from(BUILD), false).await.unwrap();
    drop(runner);
    let runner = lab.runner(first.clone(), 16 << 30, plenty).await;
    assert_eq!(
        runner.list_templates().items,
        vec![proto::Template {
            users: 1,
            ..template.clone()
        }]
    );
    drop(runner);
    // Another image: the template is refused for new machines (B-8 D3) and
    // stays until it is deleted.
    let runner = lab.runner(second, 16 << 30, plenty).await;
    let refused = create(&runner, "00000000000000c2", from(BUILD), false)
        .await
        .unwrap_err();
    assert_eq!(
        reason(refused.clone()),
        (Code::FailedPrecondition, "template_image_changed".into())
    );
    assert!(
        refused.message.contains("sha256:m1") && refused.message.contains("sha256:m2"),
        "{}",
        refused.message
    );
    assert_eq!(runner.list_templates().items.len(), 1);
    drop(runner);
    let runner = lab.runner(first, 16 << 30, plenty).await;
    create(&runner, "00000000000000c2", from(BUILD), false)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_templates_image_layers_stay_in_the_cache_and_templates_are_not_trimmed() {
    let lab = Lab::new();
    let first = pull(lab.path(), 1, &[1, 2]);
    let second = pull(lab.path(), 2, &[3]);
    let runner = lab.runner(first, 16 << 30, plenty).await;
    published(&runner).await;
    drop(runner);
    // Another image and a cache limit of 0: only what is in use stays, and
    // the template's image is (its build machine is deleted, and no
    // machine is made from it).
    let runner = lab.runner(second.clone(), 0, plenty).await;
    let cached: Vec<DiffId> = runner
        .cache
        .entries()
        .unwrap()
        .into_iter()
        .map(|e| e.diff_id)
        .collect();
    for n in [1, 2, 3] {
        assert!(cached.contains(&diff_id(n)), "layer {n}: {cached:?}");
    }
    assert!(
        template::layer(lab.path(), BUILD).is_file(),
        "the template is not the cache's"
    );
    // Once the template goes, its image's layers go.
    delete_template(&runner, BUILD).unwrap();
    let cached: Vec<DiffId> = runner
        .cache
        .entries()
        .unwrap()
        .into_iter()
        .map(|e| e.diff_id)
        .collect();
    assert_eq!(cached, vec![diff_id(3)]);
}

#[tokio::test]
async fn a_publication_cut_short_is_finished_when_the_runner_starts_again() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1]);
    let runner = lab.runner(image.clone(), 16 << 30, plenty).await;
    create(&runner, BUILD, base(), true).await.unwrap();
    write_layer(&runner, BUILD, 2);
    // Crashed after the layer was moved: the record says publishing.
    let record = {
        let state = runner.state.lock().unwrap();
        let entry = &state.machines[BUILD];
        template::TemplateRecord {
            version: 1,
            id: BUILD.into(),
            owner: OWNER.into(),
            key: "key-1".into(),
            meta: String::new(),
            state: template::State::Publishing,
            disk_gib: 1,
            bytes: 2 * 4096,
            sha256: String::new(),
            image: entry.record.image.clone().unwrap(),
            kernel_sha256: "k".into(),
            base_sha256: "b".into(),
            fence_epoch: 1,
            created_at: Timestamp::now(),
        }
    };
    template::adopt(
        lab.path(),
        &record,
        &runner.machine_dir(BUILD).join(template::DISK),
    )
    .unwrap();
    drop(runner);
    let runner = lab.runner(image.clone(), 16 << 30, plenty).await;
    let items = runner.list_templates().items;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].state, proto::template::State::Ready as i32);
    assert!(
        !runner.machine_dir(BUILD).exists(),
        "its build machine is deleted"
    );
    assert!(runner.state.lock().unwrap().deleted.contains_key(BUILD));
    // Crashed before the move: forgotten; the build machine keeps its disk.
    create(&runner, "00000000000000b2", base(), true)
        .await
        .unwrap();
    template::write(
        lab.path(),
        &template::TemplateRecord {
            id: "00000000000000b2".into(),
            ..record
        },
    )
    .unwrap();
    drop(runner);
    let runner = lab.runner(image, 16 << 30, plenty).await;
    assert_eq!(runner.list_templates().items.len(), 1);
    assert!(
        runner
            .machine_dir("00000000000000b2")
            .join(template::DISK)
            .is_file()
    );
    assert!(
        runner
            .state
            .lock()
            .unwrap()
            .machines
            .contains_key("00000000000000b2")
    );
}

#[test]
fn only_the_agents_done_goes_on_to_keep_the_disk() {
    assert!(publish_outcome(Some(Ok(Ok(AnswerKind::Done(proto::Empty {}))))).is_ok());
    // The agent's refusal is cubed's, as the agent said it.
    let busy = refuse(
        Code::FailedPrecondition,
        "busy",
        "commands are still running",
    );
    assert_eq!(
        publish_outcome(Some(Ok(Ok(AnswerKind::Error(busy.clone()))))).unwrap_err(),
        busy
    );
    let late = publish_outcome(None).unwrap_err();
    assert!(
        late.completion_unknown && late.reason == "publish_timeout",
        "{late:?}"
    );
    let (sender, receiver) = tokio::sync::oneshot::channel::<channel::Answer>();
    drop(sender);
    let gone = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(receiver);
    let gone = publish_outcome(Some(gone)).unwrap_err();
    assert!(
        gone.completion_unknown && gone.reason == "guest_disconnected",
        "{gone:?}"
    );
    assert!(
        !publish_outcome(Some(Ok(Ok(AnswerKind::Guest(vec![])))))
            .unwrap_err()
            .completion_unknown
    );
}

#[tokio::test]
async fn the_runners_shutdown_does_not_wait_for_a_publication() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1]);
    let runner = lab.runner(image, 16 << 30, plenty).await;
    create(&runner, BUILD, base(), true).await.unwrap();
    // The build machine runs, and its agent never answers.
    let (guest, mut frames) = channel::Guest::connected("s1");
    {
        let mut state = runner.state.lock().unwrap();
        let entry = state.machines.get_mut(BUILD).unwrap();
        entry.record.phase = Phase::Running;
        entry.guest = Some(guest);
    }
    let publishing = {
        let runner = Arc::clone(&runner);
        tokio::spawn(async move {
            let _op = runner.ops.lock().await;
            runner
                .publish(proto::TemplatePublish {
                    from: Some(reference(BUILD)),
                    fence: fence(1),
                    key: "key-1".into(),
                    meta: String::new(),
                })
                .await
        })
    };
    let sent = frames.recv().await.unwrap();
    assert!(matches!(
        sent.t,
        Some(proto::daemon_frame::T::Req(proto::DaemonRequest {
            op: Some(Op::TemplatePublish(_))
        }))
    ));
    tokio::time::timeout(Duration::from_secs(10), runner.shutdown())
        .await
        .expect("the shutdown waits for no publication");
    let stopped = publishing.await.unwrap().unwrap_err();
    assert!(
        stopped.completion_unknown && stopped.reason == "runner_stopping",
        "{stopped:?}"
    );
    assert!(runner.list_templates().items.is_empty());
}
