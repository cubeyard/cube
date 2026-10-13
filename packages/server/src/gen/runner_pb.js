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

import { enumDesc, fileDesc, messageDesc, tsEnum } from "@bufbuild/protobuf/codegenv2";
import { file_google_protobuf_duration, file_google_protobuf_timestamp } from "@bufbuild/protobuf/wkt";

/**
 * Describes the file runner.proto.
 */
export const file_runner = /*@__PURE__*/
  fileDesc("CgxydW5uZXIucHJvdG8SDmN1YmUucnVubmVyLnY0IiAKA1JlZhINCgVvd25lchgBIAEoCRIKCgJpZBgCIAEoCSIWCgVGZW5jZRINCgVlcG9jaBgBIAEoAyJECgRNZXRhEg8KB3ZlcnNpb24YASABKAMSKwoHdXBkYXRlZBgCIAEoCzIaLmdvb2dsZS5wcm90b2J1Zi5UaW1lc3RhbXAidQoJQ29uZGl0aW9uEgwKBHR5cGUYASABKAkSDgoGc3RhdHVzGAIgASgIEg4KBnJlYXNvbhgDIAEoCRIPCgdtZXNzYWdlGAQgASgJEikKBXNpbmNlGAUgASgLMhouZ29vZ2xlLnByb3RvYnVmLlRpbWVzdGFtcCJoCgVFcnJvchIiCgRjb2RlGAEgASgOMhQuY3ViZS5ydW5uZXIudjQuQ29kZRIOCgZyZWFzb24YAiABKAkSDwoHbWVzc2FnZRgDIAEoCRIaChJjb21wbGV0aW9uX3Vua25vd24YBCABKAgiBwoFRW1wdHkizQIKBE9wZW4SJgoFaGVsbG8YASABKAsyFS5jdWJlLnJ1bm5lci52NC5IZWxsb0gAEiQKBGNhbGwYAiABKAsyFC5jdWJlLnJ1bm5lci52NC5DYWxsSAASLQoFd2F0Y2gYAyABKAsyHC5jdWJlLnJ1bm5lci52NC5XYXRjaFJlcXVlc3RIABIsCgVndWVzdBgEIAEoCzIbLmN1YmUucnVubmVyLnY0Lkd1ZXN0SGVhZGVySAASKgoEZGlhbBgFIAEoCzIaLmN1YmUucnVubmVyLnY0LkRpYWxIZWFkZXJIABIuCgZyZXBvcnQYBiABKAsyHC5jdWJlLnJ1bm5lci52NC5SZXBvcnRIZWFkZXJIABI2CgpjcmVkZW50aWFsGAcgASgLMiAuY3ViZS5ydW5uZXIudjQuQ3JlZGVudGlhbEhlYWRlckgAQgYKBGtpbmQiNAoMU3RyZWFtQW5zd2VyEiQKBWVycm9yGAEgASgLMhUuY3ViZS5ydW5uZXIudjQuRXJyb3IiRQoFSGVsbG8SEAoIcHJvdG9jb2wYASABKA0SEwoLZXhwZWN0X25vZGUYAiABKAkSFQoNY3ViZWRfdmVyc2lvbhgDIAEoCSJdCgtIZWxsb0Fuc3dlchIQCghwcm90b2NvbBgBIAEoDRIUCgxjYXBhYmlsaXRpZXMYAiADKAkSJgoGcnVubmVyGAMgASgLMhYuY3ViZS5ydW5uZXIudjQuUnVubmVyIs0FCgZSdW5uZXISDwoHbm9kZV9pZBgBIAEoCRIYChBzb2Z0d2FyZV92ZXJzaW9uGAIgASgJEikKBGtpbmQYAyABKA4yGy5jdWJlLnJ1bm5lci52NC5SdW5uZXIuS2luZBIqCghwbGF0Zm9ybRgEIAEoCzIYLmN1YmUucnVubmVyLnY0LlBsYXRmb3JtEiYKBmxpbWl0cxgFIAEoCzIWLmN1YmUucnVubmVyLnY0LkxpbWl0cxIqCghjYXBhY2l0eRgGIAEoCzIYLmN1YmUucnVubmVyLnY0LkNhcGFjaXR5EjMKCWxpZmVjeWNsZRgHIAEoDjIgLmN1YmUucnVubmVyLnY0LlJ1bm5lci5MaWZlY3ljbGUSKAoHbmV0d29yaxgIIAEoCzIXLmN1YmUucnVubmVyLnY0Lk5ldHdvcmsSMgoJdGVtcGxhdGVzGAkgAygLMh8uY3ViZS5ydW5uZXIudjQuVGVtcGxhdGVTdW1tYXJ5EjIKBmxhYmVscxgKIAMoCzIiLmN1YmUucnVubmVyLnY0LlJ1bm5lci5MYWJlbHNFbnRyeRIOCgZjYV9wZW0YCyABKAkSIgoEbWV0YRgMIAEoCzIULmN1YmUucnVubmVyLnY0Lk1ldGESLgoKc3RhcnRlZF9hdBgNIAEoCzIaLmdvb2dsZS5wcm90b2J1Zi5UaW1lc3RhbXAaLQoLTGFiZWxzRW50cnkSCwoDa2V5GAEgASgJEg0KBXZhbHVlGAIgASgJOgI4ASIuCgRLaW5kEhQKEEtJTkRfVU5TUEVDSUZJRUQQABIGCgJWTRABEggKBEhPU1QQAiJjCglMaWZlY3ljbGUSGQoVTElGRUNZQ0xFX1VOU1BFQ0lGSUVEEAASCQoFUkVBRFkQARIMCghEUkFJTklORxACEgsKB0ZBVUxURUQQAxIVChFSRUNPVkVSWV9SRVFVSVJFRBAEIpYBCghQbGF0Zm9ybRIKCgJvcxgBIAEoCRIMCgRhcmNoGAIgASgJEhMKC2FjY2VsZXJhdG9yGAMgASgJEhQKDHFlbXVfdmVyc2lvbhgEIAEoCRIZChFiYXNlX2ltYWdlX3NoYTI1NhgFIAEoCRIXCg9iYXNlX2ltYWdlX25hbWUYBiABKAkSEQoJaG9zdF9uYW1lGAcgASgJIpABCgZMaW1pdHMSEQoJbWF4X3ZjcHVzGAEgASgNEhYKDm1heF9tZW1vcnlfbWliGAIgASgNEhQKDG1heF9kaXNrX2dpYhgDIAEoDRIUCgxtYXhfbWFjaGluZXMYBCABKA0SFgoObWF4X2Jvb3RfYnl0ZXMYBSABKA0SFwoPbWF4X2ZyYW1lX2J5dGVzGAYgASgNItwBCghDYXBhY2l0eRIXCg9tYWNoaW5lc19hY3RpdmUYASABKA0SGAoQbWFjaGluZXNfcnVubmluZxgCIAEoDRISCgpzbG90c19mcmVlGAMgASgNEhEKCWhvc3RfY3B1cxgEIAEoDRIXCg9ob3N0X21lbW9yeV9taWIYBSABKAQSHAoUaG9zdF9tZW1vcnlfZnJlZV9taWIYBiABKAQSFQoNZGlza19mcmVlX2dpYhgHIAEoBBIQCghyZXRhaW5lZBgIIAEoDRIWCg5yZXRhaW5lZF9ieXRlcxgJIAEoBCJYCgdOZXR3b3JrEgwKBG1vZGUYASABKAkSLwoMcnR0X3RvX2N1YmVkGAIgASgLMhkuZ29vZ2xlLnByb3RvYnVmLkR1cmF0aW9uEg4KBmVncmVzcxgDIAEoCCKJAQoPVGVtcGxhdGVTdW1tYXJ5EgoKAmlkGAEgASgJEgsKA2tleRgCIAEoCRItCgVzdGF0ZRgDIAEoDjIeLmN1YmUucnVubmVyLnY0LlRlbXBsYXRlLlN0YXRlEi4KCmNyZWF0ZWRfYXQYBCABKAsyGi5nb29nbGUucHJvdG9idWYuVGltZXN0YW1wIr4BCgdNYWNoaW5lEiAKA3JlZhgBIAEoCzITLmN1YmUucnVubmVyLnY0LlJlZhIpCgRzcGVjGAIgASgLMhsuY3ViZS5ydW5uZXIudjQuTWFjaGluZVNwZWMSLQoGc3RhdHVzGAMgASgLMh0uY3ViZS5ydW5uZXIudjQuTWFjaGluZVN0YXR1cxIiCgRtZXRhGAQgASgLMhQuY3ViZS5ydW5uZXIudjQuTWV0YRITCgtmZW5jZV9lcG9jaBgFIAEoAyKGAQoLTWFjaGluZVNwZWMSDgoEYmFzZRgBIAEoCEgAEhUKC3RlbXBsYXRlX2lkGAIgASgJSAASIgoEc2l6ZRgDIAEoCzIULmN1YmUucnVubmVyLnY0LlNpemUSIgoEYm9vdBgEIAEoCzIULmN1YmUucnVubmVyLnY0LkJvb3RCCAoGc291cmNlIjsKBFNpemUSDQoFdmNwdXMYASABKA0SEgoKbWVtb3J5X21pYhgCIAEoDRIQCghkaXNrX2dpYhgDIAEoDSJ9CgRCb290EjYKCWRvY3VtZW50cxgBIAMoCzIjLmN1YmUucnVubmVyLnY0LkJvb3QuRG9jdW1lbnRzRW50cnkSCwoDbWFjGAIgASgJGjAKDkRvY3VtZW50c0VudHJ5EgsKA2tleRgBIAEoCRINCgV2YWx1ZRgCIAEoDDoCOAEikgMKDU1hY2hpbmVTdGF0dXMSMgoFcGhhc2UYASABKA4yIy5jdWJlLnJ1bm5lci52NC5NYWNoaW5lU3RhdHVzLlBoYXNlEi0KCmNvbmRpdGlvbnMYAiADKAsyGS5jdWJlLnJ1bm5lci52NC5Db25kaXRpb24SDwoHYm9vdF9pZBgDIAEoCRISCgpkaXNrX2J5dGVzGAQgASgEEg0KBWVycm9yGAUgASgJEi4KCnN0YXJ0ZWRfYXQYBiABKAsyGi5nb29nbGUucHJvdG9idWYuVGltZXN0YW1wEigKBWd1ZXN0GAcgASgLMhkuY3ViZS5ydW5uZXIudjQuR3Vlc3RJbmZvIokBCgVQaGFzZRIVChFQSEFTRV9VTlNQRUNJRklFRBAAEgwKCENSRUFUSU5HEAESCwoHU1RPUFBFRBACEgwKCFNUQVJUSU5HEAMSCwoHUlVOTklORxAEEgwKCFNUT1BQSU5HEAUSDAoIUkVUQUlORUQQBhILCgdERUxFVEVEEAcSCgoGRkFJTEVEEAhKBAgUEB4ikgMKCUd1ZXN0SW5mbxIRCgljb25uZWN0ZWQYASABKAgSDQoFcmVhZHkYAiABKAgSDQoFYnVpbGQYAyABKAkSDwoHdmVyc2lvbhgEIAEoCRIUCgxjYXBhYmlsaXRpZXMYBSADKAkSCgoCb3MYBiABKAkSDgoGa2VybmVsGAcgASgJEg8KB2Jvb3RfaWQYCCABKAkSMwoFaG9va3MYCSADKAsyJC5jdWJlLnJ1bm5lci52NC5HdWVzdEluZm8uSG9va3NFbnRyeRIVCg10ZW1wbGF0ZV9zZWFsGAogASgJEikKBXNpbmNlGAsgASgLMhouZ29vZ2xlLnByb3RvYnVmLlRpbWVzdGFtcBIrCgZsaW1pdHMYDCABKAsyGy5jdWJlLnJ1bm5lci52NC5HdWVzdExpbWl0cxINCgVlcG9jaBgNIAEoAxIOCgZyZWFzb24YDiABKAkSDwoHc2Vzc2lvbhgPIAEoCRosCgpIb29rc0VudHJ5EgsKA2tleRgBIAEoCRINCgV2YWx1ZRgCIAEoCToCOAEi+AEKC0d1ZXN0TGltaXRzEhcKD21heF9mcmFtZV9ieXRlcxgBIAEoDRIaChJyZXF1ZXN0X3RpbWVvdXRfbXMYAiABKA0SGQoRbWF4X2NvbW1hbmRfYnl0ZXMYAyABKA0SFgoObWF4X3BhdGhfYnl0ZXMYBCABKA0SGwoTbWF4X2V4ZWNfdGltZW91dF9tcxgFIAEoDRIYChBtYXhfb3V0cHV0X2J5dGVzGAYgASgNEhkKEW91dHB1dF9wYWdlX2J5dGVzGAcgASgNEhYKDm1heF9yZWFkX2J5dGVzGAggASgNEhcKD21heF93cml0ZV9ieXRlcxgJIAEoDSK8BAoMRWdyZXNzUG9saWN5EjUKB2RlZmF1bHQYASABKA4yJC5jdWJlLnJ1bm5lci52NC5FZ3Jlc3NQb2xpY3kuRGVmYXVsdBISCgpkZW55X2hvc3RzGAIgAygJEjAKBXJ1bGVzGAMgAygLMiEuY3ViZS5ydW5uZXIudjQuRWdyZXNzUG9saWN5LlJ1bGUSKAoFbGVhc2UYBCABKAsyGS5nb29nbGUucHJvdG9idWYuRHVyYXRpb24aywEKBFJ1bGUSDQoFaG9zdHMYASADKAkSDQoFcG9ydHMYAiADKA0SMwoFaHR0cHMYAyABKAsyIi5jdWJlLnJ1bm5lci52NC5FZ3Jlc3NQb2xpY3kuSHR0cHNIABIxCgRodHRwGAQgASgLMiEuY3ViZS5ydW5uZXIudjQuRWdyZXNzUG9saWN5Lkh0dHBIABI1CgZkZWNpZGUYBSABKAsyIy5jdWJlLnJ1bm5lci52NC5FZ3Jlc3NQb2xpY3kuRGVjaWRlSABCBgoEa2luZBpECgVIdHRwcxI7CgpjcmVkZW50aWFsGAEgASgLMicuY3ViZS5ydW5uZXIudjQuRWdyZXNzUG9saWN5LkNyZWRlbnRpYWwaBgoESHR0cBoICgZEZWNpZGUaGgoKQ3JlZGVudGlhbBIMCgRuYW1lGAEgASgJIkMKB0RlZmF1bHQSFwoTREVGQVVMVF9VTlNQRUNJRklFRBAAEggKBERFTlkQARIVChFBTExPV19QVUJMSUNfSFRUUBACIvkBCghUZW1wbGF0ZRIKCgJpZBgBIAEoCRILCgNrZXkYAiABKAkSDAoEbWV0YRgDIAEoCRItCgVzdGF0ZRgEIAEoDjIeLmN1YmUucnVubmVyLnY0LlRlbXBsYXRlLlN0YXRlEhAKCGRpc2tfZ2liGAUgASgNEg0KBWJ5dGVzGAYgASgEEg0KBXVzZXJzGAcgASgNEi4KCmNyZWF0ZWRfYXQYCCABKAsyGi5nb29nbGUucHJvdG9idWYuVGltZXN0YW1wIjcKBVN0YXRlEhUKEVNUQVRFX1VOU1BFQ0lGSUVEEAASCQoFUkVBRFkQARIMCghSRU1PVklORxACIo4FCgRDYWxsEisKCnJ1bm5lcl9nZXQYASABKAsyFS5jdWJlLnJ1bm5lci52NC5FbXB0eUgAEjcKDm1hY2hpbmVfY3JlYXRlGAogASgLMh0uY3ViZS5ydW5uZXIudjQuTWFjaGluZUNyZWF0ZUgAEjUKDW1hY2hpbmVfc3RhcnQYCyABKAsyHC5jdWJlLnJ1bm5lci52NC5NYWNoaW5lU3RhcnRIABIyCgxtYWNoaW5lX3N0b3AYDCABKAsyGi5jdWJlLnJ1bm5lci52NC5NYWNoaW5lUmVmSAASNwoObWFjaGluZV9kZWxldGUYDSABKAsyHS5jdWJlLnJ1bm5lci52NC5NYWNoaW5lRGVsZXRlSAASNQoPbWFjaGluZV9kaXNjYXJkGA4gASgLMhouY3ViZS5ydW5uZXIudjQuTWFjaGluZVJlZkgAEjEKC21hY2hpbmVfZ2V0GA8gASgLMhouY3ViZS5ydW5uZXIudjQuTWFjaGluZVJlZkgAEi0KDG1hY2hpbmVfbGlzdBgQIAEoCzIVLmN1YmUucnVubmVyLnY0LkVtcHR5SAASNgoQbWFjaGluZV9kaWFnbm9zZRgRIAEoCzIaLmN1YmUucnVubmVyLnY0Lk1hY2hpbmVSZWZIABI7ChB0ZW1wbGF0ZV9wdWJsaXNoGBQgASgLMh8uY3ViZS5ydW5uZXIudjQuVGVtcGxhdGVQdWJsaXNoSAASLgoNdGVtcGxhdGVfbGlzdBgVIAEoCzIVLmN1YmUucnVubmVyLnY0LkVtcHR5SAASNgoPdGVtcGxhdGVfZGVsZXRlGBYgASgLMhsuY3ViZS5ydW5uZXIudjQuVGVtcGxhdGVSZWZIAEIGCgR2ZXJiIlQKCk1hY2hpbmVSZWYSIAoDcmVmGAEgASgLMhMuY3ViZS5ydW5uZXIudjQuUmVmEiQKBWZlbmNlGAIgASgLMhUuY3ViZS5ydW5uZXIudjQuRmVuY2UiggEKDU1hY2hpbmVDcmVhdGUSIAoDcmVmGAEgASgLMhMuY3ViZS5ydW5uZXIudjQuUmVmEiQKBWZlbmNlGAIgASgLMhUuY3ViZS5ydW5uZXIudjQuRmVuY2USKQoEc3BlYxgDIAEoCzIbLmN1YmUucnVubmVyLnY0Lk1hY2hpbmVTcGVjIswBCgxNYWNoaW5lU3RhcnQSIAoDcmVmGAEgASgLMhMuY3ViZS5ydW5uZXIudjQuUmVmEiQKBWZlbmNlGAIgASgLMhUuY3ViZS5ydW5uZXIudjQuRmVuY2USIgoEc2l6ZRgDIAEoCzIULmN1YmUucnVubmVyLnY0LlNpemUSIgoEYm9vdBgEIAEoCzIULmN1YmUucnVubmVyLnY0LkJvb3QSLAoGcG9saWN5GAUgASgLMhwuY3ViZS5ydW5uZXIudjQuRWdyZXNzUG9saWN5ImcKDU1hY2hpbmVEZWxldGUSIAoDcmVmGAEgASgLMhMuY3ViZS5ydW5uZXIudjQuUmVmEiQKBWZlbmNlGAIgASgLMhUuY3ViZS5ydW5uZXIudjQuRmVuY2USDgoGcmV0YWluGAMgASgIInUKD1RlbXBsYXRlUHVibGlzaBIhCgRmcm9tGAEgASgLMhMuY3ViZS5ydW5uZXIudjQuUmVmEiQKBWZlbmNlGAIgASgLMhUuY3ViZS5ydW5uZXIudjQuRmVuY2USCwoDa2V5GAMgASgJEgwKBG1ldGEYBCABKAkiGQoLVGVtcGxhdGVSZWYSCgoCaWQYASABKAki0AIKCkNhbGxSZXN1bHQSJgoFZXJyb3IYASABKAsyFS5jdWJlLnJ1bm5lci52NC5FcnJvckgAEigKBnJ1bm5lchgCIAEoCzIWLmN1YmUucnVubmVyLnY0LlJ1bm5lckgAEioKB21hY2hpbmUYAyABKAsyFy5jdWJlLnJ1bm5lci52NC5NYWNoaW5lSAASLAoIbWFjaGluZXMYBCABKAsyGC5jdWJlLnJ1bm5lci52NC5NYWNoaW5lc0gAEiwKCHRlbXBsYXRlGAUgASgLMhguY3ViZS5ydW5uZXIudjQuVGVtcGxhdGVIABIuCgl0ZW1wbGF0ZXMYBiABKAsyGS5jdWJlLnJ1bm5lci52NC5UZW1wbGF0ZXNIABIuCglkaWFnbm9zaXMYByABKAsyGS5jdWJlLnJ1bm5lci52NC5EaWFnbm9zaXNIAEIICgZyZXN1bHQiQwoITWFjaGluZXMSJgoFaXRlbXMYASADKAsyFy5jdWJlLnJ1bm5lci52NC5NYWNoaW5lEg8KB3ZlcnNpb24YAiABKAMiNAoJVGVtcGxhdGVzEicKBWl0ZW1zGAEgAygLMhguY3ViZS5ydW5uZXIudjQuVGVtcGxhdGUiGQoJRGlhZ25vc2lzEgwKBGpzb24YASABKAkiJQoMV2F0Y2hSZXF1ZXN0EhUKDXNpbmNlX3ZlcnNpb24YASABKAMiqAIKCldhdGNoRXZlbnQSLQoEdHlwZRgBIAEoDjIfLmN1YmUucnVubmVyLnY0LldhdGNoRXZlbnQuVHlwZRIPCgd2ZXJzaW9uGAIgASgDEioKB21hY2hpbmUYAyABKAsyFy5jdWJlLnJ1bm5lci52NC5NYWNoaW5lSAASLAoIdGVtcGxhdGUYBCABKAsyGC5jdWJlLnJ1bm5lci52NC5UZW1wbGF0ZUgAEigKBnJ1bm5lchgFIAEoCzIWLmN1YmUucnVubmVyLnY0LlJ1bm5lckgAIkoKBFR5cGUSFAoQVFlQRV9VTlNQRUNJRklFRBAAEgcKA1BVVBABEgoKBkRFTEVURRACEgwKCEJPT0tNQVJLEAMSCQoFUkVTRVQQBEIKCghyZXNvdXJjZSJhCgtHdWVzdEhlYWRlchIgCgNyZWYYASABKAsyEy5jdWJlLnJ1bm5lci52NC5SZWYSJAoFZmVuY2UYAiABKAsyFS5jdWJlLnJ1bm5lci52NC5GZW5jZRIKCgJvcBgDIAEoCSJiCgpEaWFsSGVhZGVyEiAKA3JlZhgBIAEoCzITLmN1YmUucnVubmVyLnY0LlJlZhIkCgVmZW5jZRgCIAEoCzIVLmN1YmUucnVubmVyLnY0LkZlbmNlEgwKBHBvcnQYAyABKA0iqQEKEENyZWRlbnRpYWxIZWFkZXISIAoDcmVmGAEgASgLMhMuY3ViZS5ydW5uZXIudjQuUmVmEhIKCmNyZWRlbnRpYWwYAiABKAkSCwoDc25pGAMgASgJEgwKBGhvc3QYBSABKAkSDAoEcG9ydBgGIAEoDRIkCgVmZW5jZRgJIAEoCzIVLmN1YmUucnVubmVyLnY0LkZlbmNlSgQIBBAFSgQIBxAISgQICBAJIiUKBkhlYWRlchIMCgRuYW1lGAEgASgJEg0KBXZhbHVlGAIgASgMIg4KDFJlcG9ydEhlYWRlciKOAQoMRWdyZXNzUmVwb3J0EiAKA3JlZhgBIAEoCzITLmN1YmUucnVubmVyLnY0LlJlZhIMCgRob3N0GAIgASgJEg4KBnJlYXNvbhgDIAEoCRIWCg5kcm9wcGVkX2JlZm9yZRgEIAEoBBImCgJhdBgFIAEoCzIaLmdvb2dsZS5wcm90b2J1Zi5UaW1lc3RhbXAiiwIKC0RhZW1vbkZyYW1lEgoKAmNoGAEgASgNEioKBWhlbGxvGAIgASgLMhkuY3ViZS5ydW5uZXIudjQuR3Vlc3RJbmZvSAASKwoGc3RhdHVzGAMgASgLMhkuY3ViZS5ydW5uZXIudjQuR3Vlc3RJbmZvSAASLAoDcmVxGAQgASgLMh0uY3ViZS5ydW5uZXIudjQuRGFlbW9uUmVxdWVzdEgAEisKA2FucxgFIAEoCzIcLmN1YmUucnVubmVyLnY0LkRhZW1vbkFuc3dlckgAEiYKBWFib3J0GAYgASgLMhUuY3ViZS5ydW5uZXIudjQuRW1wdHlIABIPCgdzZXNzaW9uGAcgASgJQgMKAXQivAIKDURhZW1vblJlcXVlc3QSLQoFZ3Vlc3QYASABKAsyHC5jdWJlLnJ1bm5lci52NC5HdWVzdFJlcXVlc3RIABI1Cg1tYWNoaW5lX3NldHVwGAIgASgLMhwuY3ViZS5ydW5uZXIudjQuTWFjaGluZVNldHVwSAASMQoQc25hcHNob3RfcHJlcGFyZRgDIAEoCzIVLmN1YmUucnVubmVyLnY0LkVtcHR5SAASLgoNc25hcHNob3RfZG9uZRgEIAEoCzIVLmN1YmUucnVubmVyLnY0LkVtcHR5SAASMQoQdGVtcGxhdGVfcHVibGlzaBgFIAEoCzIVLmN1YmUucnVubmVyLnY0LkVtcHR5SAASKQoIc2h1dGRvd24YBiABKAsyFS5jdWJlLnJ1bm5lci52NC5FbXB0eUgAQgQKAm9wIigKDEd1ZXN0UmVxdWVzdBIKCgJvcBgBIAEoCRIMCgRkYXRhGAIgASgMIngKDERhZW1vbkFuc3dlchIPCgVndWVzdBgBIAEoDEgAEiYKBWVycm9yGAIgASgLMhUuY3ViZS5ydW5uZXIudjQuRXJyb3JIABIlCgRkb25lGAMgASgLMhUuY3ViZS5ydW5uZXIudjQuRW1wdHlIAEIICgZyZXN1bHQi1gIKDE1hY2hpbmVTZXR1cBIgCgNyZWYYASABKAsyEy5jdWJlLnJ1bm5lci52NC5SZWYSPgoJZG9jdW1lbnRzGAIgAygLMisuY3ViZS5ydW5uZXIudjQuTWFjaGluZVNldHVwLkRvY3VtZW50c0VudHJ5Eg8KB2VudHJvcHkYAyABKAwSJQoGbGF5ZXJzGAQgAygLMhUuY3ViZS5ydW5uZXIudjQuTGF5ZXISKgoFaW1hZ2UYBSABKAsyGy5jdWJlLnJ1bm5lci52NC5JbWFnZUNvbmZpZxIOCgZjYV9wZW0YBiABKAkSFgoOcnVubmVyX3ZlcnNpb24YByABKAkSEAoIcHJvdG9jb2wYCCABKA0SFAoMY2FwYWJpbGl0aWVzGAkgAygJGjAKDkRvY3VtZW50c0VudHJ5EgsKA2tleRgBIAEoCRINCgV2YWx1ZRgCIAEoDDoCOAEiTgoFTGF5ZXISEQoJcGFydGl0aW9uGAEgASgNEhEKB2RpZmZfaWQYAiABKAlIABIVCgt0ZW1wbGF0ZV9pZBgDIAEoCUgAQggKBnNvdXJjZSIqCgtJbWFnZUNvbmZpZxIOCgZkaWdlc3QYASABKAkSCwoDZW52GAIgAygJKtwBCgRDb2RlEhQKEENPREVfVU5TUEVDSUZJRUQQABINCglOT1RfRk9VTkQQARISCg5BTFJFQURZX0VYSVNUUxACEhcKE0ZBSUxFRF9QUkVDT05ESVRJT04QAxIWChJSRVNPVVJDRV9FWEhBVVNURUQQBBIPCgtVTkFWQUlMQUJMRRAFEhUKEVBFUk1JU1NJT05fREVOSUVEEAYSFAoQSU5WQUxJRF9BUkdVTUVOVBAHEhEKDVVOSU1QTEVNRU5URUQQCBIMCghJTlRFUk5BTBAJEgsKB0FCT1JURUQQCmIGcHJvdG8z", [file_google_protobuf_duration, file_google_protobuf_timestamp]);

/**
 * Describes the message cube.runner.v4.Ref.
 * Use `create(RefSchema)` to create a new message.
 */
export const RefSchema = /*@__PURE__*/
  messageDesc(file_runner, 0);

/**
 * Describes the message cube.runner.v4.Fence.
 * Use `create(FenceSchema)` to create a new message.
 */
export const FenceSchema = /*@__PURE__*/
  messageDesc(file_runner, 1);

/**
 * Describes the message cube.runner.v4.Meta.
 * Use `create(MetaSchema)` to create a new message.
 */
export const MetaSchema = /*@__PURE__*/
  messageDesc(file_runner, 2);

/**
 * Describes the message cube.runner.v4.Condition.
 * Use `create(ConditionSchema)` to create a new message.
 */
export const ConditionSchema = /*@__PURE__*/
  messageDesc(file_runner, 3);

/**
 * Describes the message cube.runner.v4.Error.
 * Use `create(ErrorSchema)` to create a new message.
 */
export const ErrorSchema = /*@__PURE__*/
  messageDesc(file_runner, 4);

/**
 * Describes the message cube.runner.v4.Empty.
 * Use `create(EmptySchema)` to create a new message.
 */
export const EmptySchema = /*@__PURE__*/
  messageDesc(file_runner, 5);

/**
 * Describes the message cube.runner.v4.Open.
 * Use `create(OpenSchema)` to create a new message.
 */
export const OpenSchema = /*@__PURE__*/
  messageDesc(file_runner, 6);

/**
 * Describes the message cube.runner.v4.StreamAnswer.
 * Use `create(StreamAnswerSchema)` to create a new message.
 */
export const StreamAnswerSchema = /*@__PURE__*/
  messageDesc(file_runner, 7);

/**
 * Describes the message cube.runner.v4.Hello.
 * Use `create(HelloSchema)` to create a new message.
 */
export const HelloSchema = /*@__PURE__*/
  messageDesc(file_runner, 8);

/**
 * Describes the message cube.runner.v4.HelloAnswer.
 * Use `create(HelloAnswerSchema)` to create a new message.
 */
export const HelloAnswerSchema = /*@__PURE__*/
  messageDesc(file_runner, 9);

/**
 * Describes the message cube.runner.v4.Runner.
 * Use `create(RunnerSchema)` to create a new message.
 */
export const RunnerSchema = /*@__PURE__*/
  messageDesc(file_runner, 10);

/**
 * Describes the enum cube.runner.v4.Runner.Kind.
 */
export const Runner_KindSchema = /*@__PURE__*/
  enumDesc(file_runner, 10, 0);

/**
 * @generated from enum cube.runner.v4.Runner.Kind
 */
export const Runner_Kind = /*@__PURE__*/
  tsEnum(Runner_KindSchema);

/**
 * Describes the enum cube.runner.v4.Runner.Lifecycle.
 */
export const Runner_LifecycleSchema = /*@__PURE__*/
  enumDesc(file_runner, 10, 1);

/**
 * @generated from enum cube.runner.v4.Runner.Lifecycle
 */
export const Runner_Lifecycle = /*@__PURE__*/
  tsEnum(Runner_LifecycleSchema);

/**
 * Describes the message cube.runner.v4.Platform.
 * Use `create(PlatformSchema)` to create a new message.
 */
export const PlatformSchema = /*@__PURE__*/
  messageDesc(file_runner, 11);

/**
 * Describes the message cube.runner.v4.Limits.
 * Use `create(LimitsSchema)` to create a new message.
 */
export const LimitsSchema = /*@__PURE__*/
  messageDesc(file_runner, 12);

/**
 * Describes the message cube.runner.v4.Capacity.
 * Use `create(CapacitySchema)` to create a new message.
 */
export const CapacitySchema = /*@__PURE__*/
  messageDesc(file_runner, 13);

/**
 * Describes the message cube.runner.v4.Network.
 * Use `create(NetworkSchema)` to create a new message.
 */
export const NetworkSchema = /*@__PURE__*/
  messageDesc(file_runner, 14);

/**
 * Describes the message cube.runner.v4.TemplateSummary.
 * Use `create(TemplateSummarySchema)` to create a new message.
 */
export const TemplateSummarySchema = /*@__PURE__*/
  messageDesc(file_runner, 15);

/**
 * Describes the message cube.runner.v4.Machine.
 * Use `create(MachineSchema)` to create a new message.
 */
export const MachineSchema = /*@__PURE__*/
  messageDesc(file_runner, 16);

/**
 * Describes the message cube.runner.v4.MachineSpec.
 * Use `create(MachineSpecSchema)` to create a new message.
 */
export const MachineSpecSchema = /*@__PURE__*/
  messageDesc(file_runner, 17);

/**
 * Describes the message cube.runner.v4.Size.
 * Use `create(SizeSchema)` to create a new message.
 */
export const SizeSchema = /*@__PURE__*/
  messageDesc(file_runner, 18);

/**
 * Describes the message cube.runner.v4.Boot.
 * Use `create(BootSchema)` to create a new message.
 */
export const BootSchema = /*@__PURE__*/
  messageDesc(file_runner, 19);

/**
 * Describes the message cube.runner.v4.MachineStatus.
 * Use `create(MachineStatusSchema)` to create a new message.
 */
export const MachineStatusSchema = /*@__PURE__*/
  messageDesc(file_runner, 20);

/**
 * Describes the enum cube.runner.v4.MachineStatus.Phase.
 */
export const MachineStatus_PhaseSchema = /*@__PURE__*/
  enumDesc(file_runner, 20, 0);

/**
 * @generated from enum cube.runner.v4.MachineStatus.Phase
 */
export const MachineStatus_Phase = /*@__PURE__*/
  tsEnum(MachineStatus_PhaseSchema);

/**
 * Describes the message cube.runner.v4.GuestInfo.
 * Use `create(GuestInfoSchema)` to create a new message.
 */
export const GuestInfoSchema = /*@__PURE__*/
  messageDesc(file_runner, 21);

/**
 * Describes the message cube.runner.v4.GuestLimits.
 * Use `create(GuestLimitsSchema)` to create a new message.
 */
export const GuestLimitsSchema = /*@__PURE__*/
  messageDesc(file_runner, 22);

/**
 * Describes the message cube.runner.v4.EgressPolicy.
 * Use `create(EgressPolicySchema)` to create a new message.
 */
export const EgressPolicySchema = /*@__PURE__*/
  messageDesc(file_runner, 23);

/**
 * Describes the message cube.runner.v4.EgressPolicy.Rule.
 * Use `create(EgressPolicy_RuleSchema)` to create a new message.
 */
export const EgressPolicy_RuleSchema = /*@__PURE__*/
  messageDesc(file_runner, 23, 0);

/**
 * Describes the message cube.runner.v4.EgressPolicy.Https.
 * Use `create(EgressPolicy_HttpsSchema)` to create a new message.
 */
export const EgressPolicy_HttpsSchema = /*@__PURE__*/
  messageDesc(file_runner, 23, 1);

/**
 * Describes the message cube.runner.v4.EgressPolicy.Http.
 * Use `create(EgressPolicy_HttpSchema)` to create a new message.
 */
export const EgressPolicy_HttpSchema = /*@__PURE__*/
  messageDesc(file_runner, 23, 2);

/**
 * Describes the message cube.runner.v4.EgressPolicy.Decide.
 * Use `create(EgressPolicy_DecideSchema)` to create a new message.
 */
export const EgressPolicy_DecideSchema = /*@__PURE__*/
  messageDesc(file_runner, 23, 3);

/**
 * Describes the message cube.runner.v4.EgressPolicy.Credential.
 * Use `create(EgressPolicy_CredentialSchema)` to create a new message.
 */
export const EgressPolicy_CredentialSchema = /*@__PURE__*/
  messageDesc(file_runner, 23, 4);

/**
 * Describes the enum cube.runner.v4.EgressPolicy.Default.
 */
export const EgressPolicy_DefaultSchema = /*@__PURE__*/
  enumDesc(file_runner, 23, 0);

/**
 * @generated from enum cube.runner.v4.EgressPolicy.Default
 */
export const EgressPolicy_Default = /*@__PURE__*/
  tsEnum(EgressPolicy_DefaultSchema);

/**
 * Describes the message cube.runner.v4.Template.
 * Use `create(TemplateSchema)` to create a new message.
 */
export const TemplateSchema = /*@__PURE__*/
  messageDesc(file_runner, 24);

/**
 * Describes the enum cube.runner.v4.Template.State.
 */
export const Template_StateSchema = /*@__PURE__*/
  enumDesc(file_runner, 24, 0);

/**
 * @generated from enum cube.runner.v4.Template.State
 */
export const Template_State = /*@__PURE__*/
  tsEnum(Template_StateSchema);

/**
 * Describes the message cube.runner.v4.Call.
 * Use `create(CallSchema)` to create a new message.
 */
export const CallSchema = /*@__PURE__*/
  messageDesc(file_runner, 25);

/**
 * Describes the message cube.runner.v4.MachineRef.
 * Use `create(MachineRefSchema)` to create a new message.
 */
export const MachineRefSchema = /*@__PURE__*/
  messageDesc(file_runner, 26);

/**
 * Describes the message cube.runner.v4.MachineCreate.
 * Use `create(MachineCreateSchema)` to create a new message.
 */
export const MachineCreateSchema = /*@__PURE__*/
  messageDesc(file_runner, 27);

/**
 * Describes the message cube.runner.v4.MachineStart.
 * Use `create(MachineStartSchema)` to create a new message.
 */
export const MachineStartSchema = /*@__PURE__*/
  messageDesc(file_runner, 28);

/**
 * Describes the message cube.runner.v4.MachineDelete.
 * Use `create(MachineDeleteSchema)` to create a new message.
 */
export const MachineDeleteSchema = /*@__PURE__*/
  messageDesc(file_runner, 29);

/**
 * Describes the message cube.runner.v4.TemplatePublish.
 * Use `create(TemplatePublishSchema)` to create a new message.
 */
export const TemplatePublishSchema = /*@__PURE__*/
  messageDesc(file_runner, 30);

/**
 * Describes the message cube.runner.v4.TemplateRef.
 * Use `create(TemplateRefSchema)` to create a new message.
 */
export const TemplateRefSchema = /*@__PURE__*/
  messageDesc(file_runner, 31);

/**
 * Describes the message cube.runner.v4.CallResult.
 * Use `create(CallResultSchema)` to create a new message.
 */
export const CallResultSchema = /*@__PURE__*/
  messageDesc(file_runner, 32);

/**
 * Describes the message cube.runner.v4.Machines.
 * Use `create(MachinesSchema)` to create a new message.
 */
export const MachinesSchema = /*@__PURE__*/
  messageDesc(file_runner, 33);

/**
 * Describes the message cube.runner.v4.Templates.
 * Use `create(TemplatesSchema)` to create a new message.
 */
export const TemplatesSchema = /*@__PURE__*/
  messageDesc(file_runner, 34);

/**
 * Describes the message cube.runner.v4.Diagnosis.
 * Use `create(DiagnosisSchema)` to create a new message.
 */
export const DiagnosisSchema = /*@__PURE__*/
  messageDesc(file_runner, 35);

/**
 * Describes the message cube.runner.v4.WatchRequest.
 * Use `create(WatchRequestSchema)` to create a new message.
 */
export const WatchRequestSchema = /*@__PURE__*/
  messageDesc(file_runner, 36);

/**
 * Describes the message cube.runner.v4.WatchEvent.
 * Use `create(WatchEventSchema)` to create a new message.
 */
export const WatchEventSchema = /*@__PURE__*/
  messageDesc(file_runner, 37);

/**
 * Describes the enum cube.runner.v4.WatchEvent.Type.
 */
export const WatchEvent_TypeSchema = /*@__PURE__*/
  enumDesc(file_runner, 37, 0);

/**
 * @generated from enum cube.runner.v4.WatchEvent.Type
 */
export const WatchEvent_Type = /*@__PURE__*/
  tsEnum(WatchEvent_TypeSchema);

/**
 * Describes the message cube.runner.v4.GuestHeader.
 * Use `create(GuestHeaderSchema)` to create a new message.
 */
export const GuestHeaderSchema = /*@__PURE__*/
  messageDesc(file_runner, 38);

/**
 * Describes the message cube.runner.v4.DialHeader.
 * Use `create(DialHeaderSchema)` to create a new message.
 */
export const DialHeaderSchema = /*@__PURE__*/
  messageDesc(file_runner, 39);

/**
 * Describes the message cube.runner.v4.CredentialHeader.
 * Use `create(CredentialHeaderSchema)` to create a new message.
 */
export const CredentialHeaderSchema = /*@__PURE__*/
  messageDesc(file_runner, 40);

/**
 * Describes the message cube.runner.v4.Header.
 * Use `create(HeaderSchema)` to create a new message.
 */
export const HeaderSchema = /*@__PURE__*/
  messageDesc(file_runner, 41);

/**
 * Describes the message cube.runner.v4.ReportHeader.
 * Use `create(ReportHeaderSchema)` to create a new message.
 */
export const ReportHeaderSchema = /*@__PURE__*/
  messageDesc(file_runner, 42);

/**
 * Describes the message cube.runner.v4.EgressReport.
 * Use `create(EgressReportSchema)` to create a new message.
 */
export const EgressReportSchema = /*@__PURE__*/
  messageDesc(file_runner, 43);

/**
 * Describes the message cube.runner.v4.DaemonFrame.
 * Use `create(DaemonFrameSchema)` to create a new message.
 */
export const DaemonFrameSchema = /*@__PURE__*/
  messageDesc(file_runner, 44);

/**
 * Describes the message cube.runner.v4.DaemonRequest.
 * Use `create(DaemonRequestSchema)` to create a new message.
 */
export const DaemonRequestSchema = /*@__PURE__*/
  messageDesc(file_runner, 45);

/**
 * Describes the message cube.runner.v4.GuestRequest.
 * Use `create(GuestRequestSchema)` to create a new message.
 */
export const GuestRequestSchema = /*@__PURE__*/
  messageDesc(file_runner, 46);

/**
 * Describes the message cube.runner.v4.DaemonAnswer.
 * Use `create(DaemonAnswerSchema)` to create a new message.
 */
export const DaemonAnswerSchema = /*@__PURE__*/
  messageDesc(file_runner, 47);

/**
 * Describes the message cube.runner.v4.MachineSetup.
 * Use `create(MachineSetupSchema)` to create a new message.
 */
export const MachineSetupSchema = /*@__PURE__*/
  messageDesc(file_runner, 48);

/**
 * Describes the message cube.runner.v4.Layer.
 * Use `create(LayerSchema)` to create a new message.
 */
export const LayerSchema = /*@__PURE__*/
  messageDesc(file_runner, 49);

/**
 * Describes the message cube.runner.v4.ImageConfig.
 * Use `create(ImageConfigSchema)` to create a new message.
 */
export const ImageConfigSchema = /*@__PURE__*/
  messageDesc(file_runner, 50);

/**
 * Describes the enum cube.runner.v4.Code.
 */
export const CodeSchema = /*@__PURE__*/
  enumDesc(file_runner, 0);

/**
 * @generated from enum cube.runner.v4.Code
 */
export const Code = /*@__PURE__*/
  tsEnum(CodeSchema);

