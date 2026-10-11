//! `cube-agent`               the agent (cube-init starts it as /sbin/cube-agent)
//! `cube-agent wrap OPDIR`    an operation's main process (the agent starts it)
//! `cube-agent hold-ns ROOT`  holds the workload's mount namespace while the
//!                            agent binds it (the agent starts it)
//! `cube-agent service-run REGISTRY RUN NAME`
//!                            a service's main process (the agent starts it)
//! `cube-agent --version`
//! `cube ARGS`                the workload's `cube` command (this binary,
//!                            bind-mounted as /usr/local/bin/cube)
#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    eprintln!("cube-agent runs in a keel machine (Linux)");
    std::process::ExitCode::from(2)
}

#[cfg(target_os = "linux")]
use std::{path::Path, process::ExitCode};

#[cfg(target_os = "linux")]
use cube_agent::{agent::Agent, channel, cli, services, setup, wrap};

#[cfg(target_os = "linux")]
fn main() -> ExitCode {
    let invoked = std::env::args().next().unwrap_or_default();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if Path::new(&invoked).file_name().and_then(|n| n.to_str()) == Some("cube") {
        let code = cli::client(args, Path::new(cli::SOCKET));
        return ExitCode::from(code.clamp(0, 255) as u8);
    }
    let code = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] => daemon(),
        ["wrap", dir] => wrap::main(Path::new(dir)),
        ["hold-ns", root] => setup::hold_namespace(root),
        ["service-run", registry, run, name] => {
            services::service_run(Path::new(registry), Path::new(run), name)
        }
        ["--version"] => {
            println!("cube-agent {}", cube_agent::agent::VERSION);
            0
        }
        _ => {
            eprintln!(
                "usage: cube-agent | wrap OPDIR | hold-ns ROOT | service-run REGISTRY RUN NAME | --version"
            );
            2
        }
    };
    ExitCode::from(code as u8)
}

#[cfg(target_os = "linux")]
fn daemon() -> i32 {
    if unsafe { libc::getpid() } == 1 {
        eprintln!("cube-agent: cube-init is PID 1, not the agent");
        return 2;
    }
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("cube-agent: {error}");
            return 1;
        }
    };
    runtime.block_on(async {
        let agent = Agent::start();
        let mut terminate =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(signal) => signal,
                Err(error) => {
                    eprintln!("cube-agent: {error}");
                    return 1;
                }
            };
        tokio::select! {
            result = channel::serve(agent.clone()) => {
                eprintln!("cube-agent: the channel ended: {result:?}");
                1
            }
            _ = terminate.recv() => {
                // The machine powers off: ends are no longer recorded, so
                // cut-off commands are interrupted after the next boot.
                agent.shutting_down();
                0
            }
        }
    })
}
