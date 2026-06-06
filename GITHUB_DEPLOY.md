# GitHub And Web Deployment

This project can be pushed to GitHub and deployed as a normal Node web app.
It is not suitable for GitHub Pages because it requires `server.js`.

## Recommended Structure

- GitHub: store source code only
- Cloud server: run `node server.js`
- Domain + HTTPS: reverse proxy with Nginx or another web server

## Before Pushing To GitHub

This repo now ignores local runtime files:

- `api-config.local.json`
- `auth.local.json`
- `last-api-response.json`
- `server-run.log`

That means your API key, local users, and local logs will not be committed by default.

## Local Git Setup

Initialize Git if needed:

```powershell
git init
git add .
git commit -m "Initial deploy-ready version"
```

Create a GitHub repo, then connect it:

```powershell
git remote add origin https://github.com/your-name/your-repo.git
git branch -M main
git push -u origin main
```

## Deploy On A Server

## Option A: Linux Server (recommended)

Install Node.js 18+ first, then:

```bash
git clone https://github.com/your-name/your-repo.git
cd your-repo
npm install
npm run start
```

Because this project currently uses only Node built-in modules, `npm install` is mainly for standard workflow compatibility.

For long-running service, use `pm2` or `systemd`.

Example with PM2:

```bash
npm install -g pm2
pm2 start server.js --name chaomai-tool
pm2 save
pm2 startup
```

## Option B: Windows Server

Install Node.js 18+, then:

```powershell
git clone https://github.com/your-name/your-repo.git
cd your-repo
npm run start
```

You can also keep using the existing batch files if you prefer.

## Reverse Proxy And HTTPS

Expose the Node app through Nginx:

```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    client_max_body_size 30m;

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then users can access:

```text
https://your-domain.com
```

## First Login After Deployment

1. Open `/login`
2. Sign in with `admin / admin123`
3. Open `/admin`
4. Change the admin password immediately
5. Fill in API Base URL, API Key, image model, and LLM model
6. Add normal users
7. Test image generation with a normal account

## Important Notes

- Do not use GitHub Pages for this project in its current form
- Do not commit local auth or API config files
- If you deploy for multiple long-term users, later consider moving user/config storage from local JSON files to a database
