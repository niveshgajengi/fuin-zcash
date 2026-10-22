// The stack must already be up (./stack.sh); fail loudly instead of starting a half stack.
export default async function globalSetup() {
  for (const url of [process.env.FUIN_LANDING ?? 'http://127.0.0.1:4180/', process.env.FUIN_SALEROOM ?? 'http://127.0.0.1:4178/']) {
    const res = await fetch(url).catch((e: Error) => {
      throw new Error(`Setup required: ${url} is not running (${e.message}). Start it with e2e/stack.sh`);
    });
    if (!res.ok) throw new Error(`Setup required: ${url} answered HTTP ${res.status}`);
  }
}
