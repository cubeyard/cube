//! `cube-gateway serve | dial | --version`. See the library docs.
use anyhow::{Context, Result, bail};
use cube_gateway::{ServeOptions, decide::DECIDE_TIMEOUT, dial, http::Upstream, lan::LanLimits};
use cube_node_transport::NetworkMode;
use std::{collections::BTreeMap, path::PathBuf};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const USAGE: &str = "usage:
  cube-gateway serve --state DIR --control SOCK --decide SOCK --network loopback|direct|relay [--listen ADDR]
  cube-gateway dial --control SOCK --vm ID --port 22
  cube-gateway --version";

#[cfg(feature = "test-hooks")]
const TEST_USAGE: &str =
    "  test hooks: --test-upstream HOST=ADDR (repeatable), --test-upstream-ca FILE";

struct Options {
    values: BTreeMap<String, String>,
    #[cfg_attr(not(feature = "test-hooks"), allow(dead_code))]
    upstreams: Vec<String>,
}

fn parse(args: &[String]) -> Result<Options> {
    let mut values = BTreeMap::new();
    let mut upstreams = vec![];
    let mut i = 0;
    while i < args.len() {
        let key = args[i]
            .strip_prefix("--")
            .with_context(|| format!("unexpected argument {}\n{USAGE}", args[i]))?;
        let value = args
            .get(i + 1)
            .with_context(|| format!("--{key} needs a value\n{USAGE}"))?
            .clone();
        if key == "test-upstream" {
            upstreams.push(value);
        } else if values.insert(key.to_string(), value).is_some() {
            bail!("--{key} given twice");
        }
        i += 2;
    }
    Ok(Options { values, upstreams })
}

impl Options {
    fn take(&mut self, key: &str) -> Result<String> {
        self.values
            .remove(key)
            .with_context(|| format!("missing --{key}\n{USAGE}"))
    }
    fn done(&self) -> Result<()> {
        if let Some(key) = self.values.keys().next() {
            bail!("unknown option --{key}\n{USAGE}");
        }
        Ok(())
    }
}

#[cfg(feature = "test-hooks")]
fn upstream(options: &mut Options) -> Result<Upstream> {
    use rustls::pki_types::{CertificateDer, pem::PemObject};
    let mut roots = rustls::RootCertStore::empty();
    for cert in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(cert);
    }
    if let Some(file) = options.values.remove("test-upstream-ca") {
        for cert in CertificateDer::pem_file_iter(&file)? {
            roots.add(cert?)?;
        }
    }
    let mut overrides = std::collections::HashMap::new();
    for entry in &options.upstreams {
        let (host, address) = entry
            .split_once('=')
            .context("--test-upstream takes HOST=ADDR")?;
        overrides.insert(host.to_ascii_lowercase(), address.parse()?);
    }
    if !overrides.is_empty() {
        eprintln!("cube-gateway: TEST HOOKS ACTIVE for {:?}", overrides.keys());
    }
    Upstream::with_test_hooks(roots, overrides)
}

#[cfg(not(feature = "test-hooks"))]
fn upstream(options: &mut Options) -> Result<Upstream> {
    if !options.upstreams.is_empty() {
        bail!("--test-upstream needs a test-hooks build");
    }
    Upstream::system()
}

async fn serve(mut options: Options) -> Result<()> {
    let network = match options.take("network")?.as_str() {
        "loopback" => NetworkMode::Loopback,
        "direct" => NetworkMode::Direct,
        "relay" => NetworkMode::Relay,
        other => bail!("unknown network mode {other}"),
    };
    let listen = options
        .values
        .remove("listen")
        .map(|l| l.parse())
        .transpose()
        .context("invalid --listen")?;
    let state = PathBuf::from(options.take("state")?);
    let control = PathBuf::from(options.take("control")?);
    let decide = PathBuf::from(options.take("decide")?);
    let upstream = upstream(&mut options)?;
    options.done()?;
    let running = cube_gateway::start(ServeOptions {
        state,
        control,
        decide,
        network,
        listen,
        upstream,
        decide_timeout: DECIDE_TIMEOUT,
        limits: LanLimits::default(),
    })
    .await?;
    let mut stdout = tokio::io::stdout();
    stdout
        .write_all(format!("{}\n", running.ready).as_bytes())
        .await?;
    stdout.flush().await?;
    eprintln!("cube-gateway {} serving", cube_gateway::VERSION);

    // Lifeline: cubed holds our stdin; EOF means cubed is gone.
    let lifeline = async {
        let mut stdin = tokio::io::stdin();
        let mut buf = [0u8; 256];
        while matches!(stdin.read(&mut buf).await, Ok(n) if n > 0) {}
    };
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let reason = tokio::select! {
        _ = lifeline => "stdin closed",
        _ = terminate.recv() => "SIGTERM",
        _ = tokio::signal::ctrl_c() => "SIGINT",
    };
    eprintln!("cube-gateway: stopping ({reason})");
    running.stop();
    Ok(())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("--version") => {
            println!("cube-gateway {}", cube_gateway::VERSION);
            Ok(())
        }
        Some("serve") => match parse(&args[1..]) {
            Ok(options) => serve(options).await,
            Err(e) => Err(e),
        },
        Some("dial") => {
            async {
                let mut options = parse(&args[1..])?;
                let control = PathBuf::from(options.take("control")?);
                let vm = options.take("vm")?;
                let port: u16 = options.take("port")?.parse().context("invalid --port")?;
                options.done()?;
                dial::run(&control, &vm, port).await
            }
            .await
        }
        _ => {
            #[cfg(feature = "test-hooks")]
            eprintln!("{USAGE}\n{TEST_USAGE}");
            #[cfg(not(feature = "test-hooks"))]
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
    };
    if let Err(error) = result {
        eprintln!("cube-gateway: {error:#}");
        std::process::exit(1);
    }
    // Do not wait for the blocking stdin reader.
    std::process::exit(0);
}
