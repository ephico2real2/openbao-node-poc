# frontend/

[← Project README](../README.md) · [Tutorial](../docs/TUTORIAL.md)

The dashboard: three static files the app serves (`STATIC_DIR`). There is no build step,
no framework, and nothing loaded from another site. A strict Content Security Policy
allows only this origin, and every value is written with `textContent`, never as HTML.

| File | What it is |
| --- | --- |
| `index.html` | The page: notes, **Secrets in memory**, the credential timeline, the Rotation lab, **Try to leak it**, **Security posture** and the application log |
| `app.js` | Calls the API and draws the page. The labs call `/api/demo/*`, which exist only in demo mode |
| `styles.css` | The look, shared with the notification console (the AWS stand-in's image copies it in) |

What each part of the page reads:

| Part of the page | API |
| --- | --- |
| Notes | `GET/POST /api/notes` |
| Secrets in memory (name, version, fingerprint; never the value) | `GET /api/secrets`, `POST /api/secrets/:alias/refresh` |
| Credential timeline | `GET /api/events` |
| Rotation lab | `POST /api/demo/rotate/:alias`, `POST /api/demo/drop-connections` |
| Try to leak it | `POST /api/demo/leak-test` |
| Security posture | `GET /api/security/checks` |
| Application log | `GET /api/logs` (the redacted ring buffer) |
| Header badges | `GET /api/config` |
