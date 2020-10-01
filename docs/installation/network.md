---
layout: page
title: Network Setup
---
## Hosting an ENIGMA instance from your Home Network

If you are hosting your ENGIMA instance from inside your local network, you'll need to open your chosen ports on your router, so people outside your local area network can access the BBS.

Each router has a different way of doing this, but this [comprehensive resource](https://portforward.com/) explains how to port forward on most common brand routers.

Secondly, it is likely that your public facing server IP is a [Dynamic Address](https://support.opendns.com/hc/en-us/articles/227987827-What-is-a-Dynamic-IP-Address-) automatically provisoned to you by your ISP. You can contact your ISP and request a static IP, but in some areas this isn't available to consumers, only businesses.

Using a tool like [Duck DNS](https://www.duckdns.org/) will give you a free subdomain that automatically adjusts its records whenever your IP Address changes.