---
layout: page
title: oputil
---

oputil is the ENiGMA½ command line utility for maintaining users, file areas and message areas, as well as 
generating your initial ENiGMA½ config. 

## File areas
The `oputil.js` +op utilty `fb` command has tools for managing file bases. For example, to import existing 
files found within **all** storage locations tied to an area and set tags `tag1` and `tag2` to each import:

```bash
oputil.js fb scan some_area --tags tag1,tag2
```

See `oputil.js fb --help` for additional information.