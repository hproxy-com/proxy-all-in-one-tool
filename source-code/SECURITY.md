# Reporting a security problem

This is a proxy checker and a local relay: it handles other people's proxy
credentials and points a machine's traffic somewhere. A security bug here
matters more than a crash.

**Please do not open a public issue for a vulnerability.** Use GitHub's
private report on this repository (the Security tab, "Report a vulnerability"),
or the contact form at [hproxy.com/contact](https://hproxy.com/contact). Say what you
found, how to reproduce it, and which version you were on. You will hear back
within a few days, and the fix ships as a signed update.

## What is in scope

- Anything that sends a proxy line, a password or a result somewhere
  `PRIVACY.md` does not list.
- The relay accepting connections from anything but this machine without
  `--allow-lan`.
- The system proxy setting left changed after the app ends.
- An update that installs without a valid signature.
- Content rendered from a proxy's answer (headers, software names, ISP names)
  running as code in the window.

## What is not

- A public proxy in the free pool being slow, dead, or run by someone who
  logs traffic. That is what public proxies are; `PRIVACY.md` says so.
- Rate limits on the HProxy APIs.

## Supply chain

Releases are built by the workflows in `.github/workflows` from a tagged commit,
and every desktop update is minisign-signed with a key that is not in this
repository. The dependency trees are small on purpose: the relay speaks HTTP
and SOCKS5 itself rather than pulling in a proxy library.
