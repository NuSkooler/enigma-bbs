---
layout: page
title: Installation Under Windows
---
## Installation Under Windows

ENiGMA½ will run on both 32bit and 64bit Windows. If you want to run 16bit doors natively then you should use a 32bit Windows.

### Prerequisites

#### Node.js

Download and install Node.js from [nodejs.org](https://nodejs.org/). Use the current **LTS release** — non-LTS/bleeding-edge versions are not tested and may cause issues.

#### Visual Studio Build Tools

ENiGMA½ includes native modules (`node-pty` and `sqlite3`) that must be compiled during installation. This requires Visual Studio Build Tools:

1. Download [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. Run the installer and select the **"Desktop development with C++"** workload
3. Ensure the following are included (selected by default with the workload):
   - MSVC build tools
   - Windows SDK
   - C++ CMake tools

> **Note:** Visual Studio Build Tools 2017 or newer is required. Older versions will not be detected by node-gyp.

#### Git

Install [Git](https://git-scm.com/downloads) and optionally [TortoiseGit](https://tortoisegit.org/download/).

#### 7-Zip

Install [7-Zip](https://www.7-zip.org/download.html) and add it to your `PATH`:

1. Right click `This PC` and select `Properties`
2. Go to the `Advanced` tab and click `Environment Variables`
3. Select `Path` under `System Variables` and click `Edit`
4. Click `New` and paste the path to 7-Zip (e.g. `C:\Program Files\7-Zip`)
5. Close and reopen your console — type `7z` to verify it works

(See [Archivers](../configuration/archivers.md) for additional archive utilities.)

---

### Installation

1. Clone ENiGMA½ — browse to the directory you want and run:
    ```powershell
    git clone "https://github.com/NuSkooler/enigma-bbs.git"
    ```
    Optionally use TortoiseGit by right clicking the directory and selecting `Git Clone`.

2. Install ENiGMA½:
    ```powershell
    cd enigma-bbs
    npm install
    ```

3. Generate your initial configuration:
    ```powershell
    node .\oputil.js config new
    ```

4. Edit your configuration files in `enigma-bbs\config` with [Notepad++](https://notepad-plus-plus.org/download/) or [Visual Studio Code](https://code.visualstudio.com/Download).

5. Run ENiGMA½:
    ```powershell
    node .\main.js
    ```

See [Production Installation](production.md) when you are ready to go live.

---

### Troubleshooting: node-gyp / Visual Studio Not Found

If `npm install` fails with an error like *"could not find a version of Visual Studio"* or *"unknown version found"*, node-gyp is not detecting your VS Build Tools installation. Try:

```powershell
npm config set msvs_version 2022
npm install
```

If problems persist, see the [node-gyp Windows installation guide](https://github.com/nodejs/node-gyp#on-windows) for further troubleshooting steps.
