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
// driver blocks mode `normal`, and the layer disk is a VMDK descriptor).
// One set of QEMU arguments on Linux and macOS.
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
  fileDesc("CgxydW5uZXIucHJvdG8SDmN1YmUucnVubmVyLnY0IiAKA1JlZhINCgVvd25lchgBIAEoCRIKCgJpZBgCIAEoCSIWCgVGZW5jZRINCgVlcG9jaBgBIAEoAyJECgRNZXRhEg8KB3ZlcnNpb24YASABKAMSKwoHdXBkYXRlZBgCIAEoCzIaLmdvb2dsZS5wcm90b2J1Zi5UaW1lc3RhbXAidQoJQ29uZGl0aW9uEgwKBHR5cGUYASABKAkSDgoGc3RhdHVzGAIgASgIEg4KBnJlYXNvbhgDIAEoCRIPCgdtZXNzYWdlGAQgASgJEikKBXNpbmNlGAUgASgLMhouZ29vZ2xlLnByb3RvYnVmLlRpbWVzdGFtcCJoCgVFcnJvchIiCgRjb2RlGAEgASgOMhQuY3ViZS5ydW5uZXIudjQuQ29kZRIOCgZyZWFzb24YAiABKAkSDwoHbWVzc2FnZRgDIAEoCRIaChJjb21wbGV0aW9uX3Vua25vd24YBCABKAgiBwoFRW1wdHki5QEKBE9wZW4SJgoFaGVsbG8YASABKAsyFS5jdWJlLnJ1bm5lci52NC5IZWxsb0gAEiQKBGNhbGwYAiABKAsyFC5jdWJlLnJ1bm5lci52NC5DYWxsSAASLQoFd2F0Y2gYAyABKAsyHC5jdWJlLnJ1bm5lci52NC5XYXRjaFJlcXVlc3RIABIsCgVndWVzdBgEIAEoCzIbLmN1YmUucnVubmVyLnY0Lkd1ZXN0SGVhZGVySAASKgoEZGlhbBgFIAEoCzIaLmN1YmUucnVubmVyLnY0LkRpYWxIZWFkZXJIAEIGCgRraW5kIjQKDFN0cmVhbUFuc3dlchIkCgVlcnJvchgBIAEoCzIVLmN1YmUucnVubmVyLnY0LkVycm9yIkUKBUhlbGxvEhAKCHByb3RvY29sGAEgASgNEhMKC2V4cGVjdF9ub2RlGAIgASgJEhUKDWN1YmVkX3ZlcnNpb24YAyABKAkiXQoLSGVsbG9BbnN3ZXISEAoIcHJvdG9jb2wYASABKA0SFAoMY2FwYWJpbGl0aWVzGAIgAygJEiYKBnJ1bm5lchgDIAEoCzIWLmN1YmUucnVubmVyLnY0LlJ1bm5lciLNBQoGUnVubmVyEg8KB25vZGVfaWQYASABKAkSGAoQc29mdHdhcmVfdmVyc2lvbhgCIAEoCRIpCgRraW5kGAMgASgOMhsuY3ViZS5ydW5uZXIudjQuUnVubmVyLktpbmQSKgoIcGxhdGZvcm0YBCABKAsyGC5jdWJlLnJ1bm5lci52NC5QbGF0Zm9ybRImCgZsaW1pdHMYBSABKAsyFi5jdWJlLnJ1bm5lci52NC5MaW1pdHMSKgoIY2FwYWNpdHkYBiABKAsyGC5jdWJlLnJ1bm5lci52NC5DYXBhY2l0eRIzCglsaWZlY3ljbGUYByABKA4yIC5jdWJlLnJ1bm5lci52NC5SdW5uZXIuTGlmZWN5Y2xlEigKB25ldHdvcmsYCCABKAsyFy5jdWJlLnJ1bm5lci52NC5OZXR3b3JrEjIKCXRlbXBsYXRlcxgJIAMoCzIfLmN1YmUucnVubmVyLnY0LlRlbXBsYXRlU3VtbWFyeRIyCgZsYWJlbHMYCiADKAsyIi5jdWJlLnJ1bm5lci52NC5SdW5uZXIuTGFiZWxzRW50cnkSDgoGY2FfcGVtGAsgASgJEiIKBG1ldGEYDCABKAsyFC5jdWJlLnJ1bm5lci52NC5NZXRhEi4KCnN0YXJ0ZWRfYXQYDSABKAsyGi5nb29nbGUucHJvdG9idWYuVGltZXN0YW1wGi0KC0xhYmVsc0VudHJ5EgsKA2tleRgBIAEoCRINCgV2YWx1ZRgCIAEoCToCOAEiLgoES2luZBIUChBLSU5EX1VOU1BFQ0lGSUVEEAASBgoCVk0QARIICgRIT1NUEAIiYwoJTGlmZWN5Y2xlEhkKFUxJRkVDWUNMRV9VTlNQRUNJRklFRBAAEgkKBVJFQURZEAESDAoIRFJBSU5JTkcQAhILCgdGQVVMVEVEEAMSFQoRUkVDT1ZFUllfUkVRVUlSRUQQBCKWAQoIUGxhdGZvcm0SCgoCb3MYASABKAkSDAoEYXJjaBgCIAEoCRITCgthY2NlbGVyYXRvchgDIAEoCRIUCgxxZW11X3ZlcnNpb24YBCABKAkSGQoRYmFzZV9pbWFnZV9zaGEyNTYYBSABKAkSFwoPYmFzZV9pbWFnZV9uYW1lGAYgASgJEhEKCWhvc3RfbmFtZRgHIAEoCSKQAQoGTGltaXRzEhEKCW1heF92Y3B1cxgBIAEoDRIWCg5tYXhfbWVtb3J5X21pYhgCIAEoDRIUCgxtYXhfZGlza19naWIYAyABKA0SFAoMbWF4X21hY2hpbmVzGAQgASgNEhYKDm1heF9ib290X2J5dGVzGAUgASgNEhcKD21heF9mcmFtZV9ieXRlcxgGIAEoDSLcAQoIQ2FwYWNpdHkSFwoPbWFjaGluZXNfYWN0aXZlGAEgASgNEhgKEG1hY2hpbmVzX3J1bm5pbmcYAiABKA0SEgoKc2xvdHNfZnJlZRgDIAEoDRIRCglob3N0X2NwdXMYBCABKA0SFwoPaG9zdF9tZW1vcnlfbWliGAUgASgEEhwKFGhvc3RfbWVtb3J5X2ZyZWVfbWliGAYgASgEEhUKDWRpc2tfZnJlZV9naWIYByABKAQSEAoIcmV0YWluZWQYCCABKA0SFgoOcmV0YWluZWRfYnl0ZXMYCSABKAQiWAoHTmV0d29yaxIMCgRtb2RlGAEgASgJEi8KDHJ0dF90b19jdWJlZBgCIAEoCzIZLmdvb2dsZS5wcm90b2J1Zi5EdXJhdGlvbhIOCgZlZ3Jlc3MYAyABKAgiiQEKD1RlbXBsYXRlU3VtbWFyeRIKCgJpZBgBIAEoCRILCgNrZXkYAiABKAkSLQoFc3RhdGUYAyABKA4yHi5jdWJlLnJ1bm5lci52NC5UZW1wbGF0ZS5TdGF0ZRIuCgpjcmVhdGVkX2F0GAQgASgLMhouZ29vZ2xlLnByb3RvYnVmLlRpbWVzdGFtcCK+AQoHTWFjaGluZRIgCgNyZWYYASABKAsyEy5jdWJlLnJ1bm5lci52NC5SZWYSKQoEc3BlYxgCIAEoCzIbLmN1YmUucnVubmVyLnY0Lk1hY2hpbmVTcGVjEi0KBnN0YXR1cxgDIAEoCzIdLmN1YmUucnVubmVyLnY0Lk1hY2hpbmVTdGF0dXMSIgoEbWV0YRgEIAEoCzIULmN1YmUucnVubmVyLnY0Lk1ldGESEwoLZmVuY2VfZXBvY2gYBSABKAMihgEKC01hY2hpbmVTcGVjEg4KBGJhc2UYASABKAhIABIVCgt0ZW1wbGF0ZV9pZBgCIAEoCUgAEiIKBHNpemUYAyABKAsyFC5jdWJlLnJ1bm5lci52NC5TaXplEiIKBGJvb3QYBCABKAsyFC5jdWJlLnJ1bm5lci52NC5Cb290QggKBnNvdXJjZSI7CgRTaXplEg0KBXZjcHVzGAEgASgNEhIKCm1lbW9yeV9taWIYAiABKA0SEAoIZGlza19naWIYAyABKA0ifQoEQm9vdBI2Cglkb2N1bWVudHMYASADKAsyIy5jdWJlLnJ1bm5lci52NC5Cb290LkRvY3VtZW50c0VudHJ5EgsKA21hYxgCIAEoCRowCg5Eb2N1bWVudHNFbnRyeRILCgNrZXkYASABKAkSDQoFdmFsdWUYAiABKAw6AjgBIpIDCg1NYWNoaW5lU3RhdHVzEjIKBXBoYXNlGAEgASgOMiMuY3ViZS5ydW5uZXIudjQuTWFjaGluZVN0YXR1cy5QaGFzZRItCgpjb25kaXRpb25zGAIgAygLMhkuY3ViZS5ydW5uZXIudjQuQ29uZGl0aW9uEg8KB2Jvb3RfaWQYAyABKAkSEgoKZGlza19ieXRlcxgEIAEoBBINCgVlcnJvchgFIAEoCRIuCgpzdGFydGVkX2F0GAYgASgLMhouZ29vZ2xlLnByb3RvYnVmLlRpbWVzdGFtcBIoCgVndWVzdBgHIAEoCzIZLmN1YmUucnVubmVyLnY0Lkd1ZXN0SW5mbyKJAQoFUGhhc2USFQoRUEhBU0VfVU5TUEVDSUZJRUQQABIMCghDUkVBVElORxABEgsKB1NUT1BQRUQQAhIMCghTVEFSVElORxADEgsKB1JVTk5JTkcQBBIMCghTVE9QUElORxAFEgwKCFJFVEFJTkVEEAYSCwoHREVMRVRFRBAHEgoKBkZBSUxFRBAISgQIFBAeIpIDCglHdWVzdEluZm8SEQoJY29ubmVjdGVkGAEgASgIEg0KBXJlYWR5GAIgASgIEg0KBWJ1aWxkGAMgASgJEg8KB3ZlcnNpb24YBCABKAkSFAoMY2FwYWJpbGl0aWVzGAUgAygJEgoKAm9zGAYgASgJEg4KBmtlcm5lbBgHIAEoCRIPCgdib290X2lkGAggASgJEjMKBWhvb2tzGAkgAygLMiQuY3ViZS5ydW5uZXIudjQuR3Vlc3RJbmZvLkhvb2tzRW50cnkSFQoNdGVtcGxhdGVfc2VhbBgKIAEoCRIpCgVzaW5jZRgLIAEoCzIaLmdvb2dsZS5wcm90b2J1Zi5UaW1lc3RhbXASKwoGbGltaXRzGAwgASgLMhsuY3ViZS5ydW5uZXIudjQuR3Vlc3RMaW1pdHMSDQoFZXBvY2gYDSABKAMSDgoGcmVhc29uGA4gASgJEg8KB3Nlc3Npb24YDyABKAkaLAoKSG9va3NFbnRyeRILCgNrZXkYASABKAkSDQoFdmFsdWUYAiABKAk6AjgBIvgBCgtHdWVzdExpbWl0cxIXCg9tYXhfZnJhbWVfYnl0ZXMYASABKA0SGgoScmVxdWVzdF90aW1lb3V0X21zGAIgASgNEhkKEW1heF9jb21tYW5kX2J5dGVzGAMgASgNEhYKDm1heF9wYXRoX2J5dGVzGAQgASgNEhsKE21heF9leGVjX3RpbWVvdXRfbXMYBSABKA0SGAoQbWF4X291dHB1dF9ieXRlcxgGIAEoDRIZChFvdXRwdXRfcGFnZV9ieXRlcxgHIAEoDRIWCg5tYXhfcmVhZF9ieXRlcxgIIAEoDRIXCg9tYXhfd3JpdGVfYnl0ZXMYCSABKA0ivAQKDEVncmVzc1BvbGljeRI1CgdkZWZhdWx0GAEgASgOMiQuY3ViZS5ydW5uZXIudjQuRWdyZXNzUG9saWN5LkRlZmF1bHQSEgoKZGVueV9ob3N0cxgCIAMoCRIwCgVydWxlcxgDIAMoCzIhLmN1YmUucnVubmVyLnY0LkVncmVzc1BvbGljeS5SdWxlEigKBWxlYXNlGAQgASgLMhkuZ29vZ2xlLnByb3RvYnVmLkR1cmF0aW9uGssBCgRSdWxlEg0KBWhvc3RzGAEgAygJEg0KBXBvcnRzGAIgAygNEjMKBWh0dHBzGAMgASgLMiIuY3ViZS5ydW5uZXIudjQuRWdyZXNzUG9saWN5Lkh0dHBzSAASMQoEaHR0cBgEIAEoCzIhLmN1YmUucnVubmVyLnY0LkVncmVzc1BvbGljeS5IdHRwSAASNQoGZGVjaWRlGAUgASgLMiMuY3ViZS5ydW5uZXIudjQuRWdyZXNzUG9saWN5LkRlY2lkZUgAQgYKBGtpbmQaRAoFSHR0cHMSOwoKY3JlZGVudGlhbBgBIAEoCzInLmN1YmUucnVubmVyLnY0LkVncmVzc1BvbGljeS5DcmVkZW50aWFsGgYKBEh0dHAaCAoGRGVjaWRlGhoKCkNyZWRlbnRpYWwSDAoEbmFtZRgBIAEoCSJDCgdEZWZhdWx0EhcKE0RFRkFVTFRfVU5TUEVDSUZJRUQQABIICgRERU5ZEAESFQoRQUxMT1dfUFVCTElDX0hUVFAQAiL5AQoIVGVtcGxhdGUSCgoCaWQYASABKAkSCwoDa2V5GAIgASgJEgwKBG1ldGEYAyABKAkSLQoFc3RhdGUYBCABKA4yHi5jdWJlLnJ1bm5lci52NC5UZW1wbGF0ZS5TdGF0ZRIQCghkaXNrX2dpYhgFIAEoDRINCgVieXRlcxgGIAEoBBINCgV1c2VycxgHIAEoDRIuCgpjcmVhdGVkX2F0GAggASgLMhouZ29vZ2xlLnByb3RvYnVmLlRpbWVzdGFtcCI3CgVTdGF0ZRIVChFTVEFURV9VTlNQRUNJRklFRBAAEgkKBVJFQURZEAESDAoIUkVNT1ZJTkcQAiKOBQoEQ2FsbBIrCgpydW5uZXJfZ2V0GAEgASgLMhUuY3ViZS5ydW5uZXIudjQuRW1wdHlIABI3Cg5tYWNoaW5lX2NyZWF0ZRgKIAEoCzIdLmN1YmUucnVubmVyLnY0Lk1hY2hpbmVDcmVhdGVIABI1Cg1tYWNoaW5lX3N0YXJ0GAsgASgLMhwuY3ViZS5ydW5uZXIudjQuTWFjaGluZVN0YXJ0SAASMgoMbWFjaGluZV9zdG9wGAwgASgLMhouY3ViZS5ydW5uZXIudjQuTWFjaGluZVJlZkgAEjcKDm1hY2hpbmVfZGVsZXRlGA0gASgLMh0uY3ViZS5ydW5uZXIudjQuTWFjaGluZURlbGV0ZUgAEjUKD21hY2hpbmVfZGlzY2FyZBgOIAEoCzIaLmN1YmUucnVubmVyLnY0Lk1hY2hpbmVSZWZIABIxCgttYWNoaW5lX2dldBgPIAEoCzIaLmN1YmUucnVubmVyLnY0Lk1hY2hpbmVSZWZIABItCgxtYWNoaW5lX2xpc3QYECABKAsyFS5jdWJlLnJ1bm5lci52NC5FbXB0eUgAEjYKEG1hY2hpbmVfZGlhZ25vc2UYESABKAsyGi5jdWJlLnJ1bm5lci52NC5NYWNoaW5lUmVmSAASOwoQdGVtcGxhdGVfcHVibGlzaBgUIAEoCzIfLmN1YmUucnVubmVyLnY0LlRlbXBsYXRlUHVibGlzaEgAEi4KDXRlbXBsYXRlX2xpc3QYFSABKAsyFS5jdWJlLnJ1bm5lci52NC5FbXB0eUgAEjYKD3RlbXBsYXRlX2RlbGV0ZRgWIAEoCzIbLmN1YmUucnVubmVyLnY0LlRlbXBsYXRlUmVmSABCBgoEdmVyYiJUCgpNYWNoaW5lUmVmEiAKA3JlZhgBIAEoCzITLmN1YmUucnVubmVyLnY0LlJlZhIkCgVmZW5jZRgCIAEoCzIVLmN1YmUucnVubmVyLnY0LkZlbmNlIoIBCg1NYWNoaW5lQ3JlYXRlEiAKA3JlZhgBIAEoCzITLmN1YmUucnVubmVyLnY0LlJlZhIkCgVmZW5jZRgCIAEoCzIVLmN1YmUucnVubmVyLnY0LkZlbmNlEikKBHNwZWMYAyABKAsyGy5jdWJlLnJ1bm5lci52NC5NYWNoaW5lU3BlYyLMAQoMTWFjaGluZVN0YXJ0EiAKA3JlZhgBIAEoCzITLmN1YmUucnVubmVyLnY0LlJlZhIkCgVmZW5jZRgCIAEoCzIVLmN1YmUucnVubmVyLnY0LkZlbmNlEiIKBHNpemUYAyABKAsyFC5jdWJlLnJ1bm5lci52NC5TaXplEiIKBGJvb3QYBCABKAsyFC5jdWJlLnJ1bm5lci52NC5Cb290EiwKBnBvbGljeRgFIAEoCzIcLmN1YmUucnVubmVyLnY0LkVncmVzc1BvbGljeSJnCg1NYWNoaW5lRGVsZXRlEiAKA3JlZhgBIAEoCzITLmN1YmUucnVubmVyLnY0LlJlZhIkCgVmZW5jZRgCIAEoCzIVLmN1YmUucnVubmVyLnY0LkZlbmNlEg4KBnJldGFpbhgDIAEoCCJ1Cg9UZW1wbGF0ZVB1Ymxpc2gSIQoEZnJvbRgBIAEoCzITLmN1YmUucnVubmVyLnY0LlJlZhIkCgVmZW5jZRgCIAEoCzIVLmN1YmUucnVubmVyLnY0LkZlbmNlEgsKA2tleRgDIAEoCRIMCgRtZXRhGAQgASgJIhkKC1RlbXBsYXRlUmVmEgoKAmlkGAEgASgJItACCgpDYWxsUmVzdWx0EiYKBWVycm9yGAEgASgLMhUuY3ViZS5ydW5uZXIudjQuRXJyb3JIABIoCgZydW5uZXIYAiABKAsyFi5jdWJlLnJ1bm5lci52NC5SdW5uZXJIABIqCgdtYWNoaW5lGAMgASgLMhcuY3ViZS5ydW5uZXIudjQuTWFjaGluZUgAEiwKCG1hY2hpbmVzGAQgASgLMhguY3ViZS5ydW5uZXIudjQuTWFjaGluZXNIABIsCgh0ZW1wbGF0ZRgFIAEoCzIYLmN1YmUucnVubmVyLnY0LlRlbXBsYXRlSAASLgoJdGVtcGxhdGVzGAYgASgLMhkuY3ViZS5ydW5uZXIudjQuVGVtcGxhdGVzSAASLgoJZGlhZ25vc2lzGAcgASgLMhkuY3ViZS5ydW5uZXIudjQuRGlhZ25vc2lzSABCCAoGcmVzdWx0IkMKCE1hY2hpbmVzEiYKBWl0ZW1zGAEgAygLMhcuY3ViZS5ydW5uZXIudjQuTWFjaGluZRIPCgd2ZXJzaW9uGAIgASgDIjQKCVRlbXBsYXRlcxInCgVpdGVtcxgBIAMoCzIYLmN1YmUucnVubmVyLnY0LlRlbXBsYXRlIhkKCURpYWdub3NpcxIMCgRqc29uGAEgASgJIiUKDFdhdGNoUmVxdWVzdBIVCg1zaW5jZV92ZXJzaW9uGAEgASgDIqgCCgpXYXRjaEV2ZW50Ei0KBHR5cGUYASABKA4yHy5jdWJlLnJ1bm5lci52NC5XYXRjaEV2ZW50LlR5cGUSDwoHdmVyc2lvbhgCIAEoAxIqCgdtYWNoaW5lGAMgASgLMhcuY3ViZS5ydW5uZXIudjQuTWFjaGluZUgAEiwKCHRlbXBsYXRlGAQgASgLMhguY3ViZS5ydW5uZXIudjQuVGVtcGxhdGVIABIoCgZydW5uZXIYBSABKAsyFi5jdWJlLnJ1bm5lci52NC5SdW5uZXJIACJKCgRUeXBlEhQKEFRZUEVfVU5TUEVDSUZJRUQQABIHCgNQVVQQARIKCgZERUxFVEUQAhIMCghCT09LTUFSSxADEgkKBVJFU0VUEARCCgoIcmVzb3VyY2UiYQoLR3Vlc3RIZWFkZXISIAoDcmVmGAEgASgLMhMuY3ViZS5ydW5uZXIudjQuUmVmEiQKBWZlbmNlGAIgASgLMhUuY3ViZS5ydW5uZXIudjQuRmVuY2USCgoCb3AYAyABKAkiYgoKRGlhbEhlYWRlchIgCgNyZWYYASABKAsyEy5jdWJlLnJ1bm5lci52NC5SZWYSJAoFZmVuY2UYAiABKAsyFS5jdWJlLnJ1bm5lci52NC5GZW5jZRIMCgRwb3J0GAMgASgNIrgBChBDcmVkZW50aWFsSGVhZGVyEiAKA3JlZhgBIAEoCzITLmN1YmUucnVubmVyLnY0LlJlZhISCgpjcmVkZW50aWFsGAIgASgJEgsKA3NuaRgDIAEoCRIOCgZtZXRob2QYBCABKAkSDAoEaG9zdBgFIAEoCRIMCgRwb3J0GAYgASgNEgwKBHBhdGgYByABKAkSJwoHaGVhZGVycxgIIAMoCzIWLmN1YmUucnVubmVyLnY0LkhlYWRlciIlCgZIZWFkZXISDAoEbmFtZRgBIAEoCRINCgV2YWx1ZRgCIAEoDCIOCgxSZXBvcnRIZWFkZXIijgEKDEVncmVzc1JlcG9ydBIgCgNyZWYYASABKAsyEy5jdWJlLnJ1bm5lci52NC5SZWYSDAoEaG9zdBgCIAEoCRIOCgZyZWFzb24YAyABKAkSFgoOZHJvcHBlZF9iZWZvcmUYBCABKAQSJgoCYXQYBSABKAsyGi5nb29nbGUucHJvdG9idWYuVGltZXN0YW1wIosCCgtEYWVtb25GcmFtZRIKCgJjaBgBIAEoDRIqCgVoZWxsbxgCIAEoCzIZLmN1YmUucnVubmVyLnY0Lkd1ZXN0SW5mb0gAEisKBnN0YXR1cxgDIAEoCzIZLmN1YmUucnVubmVyLnY0Lkd1ZXN0SW5mb0gAEiwKA3JlcRgEIAEoCzIdLmN1YmUucnVubmVyLnY0LkRhZW1vblJlcXVlc3RIABIrCgNhbnMYBSABKAsyHC5jdWJlLnJ1bm5lci52NC5EYWVtb25BbnN3ZXJIABImCgVhYm9ydBgGIAEoCzIVLmN1YmUucnVubmVyLnY0LkVtcHR5SAASDwoHc2Vzc2lvbhgHIAEoCUIDCgF0IrwCCg1EYWVtb25SZXF1ZXN0Ei0KBWd1ZXN0GAEgASgLMhwuY3ViZS5ydW5uZXIudjQuR3Vlc3RSZXF1ZXN0SAASNQoNbWFjaGluZV9zZXR1cBgCIAEoCzIcLmN1YmUucnVubmVyLnY0Lk1hY2hpbmVTZXR1cEgAEjEKEHNuYXBzaG90X3ByZXBhcmUYAyABKAsyFS5jdWJlLnJ1bm5lci52NC5FbXB0eUgAEi4KDXNuYXBzaG90X2RvbmUYBCABKAsyFS5jdWJlLnJ1bm5lci52NC5FbXB0eUgAEjEKEHRlbXBsYXRlX3B1Ymxpc2gYBSABKAsyFS5jdWJlLnJ1bm5lci52NC5FbXB0eUgAEikKCHNodXRkb3duGAYgASgLMhUuY3ViZS5ydW5uZXIudjQuRW1wdHlIAEIECgJvcCIoCgxHdWVzdFJlcXVlc3QSCgoCb3AYASABKAkSDAoEZGF0YRgCIAEoDCJ4CgxEYWVtb25BbnN3ZXISDwoFZ3Vlc3QYASABKAxIABImCgVlcnJvchgCIAEoCzIVLmN1YmUucnVubmVyLnY0LkVycm9ySAASJQoEZG9uZRgDIAEoCzIVLmN1YmUucnVubmVyLnY0LkVtcHR5SABCCAoGcmVzdWx0ItYCCgxNYWNoaW5lU2V0dXASIAoDcmVmGAEgASgLMhMuY3ViZS5ydW5uZXIudjQuUmVmEj4KCWRvY3VtZW50cxgCIAMoCzIrLmN1YmUucnVubmVyLnY0Lk1hY2hpbmVTZXR1cC5Eb2N1bWVudHNFbnRyeRIPCgdlbnRyb3B5GAMgASgMEiUKBmxheWVycxgEIAMoCzIVLmN1YmUucnVubmVyLnY0LkxheWVyEioKBWltYWdlGAUgASgLMhsuY3ViZS5ydW5uZXIudjQuSW1hZ2VDb25maWcSDgoGY2FfcGVtGAYgASgJEhYKDnJ1bm5lcl92ZXJzaW9uGAcgASgJEhAKCHByb3RvY29sGAggASgNEhQKDGNhcGFiaWxpdGllcxgJIAMoCRowCg5Eb2N1bWVudHNFbnRyeRILCgNrZXkYASABKAkSDQoFdmFsdWUYAiABKAw6AjgBIk4KBUxheWVyEhEKCXBhcnRpdGlvbhgBIAEoDRIRCgdkaWZmX2lkGAIgASgJSAASFQoLdGVtcGxhdGVfaWQYAyABKAlIAEIICgZzb3VyY2UiKgoLSW1hZ2VDb25maWcSDgoGZGlnZXN0GAEgASgJEgsKA2VudhgCIAMoCSrcAQoEQ29kZRIUChBDT0RFX1VOU1BFQ0lGSUVEEAASDQoJTk9UX0ZPVU5EEAESEgoOQUxSRUFEWV9FWElTVFMQAhIXChNGQUlMRURfUFJFQ09ORElUSU9OEAMSFgoSUkVTT1VSQ0VfRVhIQVVTVEVEEAQSDwoLVU5BVkFJTEFCTEUQBRIVChFQRVJNSVNTSU9OX0RFTklFRBAGEhQKEElOVkFMSURfQVJHVU1FTlQQBxIRCg1VTklNUExFTUVOVEVEEAgSDAoISU5URVJOQUwQCRILCgdBQk9SVEVEEApiBnByb3RvMw", [file_google_protobuf_duration, file_google_protobuf_timestamp]);

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

