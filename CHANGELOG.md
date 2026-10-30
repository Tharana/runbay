# Version history

All notable changes to RunBay. Newest first.
Format: `## [version] - date`, then one bullet per change (the in-app About window reads this file).

## [1.5.0] - 2026-10-30
- Renamed from AppRun to **RunBay**; your saved apps are carried over automatically
- First public, open-source release on GitHub (MIT)
- "Check for updates" now works out of the box
- New README with screenshots, quick start and feature list

## [1.4.0] - 2026-10-30
- New premium dark design: glass cards, gradient accents, line icons, blurred dialogs
- New app icon and a proper Windows installer (Setup.exe) with desktop and Start menu shortcuts
- About window with version history, license and credit to WebCrab.lk
- Optional "Check for updates" button
- Separate Errors tab in the log panel, with Copy and Export for errors only
- Fixed: cards were squashed when an app had many services; the page now scrolls

## [1.3.0] - 2026-10-30
- Detects Django, FastAPI, Flask, Python, Go, .NET, Spring Boot and Docker Compose, plus monorepos
- Database and tool presets (Redis, PostgreSQL, MySQL, phpMyAdmin, Prisma Studio) with stop commands
- ngrok request inspector
- Webhook helper: copy ready-made Stripe / Dodo / GitHub webhook URLs
- Import and export your app list
- CPU and memory sparklines on every service
- Install / Build buttons and a warning when package.json changed since the last install

## [1.2.0] - 2026-10-30
- Log tools: error count badges, error highlighting, export logs to a file
- Git status per app (branch, uncommitted changes, ahead/behind) with a Pull button
- Env profiles (for example dev and staging) per app
- Favourites, groups and search for your apps
- System tray: closing the window keeps servers running; tray menu to run and stop apps
- Desktop notifications when a service crashes or an ngrok URL appears
- Bulk actions: Stop everything, Free memory (idle server finder)

## [1.1.0] - 2026-10-30
- "URLs to check" list for every app, with Copy buttons
- Auto-start apps when RunBay opens
- Start order: each service waits until the previous one is ready, with optional extra delay
- Health check badge (Responding / Not responding)
- Auto-restart on crash with a retry limit
- One-click fix for "port already in use"
- Open a service folder in VS Code or a terminal
- QR code for testing on your phone

## [1.0.0] - 2026-10-05
- First release: run Next.js, PHP and other dev servers from one window
- Auto-detect frontend, backend and ngrok from a folder
- Live logs, CPU, memory and uptime per service
- ngrok installed and updated automatically
