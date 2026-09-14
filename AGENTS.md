# Working on Repi

Run these from the repository root. Nothing here needs the network except
`build:kuna` and `build:rasc`, which read a local checkout.

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server. |
| `npm run build` | `tsc --noEmit`, a Vite build, then the licence is copied into `dist/`. |
| `npm run check:analysis` | The analysis contract, in Node, without a browser. |
| `npm run smoke` | Drives the real page in headless Chrome. **Does not start a server** — point it at one with `REPI_SMOKE_URL`, or use `verify`. |
| `npm run verify` | Starts a preview server, runs the smoke check, then the design-document check, then stops the server. This is the one-command path. |
| `npm run build:kuna` | Builds the native decompiler from a checkout (`KUNA_REPO`, default `~/zhome/kuna`). |
| `npm run build:rasc` | Builds the APK/DEX decompiler from a checkout (`RASC_REPO`, default `~/rasc`). |

Deploying is manual and only manual: `.github/workflows/deploy.yml` has no push
trigger. Ask for one:

```sh
gh workflow run deploy.yml --repo TsingShui/Repi
```
