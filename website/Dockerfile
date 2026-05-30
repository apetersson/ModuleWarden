# ── ModuleWarden Static Website ────────────────────────────
# Tiny nginx serving the landing page for modulewarden.com
FROM nginx:alpine

COPY . /usr/share/nginx/html

# Custom nginx config: CSP + caching headers for static assets
RUN printf 'server {\n\
  listen 80;\n\
  server_name modulewarden.com www.modulewarden.com;\n\
  root /usr/share/nginx/html;\n\
  index index.html;\n\
\n\
  # Security headers (redundant with meta CSP, belt-and-suspenders)\n\
  add_header Content-Security-Policy "default-src '\''self'\''; base-uri '\''self'\''; object-src '\''none'\''; script-src '\''none'\''; style-src '\''self'\'' '\''unsafe-inline'\''; font-src '\''self'\''; img-src '\''self'\'' data:; connect-src '\''self'\''; form-action '\''self'\'' mailto:" always;\n\
  add_header X-Content-Type-Options "nosniff" always;\n\
  add_header X-Frame-Options "DENY" always;\n\
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;\n\
\n\
  # Cache fonts aggressively (immutable content hashes)\n\
  location /assets/fonts/ {\n\
    expires 1y;\n\
    add_header Cache-Control "public, immutable";\n\
  }\n\
\n\
  location /assets/ {\n\
    expires 7d;\n\
    add_header Cache-Control "public";\n\
  }\n\
\n\
  location / {\n\
    try_files $uri $uri/ =404;\n\
  }\n\
}' > /etc/nginx/conf.d/default.conf
