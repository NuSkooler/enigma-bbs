#  Walk the RIP starter (#989) as a RIPscrip caller.
#  Run: python3 term_client.py --rows 42 --rip prompt --walk walk_rip_starter.py \
#           --user NAME [--password PW] [--rip-nul] [--term RIP]
#  on an instance made with make_instance.js --rip. It presses the keys the
#  buttons send (one letter, no Enter): matrix, login, main, messages, a new
#  post, the message list, reading, back, who's online, last callers, change
#  area, new scan, back, goodbye. After each RIP screen it prints the RIP
#  command lines received for it. It exits 1 if a RIP screen is missing, a
#  button's key is not what the walk expects, or the buttons of a RIP screen
#  were not killed (!|1K) on leaving it.
import re
import sys

BUTTON = re.compile(r'^!\|1U.{8}00..<>(.*)<>(.*)$')


def walk(s, args):
    problems = []
    screens = []

    def rip_since(mark):
        return [line for _, line in s.rip_lines[mark:]]

    def clear_popups():
        #  an achievement (first post, say) interrupts with a pause of its own
        for _ in range(3):
            if 'ACHIEVEMENT' not in s.text():
                return
            s.send(' ')
            s.settle(2)

    def step(name, keys=None, settle=2.0):
        s.label = name
        if keys is not None:
            s.send(keys)
        s.settle(settle)
        clear_popups()
        return s.dump(name)

    def rip_screen(name, keys, expect, buttons, mark=None):
        if mark is None:
            mark = len(s.rip_lines)
        s.label = name
        if keys is not None:
            s.send(keys)
        s.settle(1.5)
        clear_popups()
        try:
            s.expect(expect, timeout=10)
        except TimeoutError as e:
            problems.append(f'{name}: {e}')
            return
        s.settle(1.5)
        s.dump(name)
        lines = rip_since(mark)
        print(f'--- {name}: {len(lines)} RIP command lines')
        for line in lines:
            print('   ', line)
        found = [BUTTON.match(l).groups() for l in lines if BUTTON.match(l)]
        keys_sent = [cmd for _, cmd in found]
        if keys_sent != buttons:
            problems.append(f'{name}: buttons send {keys_sent}, expected {buttons}')
        #  the previous screen's !|1K may come first
        own = lines[1:] if lines and lines[0] == '!|1K' else lines
        if not own or own[0] != '!|Y00000100':
            problems.append(f'{name}: first RIP command is not the font style')
        screens.append((name, len(s.rip_lines)))

    def killed_after(name):
        #  a !|1K must come after the screen's own commands
        for n, end in screens:
            if n == name:
                rest = [line for _, line in s.rip_lines[end:]]
                if '!|1K' not in rest:
                    problems.append(f'{name}: no !|1K after leaving it')
                return

    s.label = 'connect'
    rip_screen('rip-matrix', None, r'Welcome to', ['L', 'A', 'G'])

    step('login', 'L', 2)
    s.send(args.user + '\r', settle=0.5)
    rip_screen('rip-main', args.password + '\r', r'Logged in as', ['M', 'W', 'L', 'G'])
    killed_after('rip-matrix')

    rip_screen('rip-messages', 'M', r'Message area:', ['L', 'P', 'C', 'N', 'Q'])
    killed_after('rip-main')

    #  post, so that the list has something in it
    step('post-header', 'P', 2.5)
    s.send('\r', settle=0.5)                 # To: All
    step('post-subject', 'Posted from RIP\r', 1.5)
    step('post-body', 'Hello from the RIP starter walk.\r', 1.5)
    step('post-menu', '\x1b', 1.5)
    rip_screen('rip-messages-after-post', '\r', r'Message area:',
               ['L', 'P', 'C', 'N', 'Q'])
    killed_after('rip-messages')

    step('msg-list', 'L', 2.5)
    step('msg-read', '\r', 2.5)
    step('msg-list-back', '\x1b', 2)
    rip_screen('rip-messages-after-list', '\x1b', r'Message area:',
               ['L', 'P', 'C', 'N', 'Q'])

    step('change-area', 'C', 2.5)
    rip_screen('rip-messages-after-area', '\r', r'Message area:',
               ['L', 'P', 'C', 'N', 'Q'])

    mark = len(s.rip_lines)
    out = step('new-scan', 'N', 4)
    for i in range(4):
        if 'Message area:' in out:
            break
        out = step(f'new-scan-{i}', '\x1b', 2.5)
    rip_screen('rip-messages-after-scan', None, r'Message area:',
               ['L', 'P', 'C', 'N', 'Q'], mark=mark)

    rip_screen('rip-main-back', 'Q', r'Logged in as', ['M', 'W', 'L', 'G'])
    killed_after('rip-messages-after-scan')

    step('whos-online', 'W', 2.5)
    rip_screen('rip-main-after-who', ' ', r'Logged in as', ['M', 'W', 'L', 'G'])
    step('last-callers', 'L', 2.5)
    rip_screen('rip-main-after-callers', ' ', r'Logged in as', ['M', 'W', 'L', 'G'])

    step('goodbye', 'G', 2.5)
    killed_after('rip-main-after-callers')
    try:
        for i in range(4):
            step(f'logoff-{i}', 'Y' if i == 0 else ' ', 2.5)
    except EOFError:
        pass

    print(f'ripQueries={s.rip_queries} ripReplies={s.rip_replies}')
    if problems:
        print('FAIL:')
        for p in problems:
            print('  ', p)
        sys.exit(1)
    print('OK: RIP starter walk')
