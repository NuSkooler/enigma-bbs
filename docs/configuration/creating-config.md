---
layout: page
title: Creating Initial Config Files
---
Configuration files in ENiGMA½ are simple UTF-8 encoded [HJSON](http://hjson.org/) files. HJSON is just like JSON but simplified and much more resilient to human error.

## Initial Configuration
Your initial configuration skeleton can be created using the `oputil.js` command line utility. From your enigma-bbs root directory:
```bash
./oputil.js config new
```

You will be asked a series of questions to create an initial configuration, which will be saved to `/enigma-bbs-install-path/config/config.hjson`. This will also produce menu files under `config/menus/`. See [Menu HJSON](menu-hjson.md) for more information.

