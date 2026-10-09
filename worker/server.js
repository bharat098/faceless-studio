
import http from 'node:http';
import { execFile } from 'node:child_process';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const port = Number(process.env.PORT || 10000);

const MAX_BODY_BYTES = 12_000;
const MAX_SCRIPT_CHARS = 4000;
const MAX_VIDEO_SCRIPT_CHARS = 350;

const ELEVENLABS_TIMEOUT_MS = 45000;
const PIXABAY_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 30000;
const RENDER_TIMEOUT_MS = 120000;

let videoJobRunning = false;

// -------------------------------------------
// HELPERS
// -------------------------------------------

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

function requireAuth(req, res) {
  if (!authorized(
    req.headers.authorization,
    process.env.STUDIO_API_TOKEN
  )) {
    json(res, 401, {
      error: 'Unauthorized'
    });

    return false;
  }

  return true;
}

// -------------------------------------------
// ELEVENLABS AUDIO GENERATION
// -------------------------------------------

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
      signal: AbortSignal.timeout(
        ELEVENLABS_TIMEOUT_MS
      )
    }
  );

  if (!response.ok) {
    console.error(
      'ElevenLabs failed:',
      response.status
    );

    const error = new Error(
      'ElevenLabs narration failed'
    );

    error.status = response.status === 429
      ? 429
      : 502;

    error.upstream_status = response.status;

    throw error;
  }

  const audio = Buffer.from(
    await response.arrayBuffer()
  );

  if (
    !audio.length ||
    audio.length > 20000000
  ) {
    const error = new Error(
      'Unexpected narration audio size'
    );
    error.status = 502;
    throw error;
  }

  return audio;
}

// -------------------------------------------
// PIXABAY VIDEO SEARCH
// -------------------------------------------

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
    headers: {
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(
      PIXABAY_TIMEOUT_MS
    )
  });

  if (!response.ok) {
    console.error(
      'Pixabay failed:',
      response.status
    );

    const error = new Error(
      'Pixabay video search failed'
    );

    error.status = response.status === 429
      ? 429
      : 502;

    error.upstream_status = response.status;

    throw error;
  }

  const data = await response.json();

  return {
    total: data.totalHits || 0,
    videos: (data.hits || []).map((hit) => {
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

// -------------------------------------------
// SECURE STOCK VIDEO DOWNLOAD
// -------------------------------------------

async function downloadStockVideo(videoUrl, outputPath) {
  const parsed = new URL(videoUrl);

  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'cdn.pixabay.com'
  ) {
    throw new Error(
      'Unsupported stock footage URL'
    );
  }

  const response = await fetch(parsed, {
    redirect: 'error',
    signal: AbortSignal.timeout(
      DOWNLOAD_TIMEOUT_MS
    )
  });

  if (!response.ok) {
    throw new Error(
      `Stock footage download failed: ${response.status}`
    );
  }

  const MAX_VIDEO_BYTES = 40000000;

  const declaredSize = Number(
    response.headers.get('content-length') || 0
  );

  if (declaredSize > MAX_VIDEO_BYTES) {
    throw new Error(
      'Stock footage exceeds size limit'
    );
  }

  const chunks = [];
  let total = 0;

  try {
    for await (const chunk of response.body) {
      total += chunk.length;

      if (total > MAX_VIDEO_BYTES) {
        throw new Error(
          'Stock footage exceeds size limit'
        );
      }

      chunks.push(chunk);
    }
  } catch (error) {
    await response.body?.cancel?.().catch(() => {});
    throw error;
  }

  if (!total) {
    throw new Error('Stock footage is empty');
  }

  await fs.writeFile(
    outputPath,
    Buffer.concat(chunks)
  );
}

// -------------------------------------------
// FFPROBE: AUDIO DURATION
// -------------------------------------------

async function getAudioDuration(audioPath) {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      audioPath
    ],
    {
      timeout: 10000
    }
  );

  const duration = Number(stdout.trim());

  if (
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    throw new Error(
      'Unable to determine audio duration'
    );
  }

  return duration;
}

// -------------------------------------------
// FFMPEG: GENERATE LANDSCAPE MP4
// -------------------------------------------

async function renderVideo({
  footagePath,
  audioPath,
  outputPath,
  duration
}) {
  const args = [
    '-y',

    '-stream_loop', '-1',
    '-i', footagePath,

    '-i', audioPath,

    '-map', '0:v:0',
    '-map', '1:a:0',

    '-vf',
    'scale=1280:720:force_original_aspect_ratio=increase,' +
    'crop=1280:720,' +
    'fps=24,' +
    'format=yuv420p',

    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '28',

    '-c:a', 'aac',
    '-b:a', '128k',

    '-t', String(duration),

    '-movflags', '+faststart',

    '-threads', '2',

    outputPath
  ];

  await execFileAsync(
    'ffmpeg',
    args,
    {
      timeout: RENDER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024
    }
  );
}

// -------------------------------------------
// EXISTING NARRATION ENDPOINT
// POST /api/narration
// -------------------------------------------

async function narrationEndpoint(req, res) {
  if (!requireAuth(req, res)) return;

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

    return res.end(audio);

  } catch (error) {
    console.error(
      'Narration endpoint error:',
      error.message
    );

    return json(res, error.status || 502, {
      error: error.status && error.status < 500
        ? error.message
        : 'Narration generation failed',
      ...(error.upstream_status
        ? { upstream_status: error.upstream_status }
        : {})
    });
  }
}

// -------------------------------------------
// EXISTING PIXABAY SEARCH ENDPOINT
// GET /api/footage/search?q=space
// -------------------------------------------

async function footageSearchEndpoint(req, res, url) {
  if (!requireAuth(req, res)) return;

  const query = (
    url.searchParams.get('q') || ''
  ).trim();

  if (!query || query.length > 100) {
    return json(res, 400, {
      error:
        'Search query must contain 1-100 characters'
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
    console.error(
      'Footage search error:',
      error.message
    );

    return json(res, error.status || 502, {
      error: error.status === 429
        ? 'Pixabay rate limit reached'
        : 'Unable to search stock footage',
      ...(error.upstream_status
        ? { upstream_status: error.upstream_status }
        : {})
    });
  }
}

// -------------------------------------------
// NEW: COMPLETE MP4 GENERATOR
// POST /api/video/generate
// -------------------------------------------

async function generateVideoEndpoint(req, res) {
  if (!requireAuth(req, res)) return;

  if (videoJobRunning) {
    return json(res, 429, {
      error:
        'Another video is being generated. Please try again shortly.'
    });
  }

  if (!req.headers['content-type']
    ?.toLowerCase()
    .startsWith('application/json')) {
    return json(res, 415, {
      error: 'Content-Type must be application/json'
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
      error:
        `script must contain 1-${MAX_VIDEO_SCRIPT_CHARS} characters`
    });
  }

  if (
    typeof topic !== 'string' ||
    !topic.trim() ||
    topic.length > 100
  ) {
    return json(res, 400, {
      error:
        'topic must contain 1-100 characters'
    });
  }

  videoJobRunning = true;

  let tempDir;

  try {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'faceless-')
    );

    const audioPath = path.join(
      tempDir,
      'narration.mp3'
    );

    const footagePath = path.join(
      tempDir,
      'footage.mp4'
    );

    const outputPath = path.join(
      tempDir,
      'final-video.mp4'
    );

    console.log(
      'Video job started:',
      randomUUID()
    );

    // Step 1: Generate narration
    const audio = await createNarration(
      script.trim()
    );

    await fs.writeFile(audioPath, audio);

    // Step 2: Find footage
    const search = await findPixabayVideos(
      topic.trim()
    );

    const matchingVideos = search.videos.filter(
      (video) => video.video_url
    );

    if (!matchingVideos.length) {
      return json(res, 404, {
        error:
          'No stock footage found for this topic'
      });
    }

    // Step 3: Download first matching clip
    await downloadStockVideo(
      matchingVideos[0].video_url,
      footagePath
    );

    // Step 4: Get narration duration
    const duration = await getAudioDuration(
      audioPath
    );

    if (duration > 60) {
      return json(res, 400, {
        error:
          'Narration exceeds the 60-second test limit'
      });
    }

    // Step 5: Render video
    await renderVideo({
      footagePath,
      audioPath,
      outputPath,
      duration
    });

    // Step 6: Return MP4
    const video = await fs.readFile(
      outputPath
    );

    if (!video.length) {
      throw new Error(
        'Generated video is empty'
      );
    }

    console.log(
      'Video generated:',
      video.length,
      'bytes'
    );

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Disposition':
        'attachment; filename="faceless-studio-video.mp4"',
      'Content-Length': video.length,
      'Cache-Control': 'no-store'
    });

    return res.end(video);

  } catch (error) {
    console.error(
      'Video generation error:',
      error.message
    );

    if (res.headersSent) {
      return res.destroy(error);
    }

    const status =
      error.status ||
      (error.name === 'TimeoutError' ? 504 : 502);

    return json(res, status, {
      error: error.status && error.status < 500
        ? error.message
        : 'Video generation failed',
      ...(error.upstream_status
        ? { upstream_status: error.upstream_status }
        : {})
    });

  } finally {
    if (tempDir) {
      try {
        await fs.rm(tempDir, {
          recursive: true,
          force: true
        });
      } catch (error) {
        console.error(
          'Temporary cleanup failed:',
          error.message
        );
      }
    }

    videoJobRunning = false;
  }
}

// -------------------------------------------
// MAIN HTTP SERVER
// -------------------------------------------

const server = http.createServer(
  async (req, res) => {
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

    // FFmpeg check
    if (
      req.method === 'GET' &&
      url.pathname === '/ffmpeg-status'
    ) {
      return execFile(
        'ffmpeg',
        ['-version'],
        { timeout: 5000 },
        (err, stdout) => {
          return json(
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

    // ElevenLabs narration
    if (url.pathname === '/api/narration') {
      if (req.method !== 'POST') {
        return json(res, 405, {
          error: 'Use POST'
        });
      }

      return narrationEndpoint(req, res);
    }

    // Pixabay footage search
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

    // New MP4 generation endpoint
    if (url.pathname === '/api/video/generate') {
      if (req.method !== 'POST') {
        return json(res, 405, {
          error: 'Use POST'
        });
      }

      return generateVideoEndpoint(
        req,
        res
      );
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
