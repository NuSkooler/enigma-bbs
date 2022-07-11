---
layout: page
title: File Base Download Manager
---
## File Base Download Manager Module
The `file_base_download_manager` module provides a download queue manager for "legacy" (X/Y/Z-Modem, etc.) downloads. Web (HTTP/HTTPS) download functionality can be optionally available when the web content server is enabled.

## Configuration
### Configuration Block
Available `config` block entries:
* `webDlExpireTimeFormat`: Sets the moment.js style format for web download expiration date/time.
* `fileTransferProtocolSelection`: Overrides the default `fileTransferProtocolSelection` target for a protocol selection menu.
* `emptyQueueMenu`: Overrides the default `fileBaseDownloadManagerEmptyQueue` target for menu to show when the users D/L queue is empty.

### Theming
The following `itemFormat` object is provided to MCI 1 (ie: `%VM1`) and MCI 10+ custom fields:
* `fileId`: File ID.
* `areaTag`: Area tag.
* `fileName`: Entry filename.
* `path`: Full file path.
* `byteSize`: Size in bytes of file.
* `webDlLink`: Web download link including [VTX style ANSI ESC sequences](https://raw.githubusercontent.com/codewar65/VTX_ClientServer/master/vtx.txt).
* `webDlExpire`: Expiration date/time for this link. Formatted using `webDlExpireTimeFormat`.