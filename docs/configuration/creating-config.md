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

You will be asked a series of questions to create an initial configuration, which will be saved to `/enigma-bbs-install-path/config/config.hjson`. This will also produce `config/<bbsName>-menu.hjson` and `config/<bbsName>-prompt.hjson` files (where `<bbsName>` is replaced by the name you provided in the steps above). See [Menu HJSON](menu-hjson.md) and [Prompt HJSON](prompt-hjson.md) for more information.

