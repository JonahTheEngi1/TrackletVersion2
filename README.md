# Tracklet Platform

Tracklet Platform is the production-oriented rewrite scaffold for Tracklet. It uses a Pterodactyl-style split:

- **Panel**: global control plane for admins.
- **Wing**: node agent that creates/starts/stops/restarts/destroys instance containers through Docker.
- **Instance**: isolated customer/location dashboard container.
- **PostgreSQL**: shared database with strict `instance_id` scoping.
- **NGINX**: public reverse proxy to the Panel. The Panel proxies `/x/<slug>/...` into the matching instance container.

## First Deploy

1. Copy `.env.example` to `.env`.
2. Change every secret value.
3. In Portainer, deploy this directory as a Compose stack.
4. Open `http://your-vps/`.
5. Log in with `DEFAULT_ADMIN_EMAIL` and `DEFAULT_ADMIN_PASSWORD`.
6. The default Compose file auto-registers `wing-local`.
7. Create an instance from the Panel.
8. Open the instance from the Panel and log in with the instance admin credentials you entered.

## Services

- `postgres`: PostgreSQL 16.
- `panel`: Tracklet Panel, running from the `tracklet-platform-app:latest` image.
- `wing`: Tracklet Wing agent. It mounts `/var/run/docker.sock` so it can create instance containers.
- `nginx`: public HTTP endpoint.

## Important Notes

- The first boot creates all tables automatically.
- The first boot seeds the Panel admin only when no Panel users exist.
- Instance containers use the same image as the Panel, but boot with `MODE=instance`.
- Destroying an instance from the Panel destroys the container. Data remains in PostgreSQL unless manually removed.
- This first implementation stores backups as JSON snapshots in PostgreSQL. External backup targets can be added next.

## Included Tracklet Features

- Panel admin login.
- Node registration.
- Instance/container creation.
- Instance start, stop, restart, suspend, unsuspend, and destroy.
- Per-instance user accounts.
- Package entry/search/delivery.
- Bulk-capable API for packages.
- Storage locations.
- Optional pricing.
- Cold storage archive/search.
- Support tickets and messages.
- Invoices with line items and paid/unpaid/voided status.
- Manual JSON backups.

## Production Follow-Ups

Before using this for real customer data, the next hardening pass should add:

- HTTPS/TLS termination.
- CSRF protection.
- Audit logs.
- Stronger per-instance secret management.
- External backups, restore workflow, and backup rotation.
- Docker resource limits per instance.
- Image version registry and rolling update UI.
- Automated tests.
