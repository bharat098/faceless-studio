# Faceless Studio — starter scaffold

This is a safe starter repository for the Faceless Studio project. It is **not yet a fully deployed video-generation app**.

## Current plan
- GitHub Pages: static frontend only (no secrets or server-side rendering here).
- Supabase: authentication, database and job metadata.
- Cloudflare R2: generated MP4/audio/image storage.
- Backend worker: Node.js + FFmpeg, hosted separately.
- ElevenLabs: voice narration.
- Pixabay: stock media search.
- Scripts: manually entered for the first version; no OpenAI API billing required.

## Upload to GitHub
1. Extract this ZIP on your computer.
2. Open your repository: https://github.com/bharat098/faceless-studio
3. Select **Add file → Upload files**.
4. Drag the extracted files and folders (not the ZIP itself) into the upload area.
5. Commit the files to the `main` branch.

If the web upload UI doesn't accept folders, upload the files using GitHub Desktop instead.

## Important security rules
- Never commit `.env`, API keys, Supabase service-role keys, or R2 secret access keys.
- `worker/.env.example` contains placeholders only.
- The public frontend must never contain secret keys.
- Do not consider the app production-ready until authentication, job claiming, signed download URLs, rendering, and deployment are tested.

## Structure
- `web/`: frontend placeholder and setup notes
- `worker/`: backend worker placeholder and environment variable template
- `supabase/schema.sql`: database tables and row-level security starter
