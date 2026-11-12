#  Log an existing user in while playing a RIPscrip terminal (#989).
#  Run: python3 term_client.py --walk walk_rip_login.py --user NAME --password PW
#       [--rip off|prompt|late] [--rip-nul]
#  With --rip late the version reply is sent in the middle of typing the user
#  name, long after the connect probes are done: the case where a late reply
#  must not end up in the login form. The walk fails (exit 1) unless the
#  login succeeds as NAME.
import sys


def walk(s, args):
    s.label = 'matrix'
    s.expect('apply'); s.settle(1)
    s.dump('matrix')
    s.label = 'login'
    s.send('\r', settle=1.5)
    s.dump('login')
    half = max(1, len(args.user) // 2)
    s.send(args.user[:half], settle=0.3)
    if args.rip == 'late':
        s.send_rip_reply()
        s.settle(0.5)
    s.send(args.user[half:], settle=0.5)
    typed = s.dump('login-typed')
    s.send('\r', settle=0.5)
    s.send(args.password + '\r')
    s.settle(3)
    after = s.dump('after-login')
    print(f'ripQueries={s.rip_queries} ripReplies={s.rip_replies}')
    if 'RIPSCRIP' in typed or 'RIPSCRIP' in after:
        print('FAIL: the RIP reply reached the screen')
        sys.exit(1)
    low = after.lower()
    if 'invalid' in low or 'incorrect' in low or 'failed' in low or 'login:' in low:
        print('FAIL: login did not succeed')
        sys.exit(1)
    print('OK: logged in')
