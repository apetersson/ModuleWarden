# ModuleWarden landing page

Static marketing site. Single `index.html` file plus local CSS/font assets, no runtime third-party dependencies.

## Deploy

- GitHub Pages: `https://github.com/apetersson/modulewarden.com` is the public Pages mirror for this directory and serves `https://modulewarden.com`.
- To publish: sync the contents of this directory to the root of `apetersson/modulewarden.com` and push `main`.
- Cloudflare Pages: `npx wrangler pages deploy docs/site` from repo root
- Local preview: `python -m http.server 8080 --directory docs/site`

See full deploy + form-wiring docs in the originating workspace at `kimiclaw/modulewarden-landing/README.md`.
