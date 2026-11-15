# Theme Manager Server Plugin

Server-side storage backend for the SillyTavern Theme Manager extension.

Current version: **2.0.0**

Install this folder into:

```text
SillyTavern/plugins/theme-manager/
```

Routes are mounted by SillyTavern under:

```text
/api/plugins/theme-manager/
```

Endpoints:

- `GET /status`
- `GET /data`
- `PUT /data`
- `GET /avatars/state`
- `PUT /avatars/manifest` (dataset ID + revision CAS)
- `POST /images`
- `POST /images/batch-fetch`
- `GET /images/:name`
- `POST /gc`

Version 2 adds the Avatar Manager manifest/CAS backend and avatar-aware image cleanup. Image cleanup always performs a dry-run first in the UI, preserves every image referenced by Theme Manager data or the Avatar Manager manifest, keeps new unreferenced uploads for a 24-hour grace period, and rejects deletion if the confirmed candidate list changes.
