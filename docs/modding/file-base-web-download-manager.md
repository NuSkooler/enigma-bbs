---
layout: page
title: File Base Web Download Manager
---
## File Base Web Download Manager Module
The `file_base_web_download_manager` module provides a download queue manager for web (HTTP/HTTPS) based downloads. This module relies on having the web server enabled at a minimum.

Web downloads can be a convienent way for users to download larger (100+ MiB) files where legacy protocols often have trouble. Additionally, batch downloads can be streamed to users in a single zip archive.

## Configuration
### Configuration Block
Available `config` block entries:
* `webDlExpireTimeFormat`: Sets the moment.js style format for web download expiration date/time.
* `emptyQueueMenu`: Overrides the default `fileBaseDownloadManagerEmptyQueue` target for menu to show when the users D/L queue is empty.

### Theming
The following `itemFormat` object is provided to MCI 1 (ie: `%VM1`) and custom range MCI 10+ custom fields:
* `fileId`: File ID.
* `areaTag`: Area tag.
* `fileName`: Entry filename.
* `path`: Full file path.
* `byteSize`: Size in bytes of file.
* `webDlLinkRaw`: Web download link.
* `webDlLink`: Web download link including [VTX style ANSI ESC sequences](https://raw.githubusercontent.com/codewar65/VTX_ClientServer/master/vtx.txt).
* `webDlExpire`: Expiration date/time for this link. Formatted using `webDlExpireTimeFormat`.

