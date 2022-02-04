---
layout: page
title: File Transfer Protocol Select
---
## The Rumorz Module
The built in `file_transfer_protocol_select` module provides a way to select a legacy file transfer protocol (X/Y/Z-Modem, etc.) for upload/downloads.

## Configuration

### Theming
The following `itemFormat` object is provided to MCI 1 (ie: `%VM1`) (the protocol list):
* `name`: The name of the protocol. Each entry is +op defined in `config.hjson` with defaults found in `config_default.js`. Note that the standard `{text}` field also contains this value.

