import { LANDING, SALEROOM } from './tests/urls';

// The stack must already be up (./stack.sh); fail loudly instead of starting a half stack.
export default async function globalSetup() {
  for (const url of [LANDING, SALEROOM]) {
    const res = await fetch(url).catch((e: Error) => {
      throw new Error(`Setup required: ${url} is not running (${e.message}). Start it with e2e/stack.sh`);
    });
    if (!res.ok) throw new Error(`Setup required: ${url} answered HTTP ${res.status}`);
  }
}
