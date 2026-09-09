---
layout: page
title: Monitoring Logs
---
## Monitoring Logs
ENiGMA½ does not produce much to stdout. Logs are produced by [Bunyan](https://github.com/trentm/node-bunyan) which outputs each entry as a JSON object.

Start by installing bunyan and making it available on your path:

```bash
npm install bunyan -g
```

or via Yarn:
```bash
yarn global add bunyan
```

To tail logs in a colorized and pretty format, issue the following command:
```bash
tail -F /path/to/enigma-bbs/logs/enigma-bbs.log | bunyan
```

See `bunyan --help` for more information on what you can do!

### Example
Logs _without_ Bunyan:
```bash
tail -F /path/to/enigma-bbs/logs/enigma-bbs.log
{"name":"ENiGMA½ BBS","hostname":"nu-dev","pid":25002,"level":30,"eventName":"updateFileAreaStats","action":{"type":"method","location":"core/file_base_area.js","what":"updateAreaStatsScheduledEvent","args":[]},"reason":"Schedule","msg":"Executing scheduled event action...","time":"2018-12-15T16:00:00.001Z","v":0}
{"name":"ENiGMA½ BBS","hostname":"nu-dev","pid":25002,"level":30,"module":"FTN BSO","msg":"Performing scheduled message import/toss...","time":"2018-12-15T16:00:00.002Z","v":0}
{"name":"ENiGMA½ BBS","hostname":"nu-dev","pid":25002,"level":30,"module":"FTN BSO","msg":"Performing scheduled message import/toss...","time":"2018-12-15T16:30:00.008Z","v":0}
```

Oof!

Logs _with_ Bunyan:
```bash
tail -F /path/to/enigma-bbs/logs/enigma-bbs.log | bunyan
[2018-12-15T16:00:00.001Z]  INFO: ENiGMA½ BBS/25002 on nu-dev: Executing scheduled event action... (eventName=updateFileAreaStats, reason=Schedule)
    action: {
      "type": "method",
      "location": "core/file_base_area.js",
      "what": "updateAreaStatsScheduledEvent",
      "args": []
    }
[2018-12-15T16:00:00.002Z]  INFO: ENiGMA½ BBS/25002 on nu-dev: Performing scheduled message import/toss... (module="FTN BSO")
[2018-12-15T16:30:00.008Z]  INFO: ENiGMA½ BBS/25002 on nu-dev: Performing scheduled message import/toss... (module="FTN BSO")
```

Much better!

