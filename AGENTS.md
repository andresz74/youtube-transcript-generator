# Repository Guidelines

## Project Structure & Module Organization
- `index.js` is the main Express API server with all routes and Firestore integration.
- Helper modules live alongside it: `youtube.js`, `fabric-youtube.js`, and `logger.js`.
- Config and ops files: `.env` (local), `ecosystem.config.js` (PM2).
- Assets/docs: `README.md`, `documentation.md`, and diagrams (e.g., `ideas.excalidraw`).
- There are no dedicated test directories in this repo.

## Build, Test, and Development Commands
- `npm install` or `yarn install` installs dependencies.
- `npm start` runs the API server (`node index.js`).
- `npm run start-fabric` runs the alternate entry (`node fabric-youtube.js`).
- `npm test` currently exits with “no test specified”.
- `pm2 start ecosystem.config.js` runs the service via PM2 for long-lived deployments.

## Coding Style & Naming Conventions
- Use 2-space indentation and standard Node.js/CommonJS patterns (`require`, `module.exports`).
- Route handlers use Express conventions (`app.get`, `app.post`) with async/await.
- Prefer camelCase for variables and functions (`videoID`, `fetchTranscript`).
- Keep logging consistent via `logger` and `console` where already used.

## Testing Guidelines
- No testing framework is configured. If adding tests, document the runner and add scripts.
- If you introduce tests, place them under a new `tests/` directory and name files `*.test.js`.

## Commit & Pull Request Guidelines
- Commit history follows a conventional pattern: `feat: ...`, `fix: ...`, plus merge commits.
- Keep commits scoped to one change and use clear, action-oriented summaries.
- PRs should include a short description, linked issues (if any), and API endpoint examples when behavior changes.

## Security & Configuration Tips
- Never commit `firebaseServiceAccount.json`; keep it local and referenced in `index.js`.
- Populate `.env` with model endpoint URLs (e.g., `CHATGPT_VERCEL_URL`).
- Be cautious with request body size; the server allows large JSON payloads (`50mb`).
