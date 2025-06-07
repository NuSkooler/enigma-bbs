---
layout: page
title: Message Area Web API
---

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

### Configuration

The API is automatically enabled when the web server is configured. To disable the API, set `messageAreaApi` to `false` in your `config.hjson`:

```hjson
contentServers: {
    web: {
        // ... other web server config ...
        
        // Set to false to disable the message area API
        messageAreaApi: false
    }
}
```

By default, the API is enabled whenever the HTTP or HTTPS server is enabled. See [Web Server](../web-server.md) for web server setup.

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