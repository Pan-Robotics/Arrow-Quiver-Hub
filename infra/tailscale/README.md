# Quiver Tailscale infra

Config + scripts for putting Quiver Hubs and drones (Raspberry Pi companion computers) on a single
Tailscale tailnet. See the full design in
[`../../docs/architecture/Tailscale_Network_Architecture.md`](../../docs/architecture/Tailscale_Network_Architecture.md).

| File | Purpose |
|---|---|
| `acl.hujson` | Example tailnet ACL policy — tags + grants for fleets, shared vs isolated, multi-operator. Paste/merge into the Tailscale admin console. |
| `setup-hub-tailscale.sh` | Join a Hub host to the tailnet (`tag:hub,tag:hub-<op>`) and expose the Hub over HTTPS via `tailscale serve`. |
| `quiver-hub-serve.service` | systemd unit that runs `tailscale serve` for the Hub on every boot. |
| `setup-drone-tailscale.sh` | Join a companion Pi to the tailnet as a tagged node (reports and leaves an already-connected Pi alone) (`tag:drone,tag:fleet-<name>`). |

## One-time tailnet setup (admin console)

1. **Enable MagicDNS** and **HTTPS certificates**.
2. **Paste `acl.hujson`** into *Access controls* and adjust `tagOwners`, `groups`,
   and the operator/fleet names to your org.
3. **Mint auth keys**:
   - Hubs: a reusable, tagged key (or just `tailscale up` and approve once).
   - Drones: an **ephemeral, pre-authorised, tagged** key (or a Tailscale OAuth
     client that mints them) so fleet onboarding is zero-touch and stale drones
     auto-expire.

## Bring up a Hub

```bash
sudo ./setup-hub-tailscale.sh --operator op1 --hostname quiver-hub-op1
# then set the printed PUBLIC_BASE_URL=https://quiver-hub-op1.<tailnet>.ts.net in the Hub .env
sudo cp quiver-hub-serve.service /etc/systemd/system/
sudo systemctl enable --now quiver-hub-serve.service
```

## Bring up a drone (companion Pi)

```bash
sudo ./setup-drone-tailscale.sh --fleet acme --drone-id quiver-001 \
     --authkey tskey-ephemeral-xxxx
# register the printed MagicDNS name with the Hub (Drone Configuration)
```

## Access-model cheat sheet

- **1 hub : fleet** — grant `tag:hub-<op>` → `tag:fleet-<name>`.
- **2 operators, same fleet** — grant both hub tags → the shared fleet tag.
- **Isolated fleet** — grant the fleet tag to exactly one hub tag.
- **Cross-org** — use Tailscale **node sharing** to share a specific drone node
  into another tailnet (not in-tailnet ACLs).

Two layers gate every connection: **Tailscale ACLs** (which hubs can reach which
fleets) **and** the Hub's **per-drone API keys** (what each hub is authorised to
do with a drone). Nothing is exposed to the public internet.
