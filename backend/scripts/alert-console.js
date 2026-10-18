#!/usr/bin/env node
// LAB (epic B7): where vmalert sends alerts (its Alertmanager notifier, pointed
// here). http://localhost:3100 shows them; /api/alerts returns them as JSON.
import { createServer } from 'node:http';
import { createAlertConsole } from '../src/detect/console.js';

const c = createAlertConsole();
const port = Number(process.env.PORT ?? 3100);
createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/v2/alerts') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const n = c.receive(JSON.parse(body));
      console.log(`[alert-console] received ${n} alert(s): ${c.list().map((a) => a.labels.alertname).join(', ')}`);
      res.writeHead(200).end();
    } else if (req.method === 'GET' && req.url === '/api/alerts') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ alerts: c.list() }));
    } else if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(c.html());
    } else if (req.url === '/health') {
      res.writeHead(200).end('ok');
    } else {
      res.writeHead(404).end();
    }
  } catch (err) {
    res.writeHead(400).end(String(err.message));
  }
}).listen(port, '0.0.0.0', () => console.log(`[alert-console] listening on ${port}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
