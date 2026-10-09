import http from 'node:http';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';

const port = Number(process.env.PORT || 10000);
const MAX_BODY_BYTES = 12_000;
const MAX_SCRIPT_CHARS = 4_000;
const ELEVENLABS_TIMEOUT_MS = 45_000;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function authorized(header, secret) {
  if (!secret || !header?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
async function readJson(req) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error('Request too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('Invalid JSON'); error.status = 400; throw error; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { status: 'ok', service: 'faceless-studio-api' });
  }
  if (req.method === 'GET' && url.pathname === '/ffmpeg-status') {
    return execFile('ffmpeg', ['-version'], { timeout: 5000 }, (err, stdout) => {
      json(res, err ? 503 : 200, err ? { status: 'unavailable' } : { status: 'ready', version: stdout.split('\n')[0] });
    });
  }
  if (url.pathname === '/api/narration') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
    if (!authorized(req.headers.authorization, process.env.STUDIO_API_TOKEN)) {
      return json(res, 401, { error: 'Unauthorized' });
    }
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;
    if (!apiKey || !voiceId) return json(res, 503, { error: 'ElevenLabs is not configured' });
    try {
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        return json(res, 415, { error: 'Content-Type must be application/json' });
      }
      const body = await readJson(req);
      const script = body?.script;
      if (typeof script !== 'string' || !script.trim() || script.length > MAX_SCRIPT_CHARS) {
        return json(res, 400, { error: `script must contain 1-${MAX_SCRIPT_CHARS} characters` });
      }
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
        body: JSON.stringify({ text: script.trim(), model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.25, use_speaker_boost: true } }),
        signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.error('ElevenLabs request failed:', response.status);
        return json(res, response.status === 429 ? 429 : 502, { error: response.status === 429 ? 'ElevenLabs rate limit reached' : 'ElevenLabs narration request failed', upstream_status: response.status });
      }
      const audio = Buffer.from(await response.arrayBuffer());
      if (!audio.length || audio.length > 20_000_000) return json(res, 502, { error: 'Unexpected narration audio size' });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Disposition': 'attachment; filename="narration.mp3"', 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
      return res.end(audio);
    } catch (error) {
      console.error('Narration error:', error?.name || 'Unknown');
      return json(res, error.status || (error.name === 'TimeoutError' ? 504 : 502), { error: error.status ? error.message : 'Narration generation failed' });
    }
  }
  return json(res, 404, { error: 'Not found' });
});
server.listen(port, '0.0.0.0', () => console.log(`Faceless Studio API listening on ${port}`));
