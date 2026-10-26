Live Playwright audit, 2026-10-26 UTC, source commit `a43d4a7`.

Both commands ran from `e2e` with the existing tests and configuration:

```sh
FUIN_LANDING=https://fuin-landing.vercel.app/ FUIN_SALEROOM=https://fuin-landing.vercel.app/saleroom/ npx playwright test tests/landing.spec.ts tests/saleroom.spec.ts
FUIN_LANDING=https://fuin-landing.vercel.app/ FUIN_SALEROOM=https://fuin-dashboard.vercel.app/ npx playwright test tests/saleroom.spec.ts
```

`landing-list.txt` and `dashboard-list.txt` are the complete list-reporter outputs. The first command exited 0 (100 passed); the second exited 1 (52 passed, 2 failed). The summary JSON files contain counts extracted from those runs' Playwright reports. Tests used headless Google Chrome, one worker, no retries, desktop 1280×800 and mobile 375×812 (device scale factor 2).

The dashboard's Catalogue navigation failed in both viewports: expected the landing origin, received the dashboard origin. The two JPEGs are the original failure captures converted for size, each below 200,000 bytes. Full videos, traces, PNGs and HTML reports are excluded from this evidence set.

Dependencies and `SBA_VERIFY_BIN` reused the existing main-checkout installation at `/Volumes/Extreme SSD/Projects/grokbot/projects/zec-sealed-bid-auction`; no build or local server ran. Chain checks only read published records through the verifier. No transactions, wallets, `.demo`, `.env`, deployments or pushes were used. `lifecycle.txt` records acquisition and trap-based release of `fuin-e2e-live`.
