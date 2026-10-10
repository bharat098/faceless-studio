
import http from 'node:http';
import { execFile } from 'node:child_process';
import { timingSafeEqual, randomUUID, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const port = Number(process.env.PORT || 10000);
const SITE_ORIGIN = 'https://bharat098.github.io';
const MAX_BODY = 12000;
let videoBusy = false;

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

function equal(a, b) {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cors(req, res) {
  if (req.headers.origin === SITE_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', SITE_ORIGIN);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

async function auth(req, res) {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Bearer ')) {
    json(res, 401, { error: 'Sign in required' });
    return null;
  }

  const token = header.slice(7);

  // Private token remains available for administrative testing.
  // Never include it in frontend code.
  if (equal(token, process.env.STUDIO_API_TOKEN)) {
    return { type: 'admin' };
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const allowedEmail = process.env.STUDIO_ALLOWED_EMAIL
    ?.trim()
    .toLowerCase();

  if (!url || !key || !allowedEmail) {
    json(res, 503, {
      error: 'Supabase access configuration incomplete'
    });
    return null;
  }

  try {
    const response = await fetch(
      `${url.replace(/\/$/, '')}/auth/v1/user`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${token}`
        },
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!response.ok) {
      json(res, 401, {
        error: 'Session expired. Sign in again.'
      });
      return null;
    }

    const user = await response.json();

    if (
      !user.id ||
      !user.email_confirmed_at ||
      user.email?.toLowerCase() !== allowedEmail
    ) {
      json(res, 403, {
        error: 'This account is not authorized to generate videos'
      });
      return null;
    }

    return {
      type: 'supabase',
      userId: user.id
    };

  } catch (err) {
    console.error(
      'Supabase verification failed:',
      err.message
    );

    json(res, 502, {
      error: 'Unable to verify login right now'
    });

    return null;
  }
}

async function readJson(req) {
  let size = 0;
  const parts = [];

  for await (const part of req) {
    size += part.length;

    if (size > MAX_BODY) {
      throw Object.assign(
        new Error('Request too large'),
        { status: 413 }
      );
    }

    parts.push(part);
  }

  try {
    return JSON.parse(
      Buffer.concat(parts).toString('utf8')
    );
  } catch {
    throw Object.assign(
      new Error('Invalid JSON'),
      { status: 400 }
    );
  }
}

function errorResponse(res, err, fallback) {
  console.error(fallback, err.message);

  if (!res.headersSent) {
    json(
      res,
      err.status ||
        (err.name === 'TimeoutError' ? 504 : 502),
      {
        error: err.status && err.status < 500
          ? err.message
          : fallback
      }
    );
  }
}

// ------------------------------------
// ELEVENLABS NARRATION
// ------------------------------------

async function narration(script) {
  const key = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID;

  if (!key || !voice) {
    throw Object.assign(
      new Error('ElevenLabs not configured'),
      { status: 503 }
    );
  }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${
      encodeURIComponent(voice)
    }`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg'
      },
      body: JSON.stringify({
        text: script,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.75,
          style: 0.25,
          use_speaker_boost: true
        }
      }),
      signal: AbortSignal.timeout(45000)
    }
  );

  if (!response.ok) {
    throw Object.assign(
      new Error(`ElevenLabs HTTP ${response.status}`),
      {
        status: response.status === 429 ? 429 : 502
      }
    );
  }

  const audio = Buffer.from(
    await response.arrayBuffer()
  );

  if (!audio.length || audio.length > 20000000) {
    throw new Error('Invalid narration size');
  }

  return audio;
}

// ------------------------------------
// PIXABAY SEARCH
// ------------------------------------

async function searchVideos(query) {
  const key = process.env.PIXABAY_API_KEY;

  if (!key) {
    throw Object.assign(
      new Error('Pixabay not configured'),
      { status: 503 }
    );
  }

  const url = new URL(
    'https://pixabay.com/api/videos/'
  );

  url.searchParams.set('key', key);
  url.searchParams.set('q', query);
  url.searchParams.set('per_page', '5');
  url.searchParams.set('safesearch', 'true');

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw Object.assign(
      new Error(`Pixabay HTTP ${response.status}`),
      {
        status: response.status === 429 ? 429 : 502
      }
    );
  }

  const data = await response.json();

  return {
    total: data.totalHits || 0,
    videos: (data.hits || []).map(hit => {
      const clip =
        hit.videos?.medium ||
        hit.videos?.small ||
        hit.videos?.large ||
        hit.videos?.tiny;

      return {
        id: hit.id,
        tags: hit.tags || '',
        duration: hit.duration || 0,
        thumbnail:
          hit.videos?.tiny?.thumbnail || null,
        video_url: clip?.url || null,
        width: clip?.width || null,
        height: clip?.height || null,
        page_url: hit.pageURL || null
      };
    })
  };
}

// ------------------------------------
// DOWNLOAD STOCK FOOTAGE
// ------------------------------------

async function downloadClip(clipUrl, destination) {
  const url = new URL(clipUrl);

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'cdn.pixabay.com'
  ) {
    throw new Error('Untrusted footage URL');
  }

  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(
      `Footage download HTTP ${response.status}`
    );
  }

  if (
    Number(
      response.headers.get('content-length') || 0
    ) > 40000000
  ) {
    throw new Error('Footage too large');
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of response.body) {
    size += chunk.length;

    if (size > 40000000) {
      throw new Error('Footage too large');
    }

    chunks.push(chunk);
  }

  if (!size) {
    throw new Error('Empty footage');
  }

  await fs.writeFile(
    destination,
    Buffer.concat(chunks)
  );
}

// ------------------------------------
// FFPROBE + FFMPEG
// ------------------------------------

async function durationOf(audioPath) {
  const { stdout } = await run(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      audioPath
    ],
    { timeout: 10000 }
  );

  const duration = Number(stdout.trim());

  if (
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    throw new Error('Invalid audio duration');
  }

  return duration;
}

async function renderVideo(
  clipPath,
  audioPath,
  outputPath,
  duration
) {
  await run(
    'ffmpeg',
    [
      '-y',
      '-stream_loop', '-1',
      '-i', clipPath,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-vf',
      'scale=1280:720:force_original_aspect_ratio=increase,' +
      'crop=1280:720,fps=24,format=yuv420p',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '28',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-t', String(duration),
      '-movflags', '+faststart',
      '-threads', '2',
      outputPath
    ],
    {
      timeout: 120000,
      maxBuffer: 1024 * 1024
    }
  );
}

// ------------------------------------
// CLOUDFLARE R2 UPLOAD
// ------------------------------------

function sha256(data) {
  return createHash('sha256')
    .update(data)
    .digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key)
    .update(data)
    .digest();
}

async function uploadR2(video, userId) {
  const account = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET_NAME;
  const access = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;

  if (!account || !bucket || !access || !secret) {
    throw Object.assign(
      new Error('R2 not configured'),
      { status: 503 }
    );
  }

  const key =
    `videos/${userId || 'admin'}/${randomUUID()}.mp4`;

  const host =
    `${account}.r2.cloudflarestorage.com`;

  const objectPath =
    '/' +
    [bucket, ...key.split('/')]
      .map(encodeURIComponent)
      .join('/');

  const amzDate = new Date()
    .toISOString()
    .replace(/[:-]|\.\d{3}/g, '');

  const date = amzDate.slice(0, 8);
  const scope =
    `${date}/auto/s3/aws4_request`;

  const payload = sha256(video);

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payload}\n` +
    `x-amz-date:${amzDate}\n`;

  const signedHeaders =
    'host;x-amz-content-sha256;x-amz-date';

  const request = [
    'PUT',
    objectPath,
    '',
    canonicalHeaders,
    signedHeaders,
    payload
  ].join('\n');

  const toSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(request)
  ].join('\n');

  const signingKey = hmac(
    hmac(
      hmac(
        hmac(`AWS4${secret}`, date),
        'auto'
      ),
      's3'
    ),
    'aws4_request'
  );

  const signature = createHmac(
    'sha256',
    signingKey
  ).update(toSign).digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${access}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  const response = await fetch(
    `https://${host}${objectPath}`,
    {
      method: 'PUT',
      headers: {
        Authorization: authorization,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payload,
        'Content-Type': 'video/mp4'
      },
      body: video,
      signal: AbortSignal.timeout(60000)
    }
  );

  if (!response.ok) {
    throw new Error(
      `R2 upload HTTP ${response.status}`
    );
  }

  console.log('Saved video in R2:', key);

  return key;
}

// ------------------------------------
// VIDEO GENERATION
// ------------------------------------

async function generate(req, res, user) {
  if (videoBusy) {
    return json(res, 429, {
      error: 'Another video is being generated'
    });
  }

  let body;

  try {
    body = await readJson(req);
  } catch (err) {
    return json(res, err.status || 400, {
      error: err.message
    });
  }

  const script = body?.script;
  const topic = body?.topic;

  if (
    typeof script !== 'string' ||
    !script.trim() ||
    script.length > 350
  ) {
    return json(res, 400, {
      error: 'Script must contain 1-350 characters'
    });
  }

  if (
    typeof topic !== 'string' ||
    !topic.trim() ||
    topic.length > 100
  ) {
    return json(res, 400, {
      error: 'Topic must contain 1-100 characters'
    });
  }

  videoBusy = true;
  let dir;

  try {
    dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'faceless-')
    );

    const audioPath =
      path.join(dir, 'narration.mp3');

    const clipPath =
      path.join(dir, 'footage.mp4');

    const outputPath =
      path.join(dir, 'final.mp4');

    const audio = await narration(
      script.trim()
    );

    await fs.writeFile(audioPath, audio);

    const results = await searchVideos(
      topic.trim()
    );

    const clip = results.videos.find(
      v => v.video_url
    );

    if (!clip) {
      return json(res, 404, {
        error: 'No matching stock footage found'
      });
    }

    await downloadClip(
      clip.video_url,
      clipPath
    );

    const duration = await durationOf(
      audioPath
    );

    if (duration > 60) {
      return json(res, 400, {
        error: 'Narration exceeds 60 seconds'
      });
    }

    await renderVideo(
      clipPath,
      audioPath,
      outputPath,
      duration
    );

    const video = await fs.readFile(
      outputPath
    );

    if (
      !video.length ||
      video.length > 60000000
    ) {
      throw new Error(
        'Invalid rendered MP4 size'
      );
    }

    await uploadR2(
      video,
      user.userId
    );

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Disposition':
        'attachment; filename="faceless-studio-video.mp4"',
      'Content-Length': video.length,
      'Cache-Control': 'no-store',
      'X-Studio-Storage': 'r2'
    });

    res.end(video);

  } catch (err) {
    errorResponse(
      res,
      err,
      'Video generation failed'
    );

  } finally {
    if (dir) {
      await fs.rm(dir, {
        recursive: true,
        force: true
      }).catch(err => {
        console.error(
          'Cleanup failed:',
          err.message
        );
      });
    }

    videoBusy = false;
  }
}

// ------------------------------------
// MAIN HTTP SERVER
// ------------------------------------

const server = http.createServer(
  async (req, res) => {
    cors(req, res);

    const url = new URL(
      req.url,
      'http://localhost'
    );

    if (req.method === 'OPTIONS') {
      if (req.headers.origin !== SITE_ORIGIN) {
        return json(res, 403, {
          error: 'Origin not allowed'
        });
      }

      res.writeHead(204);
      return res.end();
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/health'
    ) {
      return json(res, 200, {
        status: 'ok',
        service: 'faceless-studio-api'
      });
    }

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

    const routes = [
      '/api/narration',
      '/api/footage/search',
      '/api/video/generate',
      '/api/me'
    ];

    if (!routes.includes(url.pathname)) {
      return json(res, 404, {
        error: 'Not found'
      });
    }

    if (
      url.pathname === '/api/footage/search' ||
      url.pathname === '/api/me'
    ) {
      if (req.method !== 'GET') {
        return json(res, 405, {
          error: 'Use GET'
        });
      }
    } else if (req.method !== 'POST') {
      return json(res, 405, {
        error: 'Use POST'
      });
    }

    const user = await auth(req, res);

    if (!user) return;

    if (url.pathname === '/api/me') {
      return json(res, 200, {
        authorized: true,
        user_type: user.type
      });
    }

    if (url.pathname === '/api/footage/search') {
      const query = (
        url.searchParams.get('q') || ''
      ).trim();

      if (!query || query.length > 100) {
        return json(res, 400, {
          error: 'Query must contain 1-100 characters'
        });
      }

      try {
        return json(res, 200, {
          query,
          ...await searchVideos(query)
        });
      } catch (err) {
        return errorResponse(
          res,
          err,
          'Footage search failed'
        );
      }
    }

    if (
      !req.headers['content-type']
        ?.toLowerCase()
        .startsWith('application/json')
    ) {
      return json(res, 415, {
        error: 'Content-Type must be application/json'
      });
    }

    if (url.pathname === '/api/video/generate') {
      return generate(req, res, user);
    }

    try {
      const body = await readJson(req);

      if (
        typeof body?.script !== 'string' ||
        !body.script.trim() ||
        body.script.length > 4000
      ) {
        return json(res, 400, {
          error: 'Script must contain 1-4000 characters'
        });
      }

      const audio = await narration(
        body.script.trim()
      );

      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Disposition':
          'attachment; filename="narration.mp3"',
        'Content-Length': audio.length,
        'Cache-Control': 'no-store'
      });

      return res.end(audio);

    } catch (err) {
      return errorResponse(
        res,
        err,
        'Narration generation failed'
      );
    }
  }
);

server.listen(
  port,
  '0.0.0.0',
  () => {
    console.log(
      `Faceless Studio API listening on ${port}`
    );
  }
);
