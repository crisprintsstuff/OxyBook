<!-- SPDX-License-Identifier: Apache-2.0 -->

# Live GitHub App install

Checklist for the repo owner. The code has not been through these steps. A unit test is not an install.

You supply three things the repo does not know: the tunnel hostname, the GitHub account that will own the App, and the test repository. `.env.example` has no variable for the installation id. Do not invent one. Pass that id on the command line.

## Port the tunnel must hit

`.env.example` does not set `PORT`. `apps/server/src/main.ts` listens on `process.env.PORT`, and the default is **3000**. `pnpm dev` starts that process on the host.

`docker-compose.yml` also sets `PORT` to `3000` inside the app container and does not publish it on the host. Caddy publishes host port **8080** and proxies to `app:3000`. `OXYBOOK_PUBLIC_URL` in `.env.example` is `http://app.localhost:8080`. That is Caddy, not the port the Node process listens on.

Point `cloudflared` at `http://localhost:3000`. If you exported `PORT` to something else, use that value instead. Do not point the tunnel at 8080 unless you are tunneling Caddy on purpose. Run the app on the host (`pnpm dev`) so port 3000 is open on the machine where `cloudflared` runs.

## Cloudflare Tunnel

`cloudflared` is already installed on this machine. The public origin you choose becomes `OXYBOOK_PUBLIC_URL`. Set it to `https://<hostname>` with no path and no trailing slash. The server concatenates paths onto that value.

Start the tunnel before you open the setup page, and leave it running. GitHub redirects your browser to this host during App creation, and later posts webhooks to it.

### Quick tunnel

```sh
cloudflared tunnel --url http://localhost:3000
```

The process prints an `https://<words>.trycloudflare.com` hostname. That hostname is different every time you start the command. Copy it into `OXYBOOK_PUBLIC_URL` and restart `pnpm dev` before `GET /setup/github`, because the setup page bakes the origin into the manifest.

If the hostname changes after the App already exists, the App's callback URL has to be updated. On `https://github.com/settings/apps/<slug>` set:

- **Callback URL** to `https://<new-hostname>/api/github/oauth/callback`
- **Webhook URL** to `https://<new-hostname>/api/github/webhooks`

The creation redirect (`/setup/github/callback`) is only used while GitHub sends the browser back from the manifest page. You do not edit that one on an App that already exists. If you create the App again, set `OXYBOOK_PUBLIC_URL` to the new origin first.

### Named tunnel

A named tunnel keeps the hostname you already routed. The ingress service for this app is `http://localhost:3000` (or whatever `PORT` you set). The hostname is yours; this repo does not pick one.

```yaml
ingress:
  - hostname: <your stable hostname>
    service: http://localhost:3000
  - service: http_status:404
```

```sh
cloudflared tunnel run <tunnel-name>
```

Set `OXYBOOK_PUBLIC_URL` to `https://<your stable hostname>`.

## A second tunnel next to an existing one

Use this when a Cloudflare Tunnel is already running for something else. Create another tunnel in the Zero Trust dashboard. Do not edit the existing tunnel, and do not add this hostname to its routes.

Current docs call the path **Networking > Tunnels** in the dashboard at `https://one.dash.cloudflare.com` ([Create a tunnel (dashboard)](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)).

1. Go to **Networking > Tunnels**.
2. Select **Create a tunnel**. Enter a name that is not the existing tunnel's name. Select **Create Tunnel**.
3. The next screen shows an install command. The token in that command is the `eyJ…` string. Copy the token. Do not run a command that reinstalls the existing tunnel's service.
4. Open the new tunnel. On the **Routes** tab, select **Add route**, then **Published application**. That published application is the public hostname. Under **Hostname**, enter a subdomain and choose a domain you already control. Leave the existing tunnel's routes as they are.
5. Set **Service URL** to `http://localhost:3000` (or `http://localhost:<PORT>` if you changed `PORT`). Select **Add route**.

A dashboard tunnel does not use a credentials JSON or a local config file. Routes live on that tunnel in the dashboard. Isolation from the tunnel you already run is the new tunnel, its own token, and its own published hostname.

Run it with the token. `--token` comes after `run` ([run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/)):

```sh
cloudflared tunnel run --token <token>
```

Two `cloudflared` processes can run at once. Each token selects its own tunnel. The existing process keeps the token it already has.

If you already run `cloudflared` under systemd, the default unit name in Cloudflare's docs is `cloudflared.service`. Do not point that unit at the new token. Add a second unit whose `ExecStart` is the command above, for example `cloudflared-oxybook.service`:

```ini
[Unit]
Description=cloudflared for OxyBook
After=network.target

[Service]
TimeoutStartSec=0
Type=notify
ExecStart=/usr/local/bin/cloudflared tunnel run --token <token>
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

The binary path is whatever `command -v cloudflared` prints on this machine. If you do not use systemd, start the same `cloudflared tunnel run --token <token>` command the way you already start the other tunnel: a second process, not a replacement.

`sudo cloudflared service install <token>` is the install command in Cloudflare's get-started page. It writes `cloudflared.service`. Skip it when that unit is already the other tunnel.

The published hostname stays until you change that route. Set `OXYBOOK_PUBLIC_URL` to `https://<that hostname>` once, with no path and no trailing slash. The quick `cloudflared tunnel --url` tunnel above is the throwaway alternative: its `trycloudflare.com` hostname changes every run.

## What the manifest will call

With `OXYBOOK_PUBLIC_URL` set, `apps/server` builds one manifest. These paths are the ones in the code:

| Manifest field | Exact URL |
| --- | --- |
| `redirect_url` | `https://<hostname>/setup/github/callback` |
| `callback_urls` | `https://<hostname>/api/github/oauth/callback` |
| `hook_attributes.url` | `https://<hostname>/api/github/webhooks` |

`GET /setup/github/callback` is the route that exists. It requires query parameters `code` and `state`. `GET /api/github/oauth/callback` is written into the manifest and **no route handles it**. That is a gap. `POST /api/github/webhooks` exists.

`SMEE_URL` is in `.env.example`. `apps/server` does not read it. The compose webhook-relay profile does. The manifest's webhook URL is `${OXYBOOK_PUBLIC_URL}/api/github/webhooks`, not `SMEE_URL`. With `cloudflared` pointed at port 3000 you do not need smee. One origin serves both the browser redirect and the webhook.

## Create the App

The running server supports the manifest flow only. `startAppServer` sets the owner to `{ kind: 'user' }`, so the form posts to the user settings URL. `manifestCreateUrl` can build `https://github.com/organizations/<org>/settings/apps/new`, and the running server never calls it that way.

1. Export `OXYBOOK_PUBLIC_URL=https://<hostname>` and start `pnpm dev`. The server dev script builds `@oxybook/github` first, because `github-routes.ts` imports that package from its `dist` output. Confirm the process prints `app listening on 3000` (or your `PORT`).
2. In a browser, open `https://<hostname>/setup/github` (or `http://localhost:3000/setup/github` while the tunnel is up; both hit the same route). You must be logged into GitHub in that browser.
3. The page is one form. The button label is **Create GitHub App**. Submitting it POSTs the manifest to `https://github.com/settings/apps/new?state=<hex>`. The state lasts 15 minutes. The hidden field name is `manifest`.
4. On GitHub's page, review the permissions (contents write, pull requests write, metadata read; no workflows) and click **Create GitHub App**.
5. GitHub redirects the browser to `https://<hostname>/setup/github/callback?code=<code>&state=<state>`.

A successful callback is HTTP 200 and a JSON body:

```json
{"stored":true,"id":123456,"slug":"oxybook"}
```

`id` is the App id. `slug` is the App's URL slug. The body has no private key, no client secret, and no webhook secret. Reusing the same `state` returns HTTP 400 and the text `invalid manifest callback`. A failed exchange returns HTTP 502.

## Create the App by hand

Use this when `/setup/github` is rejected. A manifest whose `default_events` included `installation` and `installation_repositories` was rejected with "Default events unsupported: installation and installation_repositories." The manifest in this tree lists `push` and `pull_request` only. That new manifest has not been submitted to GitHub. Nothing in `apps/server` fills the manual form.

Go to `https://github.com/settings/apps/new` while logged in. Set:

- **Webhook URL** to `https://<hostname>/api/github/webhooks`. `<hostname>` is `OXYBOOK_PUBLIC_URL` with no path.
- Repository permissions: **Contents** read and write, **Pull requests** read and write, **Metadata** read. Do not grant Workflows.
- Subscribe to **Push** and **Pull request**.

After GitHub creates the App, the settings page at `https://github.com/settings/apps/<slug>` shows **App ID**. That value is `GITHUB_APP_ID`. Under **Private keys**, **Generate a private key** downloads a `.pem`. That file is `GITHUB_APP_PRIVATE_KEY_FILE`. The server does not read either variable. `oxybook-dev propose` does, when you pass `--github-owner`.

## Where the credentials go

The full set (App id, slug, client id, client secret, webhook secret, private key PEM) is stored in memory in that process only. Nothing writes `GITHUB_APP_PRIVATE_KEY_FILE`. Restarting the process drops the memory store.

`.env.example` names these variables. What `apps/server` actually reads:

| Variable | In `.env.example` | Read by `apps/server` |
| --- | --- | --- |
| `OXYBOOK_PUBLIC_URL` | yes | yes. Default in code, if unset, is `http://app.localhost:8080`. |
| `GITHUB_APP_WEBHOOK_SECRET` | yes | yes, and only when the memory store has no webhook secret. |
| `GITHUB_APP_ID` | yes | no |
| `GITHUB_APP_PRIVATE_KEY_FILE` | yes | no |
| `GITHUB_APP_CLIENT_ID` | yes | no |
| `GITHUB_APP_CLIENT_SECRET` | yes | no |

That is a gap. Compose passes the four unread `GITHUB_APP_*` variables into the container. The server still ignores them. The callback JSON does not give you the PEM, so you cannot fill `GITHUB_APP_PRIVATE_KEY_FILE` from the redirect.

`oxybook-dev propose` does read `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_FILE` when you ask it to open a pull request. Get those from the App settings page, not from the callback body:

1. Open `https://github.com/settings/apps/<slug>`.
2. Copy **App ID** into `GITHUB_APP_ID`. It is the same number as `id` in the callback JSON.
3. Under **Private keys**, click **Generate a private key**. GitHub downloads a `.pem`. Set `GITHUB_APP_PRIVATE_KEY_FILE` to that file's path. The server will not load it. The CLI will.
4. The webhook secret from the manifest exchange was only in process memory, and the HTTP response omitted it. On the same settings page, set **Webhook secret**, and put the same value in `GITHUB_APP_WEBHOOK_SECRET`. After a restart the webhook route uses that variable.
5. **Client ID** and a generated client secret can be copied into `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET`. Nothing in the server reads them, and nothing serves `/api/github/oauth/callback`.

## Install the App on one repo

The manifest does not set `setup_url`. After you install, GitHub does not redirect to OxyBook.

1. Open `https://github.com/apps/<slug>/installations/new`. The same page is linked as **Install App** from `https://github.com/settings/apps/<slug>`.
2. Choose **Only select repositories**.
3. Select the test repository.
4. Click **Install**.

A successful install is GitHub's installation page, not an OxyBook page. For an App on your user account the URL is `https://github.com/settings/installations/<installation_id>`, and that page lists the repository you selected. The number in the path is the installation id.

There is no env var for it. `apps/server` does not read one. Pass `--installation-id <installation_id>` to the CLI.

## Open a pull request

This command is implemented and unit-tested against a fake `fetch`. It has not been run against GitHub. Do not treat a green unit test as the M0 exit.

Build the GitHub package once so the CLI can load it (`pnpm oxybook-dev` imports `@oxybook/github` from `dist`):

```sh
pnpm install
pnpm --filter @oxybook/github build
```

`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_FILE` must be set in the environment. Then:

```sh
pnpm oxybook-dev propose path/to/page.md \
  --remote https://github.com/<owner>/<repo>.git \
  --github-owner <owner> \
  --github-repo <repo> \
  --installation-id <installation_id> \
  --base main \
  --path docs/page.md \
  --draft-url https://<hostname>/
```

`<owner>`, `<repo>`, the file, and the draft URL are yours. `--draft-url` is optional when `OXYBOOK_PUBLIC_URL` is set; the pull request body uses that URL as the link back. There is no draft page in the server. The link is the URL you pass, not a route this repo serves.

The push goes to `refs/heads/oxybook/<user>/<slug>-<id>` with `--force-with-lease`. The base branch is not pushed. The pull request `head` is that `oxybook/*` branch and the `base` is `--base` (default `main`). The body lists the pages changed and the link back. The command prints the pull request URL as `pr https://github.com/<owner>/<repo>/pull/<n>`.

The installation token is used for the push and for `POST /repos/<owner>/<repo>/pulls`. It is not printed. The clone URL stored in the mirror is the `--remote` you passed, without the token. A `file://` remote is refused when `--github-owner` is set: that push cannot become a GitHub pull request.
