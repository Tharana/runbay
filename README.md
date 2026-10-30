<div align="center">

<img src="icon.png" width="96" alt="RunBay logo">

# RunBay

**Run all your local dev servers from one window.**

A free, open-source **local dev server manager for Windows**. Start, stop and monitor your frontend,
backend, database and ngrok tunnel with one click, with live logs, health checks and auto-restart.
A simple GUI alternative to juggling terminals, `pm2` and `docker compose` commands.

**Works with:** Next.js · React · Vite · NestJS · Node.js · Laravel · PHP · Django · FastAPI · Flask ·
Go · .NET · Spring Boot · Docker Compose · PostgreSQL · MySQL · Redis · ngrok

[![Download](https://img.shields.io/github/v/release/Tharana/runbay?label=Download&style=for-the-badge&color=7c6cff)](https://github.com/Tharana/runbay/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-3ddc97?style=for-the-badge)](LICENSE.txt)
[![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-5cd6ff?style=for-the-badge)](https://github.com/Tharana/runbay/releases/latest)

</div>

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="RunBay dashboard" width="900">
</p>

## Why RunBay?

*Looking for a localhost manager, a way to run multiple dev servers at once, or a desktop GUI for ngrok? That is what RunBay is for.*

Every project needs three terminals, a database, a tunnel and a reminder of which port is which.
RunBay replaces all of that with one app:

- **Add a folder once.** RunBay finds the servers and their commands for you.
- **Press Run all.** Everything starts in the right order and waits until each part is ready.
- **See what is going on.** Live logs, errors, health, CPU and memory for every service.

## Features

| | |
|---|---|
| **Auto-detect** | Next.js, NestJS, Node, Vite, PHP/Laravel, Django, FastAPI, Flask, Go, .NET, Spring Boot, Docker Compose and monorepos |
| **One-click start** | Run all / Stop all / Restart, ordered start with "wait until ready", auto-start on launch |
| **Live logs** | Search, copy, export, and a separate **Errors** tab with a count badge |
| **Health and stats** | Responding badge, CPU and memory sparklines, uptime |
| **Self-healing** | Auto-restart on crash, one-click fix for "port already in use" |
| **ngrok built in** | Installs itself, shows your public URL, **request inspector**, QR code for your phone, **webhook URL copier** (Stripe, Dodo, GitHub) |
| **Databases and tools** | Redis, PostgreSQL, MySQL, phpMyAdmin, Prisma Studio presets (via Docker) |
| **Git and packages** | Branch and status per app, Pull button, Install / Build buttons, warning when `package.json` changed |
| **Env profiles** | Switch between dev and staging variables per app |
| **Stay organised** | Favourites, groups, search, import / export of your app list |
| **Stays out of the way** | System tray, desktop notifications on crashes, free-memory finder for idle servers |

<p align="center">
  <img src="docs/screenshots/errors.png" alt="Errors tab" width="440">
  <img src="docs/screenshots/edit.png" alt="Edit an app" width="440">
</p>

## Install

1. Download **`RunBay-Setup-x.y.z.exe`** from the [latest release](https://github.com/Tharana/runbay/releases/latest).
2. Run it, pick an install folder, and finish the wizard.
3. Open **RunBay** from your desktop or Start menu.

Prefer no installer? Download `RunBay-x.y.z-portable.exe` and run it from anywhere.

> **"Windows protected your PC"?** The installer is not code-signed yet (certificates cost money).
> Click **More info** then **Run anyway**. The code is open, so you can read or build it yourself.

## Quick start

1. Click **Add from folder** and choose your project folder.
2. Check the detected services, then **Save**.
3. Press **Run all**. Use the **URLs to check** links to open your app.

That is all. Add more apps the same way, star your favourites, and keep them in groups.

## FAQ

**Where is my data stored?**
In `%APPDATA%\runbay`. Updating or uninstalling keeps it.

**Do I need Node, PHP or Docker?**
Only the tools your own projects use. RunBay installs and updates ngrok for you.

**Does it send my data anywhere?**
No. RunBay runs fully on your PC. The only network call it can make is the optional
"Check for updates" button, which downloads a small version file from this repository.

**Which systems are supported?**
Windows 10 and 11 today. Contributions for macOS and Linux are welcome.

## Build from source

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/Tharana/runbay.git
cd runbay
npm install
npm start          # run the app
npm run dist       # build the installer into ./dist
```

## Release a new version (maintainers)

1. Change the code and test with `npm start`.
2. Raise `version` in `package.json` and add an entry at the top of `CHANGELOG.md`.
3. Run `npm run dist`.
4. Create a GitHub release tagged `vX.Y.Z` and attach `dist/RunBay-Setup-X.Y.Z.exe`
   (and the portable exe).
5. Update `latest.json` with the new version and download link, then push.
   Users get the update through **About → Check for updates**.

## Contributing

Bug reports, ideas and pull requests are very welcome.
Open an [issue](https://github.com/Tharana/runbay/issues) or send a PR, and add a line to
[CHANGELOG.md](CHANGELOG.md) for user-visible changes.

## License

[MIT](LICENSE.txt). Free to use, modify and share, including commercially.

Made with care by **[WebCrab.lk](https://webcrab.lk)**.
