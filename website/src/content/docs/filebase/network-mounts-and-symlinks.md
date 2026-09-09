---
layout: page
title: Network Mounts & Symlinks
---
## Network Mounts & Symlinks
With many Bulletin Board Systems running on small headless boxes such as Raspberry Pis, it may not be practical to have all files you would like to make available in your file base. One solution to this is to utilize network mounts. Add in symbolic links to make things even easier!

### A Practical Example
The scenario: A Windows box containing a lot of files you'd like in your systems file base. The BBS itself is running on a Raspberry Pi with very limited space.

To solve this problem, we can perform the following steps:
  1. Create a network mount in `/mnt/windows_box_share`.
  2. Next, we can create a local file base area such as `/home/enigma/file_base`
  3. Within the file base directory above, create some symbolic links to areas within our share:
  ```
  cd /home/enigma/file_base
  ln -s /mnt/windows_box_share/some/long/annoying/path area1
  ```
  
What we've done here is make `/home/enigma/file_base/area1` point to the Windows share within some nested directories. Of course we could have just pointed directly to the `/mnt/windows_box_share` area, but using symbolic links has some advantages:
  * We can now set `/home/enigma/file_base` as our `areaStoragePrefix`. That is, the base path of all of our file base
  * Since we have `areaStoragePrefix` set, we can now make storage tags relative to that path. For example, `leet_files1: "area1/leet_files"
  
There are **many** ways one can achieve the mounts between various operating systems. See your distros documentation.