---
layout: page
title: REST API
---
ENiGMA½ includes a built-in REST API served under `/_enig/api/v1/`. It exposes message bases, file areas, user profiles, and system information over JSON, enabling third-party clients, bots, and integrations to interact with your BBS programmatically.

The API requires the [Web Server](./web-server.md) to be enabled.

## Enabling the API

Add a `restApi` block inside `contentServers.web` in `config.hjson`:

```hjson
contentServers: {
    web: {
        restApi: {
            enabled: true
        }
    }
}
```

## Authentication

The API supports two authentication schemes. Both are accepted on the same `Authorization` header or dedicated header.

### JWT Bearer Tokens (interactive sessions)

Obtain a short-lived access token by posting credentials to `/auth/login`. The response includes a `Bearer` token valid for 15 minutes and an HttpOnly `refresh` cookie valid for 30 days.

```
POST /_enig/api/v1/auth/login
Content-Type: application/json

{ "username": "sysop", "password": "hunter2" }
```

Pass the access token on subsequent requests:

```
Authorization: Bearer <accessToken>
```

Refresh silently before the access token expires:

```
POST /_enig/api/v1/auth/refresh
```

Log out (revokes the refresh cookie):

```
POST /_enig/api/v1/auth/logout
```

### API Keys (automated / programmatic access)

API keys are long-lived tokens suitable for bots, scripts, and integrations. Generate them with `oputil`:

```bash
# Generate a read-only key for user "sysop"
./oputil.js rest api-key generate sysop --label "Discord bot" --scope read

# Generate a read+write key
./oputil.js rest api-key generate sysop --label "Upload bot" --scope read,write

# List all keys (optionally filter by user)
./oputil.js rest api-key list
./oputil.js rest api-key list sysop

# Revoke a key by its numeric ID
./oputil.js rest api-key revoke 3
```

Pass the key on requests via:

```
X-Enigma-API-Key: <rawKey>
```

Valid scope values are `read`, `write`, and `read,write`.

## Endpoints

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/login` | None | Exchange credentials for JWT access token + refresh cookie |
| `POST` | `/auth/refresh` | Refresh cookie | Rotate access token |
| `POST` | `/auth/logout` | Refresh cookie | Revoke refresh token |

### System

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/system/info` | Public¹ | Board name, version, node count |
| `GET` | `/system/nodes` | Required¹ | Active node list |
| `GET` | `/system/last-callers` | Public¹ | Recent login history |
| `GET` | `/system/stats` | Public¹ | Total user count |

### Messages

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/messages/conferences` | ACS | List accessible conferences |
| `GET` | `/messages/conferences/:confTag` | ACS | Conference detail + area list |
| `GET` | `/messages/areas/:areaTag` | ACS | Area detail |
| `GET` | `/messages/areas/:areaTag/messages` | ACS | Cursor-paginated message list |
| `POST` | `/messages/areas/:areaTag/messages` | ACS write | Post a message |
| `GET` | `/messages/:uuid` | ACS | Full message body + FTN metadata |
| `DELETE` | `/messages/:uuid` | Auth | Delete own message (or any, if sysop) |

ActivityPub internal areas and private mail are always blocked regardless of auth or ACS.

### Files

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/files/areas` | ACS | List accessible file areas |
| `GET` | `/files/areas/:areaTag` | ACS | Area detail |
| `GET` | `/files/areas/:areaTag/files` | ACS | Cursor-paginated file list |
| `POST` | `/files/areas/:areaTag` | ACS write | Upload a file (multipart/form-data) |
| `GET` | `/files/:fileId` | ACS | File metadata |
| `GET` | `/files/:fileId/download` | ACS | Stream file download |

### Users

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/users/me` | Required | Own profile |
| `PUT` | `/users/me` | Required | Update own profile |
| `GET` | `/users/:username` | Required | Public profile (extended view for sysops) |

## Public Access

By default all endpoints (except the explicitly public system endpoints) require authentication. You can expose message conferences and file areas to unauthenticated callers via the `publicAccess` configuration. **ACS still applies for authenticated users** — `publicAccess` only grants anonymous read access to specific areas.

```hjson
restApi: {
    enabled: true

    messages: {
        publicAccess: {
            // Expose all areas in the "local" conference except "private*" tags
            local: {
                include: ["*"]
                exclude: ["private*"]
            }
        }
    }

    files: {
        publicAccess: {
            // Expose the "local_flat" file area publicly
            local_flat: {
                include: ["*"]
            }
        }
    }
}
```

## CORS

Cross-Origin Resource Sharing headers are off by default. To allow browser-based clients:

```hjson
restApi: {
    enabled: true
    corsAllowedOrigins: ["https://my-bbs-frontend.example.com"]
}
```

Set to `["*"]` to allow any origin (suitable only for fully public read endpoints).

## stripAnsi Query Parameter

Text fields such as message bodies, file descriptions, and area descriptions may contain ANSI escape sequences. By default the API strips these before returning them. Pass `?stripAnsi=false` to receive raw ANSI-bearing content:

```
GET /_enig/api/v1/messages/areas/local_general/messages?stripAnsi=false
GET /_enig/api/v1/files/areas/local_flat/files?stripAnsi=false
```

Fields affected: `body`, `subject`, `desc`, `descLong`, and conference/area `desc`.

## Pagination

List endpoints return a standard pagination envelope:

```json
{
  "data": [ ... ],
  "pagination": {
    "next": "<opaque cursor string or null>"
  }
}
```

Pass the cursor as `?cursor=<value>` on the next request. Control page size with `?limit=N` (max 100, default 25).

## Error Responses

Errors follow [RFC 7807 Problem Details](https://www.rfc-editor.org/rfc/rfc7807):

```json
{
  "type": "/_enig/api/v1/errors/404",
  "title": "Not Found",
  "status": 404,
  "detail": "Area 'unknown_tag' not found"
}
```

## OpenAPI Specification

A full [OpenAPI 3.1 specification](https://github.com/NuSkooler/enigma-bbs/blob/master/docs/api/openapi.yaml) is included in the repository under `docs/api/openapi.yaml`. You can paste this into https://editor.swagger.io/ for example to view.

## Configuration Reference

All keys live under `contentServers.web.restApi` in `config.hjson`:

| Key | Required | Description |
|-----|----------|-------------|
| `enabled` | :+1: | Set to `true` to enable the REST API. |
| `corsAllowedOrigins` | :-1: | Array of allowed CORS origins. Default `[]` (no CORS headers). Use `["*"]` for open access. |
| `jwtSecret` | :-1: | Override the auto-generated JWT signing secret. Useful for multi-node setups sharing a secret. |
| `system.public.info` | :-1: | Make `GET /system/info` public. Default `true`. |
| `system.public.nodes` | :-1: | Make `GET /system/nodes` public. Default `false`. |
| `system.public.last-callers` | :-1: | Make `GET /system/last-callers` public. Default `true`. |
| `system.public.stats` | :-1: | Make `GET /system/stats` public. Default `true`. |
| `messages.publicAccess` | :-1: | Map of conference tags to `{ include, exclude }` glob arrays for anonymous read access. |
| `files.publicAccess` | :-1: | Map of area tags to `{ include, exclude }` glob arrays for anonymous read access. |

---

¹ Default visibility; override via `system.public.*` config keys.
