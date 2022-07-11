const paths = require('path');

module.exports = () => {
    return {
        general: {
            boardName: 'Another Fine ENiGMA½ BBS',
            prettyBoardName: '|08A|07nother |07F|08ine |07E|08NiGMA|07½ B|08BS',
            telnetHostname: '',
            sshHostname: '',
            website: 'https://enigma-bbs.github.io',
            description: 'An ENiGMA½ BBS',

            //  :TODO: closedSystem prob belongs under users{}?
            closedSystem: false, //  is the system closed to new users?

            menuFile: 'menu.hjson', //  'oputil.js config new' will set this appropriately in config.hjson; may be full path
            achievementFile: 'achievements.hjson',
        },

        term: {
            // checkUtf8Encoding requires the use of cursor position reports, which are not supported on all terminals.
            // Using this with a terminal that does not support cursor position reports results in a 2 second delay
            // during the connect process, but provides better autoconfiguration of utf-8
            checkUtf8Encoding: true,

            // Checking the ANSI home position also requires the use of cursor position reports, which are not
            // supported on all terminals. Using this with a terminal that does not support cursor position reports
            // results in a 3 second delay during the connect process, but works around positioning problems with
            // non-standard terminals.
            checkAnsiHomePosition: true,

            // List of terms that should be assumed to use cp437 encoding
            cp437TermList: [
                'ansi',
                'pcansi',
                'pc-ansi',
                'ansi-bbs',
                'qansi',
                'scoansi',
                'syncterm',
                'ansi-256color',
                'ansi-256color-rgb',
            ],
            // List of terms that should be assumed to use utf8 encoding
            utf8TermList: [
                'xterm',
                'linux',
                'screen',
                'dumb',
                'rxvt',
                'konsole',
                'gnome',
                'x11 terminal emulator',
            ],
        },

        users: {
            usernameMin: 2,
            usernameMax: 16, //  Note that FidoNet wants 36 max
            usernamePattern: '^[A-Za-z0-9~!@#$%^&*()\\-\\_+ .]+$',

            passwordMin: 6,
            passwordMax: 128,

            //
            //  The bad password list is a text file containing a password per line.
            //  Entries in this list are not allowed to be used on the system as they
            //  are known to be too common.
            //
            //  A great resource can be found at https://github.com/danielmiessler/SecLists
            //
            //  Current list source: https://raw.githubusercontent.com/danielmiessler/SecLists/master/Passwords/probable-v2-top12000.txt
            //
            badPassFile: paths.join(__dirname, '../misc/bad_passwords.txt'),

            realNameMax: 32,
            locationMax: 32,
            affilsMax: 32,
            emailMax: 255,
            webMax: 255,

            requireActivation: false, //  require SysOp activation? false = auto-activate

            groups: ['users', 'sysops'], //  built in groups
            defaultGroups: ['users'], //  default groups new users belong to

            newUserNames: ['new', 'apply'], //  Names reserved for applying

            badUserNames: [
                'sysop',
                'admin',
                'administrator',
                'root',
                'all',
                'areamgr',
                'filemgr',
                'filefix',
                'areafix',
                'allfix',
                'server',
                'client',
                'notme',
            ],

            preAuthIdleLogoutSeconds: 60 * 3, //  3m
            idleLogoutSeconds: 60 * 6, //  6m

            failedLogin: {
                disconnect: 3, //  0=disabled
                lockAccount: 9, //  0=disabled; Mark user status as "locked" if >= N
                autoUnlockMinutes: 60 * 6, //  0=disabled; Auto unlock after N minutes.
            },
            unlockAtEmailPwReset: true, //  if true, password reset via email will unlock locked accounts

            twoFactorAuth: {
                method: 'googleAuth',

                otp: {
                    registerEmailText: paths.join(
                        __dirname,
                        '../misc/otp_register_email.template.txt'
                    ),
                    registerEmailHtml: paths.join(
                        __dirname,
                        '../misc/otp_register_email.template.html'
                    ),
                    registerPageTemplate: paths.join(
                        __dirname,
                        '../www/otp_register.template.html'
                    ),
                },
            },
        },

        theme: {
            default: 'luciano_blocktronics',
            preLogin: 'luciano_blocktronics',

            passwordChar: '*',
            dateFormat: {
                short: 'MM/DD/YYYY',
                long: 'ddd, MMMM Do, YYYY',
            },
            timeFormat: {
                short: 'h:mm a',
            },
            dateTimeFormat: {
                short: 'MM/DD/YYYY h:mm a',
                long: 'ddd, MMMM Do, YYYY, h:mm a',
            },
        },

        menus: {
            cls: true, //  Clear screen before each menu by default?
        },

        paths: {
            config: paths.join(__dirname, './../config/'),
            security: paths.join(__dirname, './../config/security'), //  certs, keys, etc.
            mods: paths.join(__dirname, './../mods/'),
            loginServers: paths.join(__dirname, './servers/login/'),
            contentServers: paths.join(__dirname, './servers/content/'),
            chatServers: paths.join(__dirname, './servers/chat/'),

            scannerTossers: paths.join(__dirname, './scanner_tossers/'),
            mailers: paths.join(__dirname, './mailers/'),

            art: paths.join(__dirname, './../art/general/'),
            themes: paths.join(__dirname, './../art/themes/'),
            logs: paths.join(__dirname, './../logs/'),
            db: paths.join(__dirname, './../db/'),
            modsDb: paths.join(__dirname, './../db/mods/'),
            dropFiles: paths.join(__dirname, './../drop/'), //  + "/node<x>/
            misc: paths.join(__dirname, './../misc/'),
        },

        loginServers: {
            telnet: {
                port: 8888,
                enabled: true,
                firstMenu: 'telnetConnected',
            },
            ssh: {
                port: 8889,
                enabled: false, //  default to false as PK/pass in config.hjson are required
                //
                //  To enable SSH, perform the following steps:
                //
                //  1 - Generate a Private Key (PK):
                //  Currently ENiGMA 1/2 requires a PKCS#1 PEM formatted PK.
                //  To generate a secure PK, issue the following command:
                //
                //  > openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
                //      -pkeyopt rsa_keygen_pubexp:65537 | openssl rsa \
                //      -out ./config/security/ssh_private_key.pem -aes128
                //
                //  (The above is a more modern equivalent of the following):
                //  > openssl genrsa -aes128 -out ./config/security/ssh_private_key.pem 2048
                //
                //  2 - Set 'privateKeyPass' to the password you used in step #1
                //
                //  3 - Finally, set 'enabled' to 'true'
                //
                //  Additional reading:
                //  - https://blog.sleeplessbeastie.eu/2017/12/28/how-to-generate-private-key/
                //  - https://gist.github.com/briansmith/2ee42439923d8e65a266994d0f70180b
                //
                privateKeyPem: paths.join(
                    __dirname,
                    './../config/security/ssh_private_key.pem'
                ),
                firstMenu: 'sshConnected',
                firstMenuNewUser: 'sshConnectedNewUser',

                //
                //  SSH details that can affect security. Stronger ciphers are better for example,
                //  but terminals such as SyncTERM require KEX diffie-hellman-group14-sha1,
                //  cipher 3des-cbc, etc.
                //
                //  See https://github.com/mscdex/ssh2-streams for the full list of supported
                //  algorithms.
                //
                algorithms: {
                    kex: [
                        'ecdh-sha2-nistp256',
                        'ecdh-sha2-nistp384',
                        'ecdh-sha2-nistp521',
                        'diffie-hellman-group14-sha1',
                        'diffie-hellman-group1-sha1',
                        //  Group exchange not currnetly supported
                        //  'diffie-hellman-group-exchange-sha256',
                        //  'diffie-hellman-group-exchange-sha1',
                    ],
                    cipher: [
                        'aes128-ctr',
                        'aes192-ctr',
                        'aes256-ctr',
                        'aes128-gcm',
                        'aes128-gcm@openssh.com',
                        'aes256-gcm',
                        'aes256-gcm@openssh.com',
                        'aes256-cbc',
                        'aes192-cbc',
                        'aes128-cbc',
                        'blowfish-cbc',
                        '3des-cbc',
                        'arcfour256',
                        'arcfour128',
                        'cast128-cbc',
                        'arcfour',
                    ],
                    hmac: [
                        'hmac-sha2-256',
                        'hmac-sha2-512',
                        'hmac-sha1',
                        'hmac-md5',
                        'hmac-sha2-256-96',
                        'hmac-sha2-512-96',
                        'hmac-ripemd160',
                        'hmac-sha1-96',
                        'hmac-md5-96',
                    ],
                    //  note that we disable compression by default due to issues with many clients. YMMV.
                    compress: ['none'],
                },
            },
            webSocket: {
                ws: {
                    //  non-secure ws://
                    enabled: false,
                    port: 8810,
                },
                wss: {
                    //  secure ws://
                    //  must provide valid certPem and keyPem
                    enabled: false,
                    port: 8811,
                    certPem: paths.join(__dirname, './../config/https_cert.pem'),
                    keyPem: paths.join(__dirname, './../config/https_cert_key.pem'),
                },
            },
        },

        contentServers: {
            web: {
                domain: 'another-fine-enigma-bbs.org',

                staticRoot: paths.join(__dirname, './../www'),

                resetPassword: {
                    //
                    //  The following templates have these variables available to them:
                    //
                    //  * %BOARDNAME%       : Name of BBS
                    //  * %USERNAME%        : Username of whom to reset password
                    //  * %TOKEN%           : Reset token
                    //  * %RESET_URL%       : In case of email, the link to follow for reset. In case of landing page,
                    //                        URL to POST submit reset form.

                    //  templates for pw reset *email*
                    resetPassEmailText: paths.join(
                        __dirname,
                        '../misc/reset_password_email.template.txt'
                    ), //  plain text version
                    resetPassEmailHtml: paths.join(
                        __dirname,
                        '../misc/reset_password_email.template.html'
                    ), //  HTML version

                    //  tempalte for pw reset *landing page*
                    //
                    resetPageTemplate: paths.join(
                        __dirname,
                        './../www/reset_password.template.html'
                    ),
                },

                http: {
                    enabled: false,
                    port: 8080,
                },
                https: {
                    enabled: false,
                    port: 8443,
                    certPem: paths.join(__dirname, './../config/https_cert.pem'),
                    keyPem: paths.join(__dirname, './../config/https_cert_key.pem'),
                },
            },

            gopher: {
                enabled: false,
                port: 8070,
                publicHostname: 'another-fine-enigma-bbs.org',
                publicPort: 8070, //  adjust if behind NAT/etc.
                staticRoot: paths.join(__dirname, './../gopher'),

                //
                //  Set messageConferences{} to maps of confTag -> [ areaTag1, areaTag2, ... ]
                //  to export message confs/areas
                //
            },

            nntp: {
                //  internal caching of groups, message lists, etc.
                cache: {
                    maxItems: 200,
                    maxAge: 1000 * 30, //  30s
                },

                //
                //  Set publicMessageConferences{} to a map of confTag -> [ areaTag1, areaTag2, ... ]
                //  in order to export *public* conf/areas that are available to anonymous
                //  NNTP users. Other conf/areas: Standard ACS rules apply.
                //
                publicMessageConferences: {},

                nntp: {
                    enabled: false,
                    port: 8119,
                },

                nntps: {
                    enabled: false,
                    port: 8563,
                    certPem: paths.join(__dirname, './../config/nntps_cert.pem'),
                    keyPem: paths.join(__dirname, './../config/nntps_key.pem'),
                },
            },
        },

        chatServers: {
            mrc: {
                enabled: false,
                serverHostname: 'mrc.bottomlessabyss.net',
                serverPort: 5000,
                retryDelay: 10000,
                multiplexerPort: 5000,
            },
        },

        infoExtractUtils: {
            Exiftool2Desc: {
                cmd: `${__dirname}/../util/exiftool2desc.js`, //  ensure chmod +x
            },
            Exiftool: {
                cmd: 'exiftool',
                args: [
                    '-charset',
                    'utf8',
                    '{filePath}',
                    //  exclude the following:
                    '--directory',
                    '--filepermissions',
                    '--exiftoolversion',
                    '--filename',
                    '--filesize',
                    '--filemodifydate',
                    '--fileaccessdate',
                    '--fileinodechangedate',
                    '--createdate',
                    '--modifydate',
                    '--metadatadate',
                    '--xmptoolkit',
                ],
            },
            XDMS2Desc: {
                //  http://manpages.ubuntu.com/manpages/trusty/man1/xdms.1.html
                cmd: 'xdms',
                args: ['d', '{filePath}'],
            },
            XDMS2LongDesc: {
                //  http://manpages.ubuntu.com/manpages/trusty/man1/xdms.1.html
                cmd: 'xdms',
                args: ['f', '{filePath}'],
            },
        },

        fileTypes: {
            //
            //  File types explicitly known to the system. Here we can configure
            //  information extraction, archive treatment, etc.
            //
            //  MIME types can be found in mime-db: https://github.com/jshttp/mime-db
            //
            //  Resources for signature/magic bytes:
            //  * http://www.garykessler.net/library/file_sigs.html
            //
            //
            //  :TODO: text/x-ansi -> SAUCE extraction for .ans uploads
            //  :TODO: textual : bool -- if text, we can view.
            //  :TODO: asText : { cmd, args[] } -> viewable text

            //
            //  Audio
            //
            'audio/mpeg': {
                desc: 'MP3 Audio',
                shortDescUtil: 'Exiftool2Desc',
                longDescUtil: 'Exiftool',
            },
            'application/pdf': {
                desc: 'Adobe PDF',
                shortDescUtil: 'Exiftool2Desc',
                longDescUtil: 'Exiftool',
            },
            //
            //  Video
            //
            'video/mp4': {
                desc: 'MPEG Video',
                shortDescUtil: 'Exiftool2Desc',
                longDescUtil: 'Exiftool',
            },
            'video/x-matroska ': {
                desc: 'Matroska Video',
                shortDescUtil: 'Exiftool2Desc',
                longDescUtil: 'Exiftool',
            },
            'video/x-msvideo': {
                desc: 'Audio Video Interleave',
                shortDescUtil: 'Exiftool2Desc',
                longDescUtil: 'Exiftool',
            },
            //
            //  Images
            //
            'image/jpeg': {
                desc: 'JPEG Image',
                shortDescUtil: 'Exiftool2Desc',
                longDescUtil: 'Exiftool',
            },
            'image/png': {
                desc: 'Portable Network Graphic Image',
                shortDescUtil: 'Exiftool2Desc',
                longDescUtil: 'Exiftool',
            },
            'image/gif': {
                desc: 'Graphics Interchange Format Image',
                shortDescUtil: 'Exiftool2Desc',
                longDescUtil: 'Exiftool',
            },
            'image/webp': {
                desc: 'WebP Image',
                shortDescUtil: 'Exiftool2Desc',
                longDescUtil: 'Exiftool',
            },
            //
            //  Archives
            //
            'application/zip': {
                desc: 'ZIP Archive',
                sig: '504b0304',
                offset: 0,
                archiveHandler: 'InfoZip',
            },
            /*
            'application/x-cbr' : {
                desc            : 'Comic Book Archive',
                sig             : '504b0304',
            },
            */
            'application/x-arj': {
                desc: 'ARJ Archive',
                sig: '60ea',
                offset: 0,
                archiveHandler: 'Arj',
            },
            'application/x-rar-compressed': {
                desc: 'RAR Archive',
                sig: '526172211a07',
                offset: 0,
                archiveHandler: 'Rar',
            },
            'application/gzip': {
                desc: 'Gzip Archive',
                sig: '1f8b',
                offset: 0,
                archiveHandler: 'TarGz',
            },
            //  :TODO: application/x-bzip
            'application/x-bzip2': {
                desc: 'BZip2 Archive',
                sig: '425a68',
                offset: 0,
                archiveHandler: '7Zip',
            },
            'application/x-lzh-compressed': {
                desc: 'LHArc Archive',
                sig: '2d6c68',
                offset: 2,
                archiveHandler: 'Lha',
            },
            'application/x-lzx': {
                desc: 'LZX Archive',
                sig: '4c5a5800',
                offset: 0,
                archiveHandler: 'Lzx',
            },
            'application/x-7z-compressed': {
                desc: '7-Zip Archive',
                sig: '377abcaf271c',
                offset: 0,
                archiveHandler: '7Zip',
            },

            //
            //  Generics that need further mapping
            //
            'application/octet-stream': [
                {
                    desc: 'Amiga DISKMASHER',
                    sig: '444d5321', //  DMS!
                    ext: '.dms',
                    shortDescUtil: 'XDMS2Desc',
                    longDescUtil: 'XDMS2LongDesc',
                },
                {
                    desc: 'SIO2PC Atari Disk Image',
                    sig: '9602', //  16bit sum of "NICKATARI"
                    ext: '.atr',
                    archiveHandler: 'Atr',
                },
            ],
        },

        archives: {
            archivers: {
                '7Zip': {
                    //  p7zip package
                    compress: {
                        cmd: '7za',
                        args: ['a', '-tzip', '{archivePath}', '{fileList}'],
                    },
                    decompress: {
                        cmd: '7za',
                        args: ['e', '-y', '-o{extractPath}', '{archivePath}'], //  :TODO: should be 'x'?
                    },
                    list: {
                        cmd: '7za',
                        args: ['l', '{archivePath}'],
                        entryMatch:
                            '^[0-9]{4}-[0-9]{2}-[0-9]{2}\\s[0-9]{2}:[0-9]{2}:[0-9]{2}\\s[A-Za-z\\.]{5}\\s+([0-9]+)\\s+[0-9]+\\s+([^\\r\\n]+)$',
                    },
                    extract: {
                        cmd: '7za',
                        args: [
                            'e',
                            '-y',
                            '-o{extractPath}',
                            '{archivePath}',
                            '{fileList}',
                        ],
                    },
                },

                InfoZip: {
                    compress: {
                        cmd: 'zip',
                        args: ['{archivePath}', '{fileList}'],
                    },
                    decompress: {
                        cmd: 'unzip',
                        args: ['-n', '{archivePath}', '-d', '{extractPath}'],
                    },
                    list: {
                        cmd: 'unzip',
                        args: ['-l', '{archivePath}'],
                        //  Annoyingly, dates can be in YYYY-MM-DD or MM-DD-YYYY format
                        entryMatch:
                            '^\\s*([0-9]+)\\s+[0-9]{2,4}-[0-9]{2}-[0-9]{2,4}\\s+[0-9]{2}:[0-9]{2}\\s+([^\\r\\n]+)$',
                    },
                    extract: {
                        cmd: 'unzip',
                        args: [
                            '-n',
                            '{archivePath}',
                            '{fileList}',
                            '-d',
                            '{extractPath}',
                        ],
                    },
                },

                Lha: {
                    //
                    //  'lha' command can be obtained from:
                    //  * apt-get: lhasa
                    //
                    //  (compress not currently supported)
                    //
                    decompress: {
                        cmd: 'lha',
                        args: ['-efw={extractPath}', '{archivePath}'],
                    },
                    list: {
                        cmd: 'lha',
                        args: ['-l', '{archivePath}'],
                        entryMatch:
                            '^[\\[a-z\\]]+(?:\\s+[0-9]+\\s+[0-9]+|\\s+)([0-9]+)\\s+[0-9]{2}\\.[0-9]\\%\\s+[A-Za-z]{3}\\s+[0-9]{1,2}\\s+[0-9]{4}\\s+([^\\r\\n]+)$',
                    },
                    extract: {
                        cmd: 'lha',
                        args: ['-efw={extractPath}', '{archivePath}', '{fileList}'],
                    },
                },

                Lzx: {
                    //
                    //  'unlzx' command can be obtained from:
                    //  * Debian based: https://launchpad.net/~rzr/+archive/ubuntu/ppa/+build/2486127 (amd64/x86_64)
                    //  * RedHat: https://fedora.pkgs.org/28/rpm-sphere/unlzx-1.1-4.1.x86_64.rpm.html
                    //  * Source: http://xavprods.free.fr/lzx/
                    //
                    decompress: {
                        cmd: 'unlzx',
                        //  unzlx doesn't have a output dir option, but we'll cwd to the temp output dir first
                        args: ['-x', '{archivePath}'],
                    },
                    list: {
                        cmd: 'unlzx',
                        args: ['-v', '{archivePath}'],
                        entryMatch:
                            '^\\s+([0-9]+)\\s+[^\\s]+\\s+[0-9]{2}:[0-9]{2}:[0-9]{2}\\s+[0-9]{1,2}-[a-z]{3}-[0-9]{4}\\s+[a-z\\-]+\\s+\\"([^"]+)\\"$',
                    },
                },

                Arj: {
                    //
                    //  'arj' command can be obtained from:
                    //  * apt-get: arj
                    //
                    decompress: {
                        cmd: 'arj',
                        args: ['x', '{archivePath}', '{extractPath}'],
                    },
                    list: {
                        cmd: 'arj',
                        args: ['l', '{archivePath}'],
                        entryMatch:
                            '^([^\\s]+)\\s+([0-9]+)\\s+[0-9]+\\s[0-9\\.]+\\s+[0-9]{2}\\-[0-9]{2}\\-[0-9]{2}\\s[0-9]{2}\\:[0-9]{2}\\:[0-9]{2}\\s+(?:[^\\r\\n]+)$',
                        entryGroupOrder: {
                            //  defaults to { byteSize : 1, fileName : 2 }
                            fileName: 1,
                            byteSize: 2,
                        },
                    },
                    extract: {
                        cmd: 'arj',
                        args: ['e', '{archivePath}', '{extractPath}', '{fileList}'],
                    },
                },

                Rar: {
                    decompress: {
                        cmd: 'unrar',
                        args: ['x', '{archivePath}', '{extractPath}'],
                    },
                    list: {
                        cmd: 'unrar',
                        args: ['l', '{archivePath}'],
                        entryMatch:
                            '^\\s+[\\.A-Z]+\\s+([\\d]+)\\s{2}[0-9]{2,4}\\-[0-9]{2}\\-[0-9]{2}\\s[0-9]{2}\\:[0-9]{2}\\s{2}([^\\r\\n]+)$',
                    },
                    extract: {
                        cmd: 'unrar',
                        args: ['e', '{archivePath}', '{extractPath}', '{fileList}'],
                    },
                },

                TarGz: {
                    decompress: {
                        cmd: 'tar',
                        args: [
                            '-xf',
                            '{archivePath}',
                            '-C',
                            '{extractPath}',
                            '--strip-components=1',
                        ],
                    },
                    list: {
                        cmd: 'tar',
                        args: ['-tvf', '{archivePath}'],
                        entryMatch:
                            '^[drwx\\-]{10}\\s[A-Za-z0-9\\/]+\\s+([0-9]+)\\s[0-9]{4}\\-[0-9]{2}\\-[0-9]{2}\\s[0-9]{2}\\:[0-9]{2}\\s([^\\r\\n]+)$',
                    },
                    extract: {
                        cmd: 'tar',
                        args: [
                            '-xvf',
                            '{archivePath}',
                            '-C',
                            '{extractPath}',
                            '{fileList}',
                        ],
                    },
                },

                Atr: {
                    decompress: {
                        cmd: 'atr',
                        args: ['{archivePath}', 'x', '-a', '-o', '{extractPath}'],
                    },
                    list: {
                        cmd: 'atr',
                        args: ['{archivePath}', 'ls', '-la1'],
                        entryMatch:
                            '^[rwxs-]{5}\\s+([0-9]+)\\s\\([0-9\\s]+\\)\\s([^\\r\\n\\s]*)(?:[^\\r\\n]+)?$',
                    },
                    extract: {
                        cmd: 'atr',
                        //  note: -l converts Atari 0x9b line feeds to 0x0a; not ideal if we're dealing with a binary of course.
                        args: [
                            '{archivePath}',
                            'x',
                            '-a',
                            '-l',
                            '-o',
                            '{extractPath}',
                            '{fileList}',
                        ],
                    },
                },
            },
        },

        fileTransferProtocols: {
            //
            //  See http://www.synchro.net/docs/sexyz.txt for information on SEXYZ
            //
            zmodem8kSexyz: {
                name: 'ZModem 8k (SEXYZ)',
                type: 'external',
                sort: 1,
                external: {
                    //  :TODO: Look into shipping sexyz binaries or at least hosting them somewhere for common systems
                    //  Linux x86_64 binary: https://l33t.codes/outgoing/sexyz
                    sendCmd: 'sexyz',
                    sendArgs: ['-telnet', '-8', 'sz', '@{fileListPath}'],
                    recvCmd: 'sexyz',
                    recvArgs: ['-telnet', '-8', 'rz', '{uploadDir}'],
                    recvArgsNonBatch: ['-telnet', '-8', 'rz', '{fileName}'],
                },
            },

            xmodemSexyz: {
                name: 'XModem (SEXYZ)',
                type: 'external',
                sort: 3,
                external: {
                    sendCmd: 'sexyz',
                    sendArgs: ['-telnet', 'sX', '@{fileListPath}'],
                    recvCmd: 'sexyz',
                    recvArgsNonBatch: ['-telnet', 'rC', '{fileName}'],
                },
            },

            ymodemSexyz: {
                name: 'YModem (SEXYZ)',
                type: 'external',
                sort: 4,
                external: {
                    sendCmd: 'sexyz',
                    sendArgs: ['-telnet', 'sY', '@{fileListPath}'],
                    recvCmd: 'sexyz',
                    recvArgs: ['-telnet', 'ry', '{uploadDir}'],
                },
            },

            zmodem8kSz: {
                name: 'ZModem 8k',
                type: 'external',
                sort: 2,
                external: {
                    sendCmd: 'sz', //  Avail on Debian/Ubuntu based systems as the package "lrzsz"
                    sendArgs: [
                        //  :TODO: try -q
                        '--zmodem',
                        '--try-8k',
                        '--binary',
                        '--restricted',
                        '{filePaths}',
                    ],
                    recvCmd: 'rz', //  Avail on Debian/Ubuntu based systems as the package "lrzsz"
                    recvArgs: [
                        '--zmodem',
                        '--binary',
                        '--restricted',
                        '--keep-uppercase', //  dumps to CWD which is set to {uploadDir}
                    ],
                    processIACs: true, // escape/de-escape IACs (0xff)
                },
            },
        },

        messageAreaDefaults: {
            //
            //  The following can be override per-area as well
            //
            maxMessages: 1024, //  0 = unlimited
            maxAgeDays: 0, //  0 = unlimited
        },

        messageConferences: {
            system_internal: {
                name: 'System Internal',
                desc: 'Built in conference for private messages, bulletins, etc.',

                areas: {
                    private_mail: {
                        name: 'Private Mail',
                        desc: 'Private user to user mail/email',
                        maxExternalSentAgeDays: 30, //  max external "outbox" item age
                    },

                    local_bulletin: {
                        name: 'System Bulletins',
                        desc: 'Bulletin messages for all users',
                    },
                },
            },
        },

        scannerTossers: {
            ftn_bso: {
                paths: {
                    outbound: paths.join(__dirname, './../mail/ftn_out/'),
                    inbound: paths.join(__dirname, './../mail/ftn_in/'),
                    secInbound: paths.join(__dirname, './../mail/ftn_secin/'),
                    reject: paths.join(__dirname, './../mail/reject/'), //  bad pkt, bundles, TIC attachments that fail any check, etc.
                    //outboundNetMail   : paths.join(__dirname, './../mail/ftn_netmail_out/'),
                    //  set 'retain' to a valid path to keep good pkt files
                },

                //
                //  Packet and (ArcMail) bundle target sizes are just that: targets.
                //  Actual sizes may be slightly larger when we must place a full
                //  PKT contents *somewhere*
                //
                packetTargetByteSize: 512000, //  512k, before placing messages in a new pkt
                bundleTargetByteSize: 2048000, //  2M, before creating another archive
                packetMsgEncoding: 'utf8', //  default packet encoding. Override per node if desired.
                packetAnsiMsgEncoding: 'cp437', //  packet encoding for *ANSI ART* messages

                tic: {
                    secureInOnly: true, //  only bring in from secure inbound (|secInbound| path, password protected)
                    uploadBy: 'ENiGMA TIC', //  default upload by username (override @ network)
                    allowReplace: false, //  use "Replaces" TIC field
                    descPriority: 'diz', //  May be diz=.DIZ/etc., or tic=from TIC Ldesc
                },
            },
        },

        fileBase: {
            //  areas with an explicit |storageDir| will be stored relative to |areaStoragePrefix|:
            areaStoragePrefix: paths.join(__dirname, './../file_base/'),

            maxDescFileByteSize: 471859, //  ~1/4 MB
            maxDescLongFileByteSize: 524288, //  1/2 MB

            fileNamePatterns: {
                //  These are NOT case sensitive
                //  FILE_ID.DIZ - https://en.wikipedia.org/wiki/FILE_ID.DIZ
                //  Some groups include a FILE_ID.ANS. We try to use that over FILE_ID.DIZ if available.
                desc: [
                    '^.*FILE_ID.ANS$',
                    '^.*FILE_ID.DIZ$', //  eslint-disable-line no-useless-escape
                    '^.*DESC.SDI$', //  eslint-disable-line no-useless-escape
                    '^.*DESCRIPT.ION$', //  eslint-disable-line no-useless-escape
                    '^.*FILE.DES$', //  eslint-disable-line no-useless-escape
                    '^.*FILE.SDI$', //  eslint-disable-line no-useless-escape
                    '^.*DISK.ID$', //  eslint-disable-line no-useless-escape
                ],

                //  common README filename - https://en.wikipedia.org/wiki/README
                descLong: [
                    '^[^/]*.NFO$', //  eslint-disable-line no-useless-escape
                    '^.*README.1ST$', //  eslint-disable-line no-useless-escape
                    '^.*README.NOW$', //  eslint-disable-line no-useless-escape
                    '^.*README.TXT$', //  eslint-disable-line no-useless-escape
                    '^.*READ.ME$', //  eslint-disable-line no-useless-escape
                    '^.*README$', //  eslint-disable-line no-useless-escape
                    '^.*README.md$', //  eslint-disable-line no-useless-escape
                    '^RELEASE-INFO.ASC$', //  eslint-disable-line no-useless-escape
                ],
            },

            yearEstPatterns: [
                //
                //  Patterns should produce the year in the first submatch.
                //  The extracted year may be YY or YYYY
                //
                '\\b((?:[1-2][0-9][0-9]{2}))[\\-\\/\\.][0-3]?[0-9][\\-\\/\\.][0-3]?[0-9]\\b', //  yyyy-mm-dd, yyyy/mm/dd, ...
                '\\b[0-3]?[0-9][\\-\\/\\.][0-3]?[0-9][\\-\\/\\.]((?:[1-2][0-9][0-9]{2}))\\b', //  mm/dd/yyyy, mm.dd.yyyy, ...
                '\\b((?:[1789][0-9]))[\\-\\/\\.][0-3]?[0-9][\\-\\/\\.][0-3]?[0-9]\\b', //  yy-mm-dd, yy-mm-dd, ...
                '\\b[0-3]?[0-9][\\-\\/\\.][0-3]?[0-9][\\-\\/\\.]((?:[1789][0-9]))\\b', //  mm-dd-yy, mm/dd/yy, ...
                //'\\b((?:[1-2][0-9][0-9]{2}))[\\-\\/\\.][0-3]?[0-9][\\-\\/\\.][0-3]?[0-9]|[0-3]?[0-9][\\-\\/\\.][0-3]?[0-9][\\-\\/\\.]((?:[0-9]{2})?[0-9]{2})\\b', //  yyyy-mm-dd, m/d/yyyy, mm-dd-yyyy, etc.
                //"\\b('[1789][0-9])\\b",   //  eslint-disable-line quotes
                '\\b[0-3]?[0-9][\\-\\/\\.](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december)[\\-\\/\\.]((?:[0-9]{2})?[0-9]{2})\\b',
                '\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december),?\\s[0-9]+(?:st|nd|rd|th)?,?\\s((?:[0-9]{2})?[0-9]{2})\\b', //  November 29th, 1997
                '\\(((?:19|20)[0-9]{2})\\)', //  (19xx) or (20xx) -- with parens -- do this before 19xx 20xx such that this has priority
                '\\b((?:19|20)[0-9]{2})\\b', //  simple 19xx or 20xx with word boundaries
                "\\b'([17-9][0-9])\\b", //  '95, '17, ...
                //  :TODO: DD/MMM/YY, DD/MMMM/YY, DD/MMM/YYYY, etc.
            ],

            web: {
                path: '/f/',
                routePath: '/f/[a-zA-Z0-9]+$',
                expireMinutes: 1440, //  1 day
            },

            //
            //  File area storage location tag/value pairs.
            //  Non-absolute paths are relative to |areaStoragePrefix|.
            //
            storageTags: {
                sys_msg_attach: 'sys_msg_attach',
                sys_temp_download: 'sys_temp_download',
            },

            areas: {
                system_message_attachment: {
                    name: 'System Message Attachments',
                    desc: 'File attachments to messages',
                    storageTags: ['sys_msg_attach'],
                },

                system_temporary_download: {
                    name: 'System Temporary Downloads',
                    desc: 'Temporary downloadables',
                    storageTags: ['sys_temp_download'],
                },
            },
        },

        eventScheduler: {
            events: {
                dailyMaintenance: {
                    schedule: 'at 11:59pm',
                    action: '@method:core/misc_scheduled_events.js:dailyMaintenanceScheduledEvent',
                },
                trimMessageAreas: {
                    //  may optionally use [or ]@watch:/path/to/file
                    schedule: 'every 24 hours',

                    //  action:
                    //  - @method:path/to/module.js:theMethodName
                    //    (path is relative to ENiGMA base dir)
                    //
                    //  - @execute:/path/to/something/executable.sh
                    //
                    action: '@method:core/message_area.js:trimMessageAreasScheduledEvent',
                },

                nntpMaintenance: {
                    schedule: 'every 12 hours', //  should generally be < trimMessageAreas interval
                    action: '@method:core/servers/content/nntp.js:performMaintenanceTask',
                },

                updateFileAreaStats: {
                    schedule: 'every 1 hours',
                    action: '@method:core/file_base_area.js:updateAreaStatsScheduledEvent',
                },

                forgotPasswordMaintenance: {
                    schedule: 'every 24 hours',
                    action: '@method:core/web_password_reset.js:performMaintenanceTask',
                    args: ['24 hours'], //  items older than this will be removed
                },

                twoFactorRegisterTokenMaintenance: {
                    schedule: 'every 24 hours',
                    action: '@method:core/user_temp_token.js:temporaryTokenMaintenanceTask',
                    args: [
                        'auth_factor2_otp_register',
                        '24 hours', //  expire time
                    ],
                },

                //
                //  Enable the following entry in your config.hjson to periodically create/update
                //  DESCRIPT.ION files for your file base
                //
                /*
                updateDescriptIonFiles : {
                    schedule    : 'on the last day of the week',
                    action      : '@method:core/file_base_list_export.js:updateFileBaseDescFilesScheduledEvent',
                }
                */
            },
        },

        logging: {
            rotatingFile: {
                //  set to 'disabled' or false to disable
                type: 'rotating-file',
                fileName: 'enigma-bbs.log',
                period: '1d',
                count: 3,
                level: 'debug',
            },

            //  :TODO: syslog - https://github.com/mcavage/node-bunyan-syslog
        },

        debug: {
            assertsEnabled: false,
        },

        statLog: {
            systemEvents: {
                loginHistoryMax: -1, //  set to -1 for forever
            },
        },
    };
};
