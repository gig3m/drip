# drip

Push a screenshot or file from your laptop to a small self-hosted server and get back a short, auto-expiring URL that a coding agent on another machine can fetch.

## Why

Coding agents increasingly run somewhere other than the machine in front of you: a homelab box, a dev VM, a remote workstation you SSH into. When you want to show one a screenshot, a log file or a PDF, the usual options are clumsy. You mount an SMB share, `scp` the file over, or paste it into a chat window that the agent cannot read.

drip turns that into one step:

```
drip clip
# https://drip.example.com/f/Vh3kQ9x2LmPa0tYw/clip-2026-01-01T12-00-00-000Z.png   (copied to clipboard)
```

Paste the URL into the agent's prompt and it fetches the file with `curl` or `drip get`. The file deletes itself after its TTL (24 hours by default).

## How it works

```
 laptop                              your server (private network)           agent host
 ------                              -----------------------------           ----------
 drip clip / drip <file>   --POST-->  drip service  (Docker, SQLite + files)  <--GET--  curl / drip get
 Raycast "Send to drip"               returns https://drip.example.com/f/<id>/<name>
```

- **service** (`packages/service`): a small Node/Hono HTTP server. It stores uploads on disk with a SQLite index, serves them at `/f/<id>/<name>`, and deletes them when they expire. It also serves the CLI binaries, an install script and a landing page.
- **cli** (`packages/cli`): a single `drip` binary for macOS and Linux. It uploads files or the clipboard, lists and downloads recent drips, and includes a terminal browser (`drip tui`).
- **raycast** (`packages/raycast`): an optional Raycast extension. Most people should use the simpler script command that `drip raycast` installs.
- **shared** (`packages/shared`): the typed HTTP client used by the CLI.

drip is designed to run on a **private network** such as a [Tailscale](https://tailscale.com) tailnet. Read [Security](#security) before exposing it anywhere else.

## 1. Run the service

You need Docker with Compose.

```bash
git clone https://github.com/gig3m/drip && cd drip
cp .env.example .env
```

Edit `.env` and set `DRIP_BASE_URL` to the URL that clients will use to reach the server:

```bash
DRIP_BASE_URL=https://drip.example.com
# Recommended: require a token for uploads and deletes
DRIP_TOKEN=a-long-random-string
```

Then build and start it:

```bash
docker compose up -d --build
```

The image build cross-compiles the `drip` CLI for macOS and Linux with `DRIP_BASE_URL` compiled in as its default server, so the binaries it serves at `/dl/` work with no configuration.

Compose publishes the service on `127.0.0.1:8787` only. To reach it from your other machines, put something in front of it. With Tailscale:

```bash
tailscale serve --bg 8787
# serves https://<machine>.<your-tailnet>.ts.net -> 127.0.0.1:8787
```

Set `DRIP_BASE_URL` to the URL `tailscale serve` prints, then rebuild (`docker compose up -d --build`) so the served binaries pick it up. A reverse proxy on your LAN works as well. If you use one, raise its request body limit to at least `DRIP_MAX_SIZE`.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DRIP_BASE_URL` | *(required)* | Public URL of this server. It is used to build returned links, the install script and the CLI's default server. |
| `DRIP_TOKEN` | *(unset)* | If set, `POST /upload` and `DELETE /f/:id` require `Authorization: Bearer <token>`. |
| `DRIP_DEFAULT_TTL` | `24h` | Lifetime of an upload when the client does not ask for one. |
| `DRIP_MAX_TTL` | `168h` | Longest TTL a client may request. Longer requests are clamped to this value. |
| `DRIP_MAX_SIZE` | `100mb` | Maximum size of each uploaded file. |
| `DRIP_SWEEP_INTERVAL` | `60s` | How often expired files are deleted from disk. |
| `DRIP_DATA_DIR` | `/data` | Storage directory. It must match the volume mount in `docker-compose.yml`. |
| `PORT` | `8787` | Listen port inside the container. |

Durations accept `ms`, `s`, `m`, `h` and `d` (for example `90m` or `7d`). Sizes accept `b`, `kb`, `mb` and `gb`.

## 2. Install the CLI

On each machine that sends or fetches files, run:

```bash
curl -fsSL https://drip.example.com/install.sh | sh
```

This downloads the binary for your OS and architecture from your server, checks it against the published SHA-256, and installs it to `~/.local/bin/drip`. Set `DRIP_BIN_DIR` to install it somewhere else.

The CLI reads two environment variables:

- `DRIP_BASE_URL` overrides the server URL compiled into the binary. You need it if you built the CLI yourself.
- `DRIP_TOKEN` is the bearer token for uploads and deletes, if the server requires one.

Clipboard support depends on your platform:

- **macOS:** copied files work out of the box. Copied images need [`pngpaste`](https://github.com/jcsalterego/pngpaste) (`brew install pngpaste`).
- **Linux (Wayland):** needs `wl-clipboard`.
- **Linux (X11):** needs `xclip`. `xsel` also works, but only for copied files.

### Commands

| Command | What it does |
|---------|--------------|
| `drip <file> [file...]` | Upload files. Prints the URL(s) and copies them to the clipboard. |
| `drip clip` | Upload the file(s) or image on the clipboard. |
| `drip list [-n N] [--json]` | List the N most recent drips (default 20). |
| `drip get <id\|url> [-o PATH]` | Download a drip into the current directory. `-o -` writes it to stdout. |
| `drip tui` (or bare `drip`) | Open the interactive browser. Use `⏎`/`y` to copy the URL, `c` to copy the contents, `s`/`S` to save or save as, `d` to delete, `/` to filter, `r` to refresh and `q` to quit. |
| `drip raycast [--dir P]` | Install the Raycast "Send to drip" script command. |
| `drip upgrade` | Reinstall the latest binary from your server. |
| `drip --help` | Show full usage. The output is written so an agent can learn the tool from it. |

## 3. Raycast (macOS, optional)

The quickest route is the script command:

```bash
drip raycast    # installs ~/.raycast-scripts/send-to-drip.sh
```

Next, open Raycast and go to **Settings → Extensions → Script Commands → Add Directories**. Add `~/.raycast-scripts`, then bind a hotkey to **Send to drip**. It uploads the clipboard file or image. If the clipboard has neither, it uploads the current Finder selection. The resulting URL is copied to the clipboard.

`packages/raycast` also contains a full Raycast extension, with preferences for the server URL, token and TTL. Raycast cannot install an unpublished extension from a URL, so you have to load it in developer mode: run `npm install && npx ray develop` in that folder.

## Handing a file to an agent

```
The failing layout is in this screenshot: https://drip.example.com/f/Vh3kQ9x2LmPa0tYw/shot.png
```

Any agent that can make an HTTP request can fetch it. If `drip` is installed on the agent's host, the agent can run `drip list` and `drip get` itself. `drip --help` covers the whole command set.

## HTTP API

| Method and path | Auth | Description |
|-----------------|------|-------------|
| `POST /upload[?ttl=12h]` | token if set | Upload a multipart body with one or more `file` fields, or a raw body with `?name=` and a `Content-Type`. Returns `{id, url, filename, size, content_type, expires_at}`, or `{items: [...]}` for multiple files. |
| `GET /f/:id/:name`, `GET /f/:id` | none | Fetch a file. `:name` is cosmetic. |
| `DELETE /f/:id` | token if set | Delete a file. |
| `GET /files[?limit=N]` | none | List unexpired files, newest first (default 20, maximum 200). |
| `GET /healthz` | none | Liveness check. |
| `GET /`, `/install.sh`, `/dl/*`, `/raycast/send-to-drip.sh` | none | Landing page, installer, CLI binaries with `SHA256SUMS`, and the Raycast script. |

```bash
curl -H "Authorization: Bearer $DRIP_TOKEN" -F file=@shot.png "https://drip.example.com/upload?ttl=1h"
```

## Security

drip assumes that **the network is the perimeter**: a tailnet or a LAN where every device is yours.

- **Reads are unauthenticated.** File IDs are 96 random bits, so a URL cannot be guessed. However, `GET /files` lists every live file and its URL to anyone who can reach the server. On a private network that is a convenience. On the public internet it would publish everything you upload.
- **Writes can be protected.** Set `DRIP_TOKEN` to require a bearer token for uploads and deletes. Without a token, anyone who can reach the server can upload files and delete existing ones.
- **Expiry is enforced by the server.** Expired files return 404 immediately and are removed from disk by the next sweep.
- **Uploads are served inline with the uploader's content type.** Responses carry `X-Content-Type-Options: nosniff` and a sandboxing `Content-Security-Policy`, so an uploaded HTML or SVG file cannot run script on the drip origin.
- **Size limits** apply to each file. A request that declares an oversized `Content-Length` is rejected before its body is read. A request without a `Content-Length` header is buffered in memory before the check runs.

**Do not expose drip directly to the internet.** If you have to, set `DRIP_TOKEN` and put an authenticating proxy in front of `GET /files` and `/f/`.

## Development

You need Node.js 22 and pnpm 9 (`corepack enable`).

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r test
```

`packages/raycast` takes part in `pnpm -r typecheck` only. Raycast's tooling cannot resolve pnpm workspace links, so the extension carries its own copy of the upload client in `src/drip-client.ts`.

To build the standalone binaries you also need [Bun](https://bun.sh):

```bash
DRIP_BAKED_BASE_URL=https://drip.example.com sh packages/cli/scripts/build-binaries.sh ./out
```

## License

[MIT](LICENSE)
