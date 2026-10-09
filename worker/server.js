import http from 'node:http';
import { execFile } from 'node:child_process';

const port = Number(process.env.PORT || 10000);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: 'ok', service: 'faceless-studio-api' }));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/ffmpeg-status') {
    execFile('ffmpeg', ['-version'], { timeout: 5000 }, (err, stdout) => {
      res.writeHead(err ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(err ? { status: 'unavailable' } : { status: 'ready', version: stdout.split('\n')[0] }));
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});
server.listen(port, '0.0.0.0', () => console.log(`Faceless Studio API listening on ${port}`));
