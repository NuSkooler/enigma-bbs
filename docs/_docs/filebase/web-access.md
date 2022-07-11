---
layout: page
title: Web Access
---
Temporary web HTTP(S) URLs can be used to download files using the built in web server. Temporary links
expire after `fileBase::web::expireMinutes` (default 24 hours). The full URL given to users is built
using `contentServers::web::domain` and will default to HTTPS (https://) if enabled with a fallback to
HTTP. The end result is users are given a temporary web link that may look something like this:
`https://xibalba.l33t.codes:44512/f/h7JK`

See [Web Server](../servers/web-server.md) for more information.
