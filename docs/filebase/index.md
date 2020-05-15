---
layout: page
title: About File Areas
---
## About File Areas

### A Different Approach
ENiGMA½ has strayed away from the old familiar setup here and instead takes a more modern approach:
* [Gazelle](https://whatcd.github.io/Gazelle/) inspired system for searching & browsing files.
* No conferences (just areas!)
* File areas are still around but should *generally* be used less. Instead, files can have one or more tags. Think things like `dos.retro`, `pc.warez`, `games`, etc.

### Other bells and whistles
* Temporary web (http:// or https://) download links in additional to standard X/Y/Z protocol support. Batch downloads of many files can be downloaded as a single ZIP archive.
* Users can rate files & search/filter by ratings.
* Users can also create and save their own filters for later use such as "Latest Artscene Releases" or "C64 SIDs".
* A given area can span one to many physical storage locations.
* Upload processor can extract and use `FILE_ID.DIZ`/`DESC.SDI`, for standard descriptions as well as `README.TXT`, `*.NFO`, and so on for longer descriptions. The processor also attempts release year estimation by scanning aforementioned description file(s).
* Fast indexed [Full Text Search (FTS)](https://sqlite.org/fts3.html) across descriptions and filenames.
* Duplicates are checked for by cryptographically secure [SHA-256](https://en.wikipedia.org/wiki/SHA-2) hashes.
* Support for many archive and file formats. External utilities can easily be added to the configuration to extend for additional formats.
* Much, much more!

### Modding
The default ENiGMA½ approach for file areas may not be for everyone. Remember that you can mod everything your setup! Some inspirational examples:
* A more traditional set of areas and scrolling file listings.
* An S/X style integration of message areas and file areas.
* Something completely different! Some tweaks are possible without any code while others may require creating new JavaScript modules to use instead of the defaults.
