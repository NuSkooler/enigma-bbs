#  Walk an existing user (args.user / args.password) through the main
#  screens of a stock ENiGMA config, dumping each screen.
#  Run: python3 term_client.py --walk walk_main.py --cols 40 --user NAME --password PW
#  The user must already exist (run walk_nua.py first on a fresh instance).
import time


def walk(s, args):
    def step(name, keys=None, settle=2.0):
        if keys is not None:
            s.label = name
            s.send(keys)
        s.settle(settle)
        #  achievement pop-ups interrupt whatever screen is next
        n = 0
        while 'ACHIEVEMENT' in s.text() and 'smash' in s.text() and n < 3:
            s.dump(f'{name}-achievement')
            s.send(' ')
            s.settle(settle)
            n += 1
        return s.dump(name)

    def maybe_pause(name):
        t = s.text().lower()
        if 'smash' in t or 'any key' in t or 'more' in t.split('\n')[-1]:
            step(name, ' ', 2)

    s.label = 'matrix'
    s.expect('apply'); s.settle(1)
    s.dump('matrix')
    step('login', '\r')
    s.send(args.user + '\r', settle=0.5)
    step('login-welcome', args.password + '\r', 3)
    step('last-callers', ' ', 2.5)
    step('whos-online', ' ', 2.5)
    step('onelinerz', ' ', 2.5)
    out = step('after-onelinerz', '\r', 3)
    #  zero or more pauses (new scan / stats) until the main menu prompt
    for i in range(6):
        t = s.text().lower()
        if 'newscan?' in t:
            out = step(f'pre-main-{i}', '\x1b[C\r', 2.5)   #  "no"
        elif 'smash' in t or 'press' in t or 'any key' in t:
            out = step(f'pre-main-{i}', ' ', 2.5)
        else:
            break
    step('main-menu', None, 0.5)

    #  message base
    step('msg-menu', 'M\r', 2)
    step('msg-area-list', 'C\r', 2)
    step('msg-area-selected', '\r', 2)
    step('fse-header', 'P\r', 2.5)
    s.send('\r', settle=0.5)               #  To: All (keep)
    step('fse-subject', 'Forty column test\r', 1.5)
    body = ('This is a long first line typed on a forty column terminal '
            'to see where the editor wraps it. ')
    step('fse-body', body + '\rSecond line.\r', 2)
    step('fse-footer-menu', '\x1b', 1.5)
    step('fse-saved', '\r', 3)             #  "save" is first
    maybe_pause('fse-after-save')
    step('msg-list', 'L\r', 2.5)
    step('msg-read', '\r', 2.5)
    step('msg-read-footer', '\x1b', 1.5)
    step('msg-list-back', '\x1b', 2)
    step('msg-menu-back', '\x1b', 2)
    step('main-from-msg', 'Q\r', 2)

    #  file base
    step('file-menu', 'F\r', 2)
    step('file-area-list', 'B\r', 2.5)
    step('file-area-back', '\x1b', 2)
    step('main-from-file', 'Q\r', 2)

    #  user config
    step('user-config', 'C\r', 2.5)
    step('user-config-back', '\x1b', 2)

    #  logoff
    step('logoff', 'G\r', 3)
    for i in range(3):
        try:
            step(f'logoff-{i}', '\r' if i == 0 else ' ', 2)
        except EOFError:
            print('connection closed after logoff')
            return
