// Runner protocol 4: cubed <-> cube-runner over one Iroh connection per
// runner (ALPN `cubeyard/runner/4`), one QUIC stream per call.
//
// Every stream opens with one frame: u32 big-endian length, then an `Open`
// message as proto3 JSON. What follows depends on the stream:
//   hello   one `HelloAnswer` frame, then FIN.
//   call    one `CallResult` frame, then FIN.
//   watch   `WatchEvent` frames until either side resets the stream.
//   guest   request: the guest operation's own bytes (one JSON line and a
//           raw body, as `cube-guest call OP` reads them), then FIN.
//           answer: one `StreamAnswer` frame, then (when it has no error)
//           the operation's answer bytes as the helper wrote them, then FIN.
//   dial    one `StreamAnswer` frame, then raw TCP both ways.
//   credential (runner -> cubed) one `StreamAnswer` frame, then (when it
//           has no error) one HTTP/1.1 request and its answer as raw bytes
//           both ways, then FIN; see `CredentialHeader`.
// A runner never interprets the guest bytes (`OPERATIONS` in cube-guest).
//
// The guest channel (`berth vm` <-> keel's cube-agent): one virtio-serial
// port named `cube.0` per machine, a Unix socket on the runner's side. It
// carries `DaemonFrame`s framed as on the streams above (u32 big-endian
// length, 1 to MAX_FRAME_BYTES bytes, then proto3 JSON). MAX_FRAME_BYTES is
// the protocol's own 1 MiB limit, the same on every stream and on the port;
// neither end learns it from the other. `Limits.max_frame_bytes` only
// reports it to cubed, and `GuestLimits.max_frame_bytes` is the guest's own
// limit for an operation, which must not exceed it. A frame over the limit,
// a zero length, JSON that does not parse or a frame that breaks the channel
// rules below ends the connection; the runner treats the guest's side as
// hostile.
//   ch 0    the connection: the agent sends `hello` once it is connected
//           and `status` whenever its `GuestInfo` changes, each at most
//           MAX_GUEST_INFO_BYTES (64 KiB) so it fits a watch event.
//   ch > 0  one operation: the runner opens it with one `req` and never
//           reuses the number on this connection; the agent closes it with
//           one `ans`. `abort` from the runner stops the wait, not the
//           operation (as a closed stream does today); an `ans` that comes
//           after it is dropped. Each `req` and `ans` is one frame, so the
//           agent's limits must keep a guest request or answer under
//           MAX_FRAME_BYTES once its bytes are base64 (512 KiB reads and
//           writes do).
// A disconnect (agent restart, socket closed, machine restored from a
// snapshot) closes every channel. The agent sends `hello` again, the runner
// sends `machine_setup` again, and operations that were running are found
// by their keys, as `OPERATIONS` already requires.
// The agent says `hello` when the host opens the port: when the runner
// connects to it, after a boot, after the agent starts again, after the
// reset below, and after a restore. A restore is always a new QEMU process
// that loads the memory file, and the runner connects to its port then;
// reset and restore are the same mechanism. VMGENID has no part in it.
// When the runner closes its end, the agent closes the port and opens it
// again at once, which QMP reports as a `VSERPORT_CHANGE` timestamped after
// the runner left (the event is rate-limited, so its timestamp, not its
// state, is the answer). Before a save the runner closes its end while the
// machine runs and waits for that (bounded), then stops it and saves: the
// saved agent is waiting for the host, so the runner's connect to the
// restored QEMU is an open it sees. The agent waits for the host on SIGIO
// (the guest driver raises it for every message about the host's end),
// never on a timer alone: a timer armed before a save can fire late after a
// restore (under KVM, about 0.9 s for a young guest). (A runner still connected at the save leaves a port that is already
// open in the restored machine, and a connect right after `cont` changes
// nothing the guest sees; then only the reset helps.)
// Sessions: every `hello` starts a session with a new `DaemonFrame.session`
// (32 lowercase hex characters), and every frame the agent sends carries
// its current session. The agent makes it from fresh random bytes and the
// host's clock as the guest reads it then, so a machine restored twice from
// one snapshot (its random state rolled back with its memory) still gets
// two sessions. After a `hello` the runner puts the session on every frame
// it sends; each side drops a frame of another session (a reply or request
// that was on its way before the break), and the runner refuses a `hello`
// whose session it has seen before on this machine. The agent sets the
// guest's realtime clock from the host's (virtio-rtc's PTP clock) just
// before each `hello`, and every 500 ms besides, so a restored machine has
// the right time when it says `hello`. VMGENID (x86-64 only; QEMU has no
// such device for arm64) makes the kernel reseed its random generator on a
// restore; `machine_setup`'s entropy, with which the agent reseeds it at
// once, does the same on both architectures.
// The guest may miss a disconnect (see above), and then no `hello` comes.
// So after every connect the runner waits for `hello` (500 ms is ample
// once the agent has the port open); without one it sends one frame on
// channel 0 (a `req` with `guest.op = "hello"`, no session). That breaks
// the rules above, so the agent ends the connection, opens the port again
// and sends `hello`; the runner waits for it again (2 s), and a second miss
// means the machine is unhealthy. The runner learns whether the agent has
// the port open from QMP: `VSERPORT_CHANGE` (at most one per second per
// port, the newest state kept, so a close and an open can arrive as the
// open alone) and `query-chardev`. While the port is closed (the machine
// boots, or the agent starts again) the runner waits for it to open
// (bounded by the boot) before it starts those 500 ms, and an event that
// closes it ends the session at once. The event is never taken as a
// `hello`. The runner never sends anything else before a `hello`, and any
// `hello` on a socket it already had means every channel closed:
// `machine_setup` again, and `ready` from the `status` that follows its
// `ans`.
//
// The QEMU a VM runner needs (checked when it starts on the binary it is
// given by path, never one it searches for; refused below it):
// `virtio-rtc-pci`, `virtio-serial-pci` with `virtserialport`,
// `virtio-balloon-pci` with `free-page-reporting`, versioned machine types,
// `-kernel` boot on arm64 and x86-64, `migrate` to `file:` with the
// `mapped-ram` capability in migration mode `cpr-reboot` (QEMU's vmdk
// driver blocks mode `normal`, and the layer disk is a VMDK descriptor),
// `-netdev dgram` (on a socket pair the runner keeps the other end of) and
// `virtio-net-pci`. One set of QEMU arguments on Linux and macOS.
//
// This file is the only schema. Rust types are generated at build time
// (packages/runner-protocol/build.rs); TypeScript types are generated into
// packages/server/src/gen by `pnpm proto:generate` and checked by
// `pnpm proto:check`.

// @generated by protoc-gen-es v2.16.0 with parameter "target=js+dts,import_extension=js"
// @generated from file runner.proto (package cube.runner.v4, syntax proto3)
/* eslint-disable */

import type { GenEnum, GenFile, GenMessage } from "@bufbuild/protobuf/codegenv2";
import type { Message } from "@bufbuild/protobuf";
import type { Duration, Timestamp } from "@bufbuild/protobuf/wkt";

/**
 * Describes the file runner.proto.
 */
export declare const file_runner: GenFile;

/**
 * A machine: `owner` is cubed's (a thread id), `id` is 16 hex characters
 * and never reused.
 *
 * @generated from message cube.runner.v4.Ref
 */
export declare type Ref = Message<"cube.runner.v4.Ref"> & {
  /**
   * @generated from field: string owner = 1;
   */
  owner: string;

  /**
   * @generated from field: string id = 2;
   */
  id: string;
};

/**
 * Describes the message cube.runner.v4.Ref.
 * Use `create(RefSchema)` to create a new message.
 */
export declare const RefSchema: GenMessage<Ref>;

/**
 * The owner's newest epoch. A mutation, `guest` or `dial` with an older one
 * is FAILED_PRECONDITION/stale_epoch.
 *
 * @generated from message cube.runner.v4.Fence
 */
export declare type Fence = Message<"cube.runner.v4.Fence"> & {
  /**
   * @generated from field: int64 epoch = 1;
   */
  epoch: bigint;
};

/**
 * Describes the message cube.runner.v4.Fence.
 * Use `create(FenceSchema)` to create a new message.
 */
export declare const FenceSchema: GenMessage<Fence>;

/**
 * @generated from message cube.runner.v4.Meta
 */
export declare type Meta = Message<"cube.runner.v4.Meta"> & {
  /**
   * @generated from field: int64 version = 1;
   */
  version: bigint;

  /**
   * @generated from field: google.protobuf.Timestamp updated = 2;
   */
  updated?: Timestamp | undefined;
};

/**
 * Describes the message cube.runner.v4.Meta.
 * Use `create(MetaSchema)` to create a new message.
 */
export declare const MetaSchema: GenMessage<Meta>;

/**
 * @generated from message cube.runner.v4.Condition
 */
export declare type Condition = Message<"cube.runner.v4.Condition"> & {
  /**
   * @generated from field: string type = 1;
   */
  type: string;

  /**
   * @generated from field: bool status = 2;
   */
  status: boolean;

  /**
   * @generated from field: string reason = 3;
   */
  reason: string;

  /**
   * @generated from field: string message = 4;
   */
  message: string;

  /**
   * @generated from field: google.protobuf.Timestamp since = 5;
   */
  since?: Timestamp | undefined;
};

/**
 * Describes the message cube.runner.v4.Condition.
 * Use `create(ConditionSchema)` to create a new message.
 */
export declare const ConditionSchema: GenMessage<Condition>;

/**
 * @generated from message cube.runner.v4.Error
 */
export declare type Error = Message<"cube.runner.v4.Error"> & {
  /**
   * @generated from field: cube.runner.v4.Code code = 1;
   */
  code: Code;

  /**
   * @generated from field: string reason = 2;
   */
  reason: string;

  /**
   * @generated from field: string message = 3;
   */
  message: string;

  /**
   * The request may have taken effect; repeat it (every verb is idempotent).
   *
   * @generated from field: bool completion_unknown = 4;
   */
  completionUnknown: boolean;
};

/**
 * Describes the message cube.runner.v4.Error.
 * Use `create(ErrorSchema)` to create a new message.
 */
export declare const ErrorSchema: GenMessage<Error>;

/**
 * @generated from message cube.runner.v4.Empty
 */
export declare type Empty = Message<"cube.runner.v4.Empty"> & {
};

/**
 * Describes the message cube.runner.v4.Empty.
 * Use `create(EmptySchema)` to create a new message.
 */
export declare const EmptySchema: GenMessage<Empty>;

/**
 * The first frame of every stream says what the stream is.
 *
 * @generated from message cube.runner.v4.Open
 */
export declare type Open = Message<"cube.runner.v4.Open"> & {
  /**
   * @generated from oneof cube.runner.v4.Open.kind
   */
  kind: {
    /**
     * @generated from field: cube.runner.v4.Hello hello = 1;
     */
    value: Hello;
    case: "hello";
  } | {
    /**
     * @generated from field: cube.runner.v4.Call call = 2;
     */
    value: Call;
    case: "call";
  } | {
    /**
     * @generated from field: cube.runner.v4.WatchRequest watch = 3;
     */
    value: WatchRequest;
    case: "watch";
  } | {
    /**
     * @generated from field: cube.runner.v4.GuestHeader guest = 4;
     */
    value: GuestHeader;
    case: "guest";
  } | {
    /**
     * @generated from field: cube.runner.v4.DialHeader dial = 5;
     */
    value: DialHeader;
    case: "dial";
  } | {
    /**
     * Runner -> cubed: at most one per connection, opened at the first
     * report; `EgressReport` frames until FIN. cubed never answers.
     *
     * @generated from field: cube.runner.v4.ReportHeader report = 6;
     */
    value: ReportHeader;
    case: "report";
  } | {
    /**
     * Runner -> cubed: one per guest request that a credential rule
     * matched. cubed answers one StreamAnswer frame; without an error, one
     * HTTP/1.1 request and its answer follow as raw bytes, then FIN. The
     * header routes and authorizes; the request itself is the bytes.
     *
     * @generated from field: cube.runner.v4.CredentialHeader credential = 7;
     */
    value: CredentialHeader;
    case: "credential";
  } | { case: undefined; value?: undefined };
};

/**
 * Describes the message cube.runner.v4.Open.
 * Use `create(OpenSchema)` to create a new message.
 */
export declare const OpenSchema: GenMessage<Open>;

/**
 * The answer frame of a `guest`, `dial` or `credential` stream; no error
 * means the bytes that follow are the machine's (for `credential`: the
 * HTTP/1.1 exchange with cubed's credential proxy).
 *
 * @generated from message cube.runner.v4.StreamAnswer
 */
export declare type StreamAnswer = Message<"cube.runner.v4.StreamAnswer"> & {
  /**
   * @generated from field: cube.runner.v4.Error error = 1;
   */
  error?: Error | undefined;
};

/**
 * Describes the message cube.runner.v4.StreamAnswer.
 * Use `create(StreamAnswerSchema)` to create a new message.
 */
export declare const StreamAnswerSchema: GenMessage<StreamAnswer>;

/**
 * @generated from message cube.runner.v4.Hello
 */
export declare type Hello = Message<"cube.runner.v4.Hello"> & {
  /**
   * @generated from field: uint32 protocol = 1;
   */
  protocol: number;

  /**
   * @generated from field: string expect_node = 2;
   */
  expectNode: string;

  /**
   * @generated from field: string cubed_version = 3;
   */
  cubedVersion: string;
};

/**
 * Describes the message cube.runner.v4.Hello.
 * Use `create(HelloSchema)` to create a new message.
 */
export declare const HelloSchema: GenMessage<Hello>;

/**
 * @generated from message cube.runner.v4.HelloAnswer
 */
export declare type HelloAnswer = Message<"cube.runner.v4.HelloAnswer"> & {
  /**
   * @generated from field: uint32 protocol = 1;
   */
  protocol: number;

  /**
   * @generated from field: repeated string capabilities = 2;
   */
  capabilities: string[];

  /**
   * @generated from field: cube.runner.v4.Runner runner = 3;
   */
  runner?: Runner | undefined;
};

/**
 * Describes the message cube.runner.v4.HelloAnswer.
 * Use `create(HelloAnswerSchema)` to create a new message.
 */
export declare const HelloAnswerSchema: GenMessage<HelloAnswer>;

/**
 * @generated from message cube.runner.v4.Runner
 */
export declare type Runner = Message<"cube.runner.v4.Runner"> & {
  /**
   * @generated from field: string node_id = 1;
   */
  nodeId: string;

  /**
   * @generated from field: string software_version = 2;
   */
  softwareVersion: string;

  /**
   * @generated from field: cube.runner.v4.Runner.Kind kind = 3;
   */
  kind: Runner_Kind;

  /**
   * @generated from field: cube.runner.v4.Platform platform = 4;
   */
  platform?: Platform | undefined;

  /**
   * @generated from field: cube.runner.v4.Limits limits = 5;
   */
  limits?: Limits | undefined;

  /**
   * @generated from field: cube.runner.v4.Capacity capacity = 6;
   */
  capacity?: Capacity | undefined;

  /**
   * @generated from field: cube.runner.v4.Runner.Lifecycle lifecycle = 7;
   */
  lifecycle: Runner_Lifecycle;

  /**
   * @generated from field: cube.runner.v4.Network network = 8;
   */
  network?: Network | undefined;

  /**
   * @generated from field: repeated cube.runner.v4.TemplateSummary templates = 9;
   */
  templates: TemplateSummary[];

  /**
   * @generated from field: map<string, string> labels = 10;
   */
  labels: { [key: string]: string };

  /**
   * VM runners: the runner's egress CA (public).
   *
   * @generated from field: string ca_pem = 11;
   */
  caPem: string;

  /**
   * @generated from field: cube.runner.v4.Meta meta = 12;
   */
  meta?: Meta | undefined;

  /**
   * @generated from field: google.protobuf.Timestamp started_at = 13;
   */
  startedAt?: Timestamp | undefined;
};

/**
 * Describes the message cube.runner.v4.Runner.
 * Use `create(RunnerSchema)` to create a new message.
 */
export declare const RunnerSchema: GenMessage<Runner>;

/**
 * @generated from enum cube.runner.v4.Runner.Kind
 */
export enum Runner_Kind {
  /**
   * @generated from enum value: KIND_UNSPECIFIED = 0;
   */
  KIND_UNSPECIFIED = 0,

  /**
   * @generated from enum value: VM = 1;
   */
  VM = 1,

  /**
   * A foreground process on a Mac or Linux host: each machine is a
   * directory, commands run as the user who started it, unsandboxed.
   *
   * @generated from enum value: HOST = 2;
   */
  HOST = 2,
}

/**
 * Describes the enum cube.runner.v4.Runner.Kind.
 */
export declare const Runner_KindSchema: GenEnum<Runner_Kind>;

/**
 * @generated from enum cube.runner.v4.Runner.Lifecycle
 */
export enum Runner_Lifecycle {
  /**
   * @generated from enum value: LIFECYCLE_UNSPECIFIED = 0;
   */
  LIFECYCLE_UNSPECIFIED = 0,

  /**
   * @generated from enum value: READY = 1;
   */
  READY = 1,

  /**
   * @generated from enum value: DRAINING = 2;
   */
  DRAINING = 2,

  /**
   * @generated from enum value: FAULTED = 3;
   */
  FAULTED = 3,

  /**
   * @generated from enum value: RECOVERY_REQUIRED = 4;
   */
  RECOVERY_REQUIRED = 4,
}

/**
 * Describes the enum cube.runner.v4.Runner.Lifecycle.
 */
export declare const Runner_LifecycleSchema: GenEnum<Runner_Lifecycle>;

/**
 * @generated from message cube.runner.v4.Platform
 */
export declare type Platform = Message<"cube.runner.v4.Platform"> & {
  /**
   * linux | macos
   *
   * @generated from field: string os = 1;
   */
  os: string;

  /**
   * x86_64 | aarch64
   *
   * @generated from field: string arch = 2;
   */
  arch: string;

  /**
   * kvm | hvf | none
   *
   * @generated from field: string accelerator = 3;
   */
  accelerator: string;

  /**
   * VM runners: the version and path of the QEMU binary it runs, which it
   * is given by path (`11.1.2 /opt/qemu/bin/qemu-system-x86_64`).
   *
   * @generated from field: string qemu_version = 4;
   */
  qemuVersion: string;

  /**
   * @generated from field: string base_image_sha256 = 5;
   */
  baseImageSha256: string;

  /**
   * @generated from field: string base_image_name = 6;
   */
  baseImageName: string;

  /**
   * Shown to people, never an identity.
   *
   * @generated from field: string host_name = 7;
   */
  hostName: string;
};

/**
 * Describes the message cube.runner.v4.Platform.
 * Use `create(PlatformSchema)` to create a new message.
 */
export declare const PlatformSchema: GenMessage<Platform>;

/**
 * @generated from message cube.runner.v4.Limits
 */
export declare type Limits = Message<"cube.runner.v4.Limits"> & {
  /**
   * @generated from field: uint32 max_vcpus = 1;
   */
  maxVcpus: number;

  /**
   * @generated from field: uint32 max_memory_mib = 2;
   */
  maxMemoryMib: number;

  /**
   * @generated from field: uint32 max_disk_gib = 3;
   */
  maxDiskGib: number;

  /**
   * @generated from field: uint32 max_machines = 4;
   */
  maxMachines: number;

  /**
   * @generated from field: uint32 max_boot_bytes = 5;
   */
  maxBootBytes: number;

  /**
   * @generated from field: uint32 max_frame_bytes = 6;
   */
  maxFrameBytes: number;
};

/**
 * Describes the message cube.runner.v4.Limits.
 * Use `create(LimitsSchema)` to create a new message.
 */
export declare const LimitsSchema: GenMessage<Limits>;

/**
 * @generated from message cube.runner.v4.Capacity
 */
export declare type Capacity = Message<"cube.runner.v4.Capacity"> & {
  /**
   * @generated from field: uint32 machines_active = 1;
   */
  machinesActive: number;

  /**
   * @generated from field: uint32 machines_running = 2;
   */
  machinesRunning: number;

  /**
   * @generated from field: uint32 slots_free = 3;
   */
  slotsFree: number;

  /**
   * @generated from field: uint32 host_cpus = 4;
   */
  hostCpus: number;

  /**
   * @generated from field: uint64 host_memory_mib = 5;
   */
  hostMemoryMib: bigint;

  /**
   * @generated from field: uint64 host_memory_free_mib = 6;
   */
  hostMemoryFreeMib: bigint;

  /**
   * @generated from field: uint64 disk_free_gib = 7;
   */
  diskFreeGib: bigint;

  /**
   * @generated from field: uint32 retained = 8;
   */
  retained: number;

  /**
   * @generated from field: uint64 retained_bytes = 9;
   */
  retainedBytes: bigint;
};

/**
 * Describes the message cube.runner.v4.Capacity.
 * Use `create(CapacitySchema)` to create a new message.
 */
export declare const CapacitySchema: GenMessage<Capacity>;

/**
 * @generated from message cube.runner.v4.Network
 */
export declare type Network = Message<"cube.runner.v4.Network"> & {
  /**
   * loopback | direct | relay
   *
   * @generated from field: string mode = 1;
   */
  mode: string;

  /**
   * @generated from field: google.protobuf.Duration rtt_to_cubed = 2;
   */
  rttToCubed?: Duration | undefined;

  /**
   * VM runners: the runner lets guest traffic out itself.
   *
   * @generated from field: bool egress = 3;
   */
  egress: boolean;
};

/**
 * Describes the message cube.runner.v4.Network.
 * Use `create(NetworkSchema)` to create a new message.
 */
export declare const NetworkSchema: GenMessage<Network>;

/**
 * @generated from message cube.runner.v4.TemplateSummary
 */
export declare type TemplateSummary = Message<"cube.runner.v4.TemplateSummary"> & {
  /**
   * @generated from field: string id = 1;
   */
  id: string;

  /**
   * @generated from field: string key = 2;
   */
  key: string;

  /**
   * @generated from field: cube.runner.v4.Template.State state = 3;
   */
  state: Template_State;

  /**
   * @generated from field: google.protobuf.Timestamp created_at = 4;
   */
  createdAt?: Timestamp | undefined;
};

/**
 * Describes the message cube.runner.v4.TemplateSummary.
 * Use `create(TemplateSummarySchema)` to create a new message.
 */
export declare const TemplateSummarySchema: GenMessage<TemplateSummary>;

/**
 * @generated from message cube.runner.v4.Machine
 */
export declare type Machine = Message<"cube.runner.v4.Machine"> & {
  /**
   * @generated from field: cube.runner.v4.Ref ref = 1;
   */
  ref?: Ref | undefined;

  /**
   * @generated from field: cube.runner.v4.MachineSpec spec = 2;
   */
  spec?: MachineSpec | undefined;

  /**
   * @generated from field: cube.runner.v4.MachineStatus status = 3;
   */
  status?: MachineStatus | undefined;

  /**
   * @generated from field: cube.runner.v4.Meta meta = 4;
   */
  meta?: Meta | undefined;

  /**
   * @generated from field: int64 fence_epoch = 5;
   */
  fenceEpoch: bigint;
};

/**
 * Describes the message cube.runner.v4.Machine.
 * Use `create(MachineSchema)` to create a new message.
 */
export declare const MachineSchema: GenMessage<Machine>;

/**
 * @generated from message cube.runner.v4.MachineSpec
 */
export declare type MachineSpec = Message<"cube.runner.v4.MachineSpec"> & {
  /**
   * @generated from oneof cube.runner.v4.MachineSpec.source
   */
  source: {
    /**
     * @generated from field: bool base = 1;
     */
    value: boolean;
    case: "base";
  } | {
    /**
     * @generated from field: string template_id = 2;
     */
    value: string;
    case: "templateId";
  } | { case: undefined; value?: undefined };

  /**
   * @generated from field: cube.runner.v4.Size size = 3;
   */
  size?: Size | undefined;

  /**
   * @generated from field: cube.runner.v4.Boot boot = 4;
   */
  boot?: Boot | undefined;
};

/**
 * Describes the message cube.runner.v4.MachineSpec.
 * Use `create(MachineSpecSchema)` to create a new message.
 */
export declare const MachineSpecSchema: GenMessage<MachineSpec>;

/**
 * @generated from message cube.runner.v4.Size
 */
export declare type Size = Message<"cube.runner.v4.Size"> & {
  /**
   * @generated from field: uint32 vcpus = 1;
   */
  vcpus: number;

  /**
   * @generated from field: uint32 memory_mib = 2;
   */
  memoryMib: number;

  /**
   * @generated from field: uint32 disk_gib = 3;
   */
  diskGib: number;
};

/**
 * Describes the message cube.runner.v4.Size.
 * Use `create(SizeSchema)` to create a new message.
 */
export declare const SizeSchema: GenMessage<Size>;

/**
 * Boot data for the machine; its content is the image's business. A keel
 * machine gets the documents over its guest channel (`MachineSetup`), never
 * on the kernel command line or a disk. Their names replace today's seed:
 *   hostname          the machine's host name, one line.
 *   env               `NAME=value` lines for every command's environment:
 *                     the secret placeholders (`GH_TOKEN`,
 *                     `CUBE_SECRET_<NAME>`). keel adds its own fixed lines
 *                     (the CA variables, `GIT_TERMINAL_PROMPT=0`, ...).
 *   hooks/pre-setup   the project's external hooks, as executable scripts;
 *   hooks/pre-resume  a missing document means no hook.
 * The agent refuses a setup with a name it does not know. Everything else
 * the seed carries today is keel's own (the agent account, sudoers, git's
 * credential helper) or the runner's (its CA, `MachineSetup.ca_pem`), and
 * the image brings its packages. `berth host` ignores `Boot`, and a keel
 * machine ignores `mac`: every keel machine has the same fixed address and
 * MAC on its own link to the runner, set by the runner, so nothing in the
 * guest's network names the machine.
 *
 * @generated from message cube.runner.v4.Boot
 */
export declare type Boot = Message<"cube.runner.v4.Boot"> & {
  /**
   * @generated from field: map<string, bytes> documents = 1;
   */
  documents: { [key: string]: Uint8Array };

  /**
   * @generated from field: string mac = 2;
   */
  mac: string;
};

/**
 * Describes the message cube.runner.v4.Boot.
 * Use `create(BootSchema)` to create a new message.
 */
export declare const BootSchema: GenMessage<Boot>;

/**
 * @generated from message cube.runner.v4.MachineStatus
 */
export declare type MachineStatus = Message<"cube.runner.v4.MachineStatus"> & {
  /**
   * @generated from field: cube.runner.v4.MachineStatus.Phase phase = 1;
   */
  phase: MachineStatus_Phase;

  /**
   * @generated from field: repeated cube.runner.v4.Condition conditions = 2;
   */
  conditions: Condition[];

  /**
   * @generated from field: string boot_id = 3;
   */
  bootId: string;

  /**
   * @generated from field: uint64 disk_bytes = 4;
   */
  diskBytes: bigint;

  /**
   * @generated from field: string error = 5;
   */
  error: string;

  /**
   * @generated from field: google.protobuf.Timestamp started_at = 6;
   */
  startedAt?: Timestamp | undefined;

  /**
   * The guest's own status, as the guest reported it.
   *
   * @generated from field: cube.runner.v4.GuestInfo guest = 7;
   */
  guest?: GuestInfo | undefined;
};

/**
 * Describes the message cube.runner.v4.MachineStatus.
 * Use `create(MachineStatusSchema)` to create a new message.
 */
export declare const MachineStatusSchema: GenMessage<MachineStatus>;

/**
 * @generated from enum cube.runner.v4.MachineStatus.Phase
 */
export enum MachineStatus_Phase {
  /**
   * @generated from enum value: PHASE_UNSPECIFIED = 0;
   */
  PHASE_UNSPECIFIED = 0,

  /**
   * @generated from enum value: CREATING = 1;
   */
  CREATING = 1,

  /**
   * @generated from enum value: STOPPED = 2;
   */
  STOPPED = 2,

  /**
   * @generated from enum value: STARTING = 3;
   */
  STARTING = 3,

  /**
   * @generated from enum value: RUNNING = 4;
   */
  RUNNING = 4,

  /**
   * @generated from enum value: STOPPING = 5;
   */
  STOPPING = 5,

  /**
   * @generated from enum value: RETAINED = 6;
   */
  RETAINED = 6,

  /**
   * @generated from enum value: DELETED = 7;
   */
  DELETED = 7,

  /**
   * @generated from enum value: FAILED = 8;
   */
  FAILED = 8,
}

/**
 * Describes the enum cube.runner.v4.MachineStatus.Phase.
 */
export declare const MachineStatus_PhaseSchema: GenEnum<MachineStatus_Phase>;

/**
 * The same fields as the guest helper's `hello` answer.
 *
 * @generated from message cube.runner.v4.GuestInfo
 */
export declare type GuestInfo = Message<"cube.runner.v4.GuestInfo"> & {
  /**
   * @generated from field: bool connected = 1;
   */
  connected: boolean;

  /**
   * Whether the guest takes `OPERATIONS`. cube-guest: its own check. A
   * keel agent says true once, for the current boot and connection, the
   * newest `MachineSetup` is applied (layers mounted, writable disk checked
   * and mounted, overlay assembled, `/var/lib/cube` and `/etc/cube` bound,
   * generated files and the runner's CA in place), its journal is
   * recovered, and the workload root has bash, sudo, flock, git, gh, curl
   * and a CA bundle. Until then it refuses guest operations other than
   * `hello` (UNAVAILABLE/not_ready) and `reason` says what is missing.
   * Hooks and services are not part of it.
   *
   * @generated from field: bool ready = 2;
   */
  ready: boolean;

  /**
   * sha256 of the helper.
   *
   * @generated from field: string build = 3;
   */
  build: string;

  /**
   * @generated from field: string version = 4;
   */
  version: string;

  /**
   * @generated from field: repeated string capabilities = 5;
   */
  capabilities: string[];

  /**
   * @generated from field: string os = 6;
   */
  os: string;

  /**
   * @generated from field: string kernel = 7;
   */
  kernel: string;

  /**
   * @generated from field: string boot_id = 8;
   */
  bootId: string;

  /**
   * hook -> ok | failed:N | skipped | notrun | absent
   *
   * @generated from field: map<string, string> hooks = 9;
   */
  hooks: { [key: string]: string };

  /**
   * @generated from field: string template_seal = 10;
   */
  templateSeal: string;

  /**
   * @generated from field: google.protobuf.Timestamp since = 11;
   */
  since?: Timestamp | undefined;

  /**
   * @generated from field: cube.runner.v4.GuestLimits limits = 12;
   */
  limits?: GuestLimits | undefined;

  /**
   * The newest workspace lease epoch the guest's journal has seen (the
   * `epoch` of `OPERATIONS`), not the machine's fence epoch.
   *
   * @generated from field: int64 epoch = 13;
   */
  epoch: bigint;

  /**
   * When `ready` is false: why, for people.
   *
   * @generated from field: string reason = 14;
   */
  reason: string;

  /**
   * keel: the guest channel's current session (`DaemonFrame.session`),
   * new with every `hello`.
   *
   * @generated from field: string session = 15;
   */
  session: string;
};

/**
 * Describes the message cube.runner.v4.GuestInfo.
 * Use `create(GuestInfoSchema)` to create a new message.
 */
export declare const GuestInfoSchema: GenMessage<GuestInfo>;

/**
 * What one guest operation may carry; cubed's `WorkspaceLimits`.
 *
 * @generated from message cube.runner.v4.GuestLimits
 */
export declare type GuestLimits = Message<"cube.runner.v4.GuestLimits"> & {
  /**
   * @generated from field: uint32 max_frame_bytes = 1;
   */
  maxFrameBytes: number;

  /**
   * @generated from field: uint32 request_timeout_ms = 2;
   */
  requestTimeoutMs: number;

  /**
   * @generated from field: uint32 max_command_bytes = 3;
   */
  maxCommandBytes: number;

  /**
   * @generated from field: uint32 max_path_bytes = 4;
   */
  maxPathBytes: number;

  /**
   * @generated from field: uint32 max_exec_timeout_ms = 5;
   */
  maxExecTimeoutMs: number;

  /**
   * @generated from field: uint32 max_output_bytes = 6;
   */
  maxOutputBytes: number;

  /**
   * @generated from field: uint32 output_page_bytes = 7;
   */
  outputPageBytes: number;

  /**
   * @generated from field: uint32 max_read_bytes = 8;
   */
  maxReadBytes: number;

  /**
   * @generated from field: uint32 max_write_bytes = 9;
   */
  maxWriteBytes: number;
};

/**
 * Describes the message cube.runner.v4.GuestLimits.
 * Use `create(GuestLimitsSchema)` to create a new message.
 */
export declare const GuestLimitsSchema: GenMessage<GuestLimits>;

/**
 * Sent with every machine_start and kept for that QEMU process; a new
 * machine_start replaces it. Absent: no egress (as DENY with no rules).
 * Host patterns: a lowercase name without a trailing dot, "*.suffix", or "*".
 * Order: deny_hosts, then the first rule whose hosts and ports match, then
 * default. Rule.ports: empty means the kind's port (http 80, https 443);
 * any port but 80 or 443 is INVALID_ARGUMENT. Https.credential goes through
 * the credential stream (`CredentialHeader`). Decide is UNIMPLEMENTED
 * (egress_decide).
 * CONNECT and Upgrade are always denied; a request carrying a cube_ph_
 * placeholder is denied unless a credential rule for its host matches.
 * lease: how long ordinary egress goes on after the runner loses its
 * connection to cubed (B5: 15 min); absent or 0 stops it at once. When it
 * runs out, new flows and requests are denied (lease_expired) and the
 * upstream connections of open flows closed; an open flow's guest side is
 * not reset: what was already on its way to the guest drains and TCP ends
 * it. The next connection from cubed ends the grace. Credential requests
 * need cubed and stop at once.
 *
 * @generated from message cube.runner.v4.EgressPolicy
 */
export declare type EgressPolicy = Message<"cube.runner.v4.EgressPolicy"> & {
  /**
   * @generated from field: cube.runner.v4.EgressPolicy.Default default = 1;
   */
  default: EgressPolicy_Default;

  /**
   * @generated from field: repeated string deny_hosts = 2;
   */
  denyHosts: string[];

  /**
   * @generated from field: repeated cube.runner.v4.EgressPolicy.Rule rules = 3;
   */
  rules: EgressPolicy_Rule[];

  /**
   * @generated from field: google.protobuf.Duration lease = 4;
   */
  lease?: Duration | undefined;
};

/**
 * Describes the message cube.runner.v4.EgressPolicy.
 * Use `create(EgressPolicySchema)` to create a new message.
 */
export declare const EgressPolicySchema: GenMessage<EgressPolicy>;

/**
 * @generated from message cube.runner.v4.EgressPolicy.Rule
 */
export declare type EgressPolicy_Rule = Message<"cube.runner.v4.EgressPolicy.Rule"> & {
  /**
   * @generated from field: repeated string hosts = 1;
   */
  hosts: string[];

  /**
   * @generated from field: repeated uint32 ports = 2;
   */
  ports: number[];

  /**
   * @generated from oneof cube.runner.v4.EgressPolicy.Rule.kind
   */
  kind: {
    /**
     * @generated from field: cube.runner.v4.EgressPolicy.Https https = 3;
     */
    value: EgressPolicy_Https;
    case: "https";
  } | {
    /**
     * @generated from field: cube.runner.v4.EgressPolicy.Http http = 4;
     */
    value: EgressPolicy_Http;
    case: "http";
  } | {
    /**
     * @generated from field: cube.runner.v4.EgressPolicy.Decide decide = 5;
     */
    value: EgressPolicy_Decide;
    case: "decide";
  } | { case: undefined; value?: undefined };
};

/**
 * Describes the message cube.runner.v4.EgressPolicy.Rule.
 * Use `create(EgressPolicy_RuleSchema)` to create a new message.
 */
export declare const EgressPolicy_RuleSchema: GenMessage<EgressPolicy_Rule>;

/**
 * @generated from message cube.runner.v4.EgressPolicy.Https
 */
export declare type EgressPolicy_Https = Message<"cube.runner.v4.EgressPolicy.Https"> & {
  /**
   * @generated from field: cube.runner.v4.EgressPolicy.Credential credential = 1;
   */
  credential?: EgressPolicy_Credential | undefined;
};

/**
 * Describes the message cube.runner.v4.EgressPolicy.Https.
 * Use `create(EgressPolicy_HttpsSchema)` to create a new message.
 */
export declare const EgressPolicy_HttpsSchema: GenMessage<EgressPolicy_Https>;

/**
 * @generated from message cube.runner.v4.EgressPolicy.Http
 */
export declare type EgressPolicy_Http = Message<"cube.runner.v4.EgressPolicy.Http"> & {
};

/**
 * Describes the message cube.runner.v4.EgressPolicy.Http.
 * Use `create(EgressPolicy_HttpSchema)` to create a new message.
 */
export declare const EgressPolicy_HttpSchema: GenMessage<EgressPolicy_Http>;

/**
 * @generated from message cube.runner.v4.EgressPolicy.Decide
 */
export declare type EgressPolicy_Decide = Message<"cube.runner.v4.EgressPolicy.Decide"> & {
};

/**
 * Describes the message cube.runner.v4.EgressPolicy.Decide.
 * Use `create(EgressPolicy_DecideSchema)` to create a new message.
 */
export declare const EgressPolicy_DecideSchema: GenMessage<EgressPolicy_Decide>;

/**
 * @generated from message cube.runner.v4.EgressPolicy.Credential
 */
export declare type EgressPolicy_Credential = Message<"cube.runner.v4.EgressPolicy.Credential"> & {
  /**
   * @generated from field: string name = 1;
   */
  name: string;
};

/**
 * Describes the message cube.runner.v4.EgressPolicy.Credential.
 * Use `create(EgressPolicy_CredentialSchema)` to create a new message.
 */
export declare const EgressPolicy_CredentialSchema: GenMessage<EgressPolicy_Credential>;

/**
 * @generated from enum cube.runner.v4.EgressPolicy.Default
 */
export enum EgressPolicy_Default {
  /**
   * @generated from enum value: DEFAULT_UNSPECIFIED = 0;
   */
  DEFAULT_UNSPECIFIED = 0,

  /**
   * @generated from enum value: DENY = 1;
   */
  DENY = 1,

  /**
   * @generated from enum value: ALLOW_PUBLIC_HTTP = 2;
   */
  ALLOW_PUBLIC_HTTP = 2,
}

/**
 * Describes the enum cube.runner.v4.EgressPolicy.Default.
 */
export declare const EgressPolicy_DefaultSchema: GenEnum<EgressPolicy_Default>;

/**
 * @generated from message cube.runner.v4.Template
 */
export declare type Template = Message<"cube.runner.v4.Template"> & {
  /**
   * @generated from field: string id = 1;
   */
  id: string;

  /**
   * @generated from field: string key = 2;
   */
  key: string;

  /**
   * @generated from field: string meta = 3;
   */
  meta: string;

  /**
   * @generated from field: cube.runner.v4.Template.State state = 4;
   */
  state: Template_State;

  /**
   * @generated from field: uint32 disk_gib = 5;
   */
  diskGib: number;

  /**
   * @generated from field: uint64 bytes = 6;
   */
  bytes: bigint;

  /**
   * @generated from field: uint32 users = 7;
   */
  users: number;

  /**
   * @generated from field: google.protobuf.Timestamp created_at = 8;
   */
  createdAt?: Timestamp | undefined;
};

/**
 * Describes the message cube.runner.v4.Template.
 * Use `create(TemplateSchema)` to create a new message.
 */
export declare const TemplateSchema: GenMessage<Template>;

/**
 * @generated from enum cube.runner.v4.Template.State
 */
export enum Template_State {
  /**
   * @generated from enum value: STATE_UNSPECIFIED = 0;
   */
  STATE_UNSPECIFIED = 0,

  /**
   * @generated from enum value: READY = 1;
   */
  READY = 1,

  /**
   * @generated from enum value: REMOVING = 2;
   */
  REMOVING = 2,
}

/**
 * Describes the enum cube.runner.v4.Template.State.
 */
export declare const Template_StateSchema: GenEnum<Template_State>;

/**
 * @generated from message cube.runner.v4.Call
 */
export declare type Call = Message<"cube.runner.v4.Call"> & {
  /**
   * @generated from oneof cube.runner.v4.Call.verb
   */
  verb: {
    /**
     * @generated from field: cube.runner.v4.Empty runner_get = 1;
     */
    value: Empty;
    case: "runnerGet";
  } | {
    /**
     * @generated from field: cube.runner.v4.MachineCreate machine_create = 10;
     */
    value: MachineCreate;
    case: "machineCreate";
  } | {
    /**
     * @generated from field: cube.runner.v4.MachineStart machine_start = 11;
     */
    value: MachineStart;
    case: "machineStart";
  } | {
    /**
     * @generated from field: cube.runner.v4.MachineRef machine_stop = 12;
     */
    value: MachineRef;
    case: "machineStop";
  } | {
    /**
     * @generated from field: cube.runner.v4.MachineDelete machine_delete = 13;
     */
    value: MachineDelete;
    case: "machineDelete";
  } | {
    /**
     * @generated from field: cube.runner.v4.MachineRef machine_discard = 14;
     */
    value: MachineRef;
    case: "machineDiscard";
  } | {
    /**
     * @generated from field: cube.runner.v4.MachineRef machine_get = 15;
     */
    value: MachineRef;
    case: "machineGet";
  } | {
    /**
     * @generated from field: cube.runner.v4.Empty machine_list = 16;
     */
    value: Empty;
    case: "machineList";
  } | {
    /**
     * @generated from field: cube.runner.v4.MachineRef machine_diagnose = 17;
     */
    value: MachineRef;
    case: "machineDiagnose";
  } | {
    /**
     * @generated from field: cube.runner.v4.TemplatePublish template_publish = 20;
     */
    value: TemplatePublish;
    case: "templatePublish";
  } | {
    /**
     * @generated from field: cube.runner.v4.Empty template_list = 21;
     */
    value: Empty;
    case: "templateList";
  } | {
    /**
     * @generated from field: cube.runner.v4.TemplateRef template_delete = 22;
     */
    value: TemplateRef;
    case: "templateDelete";
  } | { case: undefined; value?: undefined };
};

/**
 * Describes the message cube.runner.v4.Call.
 * Use `create(CallSchema)` to create a new message.
 */
export declare const CallSchema: GenMessage<Call>;

/**
 * @generated from message cube.runner.v4.MachineRef
 */
export declare type MachineRef = Message<"cube.runner.v4.MachineRef"> & {
  /**
   * @generated from field: cube.runner.v4.Ref ref = 1;
   */
  ref?: Ref | undefined;

  /**
   * @generated from field: cube.runner.v4.Fence fence = 2;
   */
  fence?: Fence | undefined;
};

/**
 * Describes the message cube.runner.v4.MachineRef.
 * Use `create(MachineRefSchema)` to create a new message.
 */
export declare const MachineRefSchema: GenMessage<MachineRef>;

/**
 * @generated from message cube.runner.v4.MachineCreate
 */
export declare type MachineCreate = Message<"cube.runner.v4.MachineCreate"> & {
  /**
   * @generated from field: cube.runner.v4.Ref ref = 1;
   */
  ref?: Ref | undefined;

  /**
   * @generated from field: cube.runner.v4.Fence fence = 2;
   */
  fence?: Fence | undefined;

  /**
   * @generated from field: cube.runner.v4.MachineSpec spec = 3;
   */
  spec?: MachineSpec | undefined;
};

/**
 * Describes the message cube.runner.v4.MachineCreate.
 * Use `create(MachineCreateSchema)` to create a new message.
 */
export declare const MachineCreateSchema: GenMessage<MachineCreate>;

/**
 * @generated from message cube.runner.v4.MachineStart
 */
export declare type MachineStart = Message<"cube.runner.v4.MachineStart"> & {
  /**
   * @generated from field: cube.runner.v4.Ref ref = 1;
   */
  ref?: Ref | undefined;

  /**
   * @generated from field: cube.runner.v4.Fence fence = 2;
   */
  fence?: Fence | undefined;

  /**
   * @generated from field: cube.runner.v4.Size size = 3;
   */
  size?: Size | undefined;

  /**
   * @generated from field: cube.runner.v4.Boot boot = 4;
   */
  boot?: Boot | undefined;

  /**
   * @generated from field: cube.runner.v4.EgressPolicy policy = 5;
   */
  policy?: EgressPolicy | undefined;
};

/**
 * Describes the message cube.runner.v4.MachineStart.
 * Use `create(MachineStartSchema)` to create a new message.
 */
export declare const MachineStartSchema: GenMessage<MachineStart>;

/**
 * @generated from message cube.runner.v4.MachineDelete
 */
export declare type MachineDelete = Message<"cube.runner.v4.MachineDelete"> & {
  /**
   * @generated from field: cube.runner.v4.Ref ref = 1;
   */
  ref?: Ref | undefined;

  /**
   * @generated from field: cube.runner.v4.Fence fence = 2;
   */
  fence?: Fence | undefined;

  /**
   * @generated from field: bool retain = 3;
   */
  retain: boolean;
};

/**
 * Describes the message cube.runner.v4.MachineDelete.
 * Use `create(MachineDeleteSchema)` to create a new message.
 */
export declare const MachineDeleteSchema: GenMessage<MachineDelete>;

/**
 * @generated from message cube.runner.v4.TemplatePublish
 */
export declare type TemplatePublish = Message<"cube.runner.v4.TemplatePublish"> & {
  /**
   * @generated from field: cube.runner.v4.Ref from = 1;
   */
  from?: Ref | undefined;

  /**
   * @generated from field: cube.runner.v4.Fence fence = 2;
   */
  fence?: Fence | undefined;

  /**
   * @generated from field: string key = 3;
   */
  key: string;

  /**
   * @generated from field: string meta = 4;
   */
  meta: string;
};

/**
 * Describes the message cube.runner.v4.TemplatePublish.
 * Use `create(TemplatePublishSchema)` to create a new message.
 */
export declare const TemplatePublishSchema: GenMessage<TemplatePublish>;

/**
 * @generated from message cube.runner.v4.TemplateRef
 */
export declare type TemplateRef = Message<"cube.runner.v4.TemplateRef"> & {
  /**
   * @generated from field: string id = 1;
   */
  id: string;
};

/**
 * Describes the message cube.runner.v4.TemplateRef.
 * Use `create(TemplateRefSchema)` to create a new message.
 */
export declare const TemplateRefSchema: GenMessage<TemplateRef>;

/**
 * @generated from message cube.runner.v4.CallResult
 */
export declare type CallResult = Message<"cube.runner.v4.CallResult"> & {
  /**
   * @generated from oneof cube.runner.v4.CallResult.result
   */
  result: {
    /**
     * @generated from field: cube.runner.v4.Error error = 1;
     */
    value: Error;
    case: "error";
  } | {
    /**
     * @generated from field: cube.runner.v4.Runner runner = 2;
     */
    value: Runner;
    case: "runner";
  } | {
    /**
     * @generated from field: cube.runner.v4.Machine machine = 3;
     */
    value: Machine;
    case: "machine";
  } | {
    /**
     * @generated from field: cube.runner.v4.Machines machines = 4;
     */
    value: Machines;
    case: "machines";
  } | {
    /**
     * @generated from field: cube.runner.v4.Template template = 5;
     */
    value: Template;
    case: "template";
  } | {
    /**
     * @generated from field: cube.runner.v4.Templates templates = 6;
     */
    value: Templates;
    case: "templates";
  } | {
    /**
     * @generated from field: cube.runner.v4.Diagnosis diagnosis = 7;
     */
    value: Diagnosis;
    case: "diagnosis";
  } | { case: undefined; value?: undefined };
};

/**
 * Describes the message cube.runner.v4.CallResult.
 * Use `create(CallResultSchema)` to create a new message.
 */
export declare const CallResultSchema: GenMessage<CallResult>;

/**
 * @generated from message cube.runner.v4.Machines
 */
export declare type Machines = Message<"cube.runner.v4.Machines"> & {
  /**
   * @generated from field: repeated cube.runner.v4.Machine items = 1;
   */
  items: Machine[];

  /**
   * @generated from field: int64 version = 2;
   */
  version: bigint;
};

/**
 * Describes the message cube.runner.v4.Machines.
 * Use `create(MachinesSchema)` to create a new message.
 */
export declare const MachinesSchema: GenMessage<Machines>;

/**
 * @generated from message cube.runner.v4.Templates
 */
export declare type Templates = Message<"cube.runner.v4.Templates"> & {
  /**
   * @generated from field: repeated cube.runner.v4.Template items = 1;
   */
  items: Template[];
};

/**
 * Describes the message cube.runner.v4.Templates.
 * Use `create(TemplatesSchema)` to create a new message.
 */
export declare const TemplatesSchema: GenMessage<Templates>;

/**
 * @generated from message cube.runner.v4.Diagnosis
 */
export declare type Diagnosis = Message<"cube.runner.v4.Diagnosis"> & {
  /**
   * @generated from field: string json = 1;
   */
  json: string;
};

/**
 * Describes the message cube.runner.v4.Diagnosis.
 * Use `create(DiagnosisSchema)` to create a new message.
 */
export declare const DiagnosisSchema: GenMessage<Diagnosis>;

/**
 * @generated from message cube.runner.v4.WatchRequest
 */
export declare type WatchRequest = Message<"cube.runner.v4.WatchRequest"> & {
  /**
   * @generated from field: int64 since_version = 1;
   */
  sinceVersion: bigint;
};

/**
 * Describes the message cube.runner.v4.WatchRequest.
 * Use `create(WatchRequestSchema)` to create a new message.
 */
export declare const WatchRequestSchema: GenMessage<WatchRequest>;

/**
 * @generated from message cube.runner.v4.WatchEvent
 */
export declare type WatchEvent = Message<"cube.runner.v4.WatchEvent"> & {
  /**
   * @generated from field: cube.runner.v4.WatchEvent.Type type = 1;
   */
  type: WatchEvent_Type;

  /**
   * @generated from field: int64 version = 2;
   */
  version: bigint;

  /**
   * @generated from oneof cube.runner.v4.WatchEvent.resource
   */
  resource: {
    /**
     * @generated from field: cube.runner.v4.Machine machine = 3;
     */
    value: Machine;
    case: "machine";
  } | {
    /**
     * @generated from field: cube.runner.v4.Template template = 4;
     */
    value: Template;
    case: "template";
  } | {
    /**
     * @generated from field: cube.runner.v4.Runner runner = 5;
     */
    value: Runner;
    case: "runner";
  } | { case: undefined; value?: undefined };
};

/**
 * Describes the message cube.runner.v4.WatchEvent.
 * Use `create(WatchEventSchema)` to create a new message.
 */
export declare const WatchEventSchema: GenMessage<WatchEvent>;

/**
 * @generated from enum cube.runner.v4.WatchEvent.Type
 */
export enum WatchEvent_Type {
  /**
   * @generated from enum value: TYPE_UNSPECIFIED = 0;
   */
  TYPE_UNSPECIFIED = 0,

  /**
   * @generated from enum value: PUT = 1;
   */
  PUT = 1,

  /**
   * @generated from enum value: DELETE = 2;
   */
  DELETE = 2,

  /**
   * @generated from enum value: BOOKMARK = 3;
   */
  BOOKMARK = 3,

  /**
   * The runner cannot replay from `since_version`: every resource follows
   * as PUT, then a BOOKMARK.
   *
   * @generated from enum value: RESET = 4;
   */
  RESET = 4,
}

/**
 * Describes the enum cube.runner.v4.WatchEvent.Type.
 */
export declare const WatchEvent_TypeSchema: GenEnum<WatchEvent_Type>;

/**
 * @generated from message cube.runner.v4.GuestHeader
 */
export declare type GuestHeader = Message<"cube.runner.v4.GuestHeader"> & {
  /**
   * @generated from field: cube.runner.v4.Ref ref = 1;
   */
  ref?: Ref | undefined;

  /**
   * @generated from field: cube.runner.v4.Fence fence = 2;
   */
  fence?: Fence | undefined;

  /**
   * A cube-guest operation name (hello, exec, get, ...).
   *
   * @generated from field: string op = 3;
   */
  op: string;
};

/**
 * Describes the message cube.runner.v4.GuestHeader.
 * Use `create(GuestHeaderSchema)` to create a new message.
 */
export declare const GuestHeaderSchema: GenMessage<GuestHeader>;

/**
 * The first frame of a `dial` stream (cubed's portal, masterplan B-6): a
 * TCP connection from the runner to `port` of a running machine, fenced
 * as `guest` is. A VM runner refuses ports below 1024
 * (PERMISSION_DENIED/port; 22 too), a machine it does not run
 * (UNAVAILABLE/not_running), and a port where the guest does not answer
 * within 10 s (UNAVAILABLE/dial_failed). Each direction of the bytes that
 * follow `StreamAnswer` ends on its own (FIN to FIN); a reset or a lost
 * connection drops the guest's connection. It needs cubed's connection and
 * nothing else: the egress lease does not apply.
 *
 * @generated from message cube.runner.v4.DialHeader
 */
export declare type DialHeader = Message<"cube.runner.v4.DialHeader"> & {
  /**
   * @generated from field: cube.runner.v4.Ref ref = 1;
   */
  ref?: Ref | undefined;

  /**
   * @generated from field: cube.runner.v4.Fence fence = 2;
   */
  fence?: Fence | undefined;

  /**
   * @generated from field: uint32 port = 3;
   */
  port: number;
};

/**
 * Describes the message cube.runner.v4.DialHeader.
 * Use `create(DialHeaderSchema)` to create a new message.
 */
export declare const DialHeaderSchema: GenMessage<DialHeader>;

/**
 * The first frame of a `credential` stream (B-5). The runner opens one per
 * guest request to a host and port a credential rule matched, on its
 * connection from cubed, and never without one: with no connection it
 * refuses the request at once (503, credential_unavailable); the egress
 * lease does not apply. cubed checks, before anything reaches its proxy,
 * that `ref` is a machine of a thread placed on this runner (else
 * PERMISSION_DENIED/wrong_machine) and that `fence` is not older than the
 * thread's newest epoch (else FAILED_PRECONDITION/stale_epoch); then it
 * answers `StreamAnswer` and passes the bytes on unread. The request is
 * the guest's, placeholder and all: the token exists only in cubed's
 * proxy, which needs Host = `sni` = `host`, port 443, every placeholder to
 * be of `credential` and belong to the thread, and cubed's decision. The
 * proxy follows no redirect and adds no credential of its own; it asks for
 * `Accept-Encoding: identity`, refuses an encoded answer (502), and turns
 * what it substituted back into the guest's placeholder in the answer's
 * headers and body. No limit on body size or total time; the answer ends
 * when the stream does (cubed gone: what the runner already has goes to
 * the guest, then the guest's connection ends as on an upstream failure).
 *
 * @generated from message cube.runner.v4.CredentialHeader
 */
export declare type CredentialHeader = Message<"cube.runner.v4.CredentialHeader"> & {
  /**
   * @generated from field: cube.runner.v4.Ref ref = 1;
   */
  ref?: Ref | undefined;

  /**
   * The rule's `EgressPolicy.Credential.name`.
   *
   * @generated from field: string credential = 2;
   */
  credential: string;

  /**
   * The guest's TLS server name, and the request's host and port.
   *
   * @generated from field: string sni = 3;
   */
  sni: string;

  /**
   * @generated from field: string host = 5;
   */
  host: string;

  /**
   * @generated from field: uint32 port = 6;
   */
  port: number;

  /**
   * The machine's fence epoch as the runner last recorded it.
   *
   * @generated from field: cube.runner.v4.Fence fence = 9;
   */
  fence?: Fence | undefined;
};

/**
 * Describes the message cube.runner.v4.CredentialHeader.
 * Use `create(CredentialHeaderSchema)` to create a new message.
 */
export declare const CredentialHeaderSchema: GenMessage<CredentialHeader>;

/**
 * @generated from message cube.runner.v4.Header
 */
export declare type Header = Message<"cube.runner.v4.Header"> & {
  /**
   * @generated from field: string name = 1;
   */
  name: string;

  /**
   * @generated from field: bytes value = 2;
   */
  value: Uint8Array;
};

/**
 * Describes the message cube.runner.v4.Header.
 * Use `create(HeaderSchema)` to create a new message.
 */
export declare const HeaderSchema: GenMessage<Header>;

/**
 * @generated from message cube.runner.v4.ReportHeader
 */
export declare type ReportHeader = Message<"cube.runner.v4.ReportHeader"> & {
};

/**
 * Describes the message cube.runner.v4.ReportHeader.
 * Use `create(ReportHeaderSchema)` to create a new message.
 */
export declare const ReportHeaderSchema: GenMessage<ReportHeader>;

/**
 * A refused egress attempt, for diagnosis. reason: lease_expired | policy |
 * deny_host | connect | upgrade | placeholder | credential_unavailable |
 * address | sni_mismatch | resolve_failed. dropped_before: how many reports
 * the runner dropped (its queue full) just before this one.
 *
 * @generated from message cube.runner.v4.EgressReport
 */
export declare type EgressReport = Message<"cube.runner.v4.EgressReport"> & {
  /**
   * @generated from field: cube.runner.v4.Ref ref = 1;
   */
  ref?: Ref | undefined;

  /**
   * @generated from field: string host = 2;
   */
  host: string;

  /**
   * @generated from field: string reason = 3;
   */
  reason: string;

  /**
   * @generated from field: uint64 dropped_before = 4;
   */
  droppedBefore: bigint;

  /**
   * @generated from field: google.protobuf.Timestamp at = 5;
   */
  at?: Timestamp | undefined;
};

/**
 * Describes the message cube.runner.v4.EgressReport.
 * Use `create(EgressReportSchema)` to create a new message.
 */
export declare const EgressReportSchema: GenMessage<EgressReport>;

/**
 * @generated from message cube.runner.v4.DaemonFrame
 */
export declare type DaemonFrame = Message<"cube.runner.v4.DaemonFrame"> & {
  /**
   * @generated from field: uint32 ch = 1;
   */
  ch: number;

  /**
   * @generated from oneof cube.runner.v4.DaemonFrame.t
   */
  t: {
    /**
     * @generated from field: cube.runner.v4.GuestInfo hello = 2;
     */
    value: GuestInfo;
    case: "hello";
  } | {
    /**
     * @generated from field: cube.runner.v4.GuestInfo status = 3;
     */
    value: GuestInfo;
    case: "status";
  } | {
    /**
     * @generated from field: cube.runner.v4.DaemonRequest req = 4;
     */
    value: DaemonRequest;
    case: "req";
  } | {
    /**
     * @generated from field: cube.runner.v4.DaemonAnswer ans = 5;
     */
    value: DaemonAnswer;
    case: "ans";
  } | {
    /**
     * @generated from field: cube.runner.v4.Empty abort = 6;
     */
    value: Empty;
    case: "abort";
  } | { case: undefined; value?: undefined };

  /**
   * The session the frame belongs to (see the header); empty only on the
   * runner's reset on channel 0.
   *
   * @generated from field: string session = 7;
   */
  session: string;
};

/**
 * Describes the message cube.runner.v4.DaemonFrame.
 * Use `create(DaemonFrameSchema)` to create a new message.
 */
export declare const DaemonFrameSchema: GenMessage<DaemonFrame>;

/**
 * @generated from message cube.runner.v4.DaemonRequest
 */
export declare type DaemonRequest = Message<"cube.runner.v4.DaemonRequest"> & {
  /**
   * @generated from oneof cube.runner.v4.DaemonRequest.op
   */
  op: {
    /**
     * A `guest` stream's operation, forwarded as cubed sent it.
     *
     * @generated from field: cube.runner.v4.GuestRequest guest = 1;
     */
    value: GuestRequest;
    case: "guest";
  } | {
    /**
     * The runner's own, sent after every `hello`. Idempotent: the agent
     * applies what changed. Layers cannot change under a running workload
     * (FAILED_PRECONDITION/layers_changed; the runner boots it cold).
     *
     * @generated from field: cube.runner.v4.MachineSetup machine_setup = 2;
     */
    value: MachineSetup;
    case: "machineSetup";
  } | {
    /**
     * Right before a save (`stop`): the agent waits for the requests that
     * write to answer, syncs, drops the page cache and compacts memory, so
     * free page reporting can return what it freed, then answers `done` and
     * sends a `status` that is not ready ("prepared for a snapshot"). From
     * then on it holds every new request and every answer still to come
     * until `snapshot_done` (the save failed and the runner sent `cont`, or
     * the machine keeps running: what was held goes on) or the end of the
     * connection (the machine was saved: what was held is dropped, never
     * run, and after the restore the runner asks again by key). A prepare
     * that cannot settle the machine is refused and leaves it unprepared.
     *
     * @generated from field: cube.runner.v4.Empty snapshot_prepare = 3;
     */
    value: Empty;
    case: "snapshotPrepare";
  } | {
    /**
     * Ends a prepare; `done` also when nothing was prepared.
     *
     * @generated from field: cube.runner.v4.Empty snapshot_done = 4;
     */
    value: Empty;
    case: "snapshotDone";
  } | {
    /**
     * A build machine only (its template disk, vdd): the agent kills the
     * workload, cleans the overlay's writable layer of cube's files (the
     * runner's CA in any form, marker blocks, mount points, the agent
     * account, identity), checks it and writes it to vdd as one EROFS
     * layer, then answers `done`; the runner checks the superblock and keeps
     * the disk as the template. The machine refuses everything afterwards
     * and is powered off; a repeated request gets the same outcome.
     *
     * @generated from field: cube.runner.v4.Empty template_publish = 5;
     */
    value: Empty;
    case: "templatePublish";
  } | {
    /**
     * The runner's controlled stop (`machine_stop`): the agent holds new
     * requests and waits for those that write, stops starting services and
     * recording command ends (cut-off commands are interrupted after the next
     * boot), sends SIGTERM to every workload process, SIGKILL to what is left
     * after 10 s, syncs and unmounts the writable disk or remounts it
     * read-only. It answers `done` only when that held: everything written
     * is on the disk and the disk's teardown succeeded; else an error. It
     * refuses everything afterwards; the guest does not power off. The
     * runner then quits QEMU and records a controlled stop; without `done`
     * within 30 s (no session, an error, no answer) it quits QEMU anyway and
     * records a forced stop.
     *
     * @generated from field: cube.runner.v4.Empty shutdown = 6;
     */
    value: Empty;
    case: "shutdown";
  } | { case: undefined; value?: undefined };
};

/**
 * Describes the message cube.runner.v4.DaemonRequest.
 * Use `create(DaemonRequestSchema)` to create a new message.
 */
export declare const DaemonRequestSchema: GenMessage<DaemonRequest>;

/**
 * @generated from message cube.runner.v4.GuestRequest
 */
export declare type GuestRequest = Message<"cube.runner.v4.GuestRequest"> & {
  /**
   * `GuestHeader.op`: lowercase ASCII letters.
   *
   * @generated from field: string op = 1;
   */
  op: string;

  /**
   * The operation's request bytes (one JSON line and a raw body).
   *
   * @generated from field: bytes data = 2;
   */
  data: Uint8Array;
};

/**
 * Describes the message cube.runner.v4.GuestRequest.
 * Use `create(GuestRequestSchema)` to create a new message.
 */
export declare const GuestRequestSchema: GenMessage<GuestRequest>;

/**
 * @generated from message cube.runner.v4.DaemonAnswer
 */
export declare type DaemonAnswer = Message<"cube.runner.v4.DaemonAnswer"> & {
  /**
   * @generated from oneof cube.runner.v4.DaemonAnswer.result
   */
  result: {
    /**
     * A guest operation's answer bytes as the agent wrote them; its own
     * errors are inside, as `OPERATIONS` writes them.
     *
     * @generated from field: bytes guest = 1;
     */
    value: Uint8Array;
    case: "guest";
  } | {
    /**
     * The agent could not take the request (not ready, a setup it refuses,
     * a snapshot prepare it could not complete). The runner answers a
     * `guest` stream with it in `StreamAnswer`.
     *
     * @generated from field: cube.runner.v4.Error error = 2;
     */
    value: Error;
    case: "error";
  } | {
    /**
     * A runner operation is done.
     *
     * @generated from field: cube.runner.v4.Empty done = 3;
     */
    value: Empty;
    case: "done";
  } | { case: undefined; value?: undefined };
};

/**
 * Describes the message cube.runner.v4.DaemonAnswer.
 * Use `create(DaemonAnswerSchema)` to create a new message.
 */
export declare const DaemonAnswerSchema: GenMessage<DaemonAnswer>;

/**
 * What the agent needs to assemble the machine; nothing in it is secret
 * (placeholders are not secrets).
 *
 * @generated from message cube.runner.v4.MachineSetup
 */
export declare type MachineSetup = Message<"cube.runner.v4.MachineSetup"> & {
  /**
   * @generated from field: cube.runner.v4.Ref ref = 1;
   */
  ref?: Ref | undefined;

  /**
   * `Boot.documents` from `MachineStart`, unchanged.
   *
   * @generated from field: map<string, bytes> documents = 2;
   */
  documents: { [key: string]: Uint8Array };

  /**
   * At least 32 fresh bytes per send, mixed into the guest's random pool:
   * a machine restored from a snapshot must not repeat another's numbers.
   *
   * @generated from field: bytes entropy = 3;
   */
  entropy: Uint8Array;

  /**
   * The workload root's lower layers, topmost first (overlayfs `lowerdir`
   * order). Disks are fixed by keel's QEMU arguments: vda the base, vdb the
   * layer disk, vdc the writable disk.
   *
   * @generated from field: repeated cube.runner.v4.Layer layers = 4;
   */
  layers: Layer[];

  /**
   * @generated from field: cube.runner.v4.ImageConfig image = 5;
   */
  image?: ImageConfig | undefined;

  /**
   * The runner's egress CA (`Runner.ca_pem`), added to the image's bundle.
   *
   * @generated from field: string ca_pem = 6;
   */
  caPem: string;

  /**
   * @generated from field: string runner_version = 7;
   */
  runnerVersion: string;

  /**
   * @generated from field: uint32 protocol = 8;
   */
  protocol: number;

  /**
   * What the runner uses of the agent, so either side can tell an older or
   * newer other side.
   *
   * @generated from field: repeated string capabilities = 9;
   */
  capabilities: string[];
};

/**
 * Describes the message cube.runner.v4.MachineSetup.
 * Use `create(MachineSetupSchema)` to create a new message.
 */
export declare const MachineSetupSchema: GenMessage<MachineSetup>;

/**
 * @generated from message cube.runner.v4.Layer
 */
export declare type Layer = Message<"cube.runner.v4.Layer"> & {
  /**
   * The GPT partition on the layer disk (vdb1 is 1), EROFS.
   *
   * @generated from field: uint32 partition = 1;
   */
  partition: number;

  /**
   * @generated from oneof cube.runner.v4.Layer.source
   */
  source: {
    /**
     * An OCI layer's uncompressed digest, `sha256:<hex>`.
     *
     * @generated from field: string diff_id = 2;
     */
    value: string;
    case: "diffId";
  } | {
    /**
     * A template published on this runner.
     *
     * @generated from field: string template_id = 3;
     */
    value: string;
    case: "templateId";
  } | { case: undefined; value?: undefined };
};

/**
 * Describes the message cube.runner.v4.Layer.
 * Use `create(LayerSchema)` to create a new message.
 */
export declare const LayerSchema: GenMessage<Layer>;

/**
 * The parts of the image's OCI configuration keel uses. `User` and
 * `WorkingDir` are not: commands run as `agent` in `/workspace`.
 *
 * @generated from message cube.runner.v4.ImageConfig
 */
export declare type ImageConfig = Message<"cube.runner.v4.ImageConfig"> & {
  /**
   * The manifest's digest, `sha256:<hex>`.
   *
   * @generated from field: string digest = 1;
   */
  digest: string;

  /**
   * `NAME=value`, applied before cube's environment.
   *
   * @generated from field: repeated string env = 2;
   */
  env: string[];
};

/**
 * Describes the message cube.runner.v4.ImageConfig.
 * Use `create(ImageConfigSchema)` to create a new message.
 */
export declare const ImageConfigSchema: GenMessage<ImageConfig>;

/**
 * @generated from enum cube.runner.v4.Code
 */
export enum Code {
  /**
   * @generated from enum value: CODE_UNSPECIFIED = 0;
   */
  CODE_UNSPECIFIED = 0,

  /**
   * @generated from enum value: NOT_FOUND = 1;
   */
  NOT_FOUND = 1,

  /**
   * @generated from enum value: ALREADY_EXISTS = 2;
   */
  ALREADY_EXISTS = 2,

  /**
   * @generated from enum value: FAILED_PRECONDITION = 3;
   */
  FAILED_PRECONDITION = 3,

  /**
   * @generated from enum value: RESOURCE_EXHAUSTED = 4;
   */
  RESOURCE_EXHAUSTED = 4,

  /**
   * @generated from enum value: UNAVAILABLE = 5;
   */
  UNAVAILABLE = 5,

  /**
   * @generated from enum value: PERMISSION_DENIED = 6;
   */
  PERMISSION_DENIED = 6,

  /**
   * @generated from enum value: INVALID_ARGUMENT = 7;
   */
  INVALID_ARGUMENT = 7,

  /**
   * @generated from enum value: UNIMPLEMENTED = 8;
   */
  UNIMPLEMENTED = 8,

  /**
   * @generated from enum value: INTERNAL = 9;
   */
  INTERNAL = 9,

  /**
   * @generated from enum value: ABORTED = 10;
   */
  ABORTED = 10,
}

/**
 * Describes the enum cube.runner.v4.Code.
 */
export declare const CodeSchema: GenEnum<Code>;

