# Deployment runbook

The podcast app ships as three containers (backend, worker, frontend) plus a
standalone `livekit-server` binary on the same VPS. Supabase is the existing
self-hosted stack at `supabase.abdallahhelal.com` — nothing new there.

Everything below assumes a Debian / Ubuntu host with nginx, docker, and
certbot already installed and running (they are — the Supabase stack uses
them). Commands run as a user in the `docker` group; `sudo` is only called
out where needed.

---

## 0. One-time host prep

```bash
# Clone the repo into /opt (or wherever you prefer; update the systemd unit
# if you change this).
sudo mkdir -p /opt/podcast && sudo chown "$USER":"$USER" /opt/podcast
git clone git@github.com:Abdallah-hilal/podcast.git /opt/podcast
cd /opt/podcast
```

```bash
# UFW: open the TCP ports nginx needs and the UDP range LiveKit's media
# plane uses. Browsers reach livekit-server over UDP DIRECTLY — nginx is only
# in the signaling path.
sudo ufw allow 443/tcp
sudo ufw allow 50000:60000/udp
sudo ufw allow 7881/tcp   # optional TCP/ICE fallback
```

---

## 1. DNS (your DNS provider, not the server)

Add three A records, all pointing at the VPS's public IP:

| Host                               | Type | Value         |
| ---------------------------------- | ---- | ------------- |
| `app.abdallahhelal.com`            | A    | `<VPS IP>`    |
| `api.abdallahhelal.com`            | A    | `<VPS IP>`    |
| `livekit.abdallahhelal.com`        | A    | `<VPS IP>`    |

Wait a minute, then confirm:

```bash
dig +short app.abdallahhelal.com api.abdallahhelal.com livekit.abdallahhelal.com
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
- `LIVEKIT_API_KEY=devkey` and a fresh `LIVEKIT_API_SECRET`
  (`openssl rand -hex 32`). The same two values go into
  `deploy/livekit.yaml` under `keys:` — they must match.
- `NEXT_PUBLIC_*` mirror the Supabase values and point
  `NEXT_PUBLIC_BACKEND_URL` at `https://api.abdallahhelal.com`.
- `BACKEND_URL=https://api.abdallahhelal.com`,
  `CORS_ORIGINS=https://app.abdallahhelal.com`.

`chmod 600 .env` — this file is secret and never committed.

---

## 3. LiveKit server

```bash
curl -sSL https://get.livekit.io | bash
sudo mv livekit-server /usr/local/bin/

sudo mkdir -p /opt/livekit
sudo cp deploy/livekit.yaml /opt/livekit/
sudo $EDITOR /opt/livekit/livekit.yaml   # paste the LIVEKIT_API_SECRET

sudo cp deploy/systemd/livekit-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now livekit-server
sudo systemctl status livekit-server --no-pager
```

Should say `active (running)` and log `starting LiveKit server, port: 7880`.

---

## 4. nginx vhosts + TLS

```bash
sudo cp deploy/nginx/*.conf /etc/nginx/sites-available/
sudo ln -sf /etc/nginx/sites-available/app.abdallahhelal.com.conf      /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/api.abdallahhelal.com.conf      /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/livekit.abdallahhelal.com.conf  /etc/nginx/sites-enabled/

# First-pass: nginx won't start because the certs don't exist yet. Issue them.
sudo certbot --nginx \
  -d app.abdallahhelal.com \
  -d api.abdallahhelal.com \
  -d livekit.abdallahhelal.com \
  --redirect --agree-tos -m you@abdallahhelal.com

sudo nginx -t && sudo systemctl reload nginx
```

If certbot ever renews without reloading nginx, run
`sudo systemctl reload nginx` yourself — WebSocket upstreams stay cached
otherwise.

---

## 5. App stack (backend + worker + frontend)

```bash
cd /opt/podcast
docker compose up -d --build
docker compose ps
```

Should see three services `running (healthy)` within ~30 s. First boot
builds the images (~3–4 min) and the first job enqueued to the worker will
also download the Whisper model (~460 MB, cached to a named volume after).

Hook it into systemd so it comes back after reboots:

```bash
sudo cp deploy/systemd/podcast-stack.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable podcast-stack.service
```

---

## 6. Smoke test

```bash
# Backend is reachable through TLS
curl -sS https://api.abdallahhelal.com/health
# → {"status":"ok"}

# Frontend serves the login page
curl -sSI https://app.abdallahhelal.com/login | head -1
# → HTTP/2 200

# LiveKit signaling accepts websocket upgrade
curl -sSI -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
     -H "Sec-WebSocket-Version: 13" \
     https://livekit.abdallahhelal.com/rtc | head -1
# → HTTP/2 101 (switching protocols)
```

Then open `https://app.abdallahhelal.com` in a real browser, create a
session, click **Copy invite link**, open that link in a second browser
(or send it to the guest), both join, both record, both stop.

In `docker compose logs -f worker` you should see
`claimed job <uuid> (reconstruct)` → `completed` for each recording.

---

## 7. Updates

```bash
cd /opt/podcast
git pull
docker compose up -d --build
```

The `--build` picks up Dockerfile or source changes. Named volumes
(`hf-cache`) survive.

---

## 8. Common troubleshooting

| Symptom                                               | Cause                             | Fix                                                                 |
| ----------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| Browser: `Mixed Content` on `ws://`                   | `LIVEKIT_URL` is still `ws://`    | Set `LIVEKIT_URL=wss://livekit.abdallahhelal.com` and rebuild       |
| LiveKit connects then "Client initiated disconnect"   | UFW UDP 50000-60000 closed        | `sudo ufw allow 50000:60000/udp`                                    |
| `CORS error` on `fetch` from app → api                | `CORS_ORIGINS` wrong              | Set to `https://app.abdallahhelal.com` (no trailing slash), restart |
| Worker stuck "Downloading" forever                    | Unauthenticated Hugging Face      | Add `HF_TOKEN=...` to `.env`, `docker compose restart worker`       |
| `podcast_sessions.room_name` missing                  | Didn't apply migration 004        | See "Migrations" below                                              |
| Invite link bounces guest to login and strands them   | They haven't signed up            | Login page has a "Create account" tab; send them straight to it     |

---

## Migrations

New SQL files live in `backend/migrations/`. To apply:

```bash
# Replace <sql-file> and run from the repo root with .env loaded.
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
  `systemctl status livekit-server` are the current dashboard.
