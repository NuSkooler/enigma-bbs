---
layout: page
title: Web Server
---
ENiGMA½ comes with a built in *content server* for supporting both HTTP and HTTPS. Currently the 
[File Bases](file_base.md) registers routes for file downloads, and static files can also be served 
for your BBS. Other features will likely come in the future or you can easily write your own!

## Configuration
By default the web server is not enabled. To enable it, you will need to at a minimum configure two keys in 
the `contentServers::web` section of `config.hjson`:

```hjson
contentServers: {
	web: {
		domain: bbs.yourdomain.com

		http: {
			enabled: true
		}
	}
}
```

This will configure HTTP for port 8080 (override with `port`). To additionally enable HTTPS, you will need a 
PEM encoded SSL certificate and private key. [LetsEncrypt](https://letsencrypt.org/) supply free trusted 
certificates that work perfectly with ENiGMA½.

Once obtained, simply enable the HTTPS server:

```hjson
contentServers: {
	web: {
		domain: bbs.yourdomain.com
		// set 'overrideUrlPrefix' if for example, you use a transparent proxy in front of ENiGMA and need to be explicit about URLs the system hands out
		overrideUrlPrefix: https://bbs.yourdomain.com
		https: {
			enabled: true
			port: 8443
			certPem: /path/to/your/cert.pem
			keyPem: /path/to/your/cert_private_key.pem
		}
	}
}
```

If no certificate paths are supplied, ENiGMA½ will assume the defaults of `/config/https_cert.pem` and 
`/config/https_cert_key.pem` accordingly.

### Static Routes
Static files live relative to the `contentServers::web::staticRoot` path which defaults to `enigma-bbs/www`. 

### Custom Error Pages
Customized error pages can be created for [HTTP error codes](https://en.wikipedia.org/wiki/List_of_HTTP_status_codes#4xx_Client_Error) 
by providing a `<error_code>.html` file in the *static routes* area. For example: `404.html`.
