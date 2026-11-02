# Version history

All notable changes to RunBay. Newest first.
Format: `## [version] - date`, then one bullet per change (the in-app About window reads this file).

## [1.6.0] - 2026-11-03
- **Workspaces**: save a set of apps as a stack (for example "Client X") and run or stop all of it with one click, from the sidebar or the tray
- **Quick launcher**: press Ctrl+Alt+R anywhere in Windows, type an app or workspace name and press Enter to run or stop it (shortcut is changeable in Settings)
- **Settings**: start RunBay with Windows, start minimized in the tray, pick your code editor, and turn log history on or off
- **Port map**: see every port in use on the PC, which process owns it, which of your apps it blocks, and kill it (also works for programs RunBay did not start)
- **Logs**: filter by level (errors, warnings, info), stack traces are highlighted and no longer inflate the error count, file paths are clickable and open in your editor at the right line, and the log history is kept between restarts
- **Local domains with HTTPS**: give a service a name like `myshop.test` and open it at `https://myshop.test`. RunBay makes its own private certificate, runs a small proxy (hot reload works) and asks Windows for permission before it trusts the certificate or edits the hosts file
- **.env editor**: edit `.env` files with secrets masked, compare two files, and get a warning (on the card and in the log) when keys from `.env.example` are missing
- **Resource alerts**: a notification when a service stays above a CPU or memory limit, or goes quiet for too long (set in Settings)
- **Database tools** for Docker databases: connection string, backup and restore, and a read-only table browser for PostgreSQL, MySQL and Redis
- **History**: a timeline per app of crashes, automatic restarts and health failures, with uptime, typical outage length and a "Flaky" badge
- **Start order**: choose what each service waits for, with a live diagram; services that wait for nothing start side by side
- **Language versions per app**: RunBay reads `.nvmrc`, `.node-version`, `package.json` (engines / volta), `.python-version`, `pyproject.toml` and `composer.json`, finds a matching version among your installs (nvm-windows, fnm, Volta, pyenv-win, python.org, Laragon, XAMPP, Scoop) and runs only that app with it. Nothing global is switched, and a missing version comes with the command to install it
- **`runbay` command line**: `runbay start myshop --wait`, `stop`, `restart`, `status`, `logs -f`, `list`. It starts RunBay if needed, waits until every service is ready, and returns exit codes made for scripts and CI. Install it from Settings
- **Explain this error**: click an error in the Errors tab to ask Claude what it means and how to fix it. You see the exact text first, secrets are removed, and nothing is sent until you press the button. Needs your own Anthropic API key (stored encrypted)
- Fixed: stopping an app while it was still starting no longer lets the remaining services come up
- Quick buttons on every service: open in browser, copy URL, File Explorer, editor, and Windows Terminal (falls back to Command Prompt)

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
