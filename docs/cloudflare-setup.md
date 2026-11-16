# Cloudflare setup for the dev site

Every push to `main` in this repo publishes the open-source build to
**https://bugpop-dev.wilminator.com**. It is a Cloudflare **Worker with static assets**: a Worker with
no code of its own that serves the files `npm run build` writes to `packages/client/dist`.
(The official site, `bugpop.wilminator.com`, and its staging copy, `bugpop-staging.wilminator.com`, are
built from the private `bug-pop-server` repo, which adds the website skin and the server.)

## How a deploy works

Cloudflare is connected to this GitHub repo. On every push to `main`, Cloudflare's build machine runs

    npm ci && npm run build
    npx wrangler deploy

The first line builds the site; the second uploads it. `wrangler.jsonc` at the top of the repo tells
wrangler the Worker's name, which folder to upload, and the custom domain. No GitHub Actions
workflow is involved in deploying (the `CI` workflow only runs the tests).

## One-time step: create the Worker

Cloudflare dashboard → **Workers & Pages** → Create → Import a repository → `wilminator/bug-pop`:

| Setting | Value |
|---|---|
| Project name | `bug-pop-dev` (must match `name` in `wrangler.jsonc`) |
| Production branch | `main` |
| Build command | `npm ci && npm run build` |
| Deploy command | `npx wrangler deploy` |
| Non-production branch builds | off |
| Path | `/` |
| API token | let it create one |
| Build variable | `NODE_VERSION` = `22` |

The first deploy creates the `bugpop-dev.wilminator.com` custom domain from `wrangler.jsonc`
(the `wilminator.com` zone must be on the same Cloudflare account). If a DNS record for that name
already exists, delete it and retry the deployment.

Optional: put it behind **Zero Trust → Access** (Allow, Emails, One-time PIN) if playtests should be private.

## Checking a build locally

    npm ci
    npm run build
    npx wrangler deploy --dry-run --outdir /tmp/wrangler-dry

## If something goes wrong

The build log is in the Worker → Deployments (or Builds) → the failed one.

- Wrong Node version: check `NODE_VERSION` in the Worker's build settings.
- Name mismatch: the Worker's name and `name` in `wrangler.jsonc` must be the same.
- A file over 25 MiB: Cloudflare refuses it. The biggest file today is a 2.4 MB music track.
