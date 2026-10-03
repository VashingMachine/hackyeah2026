// Test receiver for the M&A scenario: logs every request it gets. The demo's claim is that after a refusal it logs none.
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
const log = process.argv[2] ?? '/tmp/blackwall-receiver.log';
writeFileSync(log, '');
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    appendFileSync(log, `${new Date().toISOString()} ${req.method} ${req.url} ${body.length}b\n`);
    res.end('received');
  });
}).listen(9911, '127.0.0.1', () => console.error('[receiver] listening on 127.0.0.1:9911, log:', log));
