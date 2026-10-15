//! Spike 4a/4b (2026-10-15): shared code for the gate benchmark and the
//! Datalog fixture runner. Not product code.
use biscuit_auth::{
    builder::{date, fact, string, Algorithm, Fact},
    error, AuthorizerBuilder, Biscuit, BlockBuilder, KeyPair, PrivateKey, PublicKey,
};
use serde::Deserialize;
use std::{collections::HashSet, path::Path, time::{Duration, SystemTime}};

#[derive(Deserialize, Clone, Debug)]
pub struct Keys {
    pub root_private: String,
    pub root_key_id: u32,
    pub approval_private: String,
    pub other_private: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Attenuation { code: String },
    ThirdParty { signer: String, code: String },
}

#[derive(Deserialize, Clone, Debug)]
pub struct Token {
    pub signed_by: String,
    pub authority: String,
    pub blocks: Vec<Block>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Fixture {
    pub name: String,
    pub description: String,
    pub test_only_keys: Keys,
    pub token: Token,
    pub authorizer: String,
    pub revoked_blocks: Vec<usize>,
    pub actions: Vec<String>,
    pub expect: String,
}

pub fn load_fixtures(dir: &Path) -> Vec<Fixture> {
    let mut paths: Vec<_> = std::fs::read_dir(dir)
        .expect("fixture dir")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    paths.sort();
    paths
        .iter()
        .map(|p| serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap())
        .collect()
}

pub fn keypair(hex: &str) -> KeyPair {
    KeyPair::from(&PrivateKey::from_bytes_hex(hex, Algorithm::Ed25519).unwrap())
}

impl Keys {
    pub fn signer(&self, name: &str) -> KeyPair {
        match name {
            "root" => keypair(&self.root_private),
            "approval" => keypair(&self.approval_private),
            "other" => keypair(&self.other_private),
            _ => panic!("unknown signer {name}"),
        }
    }
    pub fn root_public(&self) -> PublicKey {
        keypair(&self.root_private).public()
    }
}

/// Mints the fixture's token: authority signed by `signed_by` with the root
/// key id, then each block in order (attenuation = plain append, third_party
/// = request + block signed by the signer's key + append).
pub fn mint(f: &Fixture) -> Result<Biscuit, error::Token> {
    let k = &f.test_only_keys;
    let mut token = Biscuit::builder()
        .code(&f.token.authority)?
        .root_key_id(k.root_key_id)
        .build(&k.signer(&f.token.signed_by))?;
    for b in &f.token.blocks {
        token = match b {
            Block::Attenuation { code } => token.append(BlockBuilder::new().code(code)?)?,
            Block::ThirdParty { signer, code } => {
                let kp = k.signer(signer);
                let request = token.third_party_request()?;
                let block = request.create_block(&kp.private(), BlockBuilder::new().code(code)?)?;
                token.append_third_party(kp.public(), block)?
            }
        };
    }
    Ok(token)
}

/// Root key provider: key id 1 is cubed's (test) root key; anything else is
/// unknown. Records the id it was asked for.
pub fn verify(bytes: &[u8], keys: &Keys) -> Result<Biscuit, error::Token> {
    let root = keys.root_public();
    let id = keys.root_key_id;
    Biscuit::from(bytes, move |kid: Option<u32>| {
        if kid == Some(id) {
            Ok(root)
        } else {
            Err(error::Format::UnknownPublicKey)
        }
    })
}

pub fn is_revoked(token: &Biscuit, revoked: &HashSet<Vec<u8>>) -> bool {
    token.revocation_identifiers().iter().any(|id| revoked.contains(id))
}

/// One action, from scratch: a fresh authorizer (policies parsed) + ambient.
pub fn authorize_action(token: &Biscuit, authorizer: &str, ambient: &str) -> Result<usize, error::Token> {
    AuthorizerBuilder::new()
        .code(authorizer)?
        .code(ambient)?
        .build(token)?
        .authorize()
}

/// The fixture verdict: "allow" iff the token verifies, no block is revoked
/// and every action is allowed.
pub fn evaluate(bytes: &[u8], f: &Fixture) -> (String, String) {
    let token = match verify(bytes, &f.test_only_keys) {
        Ok(t) => t,
        Err(e) => return ("deny".into(), format!("verify: {e}")),
    };
    // Revoked set: in production cubed stores the ids at mint time; here the
    // fixture names block indexes and we read their ids off the token.
    let ids = token.revocation_identifiers();
    let revoked: HashSet<Vec<u8>> = f.revoked_blocks.iter().map(|&i| ids[i].clone()).collect();
    if is_revoked(&token, &revoked) {
        return ("deny".into(), "revoked".into());
    }
    for (i, a) in f.actions.iter().enumerate() {
        if let Err(e) = authorize_action(&token, &f.authorizer, a) {
            return ("deny".into(), format!("action {i}: {e}"));
        }
    }
    ("allow".into(), String::new())
}

// ---------- benchmark helpers ----------

pub struct Ambient<'a> {
    pub peer: &'a str,
    pub vm: &'a str,
    pub time: SystemTime,
}

pub enum Action<'a> {
    Push { host: &'a str, repo: &'a str, r#ref: String, old: &'a str, new: &'a str },
    Http { host: &'a str, method: &'a str, path: &'a str },
}

/// Ambient facts built programmatically (no Datalog parsing on the hot path).
pub fn ambient_facts(a: &Ambient, action: &Action) -> Vec<Fact> {
    let mut v = vec![
        fact("peer", &[string(a.peer)]),
        fact("vm", &[string(a.vm)]),
        fact("time", &[date(&a.time)]),
    ];
    v.push(match action {
        Action::Push { host, repo, r#ref, old, new } => fact(
            "req_git_push",
            &[string(host), string(repo), string(r#ref), string(old), string(new)],
        ),
        Action::Http { host, method, path } => fact("req_http", &[string(host), string(method), string(path)]),
    });
    v
}

/// Per-flow cache: policies parsed once into a builder; per action the
/// builder is cloned, ambient facts added and built against the already
/// verified token. biscuit-auth 6 has no way to add facts to a built
/// Authorizer, so this is the most that can be reused.
pub fn authorize_cached(base: &AuthorizerBuilder, token: &Biscuit, facts: Vec<Fact>) -> Result<usize, error::Token> {
    let mut b = base.clone();
    for f in facts {
        b = b.fact(f)?;
    }
    b.build(token)?.authorize()
}

pub fn fixture_time() -> SystemTime {
    // 2026-10-15T18:00:00Z
    SystemTime::UNIX_EPOCH + Duration::from_secs(1_792_087_200)
}

// ---------- benchmark setup ----------

pub const FIXTURE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packages/runner-protocol/fixtures/authz/datalog");
pub const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
pub const OLD: &str = "1111111111111111111111111111111111111111";

pub struct Setup {
    pub fixture: Fixture,
    pub bytes: Vec<u8>,
    pub token: Biscuit,
    pub runner: String,
}

/// Realistic token: the fixtures' authority (29 grant/identity facts, 4
/// checks with 7 alternatives in the approval check), one task attenuation
/// block (checks only), one third-party approval block.
pub fn setup() -> Setup {
    let mut fixture = load_fixtures(Path::new(FIXTURE_DIR))
        .into_iter()
        .find(|f| f.name == "push-main-approved-sha-allowed")
        .unwrap();
    let approval = fixture.token.blocks.remove(0);
    fixture.token.blocks = vec![
        Block::Attenuation {
            code: r#"check if req_git_push($h, $r, $ref, $o, $n), $ref.starts_with("refs/heads/cube/t1/")
  or req_git_push($h, $r, "refs/heads/main", $o, $n)
  or req_git_fetch($h, $r)
  or req_http($h, "GET", $path)
  or req_github_api($r, $op);"#
                .into(),
        },
        approval,
    ];
    let token = mint(&fixture).unwrap();
    let bytes = token.to_vec().unwrap();
    let runner = fixture.token.authority.split("runner(\"").nth(1).unwrap().split('"').next().unwrap().to_string();
    Setup { fixture, bytes, token, runner }
}

impl Setup {
    pub fn ambient_text(&self, action: &str) -> String {
        format!("peer(\"{}\");\nvm(\"vm1\");\ntime(2026-10-15T18:00:00Z);\n{action}", self.runner)
    }
    pub fn ambient(&self) -> Ambient<'_> {
        Ambient { peer: &self.runner, vm: "vm1", time: fixture_time() }
    }
}

pub fn push_text(r: &str, new: &str) -> String {
    format!("req_git_push(\"github.com\", \"cubeyard/cube\", \"{r}\", \"{OLD}\", \"{new}\");")
}

pub fn push_action<'a>(r: &str, new: &'a str) -> Action<'a> {
    Action::Push { host: "github.com", repo: "cubeyard/cube", r#ref: r.to_string(), old: OLD, new }
}
