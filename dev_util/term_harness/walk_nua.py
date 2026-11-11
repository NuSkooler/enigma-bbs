#  New user application at whatever size term_client.py was given.
#  Creates args.user / args.password (must not exist yet).
#  Run: python3 term_client.py --walk walk_nua.py --cols 40 --user NAME --password PW
def walk(s, args):
    s.label = 'matrix'
    s.expect('apply'); s.settle(1)
    s.dump('matrix')
    s.send('\x1b[B', settle=0.5)       #  down to "apply"
    s.label = 'nua-pre'
    s.send('\r'); s.settle(2); s.dump('nua-pre')
    s.label = 'nua-form'
    s.send(' '); s.settle(2); s.dump('nua-form')
    vals = [args.user, 'Harness Tester', '19800101', 'M', 'Testville', 'none',
            f'{args.user}@example.com', '', args.password, args.password]
    for v in vals:
        s.send(v, settle=0.3)
        s.send('\t', settle=0.3)
    s.settle(1)
    s.dump('nua-filled')
    s.label = 'nua-submit'
    s.send('\r'); s.settle(3); s.dump('nua-submit')
    for i in range(4):
        s.label = f'nua-after-{i}'
        s.send(' '); s.settle(2.5); s.dump(f'nua-after-{i}')
