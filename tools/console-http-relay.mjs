import { createServer } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Loopback HTTP edge for verification-only IPC. It never operates a browser. */
export async function startConsoleHttpRelay({ directory, port = 4184, requestTimeoutMs = 30000, lifetimeMs = 600000 } = {}) {
  if (!directory || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 60000 || !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 600000) throw new Error('Invalid relay directory, port, or bounded timeout');
  directory = resolve(directory);
  const requests = join(directory, 'requests'), responses = join(directory, 'responses');
  await mkdir(requests, { recursive: true, mode: 0o700 }); await mkdir(responses, { recursive: true, mode: 0o700 });
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
    if (!['GET', 'POST'].includes(req.method) || !['/', '/state', '/preview', '/claim', '/action', '/resume'].includes(req.url)) { res.writeHead(404).end(); return; }
    const id = randomUUID();
    const requestPath = join(requests, id + '.request.json'), responsePath = join(responses, id + '.response.json');
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) { res.writeHead(413).end(); return; } }
      const headers = Object.fromEntries(['host', 'origin', 'x-relay-token', 'content-type'].filter(key => typeof req.headers[key] === 'string').map(key => [key, req.headers[key]]));
      const temporary = join(requests, '.' + id + '.tmp');
      await writeFile(temporary, JSON.stringify({ method: req.method, url: req.url, headers, body }), { mode: 0o600 });
      await rename(temporary, requestPath);
      const deadline = Date.now() + requestTimeoutMs;
      while (Date.now() < deadline && !res.destroyed) {
        try {
          const raw = await readFile(responsePath);
          if (raw.length > 15 * 1024 * 1024) throw new Error('IPC response too large');
          const response = JSON.parse(raw.toString('utf8'));
          if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599 || !response.headers || typeof response.bodyBase64 !== 'string') throw new Error('Invalid IPC response');
          res.writeHead(response.status, response.headers).end(Buffer.from(response.bodyBase64, 'base64'));
          return;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      if (!res.destroyed) res.writeHead(504, { 'Content-Type': 'application/json' }).end('{"error":"VERIFICATION_PUMP_TIMEOUT"}');
    } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"VERIFICATION_RELAY_ERROR"}');
    } finally { await rm(requestPath, { force: true }); await rm(responsePath, { force: true }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  const timer = setTimeout(() => { void close(); }, lifetimeMs);
  return { directory, port, url: `http://127.0.0.1:${port}`, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !/^\d+$/.test(args[1])) { console.error('Usage: node tools/console-http-relay.mjs IPC_DIRECTORY PORT'); process.exitCode = 1; }
  else {
    try {
      const relay = await startConsoleHttpRelay({ directory: args[0], port: Number(args[1]) });
      console.log(`Verification-only console relay: ${relay.url}`);
      process.once('SIGINT', () => { void relay.close(); }); process.once('SIGTERM', () => { void relay.close(); });
    } catch (error) { console.error(`Console relay could not start: ${error.code || error.name}`); process.exitCode = 1; }
  }
}
