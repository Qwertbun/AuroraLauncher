<p align="center"><img src="./logo.png" width="200px" height="200px"></p>
<h1 align="center">Aurora Launcher</h1>
<h2 align="center">Fork by Qwerbentum</h2>
<h3 align="center">Especially for Mine-Souls.ru</h3>
<h4>
Server part for Aurora-based launcher infrastructure.

## Add

- HWIDS ban

## Requirements

- Node.js 20+
- npm 10+

## Quick Start

```bash
npm ci
npm run build:dev
node dist/LauncherServer.js --dev
```

On first launch the server creates `LauncherServerConfig.hjson` in the storage directory, then exits. Edit config and start again.

## Production Start

1. Set a dedicated runtime storage path outside the repository.

```powershell
$env:AURORA_STORAGE_OVERRIDE="C:\aurora\launcher-server"
```

2. Install dependencies and build production bundle.

```bash
npm ci
npm run build:prod
```

3. Run server.

```bash
node dist/LauncherServer.js
```

## Runtime Files (Do Not Commit)

If runtime storage points to repository root, server can create:

- `LauncherServerConfig.hjson`
- `authlib/`
- `logs/`
- `profiles/`
- `modules/`
- `gameFiles/`

These paths are ignored in `.gitignore`.

## HWID Bans

See `README_HWID_BANS.md`.

</h4>
