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
  fileDesc("CgxydW5uZXIucHJvdG8SDmN1YmUucnVubmVyLnY0IiAKA1JlZhINCgVvd25lchgBIAEoCRIKCgJpZBgCIAEoCSIWCgVGZW5jZRINCgVlcG9jaBgBIAEoAyJECgRNZXRhEg8KB3ZlcnNpb24YASABKAMSKwoHdXBkYXRlZBgCIAEoCzIaLmdvb2dsZS5wcm90b2J1Zi5UaW1lc3RhbXAidQoJQ29uZGl0aW9uEgwKBHR5cGUYASABKAkSDgoGc3RhdHVzGAIgASgIEg4KBnJlYXNvbhgDIAEoCRIPCgdtZXNzYWdlGAQgASgJEikKBXNpbmNlGAUgASgLMhouZ29vZ2xlLnByb3RvYnVmLlRpbWVzdGFtcCJoCgVFcnJvchIiCgRjb2RlGAEgASgOMhQuY3ViZS5ydW5uZXIudjQuQ29kZRIOCgZyZWFzb24YAiABKAkSDwoHbWVzc2FnZRgDIAEoCRIaChJjb21wbGV0aW9uX3Vua25vd24YBCABKAgiBwoFRW1wdHkizQIKBE9wZW4SJgoFaGVsbG8YASABKAsyFS5jdWJlLnJ1bm5lci52NC5IZWxsb0gAEiQKBGNhbGwYAiABKAsyFC5jdWJlLnJ1bm5lci52NC5DYWxsSAASLQoFd2F0Y2gYAyABKAsyHC5jdWJlLnJ1bm5lci52NC5XYXRjaFJlcXVlc3RIABIsCgVndWVzdBgEIAEoCzIbLmN1YmUucnVubmVyLnY0Lkd1ZXN0SGVhZGVySAASKgoEZGlhbBgFIAEoCzIaLmN1YmUucnVubmVyLnY0LkRpYWxIZWFkZXJIABIuCgZyZXBvcnQYBiABKAsyHC5jdWJlLnJ1bm5lci52NC5SZXBvcnRIZWFkZXJIABI2CgpjcmVkZW50aWFsGAcgASgLMiAuY3ViZS5ydW5uZXIudjQuQ3JlZGVudGlhbEhlYWRlckgAQgYKBGtpbmQiNAoMU3RyZWFtQW5zd2VyEiQKBWVycm9yGAEgASgLMhUuY3ViZS5ydW5uZXIudjQuRXJyb3IiRQoFSGVsbG8SEAoIcHJvdG9jb2wYASABKA0SEwoLZXhwZWN0X25vZGUYAiABKAkSFQoNY3ViZWRfdmVyc2lvbhgDIAEoCSJdCgtIZWxsb0Fuc3dlchIQCghwcm90b2NvbBgBIAEoDRIUCgxjYXBhYmlsaXRpZXMYAiADKAkSJgoGcnVubmVyGAMgASgLMhYuY3ViZS5ydW5uZXIudjQuUnVubmVyIs0FCgZSdW5uZXISDwoHbm9kZV9pZBgBIAEoCRIYChBzb2Z0d2FyZV92ZXJzaW9uGAIgASgJEikKBGtpbmQYAyABKA4yGy5jdWJlLnJ1bm5lci52NC5SdW5uZXIuS2luZBIqCghwbGF0Zm9ybRgEIAEoCzIYLmN1YmUucnVubmVyLnY0LlBsYXRmb3JtEiYKBmxpbWl0cxgFIAEoCzIWLmN1YmUucnVubmVyLnY0LkxpbWl0cxIqCghjYXBhY2l0eRgGIAEoCzIYLmN1YmUucnVubmVyLnY0LkNhcGFjaXR5EjMKCWxpZmVjeWNsZRgHIAEoDjIgLmN1YmUucnVubmVyLnY0LlJ1bm5lci5MaWZlY3ljbGUSKAoHbmV0d29yaxgIIAEoCzIXLmN1YmUucnVubmVyLnY0Lk5ldHdvcmsSMgoJdGVtcGxhdGVzGAkgAygLMh8uY3ViZS5ydW5uZXIudjQuVGVtcGxhdGVTdW1tYXJ5EjIKBmxhYmVscxgKIAMoCzIiLmN1YmUucnVubmVyLnY0LlJ1bm5lci5MYWJlbHNFbnRyeRIOCgZjYV9wZW0YCyABKAkSIgoEbWV0YRgMIAEoCzIULmN1YmUucnVubmVyLnY0Lk1ldGESLgoKc3RhcnRlZF9hdBgNIAEoCzIaLmdvb2dsZS5wcm90b2J1Zi5UaW1lc3RhbXAaLQoLTGFiZWxzRW50cnkSCwoDa2V5GAEgASgJEg0KBXZhbHVlGAIgASgJOgI4ASIuCgRLaW5kEhQKEEtJTkRfVU5TUEVDSUZJRUQQABIGCgJWTRABEggKBEhPU1QQAiJjCglMaWZlY3ljbGUSGQoVTElGRUNZQ0xFX1VOU1BFQ0lGSUVEEAASCQoFUkVBRFkQARIMCghEUkFJTklORxACEgsKB0ZBVUxURUQQAxIVChFSRUNPVkVSWV9SRVFVSVJFRBAEIqgBCghQbGF0Zm9ybRIKCgJvcxgBIAEoCRIMCgRhcmNoGAIgASgJEhMKC2FjY2VsZXJhdG9yGAMgASgJEhQKDHFlbXVfdmVyc2lvbhgEIAEoCRIZChFiYXNlX2ltYWdlX3NoYTI1NhgFIAEoCRIXCg9iYXNlX2ltYWdlX25hbWUYBiABKAkSEQoJaG9zdF9uYW1lGAcgASgJEhAKCGltYWdlX2lkGAggASgJIpABCgZMaW1pdHMSEQoJbWF4X3ZjcHVzGAEgASgNEhYKDm1heF9tZW1vcnlfbWliGAIgASgNEhQKDG1heF9kaXNrX2dpYhgDIAEoDRIUCgxtYXhfbWFjaGluZXMYBCABKA0SFgoObWF4X2Jvb3RfYnl0ZXMYBSABKA0SFwoPbWF4X2ZyYW1lX2J5dGVzGAYgASgNIogCCghDYXBhY2l0eRIXCg9tYWNoaW5lc19hY3RpdmUYASABKA0SGAoQbWFjaGluZXNfcnVubmluZxgCIAEoDRISCgpzbG90c19mcmVlGAMgASgNEhEKCWhvc3RfY3B1cxgEIAEoDRIXCg9ob3N0X21lbW9yeV9taWIYBSABKAQSHAoUaG9zdF9tZW1vcnlfZnJlZV9taWIYBiABKAQSFQoNZGlza19mcmVlX2dpYhgHIAEoBBIQCghyZXRhaW5lZBgIIAEoDRIWCg5yZXRhaW5lZF9ieXRlcxgJIAEoBBIRCglzdXNwZW5kZWQYCiABKA0SFwoPc3VzcGVuZGVkX2J5dGVzGAsgASgEIlgKB05ldHdvcmsSDAoEbW9kZRgBIAEoCRIvCgxydHRfdG9fY3ViZWQYAiABKAsyGS5nb29nbGUucHJvdG9idWYuRHVyYXRpb24SDgoGZWdyZXNzGAMgASgIIokBCg9UZW1wbGF0ZVN1bW1hcnkSCgoCaWQYASABKAkSCwoDa2V5GAIgASgJEi0KBXN0YXRlGAMgASgOMh4uY3ViZS5ydW5uZXIudjQuVGVtcGxhdGUuU3RhdGUSLgoKY3JlYXRlZF9hdBgEIAEoCzIaLmdvb2dsZS5wcm90b2J1Zi5UaW1lc3RhbXAivgEKB01hY2hpbmUSIAoDcmVmGAEgASgLMhMuY3ViZS5ydW5uZXIudjQuUmVmEikKBHNwZWMYAiABKAsyGy5jdWJlLnJ1bm5lci52NC5NYWNoaW5lU3BlYxItCgZzdGF0dXMYAyABKAsyHS5jdWJlLnJ1bm5lci52NC5NYWNoaW5lU3RhdHVzEiIKBG1ldGEYBCABKAsyFC5jdWJlLnJ1bm5lci52NC5NZXRhEhMKC2ZlbmNlX2Vwb2NoGAUgASgDIpUBCgtNYWNoaW5lU3BlYxIOCgRiYXNlGAEgASgISAASFQoLdGVtcGxhdGVfaWQYAiABKAlIABIiCgRzaXplGAMgASgLMhQuY3ViZS5ydW5uZXIudjQuU2l6ZRIiCgRib290GAQgASgLMhQuY3ViZS5ydW5uZXIudjQuQm9vdBINCgVidWlsZBgFIAEoCEIICgZzb3VyY2UiOwoEU2l6ZRINCgV2Y3B1cxgBIAEoDRISCgptZW1vcnlfbWliGAIgASgNEhAKCGRpc2tfZ2liGAMgASgNIn0KBEJvb3QSNgoJZG9jdW1lbnRzGAEgAygLMiMuY3ViZS5ydW5uZXIudjQuQm9vdC5Eb2N1bWVudHNFbnRyeRILCgNtYWMYAiABKAkaMAoORG9jdW1lbnRzRW50cnkSCwoDa2V5GAEgASgJEg0KBXZhbHVlGAIgASgMOgI4ASLfAwoNTWFjaGluZVN0YXR1cxIyCgVwaGFzZRgBIAEoDjIjLmN1YmUucnVubmVyLnY0Lk1hY2hpbmVTdGF0dXMuUGhhc2USLQoKY29uZGl0aW9ucxgCIAMoCzIZLmN1YmUucnVubmVyLnY0LkNvbmRpdGlvbhIPCgdib290X2lkGAMgASgJEhIKCmRpc2tfYnl0ZXMYBCABKAQSDQoFZXJyb3IYBSABKAkSLgoKc3RhcnRlZF9hdBgGIAEoCzIaLmdvb2dsZS5wcm90b2J1Zi5UaW1lc3RhbXASKAoFZ3Vlc3QYByABKAsyGS5jdWJlLnJ1bm5lci52NC5HdWVzdEluZm8SLAoJc3VzcGVuZGVkGBQgASgLMhkuY3ViZS5ydW5uZXIudjQuU3VzcGVuZGVkIqgBCgVQaGFzZRIVChFQSEFTRV9VTlNQRUNJRklFRBAAEgwKCENSRUFUSU5HEAESCwoHU1RPUFBFRBACEgwKCFNUQVJUSU5HEAMSCwoHUlVOTklORxAEEgwKCFNUT1BQSU5HEAUSDAoIUkVUQUlORUQQBhILCgdERUxFVEVEEAcSCgoGRkFJTEVEEAgSDgoKU1VTUEVORElORxAJEg0KCVNVU1BFTkRFRBAKSgQIFRAeIk8KCVN1c3BlbmRlZBIsCghzYXZlZF9hdBgBIAEoCzIaLmdvb2dsZS5wcm90b2J1Zi5UaW1lc3RhbXASFAoMbWVtb3J5X2J5dGVzGAIgASgEIpIDCglHdWVzdEluZm8SEQoJY29ubmVjdGVkGAEgASgIEg0KBXJlYWR5GAIgASgIEg0KBWJ1aWxkGAMgASgJEg8KB3ZlcnNpb24YBCABKAkSFAoMY2FwYWJpbGl0aWVzGAUgAygJEgoKAm9zGAYgASgJEg4KBmtlcm5lbBgHIAEoCRIPCgdib290X2lkGAggASgJEjMKBWhvb2tzGAkgAygLMiQuY3ViZS5ydW5uZXIudjQuR3Vlc3RJbmZvLkhvb2tzRW50cnkSFQoNdGVtcGxhdGVfc2VhbBgKIAEoCRIpCgVzaW5jZRgLIAEoCzIaLmdvb2dsZS5wcm90b2J1Zi5UaW1lc3RhbXASKwoGbGltaXRzGAwgASgLMhsuY3ViZS5ydW5uZXIudjQuR3Vlc3RMaW1pdHMSDQoFZXBvY2gYDSABKAMSDgoGcmVhc29uGA4gASgJEg8KB3Nlc3Npb24YDyABKAkaLAoKSG9va3NFbnRyeRILCgNrZXkYASABKAkSDQoFdmFsdWUYAiABKAk6AjgBIvgBCgtHdWVzdExpbWl0cxIXCg9tYXhfZnJhbWVfYnl0ZXMYASABKA0SGgoScmVxdWVzdF90aW1lb3V0X21zGAIgASgNEhkKEW1heF9jb21tYW5kX2J5dGVzGAMgASgNEhYKDm1heF9wYXRoX2J5dGVzGAQgASgNEhsKE21heF9leGVjX3RpbWVvdXRfbXMYBSABKA0SGAoQbWF4X291dHB1dF9ieXRlcxgGIAEoDRIZChFvdXRwdXRfcGFnZV9ieXRlcxgHIAEoDRIWCg5tYXhfcmVhZF9ieXRlcxgIIAEoDRIXCg9tYXhfd3JpdGVfYnl0ZXMYCSABKA0ivAQKDEVncmVzc1BvbGljeRI1CgdkZWZhdWx0GAEgASgOMiQuY3ViZS5ydW5uZXIudjQuRWdyZXNzUG9saWN5LkRlZmF1bHQSEgoKZGVueV9ob3N0cxgCIAMoCRIwCgVydWxlcxgDIAMoCzIhLmN1YmUucnVubmVyLnY0LkVncmVzc1BvbGljeS5SdWxlEigKBWxlYXNlGAQgASgLMhkuZ29vZ2xlLnByb3RvYnVmLkR1cmF0aW9uGssBCgRSdWxlEg0KBWhvc3RzGAEgAygJEg0KBXBvcnRzGAIgAygNEjMKBWh0dHBzGAMgASgLMiIuY3ViZS5ydW5uZXIudjQuRWdyZXNzUG9saWN5Lkh0dHBzSAASMQoEaHR0cBgEIAEoCzIhLmN1YmUucnVubmVyLnY0LkVncmVzc1BvbGljeS5IdHRwSAASNQoGZGVjaWRlGAUgASgLMiMuY3ViZS5ydW5uZXIudjQuRWdyZXNzUG9saWN5LkRlY2lkZUgAQgYKBGtpbmQaRAoFSHR0cHMSOwoKY3JlZGVudGlhbBgBIAEoCzInLmN1YmUucnVubmVyLnY0LkVncmVzc1BvbGljeS5DcmVkZW50aWFsGgYKBEh0dHAaCAoGRGVjaWRlGhoKCkNyZWRlbnRpYWwSDAoEbmFtZRgBIAEoCSJDCgdEZWZhdWx0EhcKE0RFRkFVTFRfVU5TUEVDSUZJRUQQABIICgRERU5ZEAESFQoRQUxMT1dfUFVCTElDX0hUVFAQAiL5AQoIVGVtcGxhdGUSCgoCaWQYASABKAkSCwoDa2V5GAIgASgJEgwKBG1ldGEYAyABKAkSLQoFc3RhdGUYBCABKA4yHi5jdWJlLnJ1bm5lci52NC5UZW1wbGF0ZS5TdGF0ZRIQCghkaXNrX2dpYhgFIAEoDRINCgVieXRlcxgGIAEoBBINCgV1c2VycxgHIAEoDRIuCgpjcmVhdGVkX2F0GAggASgLMhouZ29vZ2xlLnByb3RvYnVmLlRpbWVzdGFtcCI3CgVTdGF0ZRIVChFTVEFURV9VTlNQRUNJRklFRBAAEgkKBVJFQURZEAESDAoIUkVNT1ZJTkcQAiLFBQoEQ2FsbBIrCgpydW5uZXJfZ2V0GAEgASgLMhUuY3ViZS5ydW5uZXIudjQuRW1wdHlIABI3Cg5tYWNoaW5lX2NyZWF0ZRgKIAEoCzIdLmN1YmUucnVubmVyLnY0Lk1hY2hpbmVDcmVhdGVIABI1Cg1tYWNoaW5lX3N0YXJ0GAsgASgLMhwuY3ViZS5ydW5uZXIudjQuTWFjaGluZVN0YXJ0SAASMgoMbWFjaGluZV9zdG9wGAwgASgLMhouY3ViZS5ydW5uZXIudjQuTWFjaGluZVJlZkgAEjcKDm1hY2hpbmVfZGVsZXRlGA0gASgLMh0uY3ViZS5ydW5uZXIudjQuTWFjaGluZURlbGV0ZUgAEjUKD21hY2hpbmVfZGlzY2FyZBgOIAEoCzIaLmN1YmUucnVubmVyLnY0Lk1hY2hpbmVSZWZIABIxCgttYWNoaW5lX2dldBgPIAEoCzIaLmN1YmUucnVubmVyLnY0Lk1hY2hpbmVSZWZIABItCgxtYWNoaW5lX2xpc3QYECABKAsyFS5jdWJlLnJ1bm5lci52NC5FbXB0eUgAEjYKEG1hY2hpbmVfZGlhZ25vc2UYESABKAsyGi5jdWJlLnJ1bm5lci52NC5NYWNoaW5lUmVmSAASNQoPbWFjaGluZV9zdXNwZW5kGBIgASgLMhouY3ViZS5ydW5uZXIudjQuTWFjaGluZVJlZkgAEjsKEHRlbXBsYXRlX3B1Ymxpc2gYFCABKAsyHy5jdWJlLnJ1bm5lci52NC5UZW1wbGF0ZVB1Ymxpc2hIABIuCg10ZW1wbGF0ZV9saXN0GBUgASgLMhUuY3ViZS5ydW5uZXIudjQuRW1wdHlIABI2Cg90ZW1wbGF0ZV9kZWxldGUYFiABKAsyGy5jdWJlLnJ1bm5lci52NC5UZW1wbGF0ZVJlZkgAQgYKBHZlcmIiVAoKTWFjaGluZVJlZhIgCgNyZWYYASABKAsyEy5jdWJlLnJ1bm5lci52NC5SZWYSJAoFZmVuY2UYAiABKAsyFS5jdWJlLnJ1bm5lci52NC5GZW5jZSKCAQoNTWFjaGluZUNyZWF0ZRIgCgNyZWYYASABKAsyEy5jdWJlLnJ1bm5lci52NC5SZWYSJAoFZmVuY2UYAiABKAsyFS5jdWJlLnJ1bm5lci52NC5GZW5jZRIpCgRzcGVjGAMgASgLMhsuY3ViZS5ydW5uZXIudjQuTWFjaGluZVNwZWMizAEKDE1hY2hpbmVTdGFydBIgCgNyZWYYASABKAsyEy5jdWJlLnJ1bm5lci52NC5SZWYSJAoFZmVuY2UYAiABKAsyFS5jdWJlLnJ1bm5lci52NC5GZW5jZRIiCgRzaXplGAMgASgLMhQuY3ViZS5ydW5uZXIudjQuU2l6ZRIiCgRib290GAQgASgLMhQuY3ViZS5ydW5uZXIudjQuQm9vdBIsCgZwb2xpY3kYBSABKAsyHC5jdWJlLnJ1bm5lci52NC5FZ3Jlc3NQb2xpY3kiZwoNTWFjaGluZURlbGV0ZRIgCgNyZWYYASABKAsyEy5jdWJlLnJ1bm5lci52NC5SZWYSJAoFZmVuY2UYAiABKAsyFS5jdWJlLnJ1bm5lci52NC5GZW5jZRIOCgZyZXRhaW4YAyABKAgidQoPVGVtcGxhdGVQdWJsaXNoEiEKBGZyb20YASABKAsyEy5jdWJlLnJ1bm5lci52NC5SZWYSJAoFZmVuY2UYAiABKAsyFS5jdWJlLnJ1bm5lci52NC5GZW5jZRILCgNrZXkYAyABKAkSDAoEbWV0YRgEIAEoCSIZCgtUZW1wbGF0ZVJlZhIKCgJpZBgBIAEoCSLQAgoKQ2FsbFJlc3VsdBImCgVlcnJvchgBIAEoCzIVLmN1YmUucnVubmVyLnY0LkVycm9ySAASKAoGcnVubmVyGAIgASgLMhYuY3ViZS5ydW5uZXIudjQuUnVubmVySAASKgoHbWFjaGluZRgDIAEoCzIXLmN1YmUucnVubmVyLnY0Lk1hY2hpbmVIABIsCghtYWNoaW5lcxgEIAEoCzIYLmN1YmUucnVubmVyLnY0Lk1hY2hpbmVzSAASLAoIdGVtcGxhdGUYBSABKAsyGC5jdWJlLnJ1bm5lci52NC5UZW1wbGF0ZUgAEi4KCXRlbXBsYXRlcxgGIAEoCzIZLmN1YmUucnVubmVyLnY0LlRlbXBsYXRlc0gAEi4KCWRpYWdub3NpcxgHIAEoCzIZLmN1YmUucnVubmVyLnY0LkRpYWdub3Npc0gAQggKBnJlc3VsdCJDCghNYWNoaW5lcxImCgVpdGVtcxgBIAMoCzIXLmN1YmUucnVubmVyLnY0Lk1hY2hpbmUSDwoHdmVyc2lvbhgCIAEoAyI0CglUZW1wbGF0ZXMSJwoFaXRlbXMYASADKAsyGC5jdWJlLnJ1bm5lci52NC5UZW1wbGF0ZSIZCglEaWFnbm9zaXMSDAoEanNvbhgBIAEoCSIlCgxXYXRjaFJlcXVlc3QSFQoNc2luY2VfdmVyc2lvbhgBIAEoAyKoAgoKV2F0Y2hFdmVudBItCgR0eXBlGAEgASgOMh8uY3ViZS5ydW5uZXIudjQuV2F0Y2hFdmVudC5UeXBlEg8KB3ZlcnNpb24YAiABKAMSKgoHbWFjaGluZRgDIAEoCzIXLmN1YmUucnVubmVyLnY0Lk1hY2hpbmVIABIsCgh0ZW1wbGF0ZRgEIAEoCzIYLmN1YmUucnVubmVyLnY0LlRlbXBsYXRlSAASKAoGcnVubmVyGAUgASgLMhYuY3ViZS5ydW5uZXIudjQuUnVubmVySAAiSgoEVHlwZRIUChBUWVBFX1VOU1BFQ0lGSUVEEAASBwoDUFVUEAESCgoGREVMRVRFEAISDAoIQk9PS01BUksQAxIJCgVSRVNFVBAEQgoKCHJlc291cmNlImEKC0d1ZXN0SGVhZGVyEiAKA3JlZhgBIAEoCzITLmN1YmUucnVubmVyLnY0LlJlZhIkCgVmZW5jZRgCIAEoCzIVLmN1YmUucnVubmVyLnY0LkZlbmNlEgoKAm9wGAMgASgJImIKCkRpYWxIZWFkZXISIAoDcmVmGAEgASgLMhMuY3ViZS5ydW5uZXIudjQuUmVmEiQKBWZlbmNlGAIgASgLMhUuY3ViZS5ydW5uZXIudjQuRmVuY2USDAoEcG9ydBgDIAEoDSKpAQoQQ3JlZGVudGlhbEhlYWRlchIgCgNyZWYYASABKAsyEy5jdWJlLnJ1bm5lci52NC5SZWYSEgoKY3JlZGVudGlhbBgCIAEoCRILCgNzbmkYAyABKAkSDAoEaG9zdBgFIAEoCRIMCgRwb3J0GAYgASgNEiQKBWZlbmNlGAkgASgLMhUuY3ViZS5ydW5uZXIudjQuRmVuY2VKBAgEEAVKBAgHEAhKBAgIEAkiJQoGSGVhZGVyEgwKBG5hbWUYASABKAkSDQoFdmFsdWUYAiABKAwiDgoMUmVwb3J0SGVhZGVyIo4BCgxFZ3Jlc3NSZXBvcnQSIAoDcmVmGAEgASgLMhMuY3ViZS5ydW5uZXIudjQuUmVmEgwKBGhvc3QYAiABKAkSDgoGcmVhc29uGAMgASgJEhYKDmRyb3BwZWRfYmVmb3JlGAQgASgEEiYKAmF0GAUgASgLMhouZ29vZ2xlLnByb3RvYnVmLlRpbWVzdGFtcCKLAgoLRGFlbW9uRnJhbWUSCgoCY2gYASABKA0SKgoFaGVsbG8YAiABKAsyGS5jdWJlLnJ1bm5lci52NC5HdWVzdEluZm9IABIrCgZzdGF0dXMYAyABKAsyGS5jdWJlLnJ1bm5lci52NC5HdWVzdEluZm9IABIsCgNyZXEYBCABKAsyHS5jdWJlLnJ1bm5lci52NC5EYWVtb25SZXF1ZXN0SAASKwoDYW5zGAUgASgLMhwuY3ViZS5ydW5uZXIudjQuRGFlbW9uQW5zd2VySAASJgoFYWJvcnQYBiABKAsyFS5jdWJlLnJ1bm5lci52NC5FbXB0eUgAEg8KB3Nlc3Npb24YByABKAlCAwoBdCK8AgoNRGFlbW9uUmVxdWVzdBItCgVndWVzdBgBIAEoCzIcLmN1YmUucnVubmVyLnY0Lkd1ZXN0UmVxdWVzdEgAEjUKDW1hY2hpbmVfc2V0dXAYAiABKAsyHC5jdWJlLnJ1bm5lci52NC5NYWNoaW5lU2V0dXBIABIxChBzbmFwc2hvdF9wcmVwYXJlGAMgASgLMhUuY3ViZS5ydW5uZXIudjQuRW1wdHlIABIuCg1zbmFwc2hvdF9kb25lGAQgASgLMhUuY3ViZS5ydW5uZXIudjQuRW1wdHlIABIxChB0ZW1wbGF0ZV9wdWJsaXNoGAUgASgLMhUuY3ViZS5ydW5uZXIudjQuRW1wdHlIABIpCghzaHV0ZG93bhgGIAEoCzIVLmN1YmUucnVubmVyLnY0LkVtcHR5SABCBAoCb3AiKAoMR3Vlc3RSZXF1ZXN0EgoKAm9wGAEgASgJEgwKBGRhdGEYAiABKAwieAoMRGFlbW9uQW5zd2VyEg8KBWd1ZXN0GAEgASgMSAASJgoFZXJyb3IYAiABKAsyFS5jdWJlLnJ1bm5lci52NC5FcnJvckgAEiUKBGRvbmUYAyABKAsyFS5jdWJlLnJ1bm5lci52NC5FbXB0eUgAQggKBnJlc3VsdCLWAgoMTWFjaGluZVNldHVwEiAKA3JlZhgBIAEoCzITLmN1YmUucnVubmVyLnY0LlJlZhI+Cglkb2N1bWVudHMYAiADKAsyKy5jdWJlLnJ1bm5lci52NC5NYWNoaW5lU2V0dXAuRG9jdW1lbnRzRW50cnkSDwoHZW50cm9weRgDIAEoDBIlCgZsYXllcnMYBCADKAsyFS5jdWJlLnJ1bm5lci52NC5MYXllchIqCgVpbWFnZRgFIAEoCzIbLmN1YmUucnVubmVyLnY0LkltYWdlQ29uZmlnEg4KBmNhX3BlbRgGIAEoCRIWCg5ydW5uZXJfdmVyc2lvbhgHIAEoCRIQCghwcm90b2NvbBgIIAEoDRIUCgxjYXBhYmlsaXRpZXMYCSADKAkaMAoORG9jdW1lbnRzRW50cnkSCwoDa2V5GAEgASgJEg0KBXZhbHVlGAIgASgMOgI4ASJOCgVMYXllchIRCglwYXJ0aXRpb24YASABKA0SEQoHZGlmZl9pZBgCIAEoCUgAEhUKC3RlbXBsYXRlX2lkGAMgASgJSABCCAoGc291cmNlIioKC0ltYWdlQ29uZmlnEg4KBmRpZ2VzdBgBIAEoCRILCgNlbnYYAiADKAkq3AEKBENvZGUSFAoQQ09ERV9VTlNQRUNJRklFRBAAEg0KCU5PVF9GT1VORBABEhIKDkFMUkVBRFlfRVhJU1RTEAISFwoTRkFJTEVEX1BSRUNPTkRJVElPThADEhYKElJFU09VUkNFX0VYSEFVU1RFRBAEEg8KC1VOQVZBSUxBQkxFEAUSFQoRUEVSTUlTU0lPTl9ERU5JRUQQBhIUChBJTlZBTElEX0FSR1VNRU5UEAcSEQoNVU5JTVBMRU1FTlRFRBAIEgwKCElOVEVSTkFMEAkSCwoHQUJPUlRFRBAKYgZwcm90bzM", [file_google_protobuf_duration, file_google_protobuf_timestamp]);

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
 * Describes the message cube.runner.v4.Suspended.
 * Use `create(SuspendedSchema)` to create a new message.
 */
export const SuspendedSchema = /*@__PURE__*/
  messageDesc(file_runner, 21);

/**
 * Describes the message cube.runner.v4.GuestInfo.
 * Use `create(GuestInfoSchema)` to create a new message.
 */
export const GuestInfoSchema = /*@__PURE__*/
  messageDesc(file_runner, 22);

/**
 * Describes the message cube.runner.v4.GuestLimits.
 * Use `create(GuestLimitsSchema)` to create a new message.
 */
export const GuestLimitsSchema = /*@__PURE__*/
  messageDesc(file_runner, 23);

/**
 * Describes the message cube.runner.v4.EgressPolicy.
 * Use `create(EgressPolicySchema)` to create a new message.
 */
export const EgressPolicySchema = /*@__PURE__*/
  messageDesc(file_runner, 24);

/**
 * Describes the message cube.runner.v4.EgressPolicy.Rule.
 * Use `create(EgressPolicy_RuleSchema)` to create a new message.
 */
export const EgressPolicy_RuleSchema = /*@__PURE__*/
  messageDesc(file_runner, 24, 0);

/**
 * Describes the message cube.runner.v4.EgressPolicy.Https.
 * Use `create(EgressPolicy_HttpsSchema)` to create a new message.
 */
export const EgressPolicy_HttpsSchema = /*@__PURE__*/
  messageDesc(file_runner, 24, 1);

/**
 * Describes the message cube.runner.v4.EgressPolicy.Http.
 * Use `create(EgressPolicy_HttpSchema)` to create a new message.
 */
export const EgressPolicy_HttpSchema = /*@__PURE__*/
  messageDesc(file_runner, 24, 2);

/**
 * Describes the message cube.runner.v4.EgressPolicy.Decide.
 * Use `create(EgressPolicy_DecideSchema)` to create a new message.
 */
export const EgressPolicy_DecideSchema = /*@__PURE__*/
  messageDesc(file_runner, 24, 3);

/**
 * Describes the message cube.runner.v4.EgressPolicy.Credential.
 * Use `create(EgressPolicy_CredentialSchema)` to create a new message.
 */
export const EgressPolicy_CredentialSchema = /*@__PURE__*/
  messageDesc(file_runner, 24, 4);

/**
 * Describes the enum cube.runner.v4.EgressPolicy.Default.
 */
export const EgressPolicy_DefaultSchema = /*@__PURE__*/
  enumDesc(file_runner, 24, 0);

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
  messageDesc(file_runner, 25);

/**
 * Describes the enum cube.runner.v4.Template.State.
 */
export const Template_StateSchema = /*@__PURE__*/
  enumDesc(file_runner, 25, 0);

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
  messageDesc(file_runner, 26);

/**
 * Describes the message cube.runner.v4.MachineRef.
 * Use `create(MachineRefSchema)` to create a new message.
 */
export const MachineRefSchema = /*@__PURE__*/
  messageDesc(file_runner, 27);

/**
 * Describes the message cube.runner.v4.MachineCreate.
 * Use `create(MachineCreateSchema)` to create a new message.
 */
export const MachineCreateSchema = /*@__PURE__*/
  messageDesc(file_runner, 28);

/**
 * Describes the message cube.runner.v4.MachineStart.
 * Use `create(MachineStartSchema)` to create a new message.
 */
export const MachineStartSchema = /*@__PURE__*/
  messageDesc(file_runner, 29);

/**
 * Describes the message cube.runner.v4.MachineDelete.
 * Use `create(MachineDeleteSchema)` to create a new message.
 */
export const MachineDeleteSchema = /*@__PURE__*/
  messageDesc(file_runner, 30);

/**
 * Describes the message cube.runner.v4.TemplatePublish.
 * Use `create(TemplatePublishSchema)` to create a new message.
 */
export const TemplatePublishSchema = /*@__PURE__*/
  messageDesc(file_runner, 31);

/**
 * Describes the message cube.runner.v4.TemplateRef.
 * Use `create(TemplateRefSchema)` to create a new message.
 */
export const TemplateRefSchema = /*@__PURE__*/
  messageDesc(file_runner, 32);

/**
 * Describes the message cube.runner.v4.CallResult.
 * Use `create(CallResultSchema)` to create a new message.
 */
export const CallResultSchema = /*@__PURE__*/
  messageDesc(file_runner, 33);

/**
 * Describes the message cube.runner.v4.Machines.
 * Use `create(MachinesSchema)` to create a new message.
 */
export const MachinesSchema = /*@__PURE__*/
  messageDesc(file_runner, 34);

/**
 * Describes the message cube.runner.v4.Templates.
 * Use `create(TemplatesSchema)` to create a new message.
 */
export const TemplatesSchema = /*@__PURE__*/
  messageDesc(file_runner, 35);

/**
 * Describes the message cube.runner.v4.Diagnosis.
 * Use `create(DiagnosisSchema)` to create a new message.
 */
export const DiagnosisSchema = /*@__PURE__*/
  messageDesc(file_runner, 36);

/**
 * Describes the message cube.runner.v4.WatchRequest.
 * Use `create(WatchRequestSchema)` to create a new message.
 */
export const WatchRequestSchema = /*@__PURE__*/
  messageDesc(file_runner, 37);

/**
 * Describes the message cube.runner.v4.WatchEvent.
 * Use `create(WatchEventSchema)` to create a new message.
 */
export const WatchEventSchema = /*@__PURE__*/
  messageDesc(file_runner, 38);

/**
 * Describes the enum cube.runner.v4.WatchEvent.Type.
 */
export const WatchEvent_TypeSchema = /*@__PURE__*/
  enumDesc(file_runner, 38, 0);

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
  messageDesc(file_runner, 39);

/**
 * Describes the message cube.runner.v4.DialHeader.
 * Use `create(DialHeaderSchema)` to create a new message.
 */
export const DialHeaderSchema = /*@__PURE__*/
  messageDesc(file_runner, 40);

/**
 * Describes the message cube.runner.v4.CredentialHeader.
 * Use `create(CredentialHeaderSchema)` to create a new message.
 */
export const CredentialHeaderSchema = /*@__PURE__*/
  messageDesc(file_runner, 41);

/**
 * Describes the message cube.runner.v4.Header.
 * Use `create(HeaderSchema)` to create a new message.
 */
export const HeaderSchema = /*@__PURE__*/
  messageDesc(file_runner, 42);

/**
 * Describes the message cube.runner.v4.ReportHeader.
 * Use `create(ReportHeaderSchema)` to create a new message.
 */
export const ReportHeaderSchema = /*@__PURE__*/
  messageDesc(file_runner, 43);

/**
 * Describes the message cube.runner.v4.EgressReport.
 * Use `create(EgressReportSchema)` to create a new message.
 */
export const EgressReportSchema = /*@__PURE__*/
  messageDesc(file_runner, 44);

/**
 * Describes the message cube.runner.v4.DaemonFrame.
 * Use `create(DaemonFrameSchema)` to create a new message.
 */
export const DaemonFrameSchema = /*@__PURE__*/
  messageDesc(file_runner, 45);

/**
 * Describes the message cube.runner.v4.DaemonRequest.
 * Use `create(DaemonRequestSchema)` to create a new message.
 */
export const DaemonRequestSchema = /*@__PURE__*/
  messageDesc(file_runner, 46);

/**
 * Describes the message cube.runner.v4.GuestRequest.
 * Use `create(GuestRequestSchema)` to create a new message.
 */
export const GuestRequestSchema = /*@__PURE__*/
  messageDesc(file_runner, 47);

/**
 * Describes the message cube.runner.v4.DaemonAnswer.
 * Use `create(DaemonAnswerSchema)` to create a new message.
 */
export const DaemonAnswerSchema = /*@__PURE__*/
  messageDesc(file_runner, 48);

/**
 * Describes the message cube.runner.v4.MachineSetup.
 * Use `create(MachineSetupSchema)` to create a new message.
 */
export const MachineSetupSchema = /*@__PURE__*/
  messageDesc(file_runner, 49);

/**
 * Describes the message cube.runner.v4.Layer.
 * Use `create(LayerSchema)` to create a new message.
 */
export const LayerSchema = /*@__PURE__*/
  messageDesc(file_runner, 50);

/**
 * Describes the message cube.runner.v4.ImageConfig.
 * Use `create(ImageConfigSchema)` to create a new message.
 */
export const ImageConfigSchema = /*@__PURE__*/
  messageDesc(file_runner, 51);

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

