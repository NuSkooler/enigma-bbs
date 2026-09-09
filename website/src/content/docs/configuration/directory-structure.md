---
layout: page
title: Directory Structure
---
All paths mentioned here are relative to the ENiGMA½ checkout directory.

| Directory           | Description                                                                                               |
|---------------------|-----------------------------------------------------------------------------------------------------------|
| `/art/general`      | Non-theme art - welcome ANSI, logoff ANSI, etc. See [General Art](../art/general.md).
| `/art/themes`       | Theme art. Themes should be in their own subdirectory and contain a theme.hjson. See [Themes](../art/themes.md).
| `/config`           | [config.hjson](config-hjson.md) system configuration.
| `/config/menus`     | [menu.hjson](menu-hjson.md) storage.
| `/config/security`  | SSL certificates and public/private keys.
| `/db`               | All ENiGMA½ databases in SQLite3 format.
| `/docs`             | These docs ;-)
| `/dropfiles`        | Dropfiles created for [local doors](../modding/local-doors.md)
| `/logs`             | Logs. See [Monitoring Logs](../troubleshooting/monitoring-logs.md)
| `/misc`             | Stuff with no other home; reset password templates, common password lists, other random bits
| `/mods`             | User mods. See [Modding](../modding/existing-mods.md)
| `/node_modules`     | External libraries required by ENiGMA½, installed when you run `npm install`
| `/util`             | Various tools used in running/debugging ENiGMA½
| `/www`              | ENiGMA½'s built in webserver root directory
