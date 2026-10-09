
import http from 'node:http';
import { execFile } from 'node:child_process';
import {
  timingSafeEqual,
  randomUUID,
  createHash,
  createHmac
} from 'node:crypto';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || 10000);

const MAX_BODY_BYTES = 12000;
const MAX_SCRIPT_CHARS = 4000;
const MAX_VIDEO_SCRIPT_CHARS = 350;
const MAX_FOOTAGE_BYTES = 40000000;
const MAX_OUTPUT_BYTES = 60000000;

let videoJobRunning = false;

// -------------------------------------
// GENERAL HELPERS
// -------------------------------------

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

  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);

  return supplied.length === expected.length &&
    timingSafeEqual(supplied, expected);
}

function requireAuth(req, res) {
  if (!authorized(
    req.headers.authorization,
    process.env.STUDIO_API_TOKEN
  )) {
    json(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
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

function requireJson(req, res) {
  if (!req.headers['content-type']
    ?.toLowerCase()
    .startsWith('application/json')) {
    json(res, 415, {
      error: 'Content-Type must be application/json'
    });
    return false;
  }
  return true;
}

function apiError(res, error, fallback) {
  console.error(fallback, error.message);

  const status = error.status ||
    (error.name === 'TimeoutError' ? 504 : 502);

  return json(res, status, {
    error: error.status && error.status < 500
      ? error.message
      : fallback,
    ...(error.upstream_status
      ? { upstream_status: error.upstream_status }
      : {})
  });
}

// -------------------------------------
// ELEVENLABS NARRATION
// -------------------------------------

async function createNarration(script) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey || !voiceId) {
    const error = new Error(
      'ElevenLabs is not configured'
    );
    error.status = 503;
    throw error;
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
    const error = new Error(
      'ElevenLabs narration failed'
    );
    error.status = response.status === 429
      ? 429 : 502;
    error.upstream_status = response.status;
    throw error;
  }

  const audio = Buffer.from(
    await response.arrayBuffer()
  );

  if (!audio.length || audio.length > 20000000) {
    throw new Error('Invalid narration audio');
  }

  return audio;
}

// -------------------------------------
// PIXABAY SEARCH
// -------------------------------------

async function findPixabayVideos(query) {
  const apiKey = process.env.PIXABAY_API_KEY;

  if (!apiKey) {
    const error = new Error(
      'Pixabay API key is not configured'
    );
    error.status = 503;
    throw error;
  }

  const url = new URL(
    'https://pixabay.com/api/videos/'
  );

  url.searchParams.set('key', apiKey);
  url.searchParams.set('q', query);
  url.searchParams.set('per_page', '5');
  url.searchParams.set('safesearch', 'true');

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const error = new Error(
      'Pixabay search failed'
    );
    error.status = response.status === 429
      ? 429 : 502;
    error.upstream_status = response.status;
    throw error;
  }

  const data = await response.json();

  return {
    total: data.totalHits || 0,
    videos: (data.hits || []).map(hit => {
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
    })
  };
}

// -------------------------------------
// DOWNLOAD PIXABAY FOOTAGE
// -------------------------------------

async function downloadStockVideo(url, filePath) {
  const parsed = new URL(url);

  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'cdn.pixabay.com'
  ) {
    throw new Error('Unsupported footage URL');
  }

  const response = await fetch(parsed, {
    redirect: 'error',
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(
      `Footage download failed: ${response.status}`
    );
  }

  const declaredSize = Number(
    response.headers.get('content-length') || 0
  );

  if (declaredSize > MAX_FOOTAGE_BYTES) {
    throw new Error('Footage is too large');
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of response.body) {
    size += chunk.length;

    if (size > MAX_FOOTAGE_BYTES) {
      throw new Error('Footage is too large');
    }

    chunks.push(chunk);
  }

  if (!size) {
    throw new Error('Empty footage file');
  }

  await fs.writeFile(
    filePath,
    Buffer.concat(chunks)
  );
}

// -------------------------------------
// AUDIO DURATION
// -------------------------------------

async function getAudioDuration(filePath) {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath
    ],
    { timeout: 10000 }
  );

  const duration = Number(stdout.trim());

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Invalid audio duration');
  }

  return duration;
}

// -------------------------------------
// FFMPEG VIDEO RENDERING
// -------------------------------------

async function renderVideo({
  footagePath,
  audioPath,
  outputPath,
  duration
}) {
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-stream_loop', '-1',
      '-i', footagePath,
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

// -------------------------------------
// CLOUDFLARE R2 UPLOAD
// AWS SIGNATURE VERSION 4
// -------------------------------------

function sha256(value) {
  return createHash('sha256')
    .update(value)
    .digest('hex');
}

function hmac(key, value) {
  return createHmac('sha256', key)
    .update(value)
    .digest();
}

function r2Config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET_NAME;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !bucket || !accessKey || !secretKey) {
    const error = new Error(
      'R2 environment variables are missing'
    );
    error.status = 503;
    throw error;
  }

  return {
    accountId,
    bucket,
    accessKey,
    secretKey
  };
}

function signedR2Request({
  method,
  objectKey,
  body,
  expiresSeconds
}) {
  const config = r2Config();

  const host =
    `${config.accountId}.r2.cloudflarestorage.com`;

  const objectPath =
    '/' + encodeURIComponent(config.bucket) +
    '/' + objectKey
      .split('/')
      .map(encodeURIComponent)
      .join('/');

  const now = new Date();
  const amzDate = now.toISOString()
    .replace(/[:-]|\.\d{3}/g, '');

  const dateStamp = amzDate.slice(0, 8);
  const scope =
    `${dateStamp}/auto/s3/aws4_request`;

  const payloadHash = body
    ? sha256(body)
    : 'UNSIGNED-PAYLOAD';

  const isDownload = method === 'GET';

  let canonicalQuery = '';
  let canonicalHeaders = '';
  let signedHeaders = '';
  let authorization = '';

  const signingKey = hmac(
    hmac(
      hmac(
        hmac(
          `AWS4${config.secretKey}`,
          dateStamp
        ),
        'auto'
      ),
      's3'
    ),
    'aws4_request'
  );

  if (isDownload) {
    const params = [
      [
        'X-Amz-Algorithm',
        'AWS4-HMAC-SHA256'
      ],
      [
        'X-Amz-Credential',
        `${config.accessKey}/${scope}`
      ],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(expiresSeconds)],
      ['X-Amz-SignedHeaders', 'host']
    ];

    canonicalQuery = params
      .map(([key, value]) => [
        encodeURIComponent(key),
        encodeURIComponent(value)
      ])
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');

    canonicalHeaders = `host:${host}\n`;
    signedHeaders = 'host';
  } else {
    canonicalHeaders =
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;

    signedHeaders =
      'host;x-amz-content-sha256;x-amz-date';
  }

  const canonicalRequest = [
    method,
    objectPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256(canonicalRequest)
  ].join('\n');

  const signature = createHmac(
    'sha256',
    signingKey
  ).update(stringToSign).digest('hex');

  if (isDownload) {
    const url =
      `https://${host}${objectPath}?` +
      canonicalQuery +
      `&X-Amz-Signature=${signature}`;

    return { url };
  }

  authorization =
    `AWS4-HMAC-SHA256 Credential=` +
    `${config.accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  return {
    url: `https://${host}${objectPath}`,
    headers: {
      Authorization: authorization,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'Content-Type': 'video/mp4'
    }
  };
}

async function uploadVideoToR2(videoBuffer) {
  const objectKey = `videos/${randomUUID()}.mp4`;

  const signed = signedR2Request({
    method: 'PUT',
    objectKey,
    body: videoBuffer
  });

  const response = await fetch(signed.url, {
    method: 'PUT',
    headers: signed.headers,
    body: videoBuffer,
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    console.error(
      'R2 upload status:',
      response.status
    );

    throw new Error(
      `R2 upload failed with HTTP ${response.status}`
    );
  }

  console.log('R2 upload successful:', objectKey);

  return objectKey;
}

// -------------------------------------
// NARRATION ENDPOINT
// -------------------------------------

async function narrationEndpoint(req, res) {
  if (!requireAuth(req, res)) return;
  if (!requireJson(req, res)) return;

  try {
    const body = await readJson(req);
    const script = body?.script;

    if (
      typeof script !== 'string' ||
      !script.trim() ||
      script.length > MAX_SCRIPT_CHARS
    ) {
      return json(res, 400, {
        error: 'Invalid script'
      });
    }

    const audio = await createNarration(
      script.trim()
    );

    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Disposition':
        'attachment; filename="narration.mp3"',
      'Content-Length': audio.length,
      'Cache-Control': 'no-store'
    });

    res.end(audio);

  } catch (error) {
    apiError(res, error, 'Narration generation failed');
  }
}

// -------------------------------------
// FOOTAGE SEARCH ENDPOINT
// -------------------------------------

async function footageSearchEndpoint(req, res, url) {
  if (!requireAuth(req, res)) return;

  const query = (
    url.searchParams.get('q') || ''
  ).trim();

  if (!query || query.length > 100) {
    return json(res, 400, {
      error: 'Invalid search query'
    });
  }

  try {
    const result = await findPixabayVideos(query);

    return json(res, 200, {
      query,
      total: result.total,
      videos: result.videos
    });

  } catch (error) {
    apiError(res, error, 'Footage search failed');
  }
}

// -------------------------------------
// VIDEO GENERATION + R2 UPLOAD
// -------------------------------------

async function generateVideoEndpoint(req, res) {
  if (!requireAuth(req, res)) return;
  if (!requireJson(req, res)) return;

  if (videoJobRunning) {
    return json(res, 429, {
      error: 'Another video is being generated'
    });
  }

  let body;

  try {
    body = await readJson(req);
  } catch (error) {
    return json(res, error.status || 400, {
      error: error.message
    });
  }

  const script = body?.script;
  const topic = body?.topic;

  if (
    typeof script !== 'string' ||
    !script.trim() ||
    script.length > MAX_VIDEO_SCRIPT_CHARS
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

  videoJobRunning = true;
  let tempDir;

  try {
    // Check R2 configuration before using
    // ElevenLabs credits.
    r2Config();

    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'faceless-')
    );

    const audioPath =
      path.join(tempDir, 'narration.mp3');

    const footagePath =
      path.join(tempDir, 'footage.mp4');

    const outputPath =
      path.join(tempDir, 'final-video.mp4');

    console.log('Generating narration');

    const audio = await createNarration(
      script.trim()
    );

    await fs.writeFile(audioPath, audio);

    console.log('Searching Pixabay');

    const search = await findPixabayVideos(
      topic.trim()
    );

    const clips = search.videos.filter(
      video => video.video_url
    );

    if (!clips.length) {
      return json(res, 404, {
        error: 'No matching stock footage found'
      });
    }

    console.log('Downloading footage');

    await downloadStockVideo(
      clips[0].video_url,
      footagePath
    );

    const duration = await getAudioDuration(
      audioPath
    );

    if (duration > 60) {
      return json(res, 400, {
        error: 'Narration exceeds 60 seconds'
      });
    }

    console.log('Rendering MP4');

    await renderVideo({
      footagePath,
      audioPath,
      outputPath,
      duration
    });

    const video = await fs.readFile(
      outputPath
    );

    if (
      !video.length ||
      video.length > MAX_OUTPUT_BYTES
    ) {
      throw new Error('Invalid output video size');
    }

    console.log('Uploading MP4 to R2');

    const objectKey = await uploadVideoToR2(
      video
    );

    console.log(
      'Saved video successfully:',
      objectKey
    );

    // Keep the existing direct MP4 download.
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Disposition':
        'attachment; filename="faceless-studio-video.mp4"',
      'Content-Length': video.length,
      'Cache-Control': 'no-store',
      'X-Studio-Storage': 'r2'
    });

    res.end(video);

  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }

    apiError(res, error, 'Video generation failed');

  } finally {
    if (tempDir) {
      try {
        await fs.rm(tempDir, {
          recursive: true,
          force: true
        });
      } catch (error) {
        console.error(
          'Cleanup error:',
          error.message
        );
      }
    }

    videoJobRunning = false;
  }
}

// -------------------------------------
// MAIN HTTP SERVER
// -------------------------------------

const server = http.createServer(
  async (req, res) => {
    const url = new URL(
      req.url,
      'http://localhost'
    );

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
        (error, stdout) => {
          json(
            res,
            error ? 503 : 200,
            error
              ? { status: 'unavailable' }
              : {
                  status: 'ready',
                  version: stdout.split('\n')[0]
                }
          );
        }
      );
    }

    if (url.pathname === '/api/narration') {
      if (req.method !== 'POST') {
        return json(res, 405, {
          error: 'Use POST'
        });
      }

      return narrationEndpoint(req, res);
    }

    if (url.pathname === '/api/footage/search') {
      if (req.method !== 'GET') {
        return json(res, 405, {
          error: 'Use GET'
        });
      }

      return footageSearchEndpoint(
        req,
        res,
        url
      );
    }

    if (url.pathname === '/api/video/generate') {
      if (req.method !== 'POST') {
        return json(res, 405, {
          error: 'Use POST'
        });
      }

      return generateVideoEndpoint(req, res);
    }

    return json(res, 404, {
      error: 'Not found'
    });
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
