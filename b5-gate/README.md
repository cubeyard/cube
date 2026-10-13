# B-5 gate controls (not for merge)

Each diff applies to the PR head (this commit's parent) and must make the
named test fail. See the B-5 report for the recipe.

- a: B6 off (no pairs recorded): V7, `cargo test -p cube-gateway --test credential`
- b: ownership check off (`checkMachine`): the ownership step, `runner-credentials-test.ts`
- c: fence check off (`checkMachine`): the fence step, `runner-credentials-test.ts`
- d: berth sends a credential rule's request straight out: the first credential request (V5 4), berth's credential tests
- e: `Accept-Encoding` not forced and encoded answers let through: V7, gateway credential test
