
import http from 'node:http';
import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';

const port = Number(process.env.PORT || 10000);

const MAX_BODY_BYTES = 12_000;
const MAX_SCRIPT_CHARS = 4_000;
const ELEVENLABS_TIMEOUT_MS = 45_000;
const PIXABAY_TIMEOUT_MS = 15_000;

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function authorized(header, secret) {
  if (!secret || !header?.startsWith('Bearer ')) {
    return false;
  }

  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);

  return (
    provided.length === expected.length &&
    timingSafeEqual(provided, expected)
  );
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

  try {
    return JSON.parse(
      Buffer.concat(chunks).toString('utf8')
    );
  } catch {
    const error = new Error('Invalid JSON');
    error.status = 400;
    throw error;
  }
}

// --------------------------------------------------
// PIXABAY STOCK VIDEO SEARCH
// GET /api/footage/search?q=space
// --------------------------------------------------

async function searchPixabay(req, res, url) {
  if (!authorized(
    req.headers.authorization,
    process.env.STUDIO_API_TOKEN
  )) {
    return json(res, 401, {
      error: 'Unauthorized'
    });
  }

  const apiKey = process.env.PIXABAY_API_KEY;

  if (!apiKey) {
    return json(res, 503, {
      error: 'Pixabay API key is not configured'
    });
  }

  const query = (url.searchParams.get('q') || '').trim();

  if (!query || query.length > 100) {
    return json(res, 400, {
      error: 'Search query must contain 1-100 characters'
    });
  }

  try {
    const pixabayUrl = new URL(
      'https://pixabay.com/api/videos/'
    );

    pixabayUrl.searchParams.set('key', apiKey);
    pixabayUrl.searchParams.set('q', query);
    pixabayUrl.searchParams.set('per_page', '5');
    pixabayUrl.searchParams.set('safesearch', 'true');

    const response = await fetch(pixabayUrl, {
      headers: {
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(PIXABAY_TIMEOUT_MS)
    });

    if (!response.ok) {
      console.error(
        'Pixabay API request failed:',
        response.status
      );

      return json(res, response.status === 429 ? 429 : 502, {
        error: response.status === 429
          ? 'Pixabay rate limit reached'
          : 'Pixabay video search failed',
        upstream_status: response.status
      });
    }

    const data = await response.json();

    const videos = (data.hits || []).map((hit) => {
      const video =
        hit.videos?.medium ||
        hit.videos?.small ||
        hit.videos?.large ||
        hit.videos?.tiny;

      return {
        id: hit.id,
        tags: hit.tags || '',
        duration: hit.duration || 0,
        thumbnail:
          hit.videos?.tiny?.thumbnail ||
          hit.videos?.small?.thumbnail ||
          null,
        video_url: video?.url || null,
        width: video?.width || null,
        height: video?.height || null,
        page_url: hit.pageURL || null
      };
    });

    return json(res, 200, {
      query,
      total: data.totalHits || 0,
      videos
    });

  } catch (error) {
    console.error(
      'Pixabay search error:',
      error?.name || 'Unknown'
    );

    return json(
      res,
      error?.name === 'TimeoutError' ? 504 : 502,
      {
        error: 'Unable to search stock footage'
      }
    );
  }
}

// --------------------------------------------------
// ELEVENLABS NARRATION
// POST /api/narration
// --------------------------------------------------

async function generateNarration(req, res) {
  if (!authorized(
    req.headers.authorization,
    process.env.STUDIO_API_TOKEN
  )) {
    return json(res, 401, {
      error: 'Unauthorized'
    });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    return json(res, 503, {
      error: 'ElevenLabs is not configured'
    });
  }

  try {
    if (!req.headers['content-type']
      ?.toLowerCase()
      .startsWith('application/json')) {
      return json(res, 415, {
        error: 'Content-Type must be application/json'
      });
    }

    const body = await readJson(req);
    const script = body?.script;

    if (
      typeof script !== 'string' ||
      !script.trim() ||
      script.length > MAX_SCRIPT_CHARS
    ) {
      return json(res, 400, {
        error:
          `script must contain 1-${MAX_SCRIPT_CHARS} characters`
      });
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${
        encodeURIComponent(voiceId)
      }`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg'
        },
        body: JSON.stringify({
          text: script.trim(),
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.55,
            similarity_boost: 0.75,
            style: 0.25,
            use_speaker_boost: true
          }
        }),
        signal: AbortSignal.timeout(
          ELEVENLABS_TIMEOUT_MS
        )
      }
    );

    if (!response.ok) {
      console.error(
        'ElevenLabs request failed:',
        response.status
      );

      return json(
        res,
        response.status === 429 ? 429 : 502,
        {
          error: response.status === 429
            ? 'ElevenLabs rate limit reached'
            : 'ElevenLabs narration request failed',
          upstream_status: response.status
        }
      );
    }

    const audio = Buffer.from(
      await response.arrayBuffer()
    );

    if (
      !audio.length ||
      audio.length > 20_000_000
    ) {
      return json(res, 502, {
        error: 'Unexpected narration audio size'
      });
    }

    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Disposition':
        'attachment; filename="narration.mp3"',
      'Content-Length': audio.length,
      'Cache-Control': 'no-store'
    });

    return res.end(audio);

  } catch (error) {
    console.error(
      'Narration error:',
      error?.name || 'Unknown'
    );

    return json(
      res,
      error.status ||
        (error.name === 'TimeoutError' ? 504 : 502),
      {
        error: error.status
          ? error.message
          : 'Narration generation failed'
      }
    );
  }
}

// --------------------------------------------------
// MAIN HTTP SERVER
// --------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url,
    'http://localhost'
  );

  // Health check
  if (
    req.method === 'GET' &&
    url.pathname === '/health'
  ) {
    return json(res, 200, {
      status: 'ok',
      service: 'faceless-studio-api'
    });
  }

  // FFmpeg status
  if (
    req.method === 'GET' &&
    url.pathname === '/ffmpeg-status'
  ) {
    return execFile(
      'ffmpeg',
      ['-version'],
      { timeout: 5000 },
      (err, stdout) => {
        json(
          res,
          err ? 503 : 200,
          err
            ? { status: 'unavailable' }
            : {
                status: 'ready',
                version: stdout.split('\n')[0]
              }
        );
      }
    );
  }

  // Narration endpoint
  if (url.pathname === '/api/narration') {
    if (req.method !== 'POST') {
      return json(res, 405, {
        error: 'Use POST'
      });
    }

    return generateNarration(req, res);
  }

  // Pixabay footage search endpoint
  if (url.pathname === '/api/footage/search') {
    if (req.method !== 'GET') {
      return json(res, 405, {
        error: 'Use GET'
      });
    }

    return searchPixabay(req, res, url);
  }

  return json(res, 404, {
    error: 'Not found'
  });
});

// Start server
server.listen(
  port,
  '0.0.0.0',
  () => {
    console.log(
      `Faceless Studio API listening on ${port}`
    );
  }
);
