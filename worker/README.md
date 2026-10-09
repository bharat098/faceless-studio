# Backend worker

This folder documents the separate Node.js/FFmpeg worker. It must run on a backend/container host; it cannot run on GitHub Pages.

Do not deploy until the worker has safe job claiming, authenticated requests, validation, error handling, and private/signed output delivery. Store environment variables in the host's secret settings, not in Git.
