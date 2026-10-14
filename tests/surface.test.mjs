import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSandbox } from '../src/sandbox.mjs';
import { BrowserSurface } from '../src/surface.mjs';
import { Policy } from '../src/policy.mjs';

const frame = 'Member workspace';
const button = name => ({ frame, strategies: [{ kind: 'role', role: 'button', name }] });
const heading = name => ({ frame, strategies: [{ kind: 'role', role: 'heading', name }] });
const row = (label, control) => ({ frame, strategies: [{ kind: 'row', label, control }] });
const visible = target => ({ target, op: 'visible' });

// Explicit opt-in keeps unit checks portable on hosts without a browser install.
test('live DOM adapter and synthetic banking fixture', { skip: process.env.RELAY_LIVE_TESTS !== '1', timeout: 60000 }, async t => {
  const sandbox = await startSandbox({ port: 0 });
  let surface;
  const directory = await mkdtemp(join(tmpdir(), 'relay-surface-'));
  try {
    surface = await BrowserSurface.launch({ baseUrl: sandbox.baseUrl });
    const policy = new Policy({ baseUrl: sandbox.baseUrl });
    assert.equal(surface.page.url(), 'about:blank', 'policy can be installed before navigation');
    await policy.protect(surface.context);
    const visit = async scenario => {
      if (surface.page.url().startsWith(sandbox.baseUrl)) await surface.page.evaluate(() => sessionStorage.clear());
      await surface.navigate(`/bank?scenario=${scenario}`);
    };
    const click = async name => surface.act({ type: 'click', target: button(name) });
    const search = async (scenario = 'normal', member_id = '12345') => {
      await visit(scenario);
      await surface.act({ type: 'fill', target: row('Member ID', 'input'), value: { param: 'member_id' } }, { member_id });
      await click('Search');
    };

    await t.test('unlabelled table input resolves structurally; both member balances are verified', async () => {
      for (const [member_id, balance] of [['12345', '$12,480.50'], ['67890', '$8,125.00']]) {
        await search('normal', member_id);
        assert.equal(await surface.check(visible(heading('Search results'))), true);
        assert.equal(await surface.check({ target: row('Member ID', 'text'), op: 'text_equals', value: { param: 'member_id' } }, { member_id }), true);
        await click('Open member');
        assert.equal(await surface.check(visible(heading('Member overview'))), true);
        await click('Account summary');
        assert.equal(await surface.check(visible(heading('Account summary'))), true);
        assert.equal(await surface.read(row('Savings balance', 'text')), balance);
      }
    });

    await t.test('observations and saved evidence omit identifiers, names, amounts, and field values', async () => {
      const observation = await surface.observe();
      const serialized = JSON.stringify(observation);
      for (const value of ['67890', 'Jordan Reed', '$8,125.00', '$1,904.22']) assert.equal(serialized.includes(value), false);
      assert.ok(observation.text.includes('[REDACTED]'));
      const files = await surface.evidence(join(directory, 'masked'));
      assert.ok((await readFile(files.screenshot)).length > 1000);
      const snapshot = await readFile(files.snapshot, 'utf8');
      for (const value of ['67890', 'Jordan Reed', '$8,125.00']) assert.equal(snapshot.includes(value), false);
      assert.ok((await surface.screenshot()).length > 1000);
    });

    await t.test('privacy applies across frame titles, labels, row strategies, recorder events, and saved evidence', async () => {
      // This visit owns its adversarial fixture and resets it before other banking checks.
      await visit('normal');
      const privateValues = ['Casey Quinn', 'Taylor Vale', '41 Cedar Lane', '73129', '$8,125.00', 'casey.quinn@example.test', '+1 (415) 555-0198', 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'];
      const embedded = surface.page.frames().find(candidate => candidate !== surface.page.mainFrame());
      const originalScreenshot = surface.page.screenshot;
      const screenshot = originalScreenshot.bind(surface.page);
      let screenshotMasks = [];
      try {
        await surface.page.evaluate(({ privateValues }) => {
          const [mainName, frameName, address, , , email, phone, apiKey] = privateValues;
          document.title = `Review ${mainName} and ${frameName} · ${email} · ${phone} · ${apiKey}`;
          const iframe = document.querySelector('iframe');
          iframe.title = `${frameName} workspace for ${mainName}`;
          iframe.name = `${mainName} member workspace`;
          const fixture = document.createElement('section');
          fixture.innerHTML = `<table><tr><th>Member name</th><td>${mainName}</td></tr><tr><th>Address</th><td>${address}</td></tr></table>
            <h2 id="privacy-main-heading">Record for ${frameName}</h2>
            <button id="privacy-main-action" aria-label="Open ${frameName}">Open member</button>
            <label for="privacy-contact">Contact ${mainName} at ${email}</label><input id="privacy-contact" value="${phone}">
            <table><tr><th>Review ${frameName}</th><td><input value="${address}"></td></tr></table>
            <button>Search</button>`;
          document.body.append(fixture);
        }, { privateValues });
        await embedded.evaluate(({ privateValues }) => {
          const [mainName, frameName, address, memberId, balance, email, phone, apiKey] = privateValues;
          document.title = `${mainName} and ${frameName} · ${apiKey}`;
          document.body.innerHTML = `<table><tr><th>Member name</th><td>${frameName}</td></tr><tr><th>Member ID</th><td>${memberId}</td></tr><tr><th>Savings balance</th><td>${balance}</td></tr>
            <tr><th>Member ID</th><td><input value="${memberId}"></td></tr><tr><th>Review ${mainName}</th><td><input value="${address}"></td></tr></table>
            <h2 id="privacy-frame-heading">Account for ${mainName}</h2>
            <button id="privacy-frame-action" aria-label="Open ${mainName}">Open member</button>
            <label for="privacy-frame-contact">Call ${mainName} at ${phone}</label><input id="privacy-frame-contact" value="${email}">
            <button>Account summary</button>`;
        }, { privateValues });

        const assertPrivateAbsent = (value, context) => {
          const serialized = typeof value === 'string' ? value : JSON.stringify(value);
          for (const privateValue of privateValues) assert.equal(serialized.includes(privateValue), false, `${context} must omit ${privateValue}`);
        };
        const observation = await surface.observe();
        assertPrivateAbsent(observation, 'observation');
        assert.ok(observation.title.includes('[REDACTED'));
        assert.ok(observation.frames.some(item => item.name.includes('[REDACTED')));
        assert.ok(observation.controls.some(control => control.name === 'Search'), 'safe search label stays usable');
        assert.ok(observation.controls.some(control => control.name === 'Account summary'), 'safe account label stays usable');
        assert.ok(observation.controls.some(control => control.target.strategies.some(strategy => strategy.kind === 'row' && strategy.label === 'Member ID')), 'safe structural row label stays usable');
        const privateControl = observation.controls.find(control => control.name.startsWith('Open ') && control.name.includes('[REDACTED'));
        assert.ok(privateControl, 'private accessible labels are represented with redaction');
        await assert.rejects(surface.act({ type: 'click', target: privateControl.target }), error => error.code === 'sensitive_target');
        await assert.rejects(surface.check(visible(privateControl.target)), error => error.code === 'sensitive_target');
        await surface.page.locator('iframe').evaluate(element => element.removeAttribute('title'));
        const namedFrameObservation = await surface.observe();
        assertPrivateAbsent(namedFrameObservation, 'frame-name fallback observation');
        assert.ok(namedFrameObservation.frames.some(item => item.name.includes('[REDACTED')), 'frame name fallback is filtered');

        surface.page.screenshot = async options => {
          screenshotMasks = options.mask || [];
          return screenshot(options);
        };
        const files = await surface.evidence(join(directory, 'cross-frame-privacy'));
        assertPrivateAbsent(await readFile(files.snapshot, 'utf8'), 'saved snapshot');
        assert.ok((await readFile(files.screenshot)).length > 1000);
        // Check the locators actually supplied to Playwright, including repeated names
        // outside private rows. A JSON-only redaction cannot make this check pass.
        const covered = new Set();
        for (const mask of screenshotMasks) {
          for (const id of await mask.evaluateAll(elements => ['privacy-main-heading', 'privacy-frame-heading'].filter(id => {
            const candidate = document.getElementById(id);
            return candidate && elements.some(element => element === candidate || element.contains(candidate));
          }))) covered.add(id);
        }
        assert.ok(covered.has('privacy-main-heading'), 'screenshot masks a name copied from the iframe into main-page content');
        assert.ok(covered.has('privacy-frame-heading'), 'screenshot masks a name copied from the main page into iframe content');

        const events = [];
        await surface.attachHumanRecorder(event => { events.push(event); });
        // Playwright emits trusted DOM input here; it remains an automated test actor.
        await surface.page.locator('#privacy-main-action').click();
        await embedded.locator('#privacy-frame-action').click();
        for (let attempt = 0; events.length < 2 && attempt < 20; attempt++) await surface.page.waitForTimeout(25);
        assert.equal(events.length, 2, 'both main-page and iframe controls are recorded');
        assertPrivateAbsent(events, 'recorder descriptors');
        assert.ok(events.every(event => event.trusted && event.target.strategies[0].name.includes('[REDACTED')));
        assert.ok(events.every(event => !Object.hasOwn(event, 'value')), 'recorder omits entered field values');
        assert.ok(events.some(event => event.target.frame?.includes('[REDACTED')), 'iframe metadata is filtered in recorder events');
      } finally {
        surface.page.screenshot = originalScreenshot;
        await visit('normal');
      }
    });

    await t.test('actual control names expose risky actions even through a text strategy', async () => {
      await search('normal', '67890');
      await click('Open member');
      await click('Account summary');
      await click('Open sub-account');
      assert.equal(await surface.check(visible(heading('Sub-account review'))), true);
      const actual = await surface.describeAction({ type: 'click', target: { frame, strategies: [{ kind: 'text', text: 'Submit transfer' }] } });
      assert.equal(actual.target.strategies[0].name, 'Submit transfer');
      assert.throws(() => policy.assertAction(actual), error => error.code === 'IRREVERSIBLE_ACTION');
      // A benign accessible label cannot hide dangerous visible button text.
      const transfer = surface.page.frameLocator('iframe[title="Member workspace"]').getByRole('button', { name: 'Submit transfer', exact: true });
      await transfer.evaluate(element => element.setAttribute('aria-label', 'Continue'));
      const disguised = await surface.describeAction({ type: 'click', target: button('Continue') });
      assert.throws(() => policy.assertAction(disguised), error => error.code === 'IRREVERSIBLE_ACTION');
      await click('Cancel review');
      assert.equal(await surface.check(visible(heading('Account summary'))), true);
    });

    await t.test('unique terminal state signals support precise outcome classification', async () => {
      for (const [scenario, name] of [['not_found', 'Member not found'], ['validation', 'Validation error'], ['permission', 'Permission denied'], ['app_error', 'Application error']]) {
        await search(scenario);
        assert.equal(await surface.check(visible({ frame, strategies: [{ kind: 'text', text: name }] })), true);
        assert.equal(await surface.check(visible(heading('Search results'))), false);
      }
    });

    await t.test('bounded interstitial and human session repair resume the current result', async () => {
      for (const [scenario, name, repair] of [['interstitial', 'Service notice', 'Continue'], ['session_expired', 'Session expired', 'Restore session'], ['unexpected_dialog', 'Supervisor approval required', 'Operator unlock']]) {
        await search(scenario);
        assert.equal(await surface.check(visible({ frame, strategies: [{ kind: 'role', role: 'dialog', name }] })), true);
        await click(repair);
        assert.equal(await surface.check(visible({ frame, strategies: [{ kind: 'role', role: 'dialog', name }] })), false);
        assert.equal(await surface.check(visible(heading('Search results'))), true);
      }
    });

    await t.test('ambiguity fails closed before trying a weaker fallback strategy', async () => {
      await search('ambiguous');
      const target = { frame, strategies: [{ kind: 'role', role: 'button', name: 'Open member' }, { kind: 'role', role: 'button', name: 'New search' }] };
      await assert.rejects(surface.act({ type: 'click', target }), error => error.code === 'ambiguous_target');
      assert.equal(await surface.check(visible(heading('Search results'))), true);
      await surface.act({ type: 'click', target: { frame, strategies: [{ kind: 'role', role: 'button', name: 'Missing control' }, { kind: 'role', role: 'button', name: 'New search' }] } });
      assert.equal(await surface.check(visible(heading('Find a member'))), true);
    });

    await t.test('slow loading remains a checkpoint wait rather than a duplicate search', async () => {
      await search('slow');
      assert.equal(await surface.check(visible(heading('Searching members'))), true);
      assert.equal(await surface.check(visible(heading('Search results'))), false);
      await surface.act({ type: 'wait', ms: 900 });
      await surface.act({ type: 'wait', ms: 900 });
      assert.equal(await surface.check(visible(heading('Search results'))), true);
    });

    await t.test('trusted recorder emits only safe control descriptors', async () => {
      const events = [];
      await surface.attachHumanRecorder(event => { events.push(event); });
      await search('normal');
      await surface.page.waitForTimeout(50);
      assert.ok(events.some(event => event.type === 'click'));
      for (const event of events) {
        assert.equal(event.trusted, true);
        assert.equal(Object.hasOwn(event, 'value'), false);
        assert.equal(JSON.stringify(event).includes('12345'), false);
      }
    });
  } finally {
    if (surface) await surface.close();
    await sandbox.close();
    await rm(directory, { recursive: true, force: true });
  }
});
