---
layout: page
title: Creating Initial Config Files
---
Configuration files in ENiGMA½ are simple UTF-8 encoded [HJSON](http://hjson.org/) files. HJSON is just 
like JSON but simplified and much more resilient to human error.

## config.hjson
Your initial configuration skeleton can be created using the `oputil.js` command line utility. From your 
enigma-bbs root directory:
```
./oputil.js config new
```

You will be asked a series of questions to create an initial configuration.

## menu.hjson and prompt.hjson

Create your own copy of `/config/menu.hjson` and `/config/prompt.hjson`, and specify it in the
`general` section of `config.hjson`:

````hjson
general: {
    menuFile: my-menu.hjson
    promptFile: my-prompt.hjson
}
````