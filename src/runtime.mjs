import { pathToFileURL } from 'node:url';

export async function loadPlaywright() {
  // Development override avoids copying the desktop's bundled dependencies.
  if (process.env.RELAY_PLAYWRIGHT_PATH) {
    return import(pathToFileURL(process.env.RELAY_PLAYWRIGHT_PATH).href);
  }
  return import('playwright');
}
