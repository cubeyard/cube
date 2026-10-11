//! `cube-agent`               the agent (cube-init starts it as /sbin/cube-agent)
//! `cube-agent wrap OPDIR`    an operation's main process (the agent starts it)
//! `cube-agent hold-ns ROOT`  holds the workload's mount namespace while the
//!                            agent binds it (the agent starts it)
//! `cube-agent --version`
#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    eprintln!("cube-agent runs in a keel machine (Linux)");
    std::process::ExitCode::from(2)
}

#[cfg(target_os = "linux")]
use std::{path::Path, process::ExitCode};

#[cfg(target_os = "linux")]
use cube_agent::{agent::Agent, channel, setup, wrap};

#[cfg(target_os = "linux")]
fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] => daemon(),
        ["wrap", dir] => wrap::main(Path::new(dir)),
        ["hold-ns", root] => setup::hold_namespace(root),
        ["--version"] => {
            println!("cube-agent {}", cube_agent::agent::VERSION);
            0
        }
        _ => {
            eprintln!("usage: cube-agent | wrap OPDIR | hold-ns ROOT | --version");
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
