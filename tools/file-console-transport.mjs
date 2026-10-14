import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

const requestName = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.request\.json$/i;

/** Verification-only transport. The real console handler runs only when pump()
 * is explicitly called inside the active CUA invocation. No UI work runs in a
 * background timer. IPC files are scratch data, never submission evidence.
 */
export async function createFileConsoleTransport({ directory, port } = {}) {
  if (!directory || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('An explicit IPC directory and port are required');
  directory = resolve(directory);
  const requests = join(directory, 'requests'), responses = join(directory, 'responses');
  await mkdir(requests, { recursive: true, mode: 0o700 });
  await mkdir(responses, { recursive: true, mode: 0o700 });
  let handler, closed = false, pumping = false;
  const serverFactory = callback => {
    if (handler) throw new Error('One console handler per transport');
    handler = callback;
    return {
      once() { return this; },
      listen(actualPort, host, ready) {
        if (actualPort !== port || host !== '127.0.0.1') throw new Error('IPC listener must match its loopback relay');
        ready(); return this;
      },
      address() { return { address: '127.0.0.1', port }; },
      close(done) { closed = true; done?.(); },
    };
  };
  const pump = async () => {
    if (!handler || closed) return { processed: 0, closed };
    if (pumping) throw new Error('Only one IPC pump may run at once');
    pumping = true;
    let processed = 0;
    try {
      for (const name of (await readdir(requests)).filter(name => requestName.test(name)).sort()) {
        const path = join(requests, name), working = path.replace('.request.json', '.working.json');
        try { await rename(path, working); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const id = name.slice(0, -'.request.json'.length);
        let status = 500, headers = {}, body = Buffer.from('{"error":"IPC_HANDLER_ERROR"}');
        try {
          const bytes = await readFile(working);
          if (bytes.length > 32768) throw new Error('IPC request too large');
          const incoming = JSON.parse(bytes.toString('utf8'));
          if (!['GET', 'POST'].includes(incoming.method) || typeof incoming.url !== 'string' || incoming.url.length > 256 || typeof incoming.body !== 'string' || Buffer.byteLength(incoming.body) > 16384 || !incoming.headers || typeof incoming.headers !== 'object') throw new Error('Invalid IPC request');
          const req = { method: incoming.method, url: incoming.url, headers: incoming.headers, async *[Symbol.asyncIterator]() { if (incoming.body) yield Buffer.from(incoming.body); } };
          let ended = false;
          const res = {
            setHeader(key, value) { headers[key.toLowerCase()] = String(value); return this; },
            writeHead(code, values = {}) { status = code; for (const [key, value] of Object.entries(values)) this.setHeader(key, value); return this; },
            end(value) { if (ended) throw new Error('Response already ended'); ended = true; body = value === undefined ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : Buffer.from(String(value)); return this; },
          };
          status = 200;
          await handler(req, res);
          if (!ended) throw new Error('Console handler did not end its response');
        } catch {
          status = 500; headers = { 'content-type': 'application/json' }; body = Buffer.from('{"error":"IPC_HANDLER_ERROR"}');
        }
        if (body.length > 10 * 1024 * 1024) { status = 500; headers = { 'content-type': 'application/json' }; body = Buffer.from('{"error":"IPC_RESPONSE_TOO_LARGE"}'); }
        const destination = join(responses, id + '.response.json');
        const temporary = join(responses, '.' + randomUUID() + '.tmp');
        await writeFile(temporary, JSON.stringify({ status, headers, bodyBase64: body.toString('base64') }), { mode: 0o600 });
        await rename(temporary, destination);
        await rm(working, { force: true });
        processed++;
      }
      return { processed, closed };
    } finally { pumping = false; }
  };
  return { directory, port, serverFactory, pump };
}
