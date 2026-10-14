import { randomUUID } from 'node:crypto';

/** A single-session lease. Epochs fence stale automation commands. */
export class Ownership {
  constructor(evidence) {
    this.evidence = evidence;
    this.sessionId = randomUUID();
    this.owner = 'automation';
    this.epoch = 1;
    this.pending = null;
    this.inFlight = false;
  }
  ticket() { return { sessionId: this.sessionId, epoch: this.epoch }; }
  assert(ticket, owner = 'automation') {
    if (!['automation','human'].includes(owner) || this.owner !== owner || ticket.epoch !== this.epoch || ticket.sessionId !== this.sessionId) {
      throw Object.assign(new Error('Session control is fenced'), { code: 'CONTROL_FENCED' });
    }
  }
  async execute(ticket, owner, task) {
    this.assert(ticket, owner);
    if (this.inFlight) throw Object.assign(new Error('Session action already in flight'), { code: 'CONTROL_BUSY' });
    this.inFlight = true;
    try { return await task(); } finally { this.inFlight = false; }
  }
  async pause(context) {
    if (this.inFlight || this.owner !== 'automation') throw new Error('Cannot pause an active or ceded session');
    this.owner = 'paused'; this.epoch++;
    this.pending = { id: randomUUID(), ...context, sessionId: this.sessionId, epoch: this.epoch };
    await this.evidence.event('intervention.requested', this.pending);
    return this.pending;
  }
  async claim() {
    if (this.owner !== 'paused' || this.inFlight) throw new Error('Only an idle paused session can be claimed');
    this.owner = 'human'; this.epoch++;
    await this.evidence.event('control.transferred', { owner: this.owner, sessionId: this.sessionId, epoch: this.epoch });
    return this.ticket();
  }
  async resume() {
    if (this.owner !== 'human' || this.inFlight) throw new Error('Human must release an idle session');
    this.owner = 'automation'; this.epoch++;
    await this.evidence.event('control.transferred', { owner: this.owner, sessionId: this.sessionId, epoch: this.epoch });
    this.pending = null;
    this.resumeCallback?.(); this.resumeCallback = null;
  }
  async waitForResume(timeoutMs = 120000) {
    if (this.owner === 'automation') return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.resumeCallback = null; reject(Object.assign(new Error('Operator did not return control before deadline'), { code: 'HANDOFF_TIMEOUT' })); }, timeoutMs);
      this.resumeCallback = () => { clearTimeout(timer); resolve(); };
    });
  }
}
