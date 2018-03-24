---
layout: page
title: Windows Full Install
---
## Windows

ENiGMA½ will run on both 32bit and 64 bit Windows. If you want to run 16bit doors naively then you should use a 32 bit Windows.  


### Basic Instructions

1. Download and Install [Node.JS](https://nodejs.org/en/download/). 

	1. Upgrade NPM : At this time node comes with NPM 5.6 preinstalled. To upgrade to a newer version now or in the future on windows follow this method.

		`Run PowerShell as Administrator

		Set-ExecutionPolicy Unrestricted -Scope CurrentUser -Force
		npm install -g npm-windows-upgrade

		npm-windows-upgrade`
	 
		Note: Do not run npm i -g npm. Instead use npm-windows-upgrade to update npm going forward. 
		Also if you run the NodeJS installer, it will replace the node version.:


	2. Install [windows-build-tools for npm](https://www.npmjs.com/package/windows-build-tools)
		'npm install --global --production windows-build-tools'
		*This will also install python 2.7

2. Install [7zip](https://www.7-zip.org/download.html).

	*Add 7zip to your path so 7z can be called from the console

3. Install [Git](https://git-scm.com/downloads) and optionally [TortoiseGit](https://tortoisegit.org/download/). 

4. Clone Enigma - browse to the directory you want and run "git clone https://github.com/NuSkooler/enigma-bbs.git"
	Optionally use the tortoisegit gui by right clicking the directory and run git clone in the menu
    

5. Install ENiGMA½.
	1. In the enigma directory run 'npm install'
	2. Generate your initial configuration:
		'node .\oputil.js config new'
		Follow the prompts!
	3. Edit any configuration files
	4. Run ENiGMA½
		'node .\main.js'
	

6. Profit!
