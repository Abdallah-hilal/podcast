# Deployment runbook

The podcast app ships as three containers (backend, worker, frontend) and
rides the same VPS as the existing Supabase stack
(`supabase.abdallahhelal.com`) and a standalone LiveKit container that was
provisioned earlier. All browser traffic for the podcast app comes in on
one hostname — `podcast.abdallahhelal.com` — and nginx path-routes it to
the three upstreams.

Everything below assumes a Debian / Ubuntu host with nginx, docker, and
certbot already installed (they are — the Supabase stack uses them).
Commands run as a user in the `docker` group; `sudo` is only called out
where needed.

---

## 0. One-time host prep

```bash
sudo mkdir -p /opt/podcast && sudo chown "$USER":"$USER" /opt/podcast
git clone git@github.com:Abdallah-hilal/podcast.git /opt/podcast
cd /opt/podcast
```

UFW: 80/443/tcp are already open on this host. LiveKit media (UDP 7882) is
published by the Docker daemon, which bypasses UFW via its own iptables
rules, so no UFW change is needed for media.

---

## 1. DNS (your DNS provider, not the server)

Add **one** A record pointing at the VPS's public IP:

| Host                           | Type | Value         |
| ------------------------------ | ---- | ------------- |
| `podcast.abdallahhelal.com`    | A    | `<VPS IP>`    |

Wait a minute, then confirm:

```bash
dig +short podcast.abdallahhelal.com
```

---

## 2. Secrets (`/opt/podcast/.env`)

```bash
cp .env.example .env
$EDITOR .env
```

Fill in:

- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_JWT_SECRET` — copy from the existing self-hosted Supabase
  (`/opt/supabase-stack/.env` on the server).
- `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` — copy from the running
  LiveKit container's config (`/opt/livekit/livekit.yaml`, under `keys:`).
  They must match the live server; do not generate new ones.
- `LIVEKIT_URL=wss://podcast.abdallahhelal.com/livekit` — nginx proxies
  this path to the LiveKit container and strips the `/livekit` prefix.
- `NEXT_PUBLIC_*` mirror the Supabase values; `NEXT_PUBLIC_BACKEND_URL`
  and `BACKEND_URL` both point at `https://podcast.abdallahhelal.com`
  (same origin — no CORS).
- `CORS_ORIGINS=https://podcast.abdallahhelal.com` (kept for safety even
  though the frontend and backend share an origin).

`chmod 600 .env` — this file is secret and never committed.

---

## 3. nginx vhost + TLS

```bash
sudo cp deploy/nginx/podcast.abdallahhelal.com.conf /etc/nginx/sites-available/
sudo ln -sf /etc/nginx/sites-available/podcast.abdallahhelal.com.conf \
            /etc/nginx/sites-enabled/

# Temporarily comment out the TLS server block so nginx accepts the config
# before certbot has issued a cert. (If you're re-running, skip this.)
# Alternatively: install the HTTP-only block first, reload, then run certbot
# and symlink the full config.

sudo nginx -t && sudo systemctl reload nginx

# Only after DNS resolves to this host:
sudo certbot --nginx -d podcast.abdallahhelal.com \
  --redirect --agree-tos -m you@abdallahhelal.com

sudo nginx -t && sudo systemctl reload nginx
```

---

## 4. App stack (backend + worker + frontend)

```bash
cd /opt/podcast
docker compose up -d --build
docker compose ps
```

Should see three services `running (healthy)` within ~30 s. First boot
builds the images (~3–4 min) and the first job enqueued to the worker
also downloads the Whisper model (~460 MB, cached to a named volume
after).

Hook it into systemd so it comes back after reboots:

```bash
sudo cp deploy/systemd/podcast-stack.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable podcast-stack.service
```

---

## 5. Smoke test

```bash
# Backend is reachable through TLS (liveness)
curl -sS https://podcast.abdallahhelal.com/health
# → {"status":"ok"}

# Dependency check — Supabase, LiveKit, CORS
curl -sS https://podcast.abdallahhelal.com/ready | python3 -m json.tool
# → ok: true for every check. ok: false lists which dependency is broken.

# Frontend serves the login page
curl -sSI https://podcast.abdallahhelal.com/login | head -1
# → HTTP/2 200

# LiveKit signaling accepts websocket upgrade
curl -sSI -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
     -H "Sec-WebSocket-Version: 13" \
     https://podcast.abdallahhelal.com/livekit/rtc | head -1
# → HTTP/2 101 (switching protocols)
```

Then open `https://podcast.abdallahhelal.com` in a real browser, create a
session, click **Copy invite link**, open that link in a second browser
(or send it to the guest), both join, both record, both stop.

In `docker compose logs -f worker` you should see
`claimed job <uuid> (reconstruct)` → `completed` for each recording.

---

## 6. Updates

```bash
cd /opt/podcast
git pull
docker compose up -d --build
```

The `--build` picks up Dockerfile or source changes. Named volumes
(`hf-cache`) survive.

---

## 7. Common troubleshooting

| Symptom                                               | Cause                                   | Fix                                                                       |
| ----------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| Browser: `Mixed Content` on `ws://`                   | `LIVEKIT_URL` is still `ws://`          | Set `LIVEKIT_URL=wss://podcast.abdallahhelal.com/livekit` and rebuild     |
| LiveKit connects then "Client initiated disconnect"   | Docker UDP 7882 not reachable           | Check `docker ps` shows `0.0.0.0:7882->7882/udp` on the livekit container |
| `CORS error` on `fetch` from app → api                | Backend behind the wrong origin         | `CORS_ORIGINS=https://podcast.abdallahhelal.com`, restart backend         |
| Worker stuck "Downloading" forever                    | Unauthenticated Hugging Face            | Add `HF_TOKEN=...` to `.env`, `docker compose restart worker`             |
| `podcast_sessions.room_name` missing                  | Didn't apply migration 004              | See "Migrations" below                                                    |
| Invite link bounces guest to login and strands them   | They haven't signed up                  | Login page has a "Create account" tab; send them straight to it           |

---

## Migrations

New SQL files live in `backend/migrations/`. To apply:

```bash
export $(grep SUPABASE_SERVICE_ROLE_KEY .env | xargs)
SQL=$(cat backend/migrations/<sql-file>)
curl -s -X POST https://supabase.abdallahhelal.com/pg/query \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg q "$SQL" '{query: $q}')"
```

All migrations here are idempotent (`IF NOT EXISTS` / `DO $$ ... END $$`
guards), so re-running is safe.

---

## What's still on your plate

- **Credential rotation** per `COLLABORATOR-ACCESS.md` — Postgres password,
  JWT secret, anon/service keys. Then close Postgres ports 5432/6543 in
  UFW.
- **Backups** of `podcast_recordings` metadata rows and the
  `podcast-recordings` storage bucket. Supabase doesn't do this for you.
- **Monitoring** — nothing is instrumented yet. `docker compose logs` and
  `docker logs livekit` are the current dashboard.
