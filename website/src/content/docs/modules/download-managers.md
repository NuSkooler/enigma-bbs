---
title: File Base Download Managers
description: "The two download queue managers — legacy X/Y/ZModem transfers and temporary web links."
sidebar:
    order: 21
---
Users build a download queue while browsing the [file base](../filebase/index.md),
then hand it to one of two managers depending on how they want the files.

| Module | Handles | Menu it backs |
|--------|---------|---------------|
| `file_base_download_manager` | Legacy X/Y/ZModem transfers | `fileBaseDownloadManager` |
| `file_base_web_download_manager` | Temporary HTTP(S) links | `fileBaseWebDownloadManager` |

Web downloads are the practical option for larger files, where legacy protocols
often struggle, and a batch can be streamed as a single ZIP archive. They require
the [web server](../servers/contentservers/web-server.md) to be enabled — see
[Web Downloads](../filebase/index.md#web-downloads).

## Configuration

Both modules take a `config` block:

| Key | Available on | Description |
|-----|--------------|-------------|
| `webDlExpireTimeFormat` | both | [moment.js](https://momentjs.com) format for the web download expiration date/time |
| `emptyQueueMenu` | both | Overrides the default `fileBaseDownloadManagerEmptyQueue` menu shown when the queue is empty |
| `fileTransferProtocolSelection` | legacy only | Overrides the default `fileTransferProtocolSelection` target for the [protocol picker](file-transfer-protocol-select.md) |

## Theming

Both provide the same `itemFormat` object to MCI 1 (`%VM1`) and to custom range
MCI 10+ fields:

| Field | Description |
|-------|-------------|
| `fileId` | File ID |
| `areaTag` | Area tag |
| `fileName` | Entry filename |
| `path` | Full file path |
| `byteSize` | Size of the file in bytes |
| `webDlLink` | Web download link, including [VTX style ANSI ESC sequences](https://raw.githubusercontent.com/codewar65/VTX_ClientServer/master/vtx.txt) |
| `webDlExpire` | Expiration date/time for the link, formatted with `webDlExpireTimeFormat` |

`webDlLinkRaw` is additionally available on the web manager, carrying the same
link without the VTX escape sequences.

## See Also

* [File Transfer Protocol Select](file-transfer-protocol-select.md) — the picker shown before a legacy transfer
* [File Area List](file-area-list.md) — where users browse and queue files
