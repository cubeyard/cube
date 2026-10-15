//! Spike 4b: why the draft's approval shape was changed. Runs three shapes
//! against the same valid approval and a forged one, prints verdicts.
use biscuit_auth::{AuthorizerBuilder, Biscuit, BlockBuilder};
use biscuit_bench::keypair;

const ROOT: &str = "5ed761bfda702286488a3e55ea26e9844c53c877b0b131832a977d770d73ccdc";
const APPROVAL: &str = "9faf1d752ee88ed4649e5c5c17ea2e3ef3bf854f7b4980d4a4ebaee992516cb6";

fn run(name: &str, authority_rules: &str, policies: &str, approval: &str, ambient_ref: &str) {
    let root = keypair(ROOT);
    let k = keypair(APPROVAL);
    let kpub = k.public().to_string();
    let authority = format!(
        "git_push_approval(\"github.com\", \"cubeyard/cube\", \"refs/heads/main\");\n{}",
        authority_rules.replace("KEY", &kpub)
    );
    let t = Biscuit::builder().code(&authority).unwrap().build(&root).unwrap();
    let req = t.third_party_request().unwrap();
    let blk = req.create_block(&k.private(), BlockBuilder::new().code(approval).unwrap()).unwrap();
    let t = t.append_third_party(k.public(), blk).unwrap();
    let ambient = format!("req_git_push(\"github.com\", \"cubeyard/cube\", \"{ambient_ref}\", \"o\", \"A\");");
    let r = AuthorizerBuilder::new()
        .code(policies.replace("KEY", &kpub))
        .unwrap()
        .code(ambient)
        .unwrap()
        .build(&t)
        .unwrap()
        .authorize();
    println!("{name}: {}", if r.is_ok() { "allow" } else { "deny" });
}

fn main() {
    let rule = "push_ok($h, $r, $ref, $n) <- req_git_push($h, $r, $ref, $o, $n), git_push_approval($h, $r, $ref), approved($h, $r, $ref, $n) trusting authority, KEY;";
    let valid = "approved(\"github.com\", \"cubeyard/cube\", \"refs/heads/main\", \"A\");";
    let forged = "git_push_approval(\"github.com\", \"cubeyard/cube\", \"refs/heads/prod\");\napproved(\"github.com\", \"cubeyard/cube\", \"refs/heads/prod\", \"A\");\npush_ok(\"github.com\", \"cubeyard/cube\", \"refs/heads/prod\", \"A\");";
    // A: the draft. The derived push_ok fact has origin {authority, approval block, authorizer};
    // a default-scope policy only trusts {authority, authorizer}, so it never sees it.
    let a = "allow if push_ok($h, $r, $ref, $n);";
    run("A draft (authority rule trusting K, default policy), valid approval main", rule, a, valid, "refs/heads/main");
    // B: make A work by letting the policy trust K. Works, but the policy now
    // trusts every fact in K-signed blocks: K can add grants.
    let b = "allow if push_ok($h, $r, $ref, $n) trusting authority, KEY;";
    run("B policy trusting K, valid approval main", rule, b, valid, "refs/heads/main");
    run("B policy trusting K, K block forges grant for prod", rule, b, forged, "refs/heads/prod");
    // C: final. Grant in a K-blind policy, approval in an authority check
    // whose approval alternatives trust K.
    let c_rules = "check if req_git_push($h, $r, $ref, $o, $n), approved($h, $r, $ref, $n) trusting KEY;";
    let c = "allow if req_git_push($h, $r, $ref, $o, $n), git_push_approval($h, $r, $ref);";
    run("C final, valid approval main", c_rules, c, valid, "refs/heads/main");
    run("C final, K block forges grant for prod", c_rules, c, forged, "refs/heads/prod");
    run("C final, no approval (approval block for prod) push main", c_rules, c, "approved(\"github.com\", \"cubeyard/cube\", \"refs/heads/prod\", \"A\");", "refs/heads/main");
}
