---
layout: page
title: Installation Under Windows
---
## Installation Under Windows

ENiGMA½ will run on both 32bit and 64bit Windows. If you want to run 16bit doors natively then you should use a 32bit Windows.

### Basic Instructions

1. Download and Install [Node.JS](https://nodejs.org/).

	1. Upgrade NPM : At this time node comes with NPM 5.6 preinstalled. To upgrade to a newer version now or in the future on windows follow this method. `*Run PowerShell as Administrator`

		`*Initial Install`
		```Powershell
		Set-ExecutionPolicy Unrestricted -Scope CurrentUser -Force
		npm install -g npm-windows-upgrade
		```
		`*Upgrade`
		```Powershell
		npm-windows-upgrade
		```

		Note: Do not run `npm i -g npm`. Instead use `npm-windows-upgrade` to update npm going forward.
		Also if you run the NodeJS installer, it will replace the node version.

	2. Install [windows-build-tools for npm](https://www.npmjs.com/package/windows-build-tools)
		`*This will also install python 2.7`
		```Powershell
		npm install --global --production windows-build-tools
		```


2. Install [7zip](https://www.7-zip.org/download.html).

	*Add 7zip to your path so `7z` can be called from the console
	1. Right click `This PC` and Select `Properties`
	2. Go to the `Advanced` Tab and click on `Environment Variables`
	3. Select `Path` under `System Variables` and click `Edit`
	4. Click `New` and paste the path to 7zip
	5. Close your console window and reopen. You can type `7z` to make sure it's working.

(Please see [Archivers](../configuration/archivers.md) for additional archive utilities!)

3. Install [Git](https://git-scm.com/downloads) and optionally [TortoiseGit](https://tortoisegit.org/download/).

4. Clone ENiGMA½ - browse to the directory you want and run
	```Powershell
	git clone "https://github.com/NuSkooler/enigma-bbs.git"
	```
	Optionally use the TortoiseGit by right clicking the directory and selecting `Git Clone`.


5. Install ENiGMA½.
	1. In the enigma directory run
	```Powershell
	npm install
	```
	2. Generate your initial configuration: `Follow the prompts!`
	```Powershell
		node .\oputil.js config new
	```
	3. Edit your configuration files in `enigma-bbs\config` with [Notepad++](https://notepad-plus-plus.org/download/) or [Visual Studio Code](https://code.visualstudio.com/Download)
	4. Run ENiGMA½
	```Powershell
		node .\main.js
	```


6. Look at [Production Installation](production.md) for maintaining ENiGMA½ when you are ready to go live.
