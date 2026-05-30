# ModuleWarden landing page

Static marketing site. Single `index.html` file plus local CSS/font assets, no runtime third-party dependencies.

## Deploy

- Cloudflare Pages: `npx wrangler pages deploy docs/site` from repo root
- Local preview: `python -m http.server 8080 --directory docs/site`
