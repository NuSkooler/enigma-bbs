---
layout: page
title: Web Server
---
ENiGMA½ comes with a built in *content server* for supporting both HTTP and HTTPS. Currently the [File Bases](../modding/file-base-web-download-manager.md) registers routes for file downloads, password reset email links are handled via the server, and static files can also be served for your BBS. Other features will likely come in the future or you can easily write your own!

# Configuration

By default the web server is not enabled. To enable it, you will need to at a minimum configure two keys in the `contentServers.web` section of `config.hjson`:

```js
contentServers: {
    web: {
        domain: bbs.yourdomain.com

        http: {
            enabled: true
            port: 8080
        }
    }
}
```

The following is a table of all configuration keys available under `contentServers.web`:

| Key | Required | Description |
|------|----------|-------------|
| `domain` | :+1: | Sets the domain, e.g. `bbs.yourdomain.com`. |
| `http` | :-1: | Sub configuration for HTTP (non-secure) connections. See **HTTP Configuration** below. |
| `overrideUrlPrefix` | :-1: | Instructs the system to be explicit when handing out URLs. Useful if your server is behind a transparent proxy. |

### HTTP Configuration

Entries available under `contentServers.web.http`:

| Key | Required | Description |
|------|----------|-------------|
| `enable` | :+1: | Set to `true` to enable this server.
| `port` | :-1: | Override the default port of `8080`. |
| `address` | :-1: | Sets an explicit bind address. |

### HTTPS Configuration

Entries available under `contentServers.web.https`:

| Key | Required | Description |
|------|----------|-------------|
| `enable` | :+1: | Set to `true` to enable this server.
| `port` | :-1: | Override the default port of `8080`. |
| `address` | :-1: | Sets an explicit bind address. |
| `certPem` | :+1: | Overrides the default certificate path of `/config/https_cert.pem`. Certificate must be in PEM format. See **Certificates** below. |
| `keyPem` | :+1: | Overrides the default certificate key path of `/config/https_cert_key.pem`. Key must be in PEM format. See **Certificates** below. |

#### Certificates

If you don't have a TLS certificate for your domain, a good source for a certificate can be [Let's Encrypt](https://letsencrypt.org/) who supplies free and trusted TLS certificates. A common strategy is to place another web server such as [Caddy](https://caddyserver.com/) in front of ENiGMA½ acting as a transparent proxy and TLS termination point.

> :information_source: Keep in mind that the SSL certificate provided by Let's Encrypt's Certbot is by default stored in a privileged location; if your ENIGMA instance is not running as root (which it should not be!), you'll need to copy the SSL certificate somewhere else in order for ENIGMA to use it.

## Static Routes
Static files live relative to the `contentServers.web.staticRoot` path which defaults to `enigma-bbs/www`. This is also commonly known as your "public root".

## Custom Error Pages
Customized error pages can be created for [HTTP error codes](https://en.wikipedia.org/wiki/List_of_HTTP_status_codes#4xx_Client_Error) by providing a `<error_code>.html` file in the *static routes* area. For example: `404.html`.

## Message Area Web API

The Message Area Web API provides read-only access to public message areas and their messages in JSON format. This API is automatically available when the web server is enabled.

### Endpoints

All endpoints return JSON data with appropriate HTTP status codes.

#### List Conferences
```
GET /api/v1/message-areas/conferences
```

Returns a list of all available message conferences.

**Response:**
```json
{
  "conferences": [
    {
      "confTag": "local",
      "name": "Local",
      "desc": "Local message areas",
      "sort": 1,
      "areaCount": 5
    },
    {
      "confTag": "fsx_net", 
      "name": "fsxNet",
      "desc": "fsxNet message areas",
      "sort": 2,
      "areaCount": 12
    }
  ]
}
```

#### List Areas in Conference
```
GET /api/v1/message-areas/conferences/:confTag/areas
```

Returns all public message areas within a specific conference.

**Response:**
```json
{
  "conference": {
    "confTag": "local",
    "name": "Local",
    "desc": "Local message areas"
  },
  "areas": [
    {
      "areaTag": "general",
      "confTag": "local",
      "name": "General Discussion",
      "desc": "General discussion area",
      "sort": 1
    },
    {
      "areaTag": "bbs_dev",
      "confTag": "local", 
      "name": "BBS Development",
      "desc": "Discussion about BBS development",
      "sort": 2
    }
  ]
}
```

#### List Messages in Area
```
GET /api/v1/message-areas/areas/:areaTag/messages?page=1&limit=20&include_replies=false
```

Returns a paginated list of messages in the specified area.

**Query Parameters:**
- `page` (optional): Page number, defaults to 1
- `limit` (optional): Messages per page, defaults to 50, maximum 200  
- `order` (optional): `ascending` or `descending` (default)
- `include_replies` (optional): `true` to include reply lists, `false` (default) for better performance

**Response:**
```json
{
  "area": {
    "areaTag": "general",
    "confTag": "local", 
    "name": "General",
    "desc": "General chit-chat"
  },
  "pagination": {
    "page": 1,
    "limit": 20,
    "hasMore": false,
    "total": null
  },
  "messages": [
    {
      "messageId": 123,
      "messageUuid": "12345678-1234-1234-1234-123456789abc",
      "subject": "Hello World",
      "fromUserName": "admin", 
      "toUserName": "All",
      "modTimestamp": "2023-01-01T12:00:00.000Z",
      "replyToMsgId": null,
      "replies": [
        {
          "messageId": 124,
          "messageUuid": "87654321-4321-4321-4321-cba987654321",
          "subject": "Re: Hello World",
          "fromUserName": "user1",
          "toUserName": "admin", 
          "modTimestamp": "2023-01-01T12:30:00.000Z"
        }
      ]
    }
  ]
}
```

**Note:** The `replies` array is only included when `include_replies=true`. For performance, the default behavior excludes replies.

#### Get Message Details
```
GET /api/v1/message-areas/messages/:messageUuid
```

Returns the full content of a specific message by UUID.

**Response:**
```json
{
  "message": {
    "messageId": 123,
    "messageUuid": "12345678-1234-1234-1234-123456789abc",
    "areaTag": "general",
    "subject": "Hello World",
    "fromUserName": "admin",
    "toUserName": "All", 
    "modTimestamp": "2023-01-01T12:00:00.000Z",
    "replyToMsgId": null,
    "message": "Welcome to the message area!",
    "meta": {},
    "replies": [
      {
        "messageId": 124,
        "messageUuid": "87654321-4321-4321-4321-cba987654321",
        "subject": "Re: Hello World",
        "fromUserName": "user1",
        "toUserName": "admin",
        "modTimestamp": "2023-01-01T12:30:00.000Z"
      }
    ]
  },
  "area": {
    "areaTag": "general",
    "confTag": "local",
    "name": "General",
    "desc": "General chit-chat"
  }
}
```

### Error Responses

The API returns appropriate HTTP status codes and error messages:

- `404 Not Found` - Conference, area, or message not found
- `403 Forbidden` - Attempting to access a private area
- `500 Internal Server Error` - Server error

Error response format:
```json
{
  "error": true,
  "message": "Conference not found"
}
```

### Security Notes

- The API is read-only and does not require authentication
- Private message areas are automatically filtered out
- The API respects the existing access control system (ACS)
- CORS is enabled to allow browser-based access

### Message Area API Configuration

The Message Area Web API can be enabled/disabled and configured via additional configuration options:

```hjson
contentServers: {
    web: {
        // Enable/disable the message area API (defaults to true when web server is enabled)
        messageAreaApi: true

        // Control which conferences and areas are exposed through the API
        exposedConfAreas: {
            local: {
                include: [ "*" ]        // all areas in 'local' conference
                exclude: [ "private*" ] // except those starting with 'private'
            }
            another_sample_conf: {
                include: [ "general", "help" ]  // only specific areas
            }
        }
    }
}
```

#### API Configuration Options

- `messageAreaApi`: Set to `false` to disable the API entirely. Defaults to `true` when the web server is enabled.

- `exposedConfAreas`: Controls which conferences and areas are accessible through the API. If not specified, all non-private conferences and areas are exposed.

  - **Conference Level**: Only conferences listed in `exposedConfAreas` will be accessible
  - **Area Level**: For each conference, you can specify:
    - `include`: Array of area patterns to include (supports wildcards with `*`)
    - `exclude`: Array of area patterns to exclude (supports wildcards with `*`)
  
  Pattern matching is case-insensitive and supports wildcards:
  - `"*"` matches all areas
  - `"general"` matches exactly "general"
  - `"private*"` matches any area starting with "private"

### Example Usage

Using curl:
```bash
# List all conferences
curl http://your-bbs.com:8080/api/v1/message-areas/conferences

# List areas in the local conference
curl http://your-bbs.com:8080/api/v1/message-areas/conferences/local/areas

# Get messages in the general area
curl http://your-bbs.com:8080/api/v1/message-areas/areas/general/messages?page=1&limit=10

# Get a specific message
curl http://your-bbs.com:8080/api/v1/message-areas/messages/5c88b10e-d211-4e5e-8b5e-6a2a3c7d1f89
```

Using JavaScript:
```javascript
// Fetch conferences
fetch('http://your-bbs.com:8080/api/v1/message-areas/conferences')
  .then(response => response.json())
  .then(data => {
    console.log('Conferences:', data.conferences);
  });

// Fetch messages with pagination
fetch('http://your-bbs.com:8080/api/v1/message-areas/areas/general/messages?page=2&limit=20')
  .then(response => response.json())
  .then(data => {
    console.log('Messages:', data.messages);
    console.log('Has more pages:', data.pagination.hasMore);
  });
```
