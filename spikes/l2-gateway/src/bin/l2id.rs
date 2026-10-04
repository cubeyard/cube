//! Prints the endpoint id for a key file, creating the key on first use.
fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).ok_or_else(|| anyhow::anyhow!("usage: l2id <key>"))?;
    println!("{}", l2_gateway_spike::load_key(path.as_ref())?.public());
    Ok(())
}
