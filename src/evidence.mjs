import { mkdir, appendFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { scrub } from './policy.mjs';

export class Evidence {
  constructor(directory, secrets = []) {
    this.directory = directory;
    this.secrets = secrets;
    this.runId = randomUUID();
    this.sequence = 0;
    this.previousHash = '0'.repeat(64);
    this.queue = Promise.resolve();
    this.events = [];
    this.startedEvent = null;
    this.modelCalls = 0;
    this.lastResult = null;
  }
  async init() {
    await this.queue;
    await mkdir(this.directory, { recursive: true });
    for (const name of await readdir(this.directory)) {
      if(name==='result.json'||/^(?:failure|success|intervention-\d+)\.(?:json|png)$/.test(name))await rm(join(this.directory,name),{force:true});
    }
    await writeFile(join(this.directory, 'events.jsonl'), '');
    this.sequence = 0; this.previousHash = '0'.repeat(64);
    this.runId = randomUUID();
    this.events = []; this.startedEvent = null; this.modelCalls = 0; this.lastResult = null;
  }
  async event(type, data = {}) {
    const next = this.queue.then(async () => {
      const body = scrub({ ...data, sequence: ++this.sequence, time: new Date().toISOString(), runId: this.runId, type }, this.secrets);
      const hash = createHash('sha256').update(this.previousHash + JSON.stringify(body)).digest('hex');
      const record = { ...body, previousHash: this.previousHash, hash };
      await appendFile(join(this.directory, 'events.jsonl'), JSON.stringify(record) + '\n');
      this.previousHash = hash;
      if (type === 'run.started') this.startedEvent = record;
      if (type === 'model.observed') this.modelCalls++;
      this.events.push(record);
      if (this.events.length > 512) this.events.shift();
    });
    this.queue = next;
    return next;
  }
  async result(result) {
    await this.queue;
    const safe = scrub(result, this.secrets);
    if(safe.artifact)safe.artifact=basename(safe.artifact);
    // Declared sensitive outputs exist in the caller's memory, never on disk.
    if (safe.outputs) for (const key of Object.keys(safe.outputs)) safe.outputs[key] = '[REDACTED]';
    safe.runId = this.runId;
    await writeFile(join(this.directory, 'result.json'), JSON.stringify(safe, null, 2) + '\n');
    this.lastResult = safe;
    return result;
  }
  async snapshotState() {
    await this.queue;
    const events = this.startedEvent && !this.events.includes(this.startedEvent)
      ? [this.startedEvent, ...this.events] : this.events;
    return structuredClone({ events, result: this.lastResult, modelCalls: this.modelCalls });
  }
  async snapshot(surface, label = 'failure') {
    const result = await surface.evidence(join(this.directory, label));
    await this.event('evidence.captured', { label });
    return result;
  }
}

export async function verifyLog(path) {
  const { readFile } = await import('node:fs/promises');
  let previous = '0'.repeat(64), sequence = 0;
  const lines = (await readFile(path, 'utf8')).trim();
  for (const line of lines ? lines.split('\n') : []) {
    const { hash, previousHash, ...body } = JSON.parse(line);
    const actual = createHash('sha256').update(previous + JSON.stringify(body)).digest('hex');
    if (hash !== actual || previousHash !== previous || body.sequence !== ++sequence) throw new Error('Evidence integrity mismatch');
    previous = hash;
  }
  return { events: sequence, finalHash: previous };
}
