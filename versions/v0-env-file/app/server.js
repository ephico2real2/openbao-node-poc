// v0 of Secure Notes: the way most apps start. Every credential comes from an
// environment variable loaded from a .env file. This is the code the
// modernization replaces (docs/modernization/01-source-review.md). Do not deploy.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import Redis from 'ioredis';

const env = process.env;

// F1: a long-lived password, straight from the environment.
const pool = new pg.Pool({
  host: env.DB_HOST,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
});

// F5: the password is inside the URL, so any log of the URL leaks it.
const redis = new Redis(env.REDIS_URL);
redis.on('error', (err) => console.error(`redis error on ${env.REDIS_URL}: ${err.message}`));

// A common "helpful" startup line: it prints the connection strings.
console.log(`connecting to postgres://${env.DB_USER}:${env.DB_PASSWORD}@${env.DB_HOST}/${env.DB_NAME} and ${env.REDIS_URL}`);

await pool.query('CREATE TABLE IF NOT EXISTS notes (id serial PRIMARY KEY, body text NOT NULL, created_at timestamptz DEFAULT now())');

const page = readFileSync(new URL('./public/index.html', import.meta.url));

const server = http.createServer(async (req, res) => {
  const json = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    if (req.url === '/api/notes' && req.method === 'GET') {
      const cached = await redis.get('notes');
      if (cached) return json(200, { source: 'redis', notes: JSON.parse(cached) });
      const { rows } = await pool.query('SELECT id, body, created_at FROM notes ORDER BY id DESC LIMIT 50');
      await redis.set('notes', JSON.stringify(rows), 'EX', 30);
      return json(200, { source: 'postgres', notes: rows });
    }
    if (req.url === '/api/notes' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const text = String(JSON.parse(body || '{}').body ?? '').slice(0, 280);
      const { rows } = await pool.query('INSERT INTO notes (body) VALUES ($1) RETURNING *', [text]);
      await redis.del('notes');
      return json(201, rows[0]);
    }
    json(404, { message: 'not found' });
  } catch (err) {
    // F5 again: the error and the connection string go to the log together.
    console.error(`request failed (db postgres://${env.DB_USER}:${env.DB_PASSWORD}@${env.DB_HOST}): ${err.message}`);
    json(500, { message: err.message });
  }
});

server.listen(3000, '0.0.0.0', () => console.log('secure-notes v0 listening on :3000'));
