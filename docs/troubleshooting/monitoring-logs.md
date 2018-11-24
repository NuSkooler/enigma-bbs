---
layout: page
title: Monitoring Logs
---
ENiGMA½ does not produce much to stdout. Logs are produced by Bunyan which outputs each entry as a JSON object. 

Start by installing bunyan and making it available on your path:

```bash
npm install bunyan -g
```

or with Yarn:
```bash
yarn global add bunyan
```
    
To tail logs in a colorized and pretty format, issue the following command:
```bash
tail -F /path/to/enigma-bbs/logs/enigma-bbs.log | bunyan
```

