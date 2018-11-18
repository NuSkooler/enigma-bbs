---
layout: page
title: File Transfer Protocol Select
---
## File Base Download Manager Module
The `file_base_download_manager` module provides a download queue manager for "legacy" (X/Y/Z-Modem, etc.) downloads.

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

