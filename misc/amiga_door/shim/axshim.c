/*
 * axshim.c - ENiGMA½ BBS's Amiga door host shim.
 *
 * Runs inside the emulated Amiga, impersonates an AmiExpress (/X) BBS node for
 * an XIM door and relays everything to ENiGMA over the serial line, using the
 * framed protocol in "ENiGMA <-> Amiga door shim protocol, version 1"
 * (vault: ENiGMA/Features/Amiga Door Emulation - Shim Protocol).
 *
 *   boot -> H -> R -> (s from the host) -> L -> door traffic, C, E/e -> X -> R ...
 *
 * Door terminal traffic is unframed in both directions; control messages are
 * 0x1E <type> <len_hi> <len_lo> <payload>, and a literal 0x1E in terminal
 * traffic travels as 0x1E 0x1E.
 *
 * The serial port is Paula's UART, driven directly (the AROS ROM has no
 * serial.device; the same code runs on Kickstart 3.1): 115200 8N1, receive on
 * the level 5 RBF vector into a ring, transmit from a ring on the level 1 TBE
 * vector.  Nothing busy-waits.
 *
 * Usage (S:Startup-Sequence): C:axshim [baud]
 *
 * Copyright (c) 2026, Bryan Ashby (NuSkooler)
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 *
 * SPDX-License-Identifier: BSD-2-Clause
 */
#include <exec/types.h>
#include <exec/ports.h>
#include <exec/memory.h>
#include <exec/interrupts.h>
#include <exec/execbase.h>
#include <hardware/custom.h>
#include <hardware/intbits.h>
#include <devices/timer.h>
#include <dos/dos.h>
#include <dos/dosextens.h>
#include <dos/dostags.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include <stdarg.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

#define SHIM_VERSION    "1.0"
#define PROTO_VERSION   1
static const char __attribute__((used)) verstag[] = "$VER: axshim " SHIM_VERSION " (16.10.2026)";

extern struct ExecBase *SysBase;

/* ---- JHMessage and command numbers (AmiExpress axcommon.e) ------------------------- */

struct JHMessage {
    struct Message msg;     /*   0 */
    char   String[200];     /*  20 */
    LONG   Data;            /* 220 */
    LONG   Command;         /* 224 */
    LONG   NodeID;          /* 228 */
    LONG   LineNum;         /* 232 */
    ULONG  signal;          /* 236 */
    struct Process *task;   /* 240; the /X 2.x message ended here (244 bytes) */
    LONG   Semi;            /* 244 */
    LONG   Filler1, Filler2;
    char  *strptr;          /* 256, only valid if mn_Length >= 264 */
    LONG   filler3;
};
#define JHM_FULL   264
#define JHM_SEMI   248      /* a message long enough to hold Semi */

enum {
    JH_LI = 0, JH_REGISTER = 1, JH_SHUTDOWN = 2, JH_WRITE = 3, JH_SM = 4, JH_PM = 5, JH_HK = 6,
    JH_SG = 7, JH_SF = 8, JH_EF = 9, JH_CO = 10, JH_BBSNAME = 11, JH_SYSOP = 12,
    JH_FLAGFILE = 13, JH_SHOWFLAGS = 14, JH_ExtHK = 15, JH_SIGBIT = 16, JH_FetchKey = 17,
    JH_SO = 18, JH_SMPTR = 19, JH_20 = 20,
    DT_NAME = 100, DT_PASSWORD = 101, DT_LOCATION = 102, DT_PHONENUMBER = 103,
    DT_SLOTNUMBER = 104, DT_SECSTATUS = 105, DT_SECBOARD = 106, DT_SECLIBRARY = 107,
    DT_SECBULLETIN = 108, DT_MESSAGESPOSTED = 109, DT_UPLOADS = 110, DT_DOWNLOADS = 111,
    DT_TIMESCALLED = 112, DT_TIMELASTON = 113, DT_TIMEUSED = 114, DT_TIMELIMIT = 115,
    DT_TIMETOTAL = 116, DT_BYTESUPLOAD = 117, DT_BYTEDOWNLOAD = 118, DT_DAILYBYTELIMIT = 119,
    DT_DAILYBYTEDLD = 120, DT_EXPERT = 121, DT_LINELENGTH = 122, ACTIVE_NODES = 123,
    DT_DUMP = 124, DT_TIMEOUT = 125, BB_CONFNAME = 126, BB_CONFLOCAL = 127, BB_LOCAL = 128,
    BB_MAINLINE = 131, RETURNCOMMAND = 136, ZMODEMSEND = 137, ZMODEMRECEIVE = 138,
    BB_CHATFLAG = 142, DT_STAMP_LASTON = 143, DT_STAMP_CTIME = 144, DT_CURR_TIME = 145,
    DT_CONFACCESS = 146, BB_NODEID = 149, BB_CALLERSLOG = 150, BB_UDLOG = 151,
    EXPRESS_VERSION = 152, ENVSTAT = 163, SV_NEWMSG = 177,
    GETKEY = 500, RAWARROW = 501, CHAIN = 502, NODE_DEVICE = 503, NODE_UNIT = 504,
    NODE_BAUD = 505, NODE_NUMBER = 506, JH_MCI = 507, BB_CONFNUM = 510, BB_DROPDTR = 511,
    BB_GETTASK = 512, NODE_BAUDRATE = 516, BB_LOGONTYPE = 517, BB_SCRWIDTH = 520,
    BB_SCRHEIGHT = 521, BB_NONSTOPTEXT = 525, BB_LINECOUNT = 526, DT_LANGUAGE = 527,
    DT_ANSICOLOR = 530, MULTICOM = 531, LOAD_ACCOUNT = 532, SAVE_ACCOUNT = 533,
    SEARCH_ACCOUNT = 537, APPEND_ACCOUNT = 538, MOD_TYPE = 540, DT_ISANSI = 541,
    BATCHZMODEMSEND = 542, SETMCIOFF = 551, DT_REALNAME = 606, QUICK_KEY = 608,
    CONF_ACCESS = 614, DISPLAY_FILE = 617, CHECK_TO_DISPLAY = 618, INTERPRET_MCI = 621,
    GET_XIMPORT = 622, EXT_LOAD_ACCOUNT = 633, DT_HOSTNAME = 700, DT_HOSTIP = 701,
    DT_ADDBIT = 1000, DT_REMBIT = 1001, DT_QUERYBIT = 1002
};

#define RS              0x1E
#define CARRIER_GRACE   30      /* seconds from `d` (or time-up) to X, whatever the door does */
#define EXIT_GRACE      2       /* seconds for the process to end after the last JH_SHUTDOWN */
#define REG_TIMEOUT     30      /* default seconds a door has to send JH_REGISTER */
#define LONGNAME        33      /* a path component this long is refused (AROS 20250219 hang) */

/* ---- Paula UART: receive ring (RBF) and transmit ring (TBE) --------------------------- */

#define CUSTOM      ((volatile struct Custom *)0xDFF000)
#define SERDATR_TBE (1 << 13)
#define PAULA_CLOCK 3546895UL   /* PAL colour clock; SERPER = clock / baud - 1, 8 data bits */
#define RXSIZE      4096        /* powers of two */
#define TXSIZE      4096

struct RxBuf {
    volatile UWORD head, tail;  /* head: written by the interrupt; tail: by the shim */
    volatile UBYTE stalled;     /* ring was full: RBF is off and the byte waits in SERDATR */
    struct Task   *task;
    ULONG          sigmask;
    UBYTE          buf[RXSIZE];
};

struct TxBuf {
    volatile UWORD head, tail;  /* head: written by the shim; tail: by the interrupt */
    volatile UBYTE active;      /* the TBE interrupt is enabled and will take the next byte */
    volatile UBYTE want;        /* the shim waits for room: signal it */
    struct Task   *task;
    ULONG          sigmask;
    UBYTE          buf[TXSIZE];
};

static struct RxBuf rx;
static struct TxBuf tx;
static struct Interrupt rbf_int, tbe_int, *old_rbf, *old_tbe;
static BYTE rx_sig = -1, tx_sig = -1;
static BOOL tx_polled;          /* fallback: TBE never fired, poll SERDATR with Delay(1) */
static UWORD tx_last_tail;
static ULONG tx_stuck_ticks;

/* level 5 RBF handler (SetIntVector): a1 = is_Data.  A full ring stalls the port: the
 * byte stays unread in SERDATR, and the host's flow control holds the ones behind it. */
static void rbf_code(register struct RxBuf *b __asm("a1"))
{
    UWORD head = b->head, next = (head + 1) & (RXSIZE - 1);
    CUSTOM->intreq = INTF_RBF;          /* ack first: a byte landing after the read raises it anew */
    if (next == b->tail) {
        CUSTOM->intena = INTF_RBF;
        b->stalled = 1;
        return;
    }
    b->buf[head] = (UBYTE)CUSTOM->serdatr;
    b->head = next;
    if (head == b->tail) Signal(b->task, b->sigmask);      /* it was empty */
}

/* level 1 TBE handler: the transmit buffer moved into the shift register */
static void tbe_code(register struct TxBuf *t __asm("a1"))
{
    UWORD tail = t->tail;
    CUSTOM->intreq = INTF_TBE;
    if (tail != t->head) {
        CUSTOM->serdat = 0x100 | t->buf[tail];
        t->tail = tail = (tail + 1) & (TXSIZE - 1);
        if (t->want && ((t->head - tail) & (TXSIZE - 1)) < TXSIZE / 2) {
            t->want = 0;
            Signal(t->task, t->sigmask);
        }
    } else {
        CUSTOM->intena = INTF_TBE;      /* idle until the shim queues more */
        t->active = 0;
        if (t->want) { t->want = 0; Signal(t->task, t->sigmask); }
    }
}

static BOOL uart_open(ULONG baud)
{
    if ((rx_sig = AllocSignal(-1)) < 0 || (tx_sig = AllocSignal(-1)) < 0) return FALSE;
    rx.task = tx.task = FindTask(NULL);
    rx.sigmask = 1UL << rx_sig;
    tx.sigmask = 1UL << tx_sig;
    rbf_int.is_Node.ln_Type = tbe_int.is_Node.ln_Type = NT_INTERRUPT;
    rbf_int.is_Node.ln_Name = (char *)"axshim rbf";
    tbe_int.is_Node.ln_Name = (char *)"axshim tbe";
    rbf_int.is_Data = &rx;
    tbe_int.is_Data = &tx;
    rbf_int.is_Code = (void (*)(void))rbf_code;
    tbe_int.is_Code = (void (*)(void))tbe_code;
    CUSTOM->serper = (UWORD)(PAULA_CLOCK / baud - 1);
    Disable();
    old_rbf = SetIntVector(INTB_RBF, &rbf_int);
    old_tbe = SetIntVector(INTB_TBE, &tbe_int);
    (void)CUSTOM->serdatr;          /* release a byte that arrived before us (host flow control) */
    CUSTOM->intena = INTF_TBE;
    CUSTOM->intreq = INTF_RBF | INTF_TBE;
    CUSTOM->intena = INTF_SETCLR | INTF_RBF;
    Enable();
    return TRUE;
}

static void tx_kick(void)
{
    Disable();
    if (!tx.active && tx.head != tx.tail) {
        tx.active = 1;
        CUSTOM->intena = INTF_SETCLR | INTF_TBE;
        CUSTOM->intreq = INTF_SETCLR | INTF_TBE;    /* run the handler now */
    }
    Enable();
}

/* polled fallback: a short spin for the transmit buffer, then give the CPU away */
static void poll_put(UBYTE c)
{
    int spins = 0;
    while (!(CUSTOM->serdatr & SERDATR_TBE))
        if (++spins > 500) { Delay(1); spins = 0; }
    CUSTOM->serdat = 0x100 | c;
}

static void tx_go_polled(void)
{
    Disable();
    CUSTOM->intena = INTF_TBE;
    tx.active = 0;
    tx_polled = TRUE;
    Enable();
    while (tx.tail != tx.head) {
        poll_put(tx.buf[tx.tail]);
        tx.tail = (tx.tail + 1) & (TXSIZE - 1);
    }
}

/* called once a second: a ring that has not moved with the interrupt enabled means the
 * TBE vector never runs on this machine; switch to polling for good */
static void tx_check(void)
{
    if (tx_polled || tx.head == tx.tail) { tx_stuck_ticks = 0; tx_last_tail = tx.tail; return; }
    if (tx.tail != tx_last_tail) { tx_stuck_ticks = 0; tx_last_tail = tx.tail; return; }
    if (!tx.active) tx_kick();
    if (++tx_stuck_ticks >= 3) tx_go_polled();
}

static void pump(void);
static void timer_poll(void);
static ULONG timer_sigmask(void);

/* the ring is full: wait for the interrupt to make room, keep the receive side moving */
static void tx_wait(void)
{
    for (;;) {
        BOOL full;
        Disable();
        full = ((tx.head + 1) & (TXSIZE - 1)) == tx.tail;
        if (full) tx.want = 1;
        Enable();
        if (!full || tx_polled) return;
        tx_kick();
        Wait(tx.sigmask | rx.sigmask | timer_sigmask());
        timer_poll();
        pump();
    }
}

static void tx_put(UBYTE c)
{
    UWORD next;
    if (tx_polled) { poll_put(c); return; }
    for (;;) {
        next = (tx.head + 1) & (TXSIZE - 1);
        if (next != tx.tail) break;
        tx_wait();
        if (tx_polled) { poll_put(c); return; }
    }
    tx.buf[tx.head] = c;
    tx.head = next;
    if (!tx.active) tx_kick();
}

static void tx_drain(void)       /* before giving the port back */
{
    int i;
    for (i = 0; i < 250 && !tx_polled && tx.head != tx.tail; i++) { tx_kick(); Delay(1); }
}

static void uart_close(void)
{
    tx_drain();
    Disable();
    CUSTOM->intena = INTF_RBF | INTF_TBE;
    SetIntVector(INTB_RBF, old_rbf);
    SetIntVector(INTB_TBE, old_tbe);
    Enable();
    if (rx_sig >= 0) FreeSignal(rx_sig);
    if (tx_sig >= 0) FreeSignal(tx_sig);
}

static int rx_get(void)         /* -1 = nothing buffered */
{
    UBYTE c;
    if (rx.tail == rx.head) return -1;
    c = rx.buf[rx.tail];
    rx.tail = (rx.tail + 1) & (RXSIZE - 1);
    if (rx.stalled) {           /* room again: take the waiting byte */
        Disable();
        rx.stalled = 0;
        CUSTOM->intreq = INTF_SETCLR | INTF_RBF;
        CUSTOM->intena = INTF_SETCLR | INTF_RBF;
        Enable();
    }
    return c;
}

/* ---- timer: a one-second tick ------------------------------------------------------- */

static struct MsgPort *tport;
static struct timerequest *treq;
static BOOL timer_busy;
static volatile ULONG now_s;     /* seconds since the shim started */

static ULONG timer_sigmask(void) { return 1UL << tport->mp_SigBit; }

static BOOL timer_open(void)
{
    if (!(tport = CreateMsgPort())) return FALSE;
    if (!(treq = (struct timerequest *)CreateIORequest(tport, sizeof(struct timerequest)))) return FALSE;
    if (OpenDevice((STRPTR)TIMERNAME, UNIT_VBLANK, (struct IORequest *)treq, 0)) {
        treq->tr_node.io_Device = NULL;
        return FALSE;
    }
    return TRUE;
}

static void timer_arm(void)
{
    if (timer_busy) return;
    treq->tr_node.io_Command = TR_ADDREQUEST;
    treq->tr_time.tv_secs = 1;
    treq->tr_time.tv_micro = 0;
    SendIO((struct IORequest *)treq);
    timer_busy = TRUE;
}

static void timer_poll(void)
{
    if (timer_busy && CheckIO((struct IORequest *)treq)) {
        WaitIO((struct IORequest *)treq);
        timer_busy = FALSE;
        now_s++;
        timer_arm();
        tx_check();
    }
}

static void timer_close(void)
{
    if (treq) {
        if (timer_busy) { AbortIO((struct IORequest *)treq); WaitIO((struct IORequest *)treq); }
        if (treq->tr_node.io_Device) CloseDevice((struct IORequest *)treq);
        DeleteIORequest((struct IORequest *)treq);
    }
    if (tport) DeleteMsgPort(tport);
}

/* set the system clock (Amiga seconds since 1 Jan 1978); a restored snapshot's clock is stale */
static void set_clock(ULONG amiga_secs)
{
    struct MsgPort *p = CreateMsgPort();
    struct timerequest *r;
    if (!p) return;
    if ((r = (struct timerequest *)CreateIORequest(p, sizeof(struct timerequest)))) {
        if (!OpenDevice((STRPTR)TIMERNAME, UNIT_MICROHZ, (struct IORequest *)r, 0)) {
            r->tr_node.io_Command = TR_SETSYSTIME;
            r->tr_time.tv_secs = amiga_secs;
            r->tr_time.tv_micro = 0;
            DoIO((struct IORequest *)r);
            CloseDevice((struct IORequest *)r);
        }
        DeleteIORequest((struct IORequest *)r);
    }
    DeleteMsgPort(p);
}

/* ---- frames out ---------------------------------------------------------------------- */

#define FBUFSZ 2048
static char  fbuf[FBUFSZ];
static UWORD flen;
static UBYTE ftype;

static void f_begin(UBYTE type) { ftype = type; flen = 0; }

static void f_byte(UBYTE c) { if (flen < FBUFSZ) fbuf[flen++] = c; }

static void f_str(const char *s) { while (*s) f_byte((UBYTE)*s++); }

/* key=value; a value never carries a line break (the payload's separator) */
static void f_kv(const char *key, const char *val)
{
    if (flen) f_byte('\n');
    while (*key) f_byte((UBYTE)*key++);
    f_byte('=');
    for (; val && *val; val++) f_byte(*val == '\n' || *val == '\r' ? ' ' : (UBYTE)*val);
}

static void f_kvn(const char *key, LONG n)
{
    char b[16];
    sprintf(b, "%ld", (long)n);
    f_kv(key, b);
}

static void f_end(void)
{
    UWORD i;
    tx_put(RS);
    tx_put(ftype);
    tx_put((UBYTE)(flen >> 8));
    tx_put((UBYTE)flen);
    for (i = 0; i < flen; i++) tx_put((UBYTE)fbuf[i]);
}

/* the C frame's string: \, CR, LF, RS, control bytes and DEL as \xNN */
static void f_kv_escaped(const char *key, const char *s, LONG max)
{
    static const char hex[] = "0123456789abcdef";
    LONG i;
    if (flen) f_byte('\n');
    while (*key) f_byte((UBYTE)*key++);
    f_byte('=');
    for (i = 0; i < max && s[i]; i++) {
        UBYTE c = (UBYTE)s[i];
        if (c < 0x20 || c == 0x7F || c == '\\') {
            f_byte('\\'); f_byte('x'); f_byte(hex[c >> 4]); f_byte(hex[c & 15]);
        } else f_byte(c);
    }
}

/* ---- door output: unframed, RS doubled, LF -> CR LF (as /X does on the serial side) --- */

static BOOL crlf = TRUE;
static UBYTE last_out;

static void out_bytes(const char *s, LONG n)
{
    LONG i;
    for (i = 0; i < n; i++) {
        UBYTE c = (UBYTE)s[i];
        if (c == '\n' && crlf && last_out != '\r') tx_put('\r');
        if (c == RS) tx_put(RS);
        tx_put(c);
        last_out = c;
    }
}

static void out_str(const char *s) { out_bytes(s, strlen(s)); }

/* ---- the session's key=value table (the `s` payload plus the door's DT_* writes) ------- */

#define MAXKV 96
static struct { char key[16]; char val[200]; } kv[MAXKV];
static int nkv;

static const char *get(const char *key, const char *def)
{
    int i;
    for (i = 0; i < nkv; i++) if (!strcmp(kv[i].key, key)) return kv[i].val;
    return def;
}

static LONG geti(const char *key, LONG def)
{
    const char *v = get(key, NULL);
    return v && *v ? atol(v) : def;
}

static void put(const char *key, const char *val)
{
    int i;
    for (i = 0; i < nkv; i++) if (!strcmp(kv[i].key, key)) break;
    if (i == nkv) { if (nkv == MAXKV) return; nkv++; }
    strncpy(kv[i].key, key, sizeof(kv[i].key) - 1); kv[i].key[sizeof(kv[i].key) - 1] = 0;
    strncpy(kv[i].val, val, sizeof(kv[i].val) - 1); kv[i].val[sizeof(kv[i].val) - 1] = 0;
}

/* key=value lines; keys are folded to lower case, a trailing CR is dropped */
static void parse_kv(const UBYTE *p, LONG n)
{
    LONG i = 0;
    while (i < n) {
        char key[16], val[200];
        int k = 0, v = 0;
        BOOL eq = FALSE;
        for (; i < n && p[i] != '\n'; i++) {
            UBYTE c = p[i];
            if (!eq && c == '=') { eq = TRUE; continue; }
            if (!eq) { if (k < (int)sizeof(key) - 1) key[k++] = (c >= 'A' && c <= 'Z') ? c + 32 : c; }
            else if (v < (int)sizeof(val) - 1) val[v++] = c;
        }
        i++;
        if (v && val[v - 1] == '\r') v--;
        key[k] = 0; val[v] = 0;
        if (eq && k) put(key, val);
    }
}

/* one key from a small frame payload (t, d, w, e) */
static BOOL frame_get(const UBYTE *p, LONG n, const char *key, char *out, int outsz)
{
    int kl = strlen(key);
    LONG i = 0;
    while (i < n) {
        LONG e = i;
        while (e < n && p[e] != '\n') e++;
        if (e - i > kl && p[i + kl] == '=' && !strncmp((const char *)p + i, key, kl)) {
            int o = 0;
            LONG j;
            for (j = i + kl + 1; j < e && o < outsz - 1; j++) if (p[j] != '\r') out[o++] = p[j];
            out[o] = 0;
            return TRUE;
        }
        i = e + 1;
    }
    return FALSE;
}

/* ---- state -------------------------------------------------------------------------- */

enum { ST_READY, ST_SESSION };
enum { LOST_NONE, LOST_HANGUP, LOST_TIMEUP, LOST_BREAK };
enum { WK_NONE, WK_HK, WK_LINE, WK_EXTHK, WK_RAWKEY };

static UBYTE state = ST_READY;

/* the launcher process runs the door synchronously (SystemTagList) and signals when the
 * door is gone.  It stays "busy" past the session if the door outlives it. */
static struct {
    char  cmd[300];
    char  dir[200];
    LONG  stack;
    LONG  rc;
    volatile BOOL done;
    BOOL  busy;                 /* launched and not yet reaped */
    struct Task *parent;
    BYTE  donesig;
} LN = { .donesig = -1 };

static struct MsgPort *port;    /* AEDoorPort<node>, lives as long as a door may use it */
static char  portname[24];
static BYTE  extsig = -1;       /* JH_SIGBIT: a door Signal()s it to wake a JH_ExtHK */

struct Session {
    LONG  node, rows, cols, timeout, regtimeout, level;
    BOOL  ansi, expert, log;
    ULONG start_s;
    struct DateStamp start_ds;
    ULONG laston_ae;            /* DT_TIMELASTON, /X clock */
    LONG  tzsecs;
    /* time */
    LONG  budget;               /* seconds left at budget_base */
    ULONG budget_base;
    BOOL  timeup;
    ULONG timeup_at;
    /* carrier */
    UBYTE lost;                 /* LOST_* from `d` */
    ULONG lost_at;
    BOOL  dtr;                  /* the door dropped the line (BB_DROPDTR) */
    BOOL  input_failed;         /* the last input request failed on timeout / time-up */
    BOOL  door_timeout;         /* the door set DT_TIMEOUT: its timeouts are its own business */
    /* door */
    BOOL  launched;
    LONG  registered, cmds;
    BOOL  ever_registered, chain_pending;
    ULONG unreg_at;             /* when the register count reached zero */
    BOOL  wrote;
    BOOL  rawarrow, extsig_seen;
    LONG  envstat;
    struct JHMessage *waiting;  /* a parked input request */
    UBYTE wait_kind;
    LONG  maxlen;
    char  line[204];
    LONG  len;
    ULONG wait_since;
    struct JHMessage *editing;  /* a parked JH_EF, waiting for `e` */
    ULONG edit_since;
    BYTE  edit_answer;          /* -1 none yet, 0 refused, 1 done */
    char  retcmd[204];
    UBYTE seen[1100 / 8 + 1];
    LONG  seen_hi[16];
    int   nseen_hi;
    LONG  unknown[16];
    int   nunknown;
    ULONG indrop;               /* caller bytes dropped: the door did not read them */
};
static struct Session S;

/* host input: data bytes for the door (filled by the frame parser) */
#define INQSIZE 4096
static UBYTE inq[INQSIZE];
static UWORD inq_head, inq_tail;
static BOOL  last_cr;           /* the last key was CR: swallow an LF or NUL after it */

static void inq_put(UBYTE c)
{
    UWORD next = (inq_head + 1) & (INQSIZE - 1);
    if (next == inq_tail) { S.indrop++; return; }
    inq[inq_head] = c;
    inq_head = next;
}

static int inq_get(void)
{
    UBYTE c;
    if (inq_tail == inq_head) return -1;
    c = inq[inq_tail];
    inq_tail = (inq_tail + 1) & (INQSIZE - 1);
    return c;
}

static BOOL inq_avail(void) { return inq_tail != inq_head; }

/* ---- frames in: the parser only records what the host said; the main loop acts on it --- */

#define PAYMAX 4096
static struct {
    UBYTE state, type;
    UWORD len, got;
    UBYTE buf[PAYMAX];
} P;
enum { P_DATA, P_RS, P_LEN1, P_LEN2, P_PAYLOAD };

static UBYTE sbuf[PAYMAX];      /* a pending `s` payload */
static UWORD slen;
static BOOL  s_pending;

static void frame_in(void)
{
    UWORD n = P.len < PAYMAX ? P.len : PAYMAX;
    char v[48];
    switch (P.type) {
    case 's':
        if (state == ST_READY && !s_pending) {
            memcpy(sbuf, P.buf, n);
            slen = n;
            s_pending = TRUE;
            inq_head = inq_tail = 0;        /* keys typed from here on are the door's */
        }
        break;
    case 't':
        if (state == ST_SESSION && frame_get(P.buf, n, "timeleft", v, sizeof(v))) {
            S.budget = atol(v) * 60;
            if (S.budget < 0) S.budget = 0;
            S.budget_base = now_s;
            if (S.budget > 0) { S.timeup = FALSE; S.timeup_at = 0; }
        }
        break;
    case 'd':
        if (state == ST_SESSION && !S.lost) {
            S.lost = LOST_HANGUP;
            if (frame_get(P.buf, n, "reason", v, sizeof(v))) {
                if (!strcmp(v, "timeup")) S.lost = LOST_TIMEUP;
                else if (!strcmp(v, "break")) S.lost = LOST_BREAK;
            }
            S.lost_at = now_s;
        }
        break;
    case 'w':
        if (state == ST_SESSION) {
            LONG r, c;
            if (frame_get(P.buf, n, "rows", v, sizeof(v)) && (r = atol(v)) > 0) S.rows = r;
            if (frame_get(P.buf, n, "cols", v, sizeof(v)) && (c = atol(v)) > 0) S.cols = c;
        }
        break;
    case 'e':
        if (state == ST_SESSION && S.editing && S.edit_answer < 0)
            S.edit_answer = frame_get(P.buf, n, "status", v, sizeof(v)) && !strcmp(v, "done") ? 1 : 0;
        break;
    default:                    /* unknown or upper case: skipped by its length */
        break;
    }
}

static void data_in(UBYTE c)
{
    if ((state == ST_SESSION && !S.lost) || s_pending) inq_put(c);
}

static void pump(void)
{
    int c;
    while ((c = rx_get()) >= 0) {
        switch (P.state) {
        case P_DATA:
            if (c == RS) P.state = P_RS; else data_in((UBYTE)c);
            break;
        case P_RS:
            if (c == RS) { data_in(RS); P.state = P_DATA; }
            else { P.type = (UBYTE)c; P.state = P_LEN1; }
            break;
        case P_LEN1:
            P.len = (UWORD)(c << 8);
            P.state = P_LEN2;
            break;
        case P_LEN2:
            P.len |= (UWORD)c;
            P.got = 0;
            if (P.len == 0) { frame_in(); P.state = P_DATA; }
            else P.state = P_PAYLOAD;
            break;
        default:
            if (P.got < PAYMAX) P.buf[P.got] = (UBYTE)c;
            if (++P.got == P.len) { frame_in(); P.state = P_DATA; }
            break;
        }
    }
}

/* ---- dates ---------------------------------------------------------------------------- */

#define AE_EPOCH    (2922UL * 86400UL + 21600UL)   /* /X's clock: 1970 + 6 h; ours: 1978 */
#define UNIX_1978   252460800UL

static ULONG sys_secs(void)     /* Amiga seconds since 1978 */
{
    struct DateStamp ds;
    DateStamp(&ds);
    return (ULONG)ds.ds_Days * 86400UL + (ULONG)ds.ds_Minute * 60UL + (ULONG)ds.ds_Tick / TICKS_PER_SECOND;
}

/* "Fri Oct 16 14:05:00 2026", the form /X's DT_STAMP_* give, from a /X clock value */
static void ae_ctime(ULONG ae, char *out)
{
    static const char *wd[7] = { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };
    static const char *mn[12] = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
    static const UBYTE md[12] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    ULONG t = ae >= AE_EPOCH ? ae - AE_EPOCH : 0;
    ULONG days = t / 86400UL, secs = t % 86400UL;
    int y = 1978, m = 0, dow = (int)(days % 7);     /* 1 Jan 1978 was a Sunday */
    for (;;) {
        int yl = ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0) ? 366 : 365;
        if (days < (ULONG)yl) break;
        days -= yl; y++;
    }
    for (;;) {
        int dim = md[m] + (m == 1 && ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0));
        if (days < (ULONG)dim) break;
        days -= dim; m++;
    }
    sprintf(out, "%s %s %02lu %02lu:%02lu:%02lu %d", wd[dow], mn[m], (unsigned long)days + 1,
            (unsigned long)(secs / 3600), (unsigned long)((secs / 60) % 60), (unsigned long)(secs % 60), y);
}

/* ---- door process ----------------------------------------------------------------------- */

#define DOOR_OUT "RAM:axshim.out"

static void launcher(void)
{
    BPTR in = Open((STRPTR)"NIL:", MODE_OLDFILE);
    BPTR out = Open((STRPTR)DOOR_OUT, MODE_NEWFILE);
    BPTR dl = LN.dir[0] ? Lock((STRPTR)LN.dir, ACCESS_READ) : 0, od = 0;
    if (!out) out = Open((STRPTR)"NIL:", MODE_NEWFILE);
    if (dl) od = CurrentDir(dl);
    LN.rc = SystemTags((STRPTR)LN.cmd,
                       SYS_Input, in, SYS_Output, out,
                       NP_StackSize, LN.stack, NP_Priority, 0,
                       TAG_END);
    if (dl) { CurrentDir(od); UnLock(dl); }
    if (in) Close(in);
    if (out) Close(out);
    Forbid();                   /* the parent may not reap us before we are gone */
    LN.done = TRUE;
    Signal(LN.parent, 1UL << LN.donesig);
}

/* first line the door (or the shell) printed on stdout, for an error= text */
static void door_stdout(char *out, int max)
{
    BPTR fh = Open((STRPTR)DOOR_OUT, MODE_OLDFILE);
    out[0] = 0;
    if (!fh) return;
    if (FGets(fh, (STRPTR)out, max)) {
        int n = strlen(out);
        while (n && (out[n - 1] == '\n' || out[n - 1] == '\r')) out[--n] = 0;
    }
    Close(fh);
}

/* every path component shorter than LONGNAME: the AROS 20250219 afs.handler hangs for good
 * on a lookup of a name of 33 or more characters instead of failing */
static BOOL path_ok(const char *path)
{
    int run = 0;
    for (; *path; path++) {
        if (*path == '/' || *path == ':') run = 0;
        else if (++run >= LONGNAME) return FALSE;
    }
    return TRUE;
}

static BOOL port_open(LONG node)
{
    sprintf(portname, "AEDoorPort%ld", (long)node);
    Forbid();
    if (FindPort((STRPTR)portname)) { Permit(); return FALSE; }
    if ((port = CreateMsgPort())) {
        port->mp_Node.ln_Name = portname;
        port->mp_Node.ln_Pri = 0;
        AddPort(port);
    }
    Permit();
    return port != NULL;
}

static void zombie_reply(struct JHMessage *m);

static void port_close(void)
{
    struct JHMessage *m;
    if (!port) return;
    Forbid();
    RemPort(port);
    while ((m = (struct JHMessage *)GetMsg(port))) zombie_reply(m);
    Permit();
    DeleteMsgPort(port);
    port = NULL;
}

/* the launcher finished: free what it used, and the port if no session needs it */
static void reap(void)
{
    if (!LN.busy || !LN.done) return;
    if (LN.donesig >= 0) { FreeSignal(LN.donesig); LN.donesig = -1; }
    LN.busy = FALSE;
    if (state != ST_SESSION) { port_close(); DeleteFile((STRPTR)DOOR_OUT); }
}

static BOOL launch(const char *door)
{
    char *slash;
    const char *dir = get("dir", NULL);
    memset(LN.cmd, 0, sizeof(LN.cmd));
    snprintf(LN.cmd, sizeof(LN.cmd), "\"%s\" %ld %s", door, (long)S.node, get("args", ""));
    if (dir && *dir) {
        strncpy(LN.dir, dir, sizeof(LN.dir) - 1);
        LN.dir[sizeof(LN.dir) - 1] = 0;
    } else {
        strncpy(LN.dir, door, sizeof(LN.dir) - 1);
        LN.dir[sizeof(LN.dir) - 1] = 0;
        slash = strrchr(LN.dir, '/');
        if (!slash) slash = strchr(LN.dir, ':') ? strchr(LN.dir, ':') + 1 : LN.dir;
        *slash = 0;
    }
    LN.stack = geti("stack", 32768);
    if (LN.stack < 4096) LN.stack = 4096;
    LN.rc = 0;
    LN.done = FALSE;
    LN.parent = FindTask(NULL);
    if ((LN.donesig = AllocSignal(-1)) < 0) return FALSE;
    LN.busy = TRUE;
    if (!CreateNewProcTags(NP_Entry, (ULONG)launcher, NP_Name, (ULONG)"axshim launcher",
                           NP_StackSize, 8192, NP_Priority, 0, TAG_END)) {
        FreeSignal(LN.donesig);
        LN.donesig = -1;
        LN.busy = FALSE;
        return FALSE;
    }
    return TRUE;
}

/* ---- session ------------------------------------------------------------------------- */

static void mark_seen(LONG cmd)
{
    int i;
    if (cmd >= 0 && cmd < 1100) { S.seen[cmd >> 3] |= 1 << (cmd & 7); return; }
    for (i = 0; i < S.nseen_hi; i++) if (S.seen_hi[i] == cmd) return;
    if (S.nseen_hi < 16) S.seen_hi[S.nseen_hi++] = cmd;
}

static void mark_unknown(LONG cmd)
{
    int i;
    for (i = 0; i < S.nunknown; i++) if (S.unknown[i] == cmd) return;
    if (S.nunknown < 16) S.unknown[S.nunknown++] = cmd;
}

static void emit_ready(void)
{
    f_begin('R');
    f_end();
}

static void emit_hello(ULONG baud)
{
    char b[24];
    f_begin('H');
    f_kvn("version", PROTO_VERSION);
    f_kv("shim", "axshim " SHIM_VERSION);
    sprintf(b, "%u.%u", (unsigned)SysBase->LibNode.lib_Version, (unsigned)SysBase->LibNode.lib_Revision);
    f_kv("exec", b);
    f_kvn("kick", SysBase->SoftVer);
    f_kvn("baud", (LONG)baud);
    f_end();
}

static LONG time_left(void)     /* seconds */
{
    LONG left = S.budget - (LONG)(now_s - S.budget_base);
    return left > 0 ? left : 0;
}

/* a FileInfoBlock date at or after the session start */
static BOOL fresh(const struct DateStamp *d)
{
    const struct DateStamp *s = &S.start_ds;
    if (d->ds_Days != s->ds_Days) return d->ds_Days > s->ds_Days;
    if (d->ds_Minute != s->ds_Minute) return d->ds_Minute > s->ds_Minute;
    return d->ds_Tick >= s->ds_Tick;
}

static char changed[200];      /* the first path scan_writes() found, for X changed= */

static void note_changed(BPTR dir, const char *name)
{
    if (!NameFromLock(dir, (STRPTR)changed, sizeof(changed))) changed[0] = 0;
    else if (name) AddPart((STRPTR)changed, (STRPTR)name, sizeof(changed));
}

/* did the door write to the boot volume?  A walk for anything dated after the session start
 * (a write stamps the file, a create or delete stamps the directory; AROS stamps the root on
 * any write).  A directory's own date counts only after its contents, so changed= names a file. */
static BOOL scan_dir(BPTR lock, int depth, LONG *budget)
{
    struct FileInfoBlock *fib = AllocDosObject(DOS_FIB, NULL);
    struct DateStamp self;
    BOOL found = FALSE;
    if (!fib) return FALSE;
    if (Examine(lock, fib)) {
        self = fib->fib_Date;
        while (!found && --*budget > 0 && ExNext(lock, fib)) {
            if (fib->fib_DirEntryType == ST_USERDIR && depth < 12) {
                /* its contents first, then its own date (checked at the end of that walk) */
                BPTR old = CurrentDir(lock), sub = Lock((STRPTR)fib->fib_FileName, ACCESS_READ);
                CurrentDir(old);
                if (sub) {
                    found = scan_dir(sub, depth + 1, budget);
                    UnLock(sub);
                }
            } else if (fresh(&fib->fib_Date)) {
                found = TRUE;
                note_changed(lock, (const char *)fib->fib_FileName);
            }
        }
        if (!found && fresh(&self)) { found = TRUE; note_changed(lock, NULL); }
    }
    FreeDosObject(DOS_FIB, fib);
    return found;
}

static BOOL scan_writes(void)
{
    LONG budget = 5000;
    BPTR l = Lock((STRPTR)"SYS:", ACCESS_READ);
    BOOL found = FALSE;
    if (l) { found = scan_dir(l, 0, &budget); UnLock(l); }
    return found;
}

static void fail_waiting(BOOL timeout);
static void reply(struct JHMessage *m) { ReplyMsg((struct Message *)m); }

/* X, then back to R.  status: ok carrier timeout break error */
static void end_session(const char *status, const char *error)
{
    char b[16];
    int i;
    UWORD o;

    if (S.waiting) fail_waiting(FALSE);
    if (S.editing) { S.editing->Data = -1; reply(S.editing); S.editing = NULL; }
    changed[0] = 0;
    if (S.launched) {           /* a walk even after a DT write: changed= names a file */
        BOOL files = scan_writes();
        S.wrote = S.wrote || files;
    }

    f_begin('X');
    f_kv("status", status);
    f_kvn("reg", S.registered > 0 ? S.registered : 0);
    f_kvn("cmds", S.cmds);
    f_kv("codes", "");
    o = flen;
    for (i = 0; i < 1100; i++)
        if (S.seen[i >> 3] & (1 << (i & 7))) {
            sprintf(b, "%s%d", flen > o ? " " : "", i);
            f_str(b);
        }
    for (i = 0; i < S.nseen_hi; i++) {
        sprintf(b, "%s%ld", flen > o ? " " : "", (long)S.seen_hi[i]);
        f_str(b);
    }
    f_kv("return", S.retcmd);
    if (error) f_kv("error", error);
    f_kvn("wrote", S.wrote ? 1 : 0);
    /* additions to the spec's set (adding keys does not bump the version) */
    if (S.launched) f_kvn("rc", LN.done ? LN.rc : -1);
    if (S.nunknown) {
        f_kv("unknown", "");
        o = flen;
        for (i = 0; i < S.nunknown; i++) {
            sprintf(b, "%s%ld", flen > o ? " " : "", (long)S.unknown[i]);
            f_str(b);
        }
    }
    if (changed[0]) f_kv("changed", changed);
    if (S.dtr) f_kvn("dropdtr", 1);
    if (S.indrop) f_kvn("indrop", (LONG)S.indrop);
    if (tx_polled) f_kvn("txpoll", 1);
    f_end();

    state = ST_READY;
    inq_head = inq_tail = 0;
    if (LN.busy && LN.done) reap();
    if (!LN.busy) { port_close(); DeleteFile((STRPTR)DOOR_OUT); }
    /* else the door outlived the session: the port stays up and answers "carrier lost" */
    memset(&S, 0, sizeof(S));
    nkv = 0;
    emit_ready();
}

static void error_session(const char *error) { end_session("error", error); }

static void start_session(void)
{
    const char *door, *v;
    BPTR l;

    memset(&S, 0, sizeof(S));
    S.edit_answer = -1;
    nkv = 0;
    parse_kv(sbuf, slen);
    state = ST_SESSION;         /* end_session() below needs it; no door yet */
    last_cr = FALSE;
    last_out = 0;
    S.start_s = now_s;

    v = get("version", NULL);
    if (!v || atol(v) != PROTO_VERSION) { error_session("version"); return; }
    door = get("door", "");
    if (!*door) { error_session("no door"); return; }
    if (LN.busy) { error_session("busy: the previous door is still running"); return; }
    if (!path_ok(door)) { error_session("door path has a name of 33 or more characters"); return; }
    if (!(l = Lock((STRPTR)door, ACCESS_READ))) { error_session("door not found"); return; }
    UnLock(l);

    /* the user block */
    S.node = geti("node", 0);
    S.rows = geti("rows", 24);
    S.cols = geti("cols", 80);
    S.timeout = geti("timeout", 300);
    S.regtimeout = geti("regtimeout", REG_TIMEOUT);
    S.level = geti("level", 10);
    S.ansi = geti("ansi", 1) != 0;
    S.expert = geti("expert", 0) != 0;
    S.log = geti("log", 0) != 0;
    crlf = geti("crlf", 1) != 0;
    S.tzsecs = geti("tz", 0) * 60;
    if (S.rows <= 0) S.rows = 24;
    if (S.cols <= 0) S.cols = 80;
    if ((v = get("now", NULL)) && *v) {
        ULONG unix_now = strtoul(v, NULL, 10);
        if (unix_now > UNIX_1978) set_clock(unix_now - UNIX_1978 + S.tzsecs);
    }
    DateStamp(&S.start_ds);
    if ((v = get("laston", NULL)) && *v) S.laston_ae = strtoul(v, NULL, 10) + S.tzsecs + 21600UL;
    else S.laston_ae = sys_secs() + AE_EPOCH;
    S.budget = geti("timeleft", 60) * 60;
    if (S.budget < 0) S.budget = 0;
    S.budget_base = now_s;
    S.envstat = 3;
    S.edit_answer = -1;

    if (!port_open(S.node)) { error_session("door port busy"); return; }
    if (!launch(door)) { port_close(); error_session("cannot start the launcher"); return; }
    S.launched = TRUE;

    f_begin('L');
    f_kv("door", door);
    f_kvn("pid", 0);
    f_end();
}

/* ---- input ---------------------------------------------------------------------------- */

/* wait a few ticks for the rest of an escape sequence (it arrives with its ESC) */
static BOOL key_soon(void)
{
    int i;
    for (i = 0; i < 3 && !inq_avail(); i++) { Delay(1); pump(); }
    return inq_avail();
}

/* the next key, -1 = none yet, -2 = swallowed.  Cursor keys are one key: 4 up, 5 down,
 * 3 right, 2 left when RAWARROW is on, else swallowed.  LF or NUL right after CR (telnet's
 * CR LF / CR NUL) is swallowed. */
static LONG next_key(void)
{
    int c, c2;
    pump();
    c = inq_get();
    if (c < 0) return -1;
    if (last_cr && (c == '\n' || c == 0)) { last_cr = FALSE; return -2; }
    last_cr = (c == '\r');
    if (c != 27) return c;
    if (!key_soon()) return 27;
    c2 = inq_get();
    if (c2 != '[' && c2 != 'O') return c2;
    if (!key_soon()) return -2;
    c = inq_get();
    while ((c >= '0' && c <= '9') || c == ';') {
        if (!key_soon()) return -2;
        c = inq_get();
    }
    if (c < 'A' || c > 'D' || !S.rawarrow) return -2;
    return c == 'A' ? 4 : c == 'B' ? 5 : c == 'C' ? 3 : 2;
}

/* an input request fails: Data = -1 (the /X 2-4 convention every tested door knows) */
static void fail_msg(struct JHMessage *m, UBYTE kind)
{
    switch (kind) {
    case WK_HK:    m->String[0] = (char)-1; m->String[1] = 0; m->Command = -1; m->Data = -1; break;
    case WK_EXTHK: m->Command = -1; m->Data = -1; break;
    case WK_RAWKEY: m->Data = -1; m->Command = 2; break;
    default:       m->Data = -1; break;            /* PM / LI: the text stays */
    }
    reply(m);
}

static void fail_waiting(BOOL timeout)
{
    if (!S.waiting) return;
    fail_msg(S.waiting, S.wait_kind);
    S.waiting = NULL;
    if (timeout) S.input_failed = TRUE;
}

static BOOL input_dead(void) { return S.lost || S.dtr || S.timeup; }

static void service_input(void)
{
    struct JHMessage *m = S.waiting;
    LONG c;
    if (!m) return;
    if (input_dead()) { fail_waiting(!S.lost && !S.dtr); return; }
    if (S.wait_kind == WK_EXTHK && S.extsig_seen) {
        S.extsig_seen = FALSE;
        m->Command = 0; m->Data = 1;
        reply(m); S.waiting = NULL;
        return;
    }
    if (S.wait_kind != WK_LINE) {
        do c = next_key(); while (c == -2);
        if (c < 0) return;
        if (S.wait_kind == WK_HK) { m->String[0] = (char)c; m->String[1] = 0; m->Command = 2; m->Data = 1; }
        else if (S.wait_kind == WK_EXTHK) { m->Command = c; m->Data = 1; }
        else { m->Data = c; m->Command = 2; }
        reply(m); S.waiting = NULL;
        S.input_failed = FALSE;
        return;
    }
    while ((c = next_key()) != -1) {
        if (c == -2) continue;
        S.wait_since = now_s;   /* the inactivity timeout counts from the last key */
        if (c == '\r' || c == '\n') {
            out_bytes("\r\n", 2);
            S.line[S.len] = 0;
            strncpy(m->String, S.line, 199); m->String[199] = 0;
            m->Data = 1;
            reply(m); S.waiting = NULL;
            S.input_failed = FALSE;
            return;
        } else if (c == 8 || c == 127) {
            if (S.len > 0) { S.len--; out_bytes("\b \b", 3); }
        } else if (c == 21 || c == 24) {
            while (S.len > 0) { S.len--; out_bytes("\b \b", 3); }
        } else if (c >= 32 && S.len < S.maxlen && S.len < 199) {
            char b = (char)c;
            S.line[S.len++] = b;
            out_bytes(&b, 1);
        }
    }
}

/* ---- files ---------------------------------------------------------------------------- */

static BOOL show_file(const char *path)
{
    char buf[512];
    LONG n;
    BPTR fh;
    if (!path_ok(path)) return FALSE;
    if (!(fh = Open((STRPTR)path, MODE_OLDFILE))) return FALSE;
    while ((n = Read(fh, buf, sizeof(buf))) > 0) out_bytes(buf, n);
    Close(fh);
    return TRUE;
}

/* ---- answers -------------------------------------------------------------------------- */

static void sets(struct JHMessage *m, const char *s) { strncpy(m->String, s, 199); m->String[199] = 0; }

static void setn(struct JHMessage *m, LONG n) { sprintf(m->String, "%ld", (long)n); }

static void setu(struct JHMessage *m, ULONG n) { sprintf(m->String, "%lu", (unsigned long)n); }

/* a DT_* the door wrote earlier wins over the user block ("dt<N>" in the table) */
static const char *dt_written(LONG cmd)
{
    char k[12];
    sprintf(k, "dt%ld", (long)cmd);
    return get(k, NULL);
}

static void dt_write(struct JHMessage *m, LONG cmd)
{
    char k[12];
    S.wrote = TRUE;
    switch (cmd) {
    case DT_TIMEOUT:    S.timeout = atol(m->String); S.door_timeout = TRUE; return;
    case DT_LINELENGTH: { LONG r = atol(m->String); if (r > 0) S.rows = r; return; }
    default:
        sprintf(k, "dt%ld", (long)cmd);
        put(k, m->String);
    }
}

static void dt_read(struct JHMessage *m, LONG cmd)
{
    const char *w = dt_written(cmd);
    if (w) { sets(m, w); return; }
    switch (cmd) {
    case DT_NAME:           sets(m, get("name", "User")); break;
    case DT_REALNAME:       sets(m, get("realname", get("name", "User"))); break;
    case DT_PASSWORD:       sets(m, ""); break;     /* doors never get it (as /X 5) */
    case DT_LOCATION:       sets(m, get("location", "")); break;
    case DT_PHONENUMBER:    sets(m, "000-000-0000"); break;
    case DT_SLOTNUMBER:     setn(m, geti("slot", 1)); break;
    case DT_SECSTATUS:      setn(m, S.level); break;
    case DT_SECBOARD: case DT_SECLIBRARY: case DT_SECBULLETIN: setn(m, 0); break;
    case DT_MESSAGESPOSTED: setn(m, geti("posts", 0) & 0xFFFF); break;
    case DT_UPLOADS:        setn(m, geti("uploads", 0) & 0xFFFF); break;
    case DT_DOWNLOADS:      setn(m, geti("downloads", 0) & 0xFFFF); break;
    case DT_TIMESCALLED:    setn(m, geti("calls", 1) & 0xFFFF); break;
    case DT_TIMELASTON:     setu(m, S.laston_ae); break;
    case DT_TIMEUSED:       setn(m, geti("timeused", 0) * 60 + (LONG)(now_s - S.start_s)); break;
    case DT_TIMELIMIT:      setn(m, time_left()); break;
    case DT_TIMETOTAL:      setn(m, geti("timelimit", geti("timeleft", 60)) * 60); break;
    case DT_BYTESUPLOAD:    sets(m, get("ulbytes", "0")); break;
    case DT_BYTEDOWNLOAD:   sets(m, get("dlbytes", "0")); break;
    case DT_DAILYBYTELIMIT: case DT_DAILYBYTEDLD: setn(m, 0); break;
    case DT_EXPERT:         sets(m, S.expert ? "X" : "N"); break;
    case DT_LINELENGTH:     setn(m, S.rows); break;
    case DT_TIMEOUT:        setn(m, S.timeout); break;
    case DT_HOSTNAME:       sets(m, get("hostname", "")); break;
    case DT_HOSTIP:         sets(m, get("hostip", "")); break;
    default:                sets(m, ""); break;
    }
}

/* sysop-only /X security bits (as NilBBS lists them) */
static const UBYTE sysop_acs[] = { 0, 11, 20, 21, 22, 23, 25, 32, 34, 36, 40, 46, 47, 48, 49, 50,
                                   63, 64, 72, 74, 75, 76, 78, 79, 81, 82, 83, 84, 85 };
static LONG query_bit(LONG bit)
{
    int i;
    if (bit < 0 || bit > 86 || bit == 71) return 0;
    if (S.level >= 255) return 1;
    for (i = 0; i < (int)sizeof(sysop_acs); i++) if (sysop_acs[i] == bit) return 0;
    return 1;
}

/* the door's request after its session ended (or before the port went away) */
static void zombie_reply(struct JHMessage *m)
{
    switch (m->Command) {
    case JH_HK:    m->String[0] = (char)-1; m->String[1] = 0; m->Command = -1; m->Data = -1; break;
    case JH_ExtHK: case JH_FetchKey: m->Command = -1; m->Data = -1; break;
    case JH_20: case QUICK_KEY: m->Data = -1; m->Command = 2; break;
    case JH_PM: case JH_LI: case JH_EF: m->Data = -1; break;
    default: break;
    }
    reply(m);
}

static void log_cmd(struct JHMessage *m)
{
    f_begin('C');
    f_kvn("cmd", m->Command);
    f_kvn("data", m->Data);
    f_kvn("len", m->msg.mn_Length);
    f_kv_escaped("str", m->String, 200);
    f_end();
}

static void park_input(struct JHMessage *m, UBYTE kind)
{
    if (S.waiting) { fail_msg(m, kind); return; }      /* one at a time */
    S.waiting = m;
    S.wait_kind = kind;
    S.wait_since = now_s;
    service_input();
}

static void xim_command(struct JHMessage *m)
{
    LONG cmd = m->Command, linenum = m->LineNum;
    UWORD len = m->msg.mn_Length;
    char s[220];

    S.cmds++;
    mark_seen(cmd);
    if (S.log) log_cmd(m);
    m->LineNum = 0;             /* as NilBBS; an unknown command gets it back below */

    switch (cmd) {
    case JH_REGISTER:
        S.registered++;
        S.ever_registered = TRUE;
        S.chain_pending = FALSE;
        S.unreg_at = 0;
        m->Command = S.rows;            /* /X: the user's line length */
        break;
    case CHAIN:                         /* the door hands over: the next one registers */
        S.registered--;
        S.chain_pending = TRUE;
        break;
    case JH_SHUTDOWN:
        if (--S.registered <= 0) S.rawarrow = FALSE;
        break;
    case JH_WRITE:      out_str(m->String); break;
    case JH_SM: case JH_SO: case JH_MCI:
        out_str(m->String);
        if (m->Data) out_str("\n");
        break;
    case JH_SMPTR:
        if (len >= JHM_FULL && m->strptr) { out_str(m->strptr); if (m->Data) out_str("\n"); }
        break;
    case JH_CO:         break;          /* console only */
    case JH_HK:
        out_str(m->String);
        park_input(m, WK_HK);
        return;
    case JH_PM: case JH_LI:
        if (!S.waiting) {
            S.maxlen = m->Data > 0 && m->Data < 200 ? m->Data : 199;
            S.len = 0;
            if (cmd == JH_PM) out_str(m->String);
            else if (!input_dead()) {   /* LI: String is an editable default */
                strncpy(S.line, m->String, 200); S.line[200] = 0;
                S.len = strlen(S.line);
                if (S.len > S.maxlen) S.len = S.maxlen;
                out_bytes(S.line, S.len);
            }
        }
        park_input(m, WK_LINE);
        return;
    case JH_ExtHK:      park_input(m, WK_EXTHK); return;
    case JH_20: case QUICK_KEY: park_input(m, WK_RAWKEY); return;
    case JH_FetchKey: {                 /* a poll: Command 0 when no key */
        LONG c;
        if (input_dead()) { m->Command = -1; m->Data = -1; break; }
        do c = next_key(); while (c == -2);
        m->Command = c >= 0 ? c : 0;
        m->Data = 1;
        break;
    }
    case GETKEY:        sets(m, !input_dead() && inq_avail() ? "1" : "0"); break;
    case JH_SG: case JH_SF: case DISPLAY_FILE: case CHECK_TO_DISPLAY: {
        static const char *ext[] = { "", ".txt", ".ans", ".gr", ".asc", NULL };
        int i;
        BOOL ok = FALSE;
        if (!path_ok(m->String)) { m->Data = 0; break; }
        for (i = 0; ext[i] && !ok; i++) {
            if (cmd != JH_SG && i > 0) break;
            snprintf(s, sizeof(s), "%s%s", m->String, ext[i]);
            ok = show_file(s);
        }
        break;
    }
    case JH_EF:                         /* hand the editor to the host: E, then wait for e */
        if (!path_ok(m->String) || S.editing) { m->Data = 0; break; }
        if (input_dead()) { m->Data = -1; break; }
        S.editing = m;
        S.edit_since = now_s;
        S.edit_answer = -1;
        f_begin('E');
        f_kv("file", m->String);
        f_end();
        return;
    case JH_BBSNAME:    sets(m, get("bbsname", "ENiGMA")); break;
    case JH_SYSOP:      sets(m, get("sysop", "SysOp")); break;
    case JH_SIGBIT:     m->Data = extsig >= 0 ? extsig : 0; break;
    case RAWARROW:      S.rawarrow = !S.rawarrow; break;
    case RETURNCOMMAND: strncpy(S.retcmd, m->String, 199); S.retcmd[199] = 0; break;
    case ENVSTAT:
        if (m->Data) setn(m, S.envstat); else S.envstat = atol(m->String);
        break;
    case SV_NEWMSG:     break;
    case NODE_BAUD: case NODE_BAUDRATE: sets(m, "38400"); break;
    case NODE_DEVICE:   sets(m, "telnet.device"); break;
    case NODE_UNIT:     setn(m, S.node); break;
    case NODE_NUMBER:   setn(m, S.node); m->Data = S.node; break;
    case BB_DROPDTR:    S.dtr = TRUE; break;        /* reported as dropdtr=1 in X */
    case GET_XIMPORT:   m->Data = 2; break;
    case DT_QUERYBIT:   m->Command = query_bit(m->Data); break;
    case DT_ADDBIT: case DT_REMBIT: case SETMCIOFF: case INTERPRET_MCI: break;
    case CONF_ACCESS:   m->Data = (m->Data == 0) ? 1 : 2; break;
    case MULTICOM:      if (len >= JHM_SEMI) m->Semi = 0; break;
    case LOAD_ACCOUNT: case EXT_LOAD_ACCOUNT: case SEARCH_ACCOUNT: case APPEND_ACCOUNT:
        m->Data = 0; m->NodeID = 0;
        break;
    case SAVE_ACCOUNT:  m->Data = 0; break;
    case JH_FLAGFILE: case JH_SHOWFLAGS: case BB_NONSTOPTEXT: case BB_CALLERSLOG: case BB_UDLOG: break;
    case DT_ANSICOLOR:  sets(m, S.ansi ? "1" : "0"); break;
    case DT_ISANSI:     m->Data = S.ansi ? 1 : 0; break;
    case ACTIVE_NODES:
        memset(s, ' ', 32); s[32] = 0; s[S.node & 31] = 'X';
        sets(m, s);
        break;
    case DT_DUMP:       break;
    case BB_CONFNAME:
        if (m->Data) { const char *w = dt_written(cmd); sets(m, w ? w : get("bbsname", "ENiGMA")); }
        else dt_write(m, cmd);
        break;
    case BB_CONFLOCAL: case BB_LOCAL: if (m->Data || cmd == BB_LOCAL) sets(m, "BBS:"); break;
    case BB_CONFNUM:    sets(m, "0"); break;
    case BB_MAINLINE:   sets(m, get("mainline", "")); break;
    case BB_NODEID:     setn(m, S.node); break;
    case EXPRESS_VERSION: sets(m, "v5.6"); break;
    case BB_CHATFLAG:   sets(m, "OFF"); break;
    case DT_CURR_TIME:  setu(m, sys_secs() + AE_EPOCH); break;
    case DT_STAMP_LASTON: ae_ctime(S.laston_ae, s); sets(m, s); break;
    case DT_STAMP_CTIME: ae_ctime(sys_secs() + AE_EPOCH, s); sets(m, s); break;
    case DT_CONFACCESS: if (m->Data) sets(m, "XXXXXXXXX"); break;
    case BB_GETTASK:    m->task = (struct Process *)FindTask(NULL); break;
    case BB_LOGONTYPE:  m->Data = 3; break;
    case BB_SCRWIDTH:   m->Data = S.cols; break;
    case BB_SCRHEIGHT:  m->Data = S.rows; break;
    case BB_LINECOUNT:  if (m->Data) sets(m, "0"); break;
    case DT_LANGUAGE:   if (m->Data) sets(m, "txt"); break;
    case MOD_TYPE:      m->Data = 0; break;
    case ZMODEMSEND: case ZMODEMRECEIVE: case BATCHZMODEMSEND: m->Data = 0; break;
    case DT_REALNAME: case DT_HOSTNAME: case DT_HOSTIP:
        if (m->Data) dt_read(m, cmd); else dt_write(m, cmd);
        break;
    default:
        if (cmd >= DT_NAME && cmd <= DT_TIMEOUT && cmd != ACTIVE_NODES && cmd != DT_DUMP) {
            if (m->Data) dt_read(m, cmd); else dt_write(m, cmd);
            break;
        }
        mark_unknown(cmd);      /* replied unchanged */
        m->LineNum = linenum;
        break;
    }
    reply(m);
}

/* ---- the session's clock work: input, editor, exit ------------------------------------ */

static void session_service(void)
{
    struct JHMessage *m;
    BOOL ended = FALSE;

    if (!S.timeup && time_left() <= 0) { S.timeup = TRUE; S.timeup_at = now_s; }

    if (S.editing) {
        BYTE a = S.edit_answer;
        if (S.lost || S.dtr || S.timeup) a = -2;
        else if (a < 0 && S.timeout > 0 && now_s - S.edit_since >= (ULONG)S.timeout) a = 0;
        if (a != -1) {
            S.editing->Data = a == 1 ? 1 : a == 0 ? 0 : -1;
            if (a == 1) S.wrote = TRUE;
            reply(S.editing);
            S.editing = NULL;
        }
    }

    if (S.waiting) {
        service_input();
        if (S.waiting && S.timeout > 0 && now_s - S.wait_since >= (ULONG)S.timeout)
            fail_waiting(!S.door_timeout);
    }

    if (LN.done) {              /* the door process is gone: whatever it left, then X */
        while ((m = (struct JHMessage *)GetMsg(port))) xim_command(m);
        if (!S.ever_registered) {
            char out[120], err[200];
            door_stdout(out, sizeof(out));
            snprintf(err, sizeof(err), "door exited without registering (rc=%ld)%s%s", (long)LN.rc,
                     out[0] ? ": " : "", out);
            reap();
            error_session(err);
            return;
        }
        ended = TRUE;
    } else if (!S.ever_registered && S.regtimeout > 0 && now_s - S.start_s >= (ULONG)S.regtimeout
               && !S.lost) {
        char err[64];
        sprintf(err, "door did not register within %ld s", (long)S.regtimeout);
        error_session(err);
        return;
    } else if (S.ever_registered && S.registered <= 0 && !S.chain_pending) {
        if (!S.unreg_at) S.unreg_at = now_s ? now_s : 1;
        else if (now_s - S.unreg_at >= EXIT_GRACE) ended = TRUE;
    }

    if (!ended && S.lost && now_s - S.lost_at >= CARRIER_GRACE) ended = TRUE;
    if (!ended && S.timeup && S.timeup_at && now_s - S.timeup_at >= CARRIER_GRACE) ended = TRUE;
    if (!ended) return;

    if (S.lost == LOST_HANGUP) end_session("carrier", NULL);
    else if (S.lost == LOST_TIMEUP) end_session("timeout", NULL);
    else if (S.lost == LOST_BREAK) end_session("break", NULL);
    else if (!S.ever_registered) error_session("door did not register");
    else if (S.timeup || S.input_failed) end_session("timeout", NULL);
    else end_session("ok", NULL);
}

static void step(void)
{
    struct JHMessage *m;
    int pass;
    timer_poll();
    pump();
    for (pass = 0; pass < 2; pass++) {  /* a session that ends here may already have its next s */
        if (state == ST_READY) {
            if (port) while ((m = (struct JHMessage *)GetMsg(port))) zombie_reply(m);
            if (LN.busy && LN.done) reap();
            if (s_pending) {
                s_pending = FALSE;
                start_session();
            }
        }
        if (state == ST_SESSION) {
            while ((m = (struct JHMessage *)GetMsg(port))) {
                xim_command(m);
                pump();
            }
            session_service();
        }
        if (state != ST_READY || !s_pending) break;
    }
}

/* ---- startup -------------------------------------------------------------------------- */

static void assign(const char *name, const char *path)
{
    char dev[32];
    BPTR l;
    sprintf(dev, "%s:", name);
    if ((l = Lock((STRPTR)dev, ACCESS_READ))) { UnLock(l); return; }   /* a volume or assign already */
    if (!(l = Lock((STRPTR)path, ACCESS_READ))) return;
    if (!AssignLock((STRPTR)name, l)) UnLock(l);
}

int main(int argc, char **argv)
{
    ULONG baud = 115200;
    int i;

    for (i = 1; i < argc; i++) {        /* axshim [baud]; anything else is ignored */
        ULONG b = strtoul(argv[i], NULL, 10);
        if (b >= 1200 && b <= 230400) baud = b;
    }
    /* no "insert volume" requesters: a missing path fails at once (doors inherit this) */
    ((struct Process *)FindTask(NULL))->pr_WindowPtr = (APTR)-1;
    if (!timer_open()) { timer_close(); return 20; }
    if (!uart_open(baud)) { timer_close(); return 20; }
    timer_arm();
    extsig = AllocSignal(-1);
    assign("BBS", "SYS:");
    assign("DOORS", "SYS:Doors");

    emit_hello(baud);
    emit_ready();
    for (;;) {
        ULONG sigs = rx.sigmask | timer_sigmask() | SIGBREAKF_CTRL_C, got;
        if (port) sigs |= 1UL << port->mp_SigBit;
        if (LN.busy && LN.donesig >= 0) sigs |= 1UL << LN.donesig;
        if (extsig >= 0) sigs |= 1UL << extsig;
        got = Wait(sigs);
        if (got & SIGBREAKF_CTRL_C) break;
        if (extsig >= 0 && (got & (1UL << extsig)) && state == ST_SESSION) S.extsig_seen = TRUE;
        step();
    }
    if (extsig >= 0) FreeSignal(extsig);
    timer_close();
    uart_close();
    return 0;
}
