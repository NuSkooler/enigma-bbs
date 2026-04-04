---
layout: page
title: Troubleshooting WebSocket & VTX
---

Stuck getting WebSocket or the VTX client working? See the common problems below. You can also reach out by creating an [Issue](https://github.com/NuSkooler/enigma-bbs/issues) or starting a [Discussion](https://github.com/NuSkooler/enigma-bbs/discussions).

---

## Black Screen / No VTX Client Visible

***Symptom:***
Navigating to `vtx.html` shows only a black page. The browser console contains an error similar to:

```
Uncaught TypeError: n is not a function   vtxclient.js:4715
```
or
```
Cannot read properties of undefined
```

***Cause:***
A value in `vtxdata.js` is the wrong type for the version of VTX_ClientServer you downloaded. The most common culprit is `defCrsrAttr`.

***Solution:***
Ensure `defCrsrAttr` is an **array**, not a hex integer:

```javascript
// Wrong — causes the black screen crash:
defCrsrAttr: 0x0207,

// Correct:
defCrsrAttr: ['thick', 'horizontal'],
```

Cross-check your entire `vtxdata.js` against the working example in the [WebSocket setup guide](../servers/loginservers/websocket.md).

---

## Browser Refuses WebSocket Connection (Mixed Content)

***Symptom:***
The VTX page loads but immediately fails to connect. The browser console shows:

```
Mixed Content: The page at 'https://...' was loaded over HTTPS, but attempted
to connect to the insecure WebSocket endpoint 'ws://...'. This request has
been blocked.
```

***Cause:***
Browsers block plain `ws://` connections from pages served over HTTPS. This is a browser security policy and cannot be worked around from ENiGMA's side.

***Solution:***
Use a secure `wss://` WebSocket endpoint. See [Deployment Architectures](../servers/loginservers/websocket.md#deployment-architectures) for the two supported options (reverse proxy or direct TLS in ENiGMA).

If you are testing locally over plain HTTP, `ws://` is fine. For any public deployment where the VTX page is served over HTTPS, `wss://` is required.

---

## Connection Refused on WebSocket Port

***Symptom:***
The browser console shows:

```
WebSocket connection to 'wss://your-hostname:8811' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED
```

***Solutions to check in order:***

1. **ENiGMA was not restarted** after adding the `webSocket` block to `config.hjson`. Restart and check the logs for a line like:
   ```
   INFO: Listening for connections (server="WebSocket (secure)", port=8811)
   ```
   If that line is absent, the server did not start — look for an error above it in the log.

2. **Port not forwarded.** If ENiGMA is behind a router, port `8811` (or whichever port you configured) must be forwarded to the host running ENiGMA. See [Network Setup](../installation/network.md).

3. **Firewall blocking the port.** Check your host firewall (`ufw`, `iptables`, security groups, etc.) for the configured port.

4. **Wrong port in `vtxdata.js`.** The `wsConnect` value must match the port ENiGMA is actually listening on.

---

## Certificate / TLS Errors

***Symptom:***
The browser shows a certificate warning or the console shows:

```
WebSocket connection failed: ERR_CERT_AUTHORITY_INVALID
```
or ENiGMA logs show an error starting the `wss://` listener.

***Solutions:***

1. **Self-signed certificate.** Browsers reject self-signed certs for WebSocket connections just as they do for HTTPS. Use a certificate from a trusted CA — [Let's Encrypt](https://letsencrypt.org/) is free and widely trusted. Alternatively, use Option A (reverse proxy) so nginx/Caddy owns the certificate.

2. **Certificate not readable by ENiGMA.** Let's Encrypt writes certificates to `/etc/letsencrypt/` which is only readable by root. If ENiGMA does not run as root (it should not), copy the cert and key to a location the ENiGMA user can read, and update that copy when the cert renews (e.g. a `certbot` deploy hook).

3. **Wrong paths in config.** Double-check `certPem` and `keyPem` in the `wss` block point to the correct files. ENiGMA will fail to start the `wss://` listener if either path is wrong.

---

## `proxied: true` Not Working / Treated as Insecure

***Symptom:***
With `proxied: true` set and nginx forwarding connections, features that require a secure connection (such as 2FA/OTP registration) report that the connection is insecure.

***Solutions:***

1. **Missing `X-Forwarded-Proto` header.** ENiGMA trusts the proxy only when the connection carries `X-Forwarded-Proto: https`. Confirm your nginx config includes:
   ```nginx
   proxy_set_header X-Forwarded-Proto https;
   ```

2. **`proxied: true` set but no proxy in use.** If ENiGMA is exposed directly to the internet (not behind nginx/Caddy), do not set `proxied: true`. Use the `wss:` block directly instead.

---

## VTX Page Shows Splash but Immediately Disconnects

***Symptom:***
The VTX splash graphic appears briefly then the client disconnects or shows a connection error overlay.

***Solutions to check:***

1. **`wsConnect` points to wrong address or port.** Verify the value in `vtxdata.js` matches what ENiGMA is actually listening on and what is reachable from the browser.

2. **`wsProtocol` mismatch.** ENiGMA expects `telnet` sub-protocol negotiation. Ensure `vtxdata.js` has:
   ```javascript
   wsProtocol: 'telnet',
   wsDataType: 'arraybuffer',
   ```

3. **ENiGMA log errors.** Check ENiGMA's log at the time of the connection attempt for any errors during the WebSocket handshake or login sequence.
