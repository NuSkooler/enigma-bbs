---
title: About File Areas
description: "How ENiGMA½'s tag-driven, full-text-indexed file base differs from a traditional conference layout."
sidebar:
    order: 1
---
## A Different Approach
ENiGMA½ has strayed away from the old familiar setup here and instead takes a more modern approach:
* [Gazelle](https://whatcd.github.io/Gazelle/) inspired system for searching & browsing files.
* No conferences (just areas!)
* File areas are still around but should *generally* be used less. Instead, files can have one or more tags. Think things like `dos.retro`, `pc.warez`, `games`, etc.

## Other bells and whistles
* Temporary web (http:// or https://) download links in addition to standard X/Y/Z protocol support. Batch downloads of many files can be downloaded as a single ZIP archive. See **Web Downloads** below.
* Users can rate files & search/filter by ratings.
* Users can also create and save their own filters for later use such as "Latest Artscene Releases" or "C64 SIDs".
* A given area can span one to many physical storage locations.
* Upload processor can extract and use `FILE_ID.DIZ`/`DESC.SDI`, for standard descriptions as well as `README.TXT`, `*.NFO`, and so on for longer descriptions. The processor also attempts release year estimation by scanning aforementioned description file(s).
* Fast indexed [Full Text Search (FTS)](https://sqlite.org/fts3.html) across descriptions and filenames.
* Duplicates are checked for by cryptographically secure [SHA-256](https://en.wikipedia.org/wiki/SHA-2) hashes.
* Support for many archive and file formats. External utilities can easily be added to the configuration to extend for additional formats.
* Much, much more!
* FidoNet file echo support — see [TIC Support](tic-support.md).

## Web Downloads

Alongside the legacy X/Y/ZModem protocols, files can be handed out as temporary
HTTP(S) links served by the built-in [web server](../servers/contentservers/web-server.md).
A link expires after `fileBase::web::expireMinutes` (24 hours by default), and the
URL is built from `contentServers::web::domain`, preferring HTTPS where it is
enabled and falling back to HTTP. Users end up with something like:

```
https://xibalba.vip:44512/f/h7JK
```

The queue users build these links from is the
[File Base Web Download Manager](../modules/download-managers.md).

## Modding
The default ENiGMA½ approach for file areas may not be for everyone. Remember that you can mod everything your setup! Some inspirational examples:
* A more traditional set of areas and scrolling file listings.
* An S/X style integration of message areas and file areas.
* Something completely different! Some tweaks are possible without any code while others may require creating new JavaScript modules to use instead of the defaults.
