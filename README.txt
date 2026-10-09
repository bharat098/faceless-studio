Faceless Studio - ElevenLabs narration endpoint update

Upload ONLY worker/server.js into the existing GitHub worker folder, replacing the old server.js.
Do not upload the entire extracted folder at repository root.
No new dependencies or Dockerfile changes required.

Endpoint: POST /api/narration
Header: Authorization: Bearer <STUDIO_API_TOKEN>
Header: Content-Type: application/json
Body: {"script":"Your narration text"}
Success: audio/mpeg file download

Required Render private environment variables:
STUDIO_API_TOKEN
ELEVENLABS_API_KEY
ELEVENLABS_VOICE_ID

This is a server-only integration. It does not yet save audio to Cloudflare R2 or expose a public website UI.
