---
layout: page
title: Waiting For Caller (WFC)
---
## The Waiting For Caller (WFC) Module
The `wfc.js` module provides a Waiting For Caller (WFC) type dashboard from a bygone era. ENiGMA½'s WFC can be accessed over secure connections for accounts with the proper ACS. See **Security** information.

## Security
The system allows any user with the proper security to access the WFC / system operator functionality. The security policy is enforced by ACS with the default of `SCAF2ID1GM[wfc]`, meaning the following are true:

1. Securely Connected (such as SSH or Secure WebSocket, but not Telnet)
2. Auth Factor 2+. That is, the user has 2FA enabled.
3. User ID of 1 (root/admin)
4. The user belongs to the `wfc` group.

To change the ACS required, specify a alternative `acs` in the `config` block. For example:
```hjson
mainMenuWaitingForCaller: {
    // ...
    config: {
        // initial +op over secure connection only
        acs: SCID1GM[sysops]
    }
}
```

:information_source: ENiGMA½ will enforce ACS of at least `SC` (secure connection)

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
    * `{totalUsers}`: Total users on the system.