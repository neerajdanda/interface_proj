import { createServer } from 'node:http';

// Adversarial, entirely fictional data for live adapter privacy verification.
export const privateValues = ['Casey Quinn', 'Taylor Vale', '41 Cedar Lane', '73129', '$8,125.00', 'casey.quinn@example.test', '+1 (415) 555-0198', 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789', 'a-private-form-payload "quoted"\nsecond line'];

const [mainName, frameName, address, memberId, balance, email, phone, apiKey] = privateValues;
const style = '<style>body{font:16px system-ui;padding:24px}td,th{padding:8px;text-align:left}button,input{margin:8px;padding:8px}iframe{width:100%;height:500px;border:1px solid #ddd}</style>';
const main = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Review ${mainName} and ${frameName} · ${email} · ${phone} · ${apiKey}</title>${style}<body>
<h1>Relay privacy verification fixture</h1><p>Fictional records deliberately repeated in titles, labels, and frames.</p>
<table><tr><th>Member name</th><td>${mainName}</td></tr><tr><th>Address</th><td>${address}</td></tr></table>
<h2 id="privacy-main-heading">Record for ${frameName}</h2>
<button id="privacy-main-action" aria-label="Open ${frameName}">Open member</button>
<label for="privacy-contact">Contact ${mainName} at ${email}</label><input id="privacy-contact" value="${phone}">
<table><tr><th>Review ${frameName}</th><td><input value="${address}"></td></tr></table>
<label for="privacy-note">Memo</label><textarea id="privacy-note">${privateValues[8]}</textarea>
<button>Search</button>
<iframe title="${frameName} workspace for ${mainName}" name="${mainName} member workspace" src="/workspace"></iframe>
</body></html>`;
const embedded = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${mainName} and ${frameName} · ${apiKey}</title>${style}<body>
<table><tr><th>Member name</th><td>${frameName}</td></tr><tr><th>Member ID</th><td>${memberId}</td></tr><tr><th>Savings balance</th><td>${balance}</td></tr>
<tr><th>Member ID</th><td><input value="${memberId}"></td></tr><tr><th>Review ${mainName}</th><td><input value="${address}"></td></tr></table>
<h2 id="privacy-frame-heading">Account for ${mainName}</h2>
<button id="privacy-frame-action" aria-label="Open ${mainName}">Open member</button>
<label for="privacy-frame-contact">Call ${mainName} at ${phone}</label><input id="privacy-frame-contact" value="${email}">
<button>Account summary</button></body></html>`;

export async function startPrivacyFixture({ port = 0 } = {}) {
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' || !['/bank', '/workspace'].includes(req.url)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(req.url === '/bank' ? main : embedded);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
