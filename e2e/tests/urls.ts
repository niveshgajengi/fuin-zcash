// The stack (./stack.sh) serves the site as hosted: the landing at /, the saleroom at /saleroom/.
// FUIN_LANDING / FUIN_SALEROOM point the suite at another copy (e.g. the GitHub Pages URLs).
export const LANDING = process.env.FUIN_LANDING ?? `http://127.0.0.1:${process.env.FUIN_PORT ?? 4180}/`;
export const SALEROOM = process.env.FUIN_SALEROOM ?? new URL('saleroom/', LANDING).href;
/** The saleroom's verification key, next to it (a relative fetch). */
export const VK_PATH = new URL('verification_key.json', SALEROOM).pathname;
