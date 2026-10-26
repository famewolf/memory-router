# Hosts — inventory template

Copy this shape for each host you actually have. Use RFC 5737 documentation
addresses (`192.0.2.x`, `198.51.100.x`, `203.0.113.x`) in any EXAMPLE below —
never real addresses in examples.

## Rules (read before adding real hosts)

- Connection method per host (ssh key? password? which user?).
- Subnet notes only where they disambiguate routing.
- NEVER secrets here: no passwords, tokens, API keys, or private keys. If a
  workflow needs a credential, it references a secret store by NAME, and the
  store path goes on the agent's sensitive-path deny list (e.g. cc-safety-net
  `secret_protection.deny_paths`), not in this file.

## Hosts (template — replace with real ones)

- `SAMPLE lxc-name (192.0.2.10)`: ssh as user, key auth. Runs docker; service
  ports live here.
- `SAMPLE nas (192.0.2.11)`: nfs/smb shares mounted at these local paths.
