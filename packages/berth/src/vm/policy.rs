//! A machine's egress policy as data (runner.proto's `EgressPolicy`, sent
//! with every `machine_start`; masterplan B-4). Checked when it arrives, so
//! a policy berth cannot carry out is refused before the machine starts,
//! and decided per HTTP request in this order:
//!
//! ```text
//! deny_hosts                         -> deny_host
//! first rule whose hosts and ports match
//!   Http, Https without credential   -> allow (out from the runner)
//!   Https with a credential          -> the credential stream to cubed
//!                                       (B-5; placeholders go along)
//! no rule: ALLOW_PUBLIC_HTTP         -> allow;  DENY -> policy
//! allowed out, but a cube_ph_ placeholder in a header -> placeholder
//! ```
//!
//! CONNECT, Upgrade and the `Host` checks come before (egress.rs); the
//! address check after (netstack's `Upstream`).
use std::time::Duration;

use cube_runner_protocol::{
    proto::{self, Code, egress_policy},
    refuse,
};

/// How a request reached the runner: plain HTTP on 80 or TLS on 443.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
    Http,
    Https,
}

impl Scheme {
    fn port(self) -> u16 {
        match self {
            Self::Http => 80,
            Self::Https => 443,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Pattern {
    Any,
    /// `*.suffix`: names that end in `.suffix` (not `suffix` itself).
    Below(String),
    Exact(String),
}

impl Pattern {
    fn parse(text: &str) -> Option<Self> {
        if text == "*" {
            return Some(Self::Any);
        }
        let (below, name) = match text.strip_prefix("*.") {
            Some(name) => (true, name),
            None => (false, text),
        };
        let valid = !name.is_empty()
            && name.len() <= 253
            && name.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_'
                    })
            });
        valid.then(|| {
            if below {
                Self::Below(name.to_owned())
            } else {
                Self::Exact(name.to_owned())
            }
        })
    }

    fn matches(&self, host: &str) -> bool {
        match self {
            Self::Any => true,
            Self::Exact(name) => host == name,
            Self::Below(suffix) => host
                .strip_suffix(suffix.as_str())
                .is_some_and(|head| head.len() > 1 && head.ends_with('.')),
        }
    }
}

/// Where an allowed request goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    /// Out from the runner, without any placeholder.
    Direct,
    /// To cubed's credential proxy over a `credential` stream, as the
    /// credential of this name.
    Credential(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Kind {
    Http,
    Https,
    /// An Https rule with a credential: the `credential` stream (B-5).
    Credential(String),
}

#[derive(Clone, Debug)]
struct Rule {
    hosts: Vec<Pattern>,
    ports: Vec<u16>,
    kind: Kind,
}

impl Rule {
    fn scheme(&self) -> Scheme {
        match self.kind {
            Kind::Http => Scheme::Http,
            Kind::Https | Kind::Credential(_) => Scheme::Https,
        }
    }

    fn matches(&self, scheme: Scheme, host: &str, port: u16) -> bool {
        let ports_match = if self.ports.is_empty() {
            port == self.scheme().port()
        } else {
            self.ports.contains(&port)
        };
        self.scheme() == scheme && ports_match && self.hosts.iter().any(|p| p.matches(host))
    }
}

/// A checked policy.
#[derive(Clone, Debug)]
pub struct Policy {
    allow_public: bool,
    deny_hosts: Vec<Pattern>,
    rules: Vec<Rule>,
    /// Ordinary egress after cubed's connection is gone.
    pub lease: Duration,
}

/// Why a request is refused, as `EgressReport.reason` names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Denial {
    LeaseExpired,
    Policy,
    DenyHost,
    Connect,
    Upgrade,
    Placeholder,
    CredentialUnavailable,
    Address,
    SniMismatch,
    ResolveFailed,
}

impl Denial {
    pub fn reason(self) -> &'static str {
        match self {
            Self::LeaseExpired => "lease_expired",
            Self::Policy => "policy",
            Self::DenyHost => "deny_host",
            Self::Connect => "connect",
            Self::Upgrade => "upgrade",
            Self::Placeholder => "placeholder",
            Self::CredentialUnavailable => "credential_unavailable",
            Self::Address => "address",
            Self::SniMismatch => "sni_mismatch",
            Self::ResolveFailed => "resolve_failed",
        }
    }

    /// What the guest reads in the 403 (`x-cube-denied`).
    pub fn message(self) -> &'static str {
        match self {
            Self::LeaseExpired => "egress lease expired: the runner has lost cubed",
            Self::Policy => "host is not allowed by the egress policy",
            Self::DenyHost => "host is denied by the egress policy",
            Self::Connect => "CONNECT is not supported",
            Self::Upgrade => "protocol upgrades are not supported",
            Self::Placeholder => {
                "a secret placeholder is only sent where a credential rule allows it"
            }
            Self::CredentialUnavailable => "credentials need cubed, which the runner cannot reach",
            Self::Address => "upstream address is not public",
            Self::SniMismatch => "Host does not match the TLS server name",
            Self::ResolveFailed => "upstream host did not resolve",
        }
    }
}

fn invalid(message: String) -> proto::Error {
    refuse(Code::InvalidArgument, "egress_policy", &message)
}

impl Policy {
    /// No egress at all: what a machine started without a policy gets.
    pub fn deny_all() -> Self {
        Self {
            allow_public: false,
            deny_hosts: vec![],
            rules: vec![],
            lease: Duration::ZERO,
        }
    }

    /// Checks `MachineStart.policy`. Absent: [`Policy::deny_all`].
    pub fn from_proto(policy: Option<&proto::EgressPolicy>) -> Result<Self, proto::Error> {
        let Some(policy) = policy else {
            return Ok(Self::deny_all());
        };
        let patterns = |list: &[String]| -> Result<Vec<Pattern>, proto::Error> {
            list.iter()
                .map(|text| {
                    Pattern::parse(text).ok_or_else(|| {
                        invalid(format!(
                            "host pattern {text:?}: a lowercase name without a trailing dot, *.suffix or *"
                        ))
                    })
                })
                .collect()
        };
        let mut rules = vec![];
        for rule in &policy.rules {
            let kind = match &rule.kind {
                Some(egress_policy::rule::Kind::Http(_)) => Kind::Http,
                Some(egress_policy::rule::Kind::Https(https)) => match &https.credential {
                    Some(credential) if !credential.name.is_empty() => {
                        Kind::Credential(credential.name.clone())
                    }
                    _ => Kind::Https,
                },
                Some(egress_policy::rule::Kind::Decide(_)) => {
                    return Err(refuse(
                        Code::Unimplemented,
                        "egress_decide",
                        "a vm runner decides egress from the policy alone; Decide rules are not supported",
                    ));
                }
                None => return Err(invalid("a rule needs http, https or decide".into())),
            };
            let mut ports = vec![];
            for port in &rule.ports {
                match *port {
                    80 | 443 => ports.push(*port as u16),
                    other => {
                        return Err(invalid(format!(
                            "rule port {other}: a vm runner carries only 80 and 443"
                        )));
                    }
                }
            }
            if rule.hosts.is_empty() {
                return Err(invalid("a rule needs at least one host pattern".into()));
            }
            rules.push(Rule {
                hosts: patterns(&rule.hosts)?,
                ports,
                kind,
            });
        }
        let lease = match &policy.lease {
            None => Duration::ZERO,
            Some(lease) if lease.seconds < 0 || lease.nanos < 0 => {
                return Err(invalid("the lease must not be negative".into()));
            }
            Some(lease) => Duration::new(lease.seconds as u64, lease.nanos as u32),
        };
        Ok(Self {
            // DEFAULT_UNSPECIFIED is DENY: nothing goes out unless said so.
            allow_public: policy.default == egress_policy::Default::AllowPublicHttp as i32,
            deny_hosts: patterns(&policy.deny_hosts)?,
            rules,
            lease,
        })
    }

    /// The decision for one request to `host` (lowercase, no trailing dot)
    /// on `port`, which carries `placeholders` in its headers.
    pub fn decide(
        &self,
        scheme: Scheme,
        host: &str,
        port: u16,
        placeholders: &[String],
    ) -> Result<Route, Denial> {
        if self.deny_hosts.iter().any(|p| p.matches(host)) {
            return Err(Denial::DenyHost);
        }
        match self.rules.iter().find(|r| r.matches(scheme, host, port)) {
            // cubed's proxy checks the placeholders (their credential and
            // thread) and decides; the runner never sees the token.
            Some(Rule {
                kind: Kind::Credential(name),
                ..
            }) => return Ok(Route::Credential(name.clone())),
            Some(_) => {}
            None if self.allow_public => {}
            None => return Err(Denial::Policy),
        }
        // No credential rule matched, so no placeholder may leave.
        if !placeholders.is_empty() {
            return Err(Denial::Placeholder);
        }
        Ok(Route::Direct)
    }

    /// The policy as a diagnosis shows it (masterplan B-9): its default,
    /// lease, denied hosts and rules, at most [`SUMMARY_ITEMS`] of each list
    /// with how many there are. A credential rule names its credential,
    /// never a value: the runner has none.
    pub fn summary(&self) -> serde_json::Value {
        let patterns = |list: &[Pattern]| -> serde_json::Value {
            serde_json::json!({
                "count": list.len(),
                "shown": list.iter().take(SUMMARY_ITEMS).map(Pattern::text).collect::<Vec<_>>(),
            })
        };
        let rules: Vec<serde_json::Value> = self
            .rules
            .iter()
            .take(SUMMARY_ITEMS)
            .map(|rule| {
                let (kind, credential) = match &rule.kind {
                    Kind::Http => ("http", None),
                    Kind::Https => ("https", None),
                    Kind::Credential(name) => ("https", Some(name.as_str())),
                };
                serde_json::json!({
                    "kind": kind,
                    "credential": credential,
                    "hosts": patterns(&rule.hosts),
                    "ports": rule.ports,
                })
            })
            .collect();
        serde_json::json!({
            "default": if self.allow_public { "allow_public_http" } else { "deny" },
            "leaseSeconds": self.lease.as_secs_f64(),
            "denyHosts": patterns(&self.deny_hosts),
            "rules": { "count": self.rules.len(), "shown": rules },
        })
    }
}

/// At most this many of a policy's rules, denied hosts and hosts per rule
/// in its [`Policy::summary`].
pub const SUMMARY_ITEMS: usize = 32;

impl Pattern {
    fn text(&self) -> String {
        match self {
            Self::Any => "*".into(),
            Self::Below(name) => format!("*.{name}"),
            Self::Exact(name) => name.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GH: &str = "cube_ph_github_AbCdEfGhIjKlMnOpQrStUv";

    fn rule(hosts: &[&str], ports: &[u32], kind: egress_policy::rule::Kind) -> egress_policy::Rule {
        egress_policy::Rule {
            hosts: hosts.iter().map(|h| h.to_string()).collect(),
            ports: ports.to_vec(),
            kind: Some(kind),
        }
    }
    fn https() -> egress_policy::rule::Kind {
        egress_policy::rule::Kind::Https(egress_policy::Https { credential: None })
    }
    fn http() -> egress_policy::rule::Kind {
        egress_policy::rule::Kind::Http(egress_policy::Http {})
    }
    fn credential(name: &str) -> egress_policy::rule::Kind {
        egress_policy::rule::Kind::Https(egress_policy::Https {
            credential: Some(egress_policy::Credential { name: name.into() }),
        })
    }
    fn policy(
        default: egress_policy::Default,
        deny: &[&str],
        rules: Vec<egress_policy::Rule>,
    ) -> proto::EgressPolicy {
        proto::EgressPolicy {
            default: default as i32,
            deny_hosts: deny.iter().map(|h| h.to_string()).collect(),
            rules,
            lease: Some(pbjson_types::Duration {
                seconds: 900,
                nanos: 0,
            }),
        }
    }

    #[test]
    fn the_order_is_deny_hosts_rules_default_then_placeholders() {
        let p = Policy::from_proto(Some(&policy(
            egress_policy::Default::AllowPublicHttp,
            &["*.evil.example", "blocked.example"],
            vec![
                rule(&["github.com", "*.github.com"], &[], credential("github")),
                rule(&["plain.example"], &[], http()),
            ],
        )))
        .unwrap();
        assert_eq!(p.lease, Duration::from_secs(900));
        let d = |s, h: &str, port, ph: &[&str]| {
            p.decide(
                s,
                h,
                port,
                &ph.iter().map(|x| x.to_string()).collect::<Vec<_>>(),
            )
        };
        use Scheme::*;
        let direct = Ok(Route::Direct);
        let github = Ok(Route::Credential("github".into()));
        assert_eq!(d(Https, "example.com", 443, &[]), direct);
        assert_eq!(d(Http, "example.com", 80, &[]), direct);
        assert_eq!(d(Https, "a.evil.example", 443, &[]), Err(Denial::DenyHost));
        assert_eq!(
            d(Https, "evil.example", 443, &[]),
            direct,
            "*.x is below x only"
        );
        assert_eq!(d(Https, "blocked.example", 443, &[]), Err(Denial::DenyHost));
        assert_eq!(d(Https, "api.github.com", 443, &[GH]), github);
        assert_eq!(d(Https, "github.com", 443, &[]), github);
        // Plain HTTP to github.com matches no rule (the rule is https).
        assert_eq!(d(Http, "github.com", 80, &[]), direct);
        assert_eq!(d(Http, "github.com", 80, &[GH]), Err(Denial::Placeholder));
        assert_eq!(
            d(Https, "example.com", 443, &[GH]),
            Err(Denial::Placeholder)
        );
        assert_eq!(d(Http, "plain.example", 80, &[]), direct);

        let deny = Policy::from_proto(Some(&policy(
            egress_policy::Default::Deny,
            &[],
            vec![rule(&["*"], &[443], https())],
        )))
        .unwrap();
        assert_eq!(
            deny.decide(Https, "any.example", 443, &[]),
            Ok(Route::Direct)
        );
        assert_eq!(
            deny.decide(Http, "any.example", 80, &[]),
            Err(Denial::Policy)
        );
        let unspecified = Policy::from_proto(Some(&policy(
            egress_policy::Default::Unspecified,
            &[],
            vec![],
        )))
        .unwrap();
        assert_eq!(
            unspecified.decide(Https, "example.com", 443, &[]),
            Err(Denial::Policy),
            "an unspecified default is DENY"
        );
        let none = Policy::from_proto(None).unwrap();
        assert_eq!(
            none.decide(Https, "example.com", 443, &[]),
            Err(Denial::Policy)
        );
        assert_eq!(none.lease, Duration::ZERO);
    }

    #[test]
    fn what_berth_cannot_carry_out_is_refused() {
        let refused = |p: proto::EgressPolicy| Policy::from_proto(Some(&p)).unwrap_err();
        let e = refused(policy(
            egress_policy::Default::Deny,
            &[],
            vec![rule(&["a.example"], &[8080], https())],
        ));
        assert_eq!(
            (e.code, e.reason.as_str()),
            (Code::InvalidArgument as i32, "egress_policy")
        );
        let e = refused(policy(
            egress_policy::Default::Deny,
            &[],
            vec![rule(
                &["a.example"],
                &[],
                egress_policy::rule::Kind::Decide(egress_policy::Decide {}),
            )],
        ));
        assert_eq!(
            (e.code, e.reason.as_str()),
            (Code::Unimplemented as i32, "egress_decide")
        );
        for bad in [
            "Example.com",
            "a.example.",
            "",
            "*.",
            "a.*.example",
            "a b",
            "**",
        ] {
            let e = refused(policy(egress_policy::Default::Deny, &[bad], vec![]));
            assert_eq!(e.reason, "egress_policy", "{bad:?}");
        }
        let mut negative = policy(egress_policy::Default::Deny, &[], vec![]);
        negative.lease = Some(pbjson_types::Duration {
            seconds: -1,
            nanos: 0,
        });
        assert_eq!(refused(negative).reason, "egress_policy");
        let mut no_kind = rule(&["a.example"], &[], http());
        no_kind.kind = None;
        assert_eq!(
            refused(policy(egress_policy::Default::Deny, &[], vec![no_kind])).reason,
            "egress_policy"
        );
    }
}
