//! `cube-netstack`: a guest's network in user space, without policy or
//! secrets.
//!
//! Per guest a small LAN over raw Ethernet frames (DHCP, DNS, TCP termination
//! with smoltcp), the address check that keeps upstream connections on public
//! unicast, a CA that mints leaves for intercepted HTTPS, and the guest-facing
//! and upstream halves of HTTP, and how a placeholder secret looks.
//! `cube-gateway` uses it for protocol-3 runners and `berth vm` for keel
//! machines; what a guest may reach and which secrets a request carries
//! stay with them.
pub mod addr;
pub mod ca;
pub mod dns;
pub mod http;
pub mod lan;
pub mod placeholder;
