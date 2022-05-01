---
layout: page
title: Waiting For Caller (WFC)
---
## The Waiting For Caller (WFC) Module
The `wfc.js` module provides a Waiting For Caller (WFC) type dashboard from a bygone era. ENiGMA½'s WFC can be accessed over secure connections for accounts with the proper ACS. See **Security** information.

## Security

## Theming
The following MCI codes are available:
* MCI 1 (`VM1`): Node status list with the following format items available:
    * `{text}`: Username or `*Pre Auth*`.
    * `{action}`: Current action/menu.
    * `{timeOn}`: How long the node has been connected.
* MCI 2 (`VM2`): Quick log with the following format keys available:
    * `{timestamp}`: Log entry timestamp in `quickLogTimestampFormat` format.
    * `{level}`: Log entry level from Bunyan.
    * `{levelIndicator}`: `T` for TRACE, `D` for DEBUG, `I` for INFO, `W` for WARN, `E` for ERROR, or `F` for FATAL.
    * `{nodeId}`: Node ID.
    * `{sessionId}`: Session ID.
    * `{message}`: Log message.
* MCI 10...99: Custom entries with the following format keys available:
    * `{nowDate}`: Current date in the `dateFormat` style, defaulting to `short`.
    * `{nowTime}`: Current time in the `timeFormat` style, defaulting to `short`.
    * `{now}`: Current date and/or time in `nowDateTimeFormat` format.
    * `{processUptimeSeconds}`: Process (the BBS) uptime in seconds.
    * `{totalCalls}`: Total calls to the system.
    * `{totalPosts}`: Total posts to the system.