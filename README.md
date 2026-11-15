# avidviewer.app

The website for Avid Viewer, served by a Cloudflare Worker with static assets.

- `src/pages/*.html` — page bodies (the first line is a JSON comment with title and description). `build.mjs` wraps them in the shared layout.
- `public/` — CSS, scripts and files copied as-is.
- User guide (`/guide/`) and release notes (`/releases/`) are built from `docs/USER_GUIDE.md` in [mavenmarty/avid-viewer](https://github.com/mavenmarty/avid-viewer), so they follow the app automatically.
- `src/worker/index.js` — redirects www to the bare domain and answers `/api/notify` (launch-news sign-ups, stored in the D1 database `avidviewer`, table `signups`).
- `migrations/` — D1 schema, applied on every deploy.

## Build and deploy

```
npm ci
node build.mjs      # writes dist/
npx wrangler dev    # local preview
```

Every push to `main` deploys through `.github/workflows/deploy.yml` (also every 6 hours, to pick up guide changes). The workflow needs the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
