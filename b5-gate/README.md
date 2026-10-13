# B-5 gate controls, second set (not for merge)

Each diff applies to the PR head (this commit's parent) and must make the
named test fail. a–e are unchanged from `b5-gate-controls` (same bytes).

- a: B6 off: V7; `cargo test -p cube-gateway --test credential`
- b: ownership check off: the ownership step; `runner-credentials-test.ts`
- c: fence check off: the fence step; `runner-credentials-test.ts`
- d: berth sends a credential rule's request straight out: V5 4; berth's credential tests
- e: identity not forced, encoded answers let through: V7; the gateway's credential test
- f: the token planted in the machine's directory: the host leak scan (a match)
- g: an unreadable file in the machine's directory: the host leak scan (EACCES)
