/*
 * axshim.c - ENiGMA½ BBS's Amiga door host shim.
 *
 * Runs inside the emulated Amiga, impersonates an AmiExpress (/X) BBS node for
 * an XIM door and relays everything to ENiGMA over the serial line, using the
 * framed protocol, version 1, of core/amiga_door/protocol.js (frames and keys in
 * misc/amiga_door/README.md).
 *
 * A CLI (stdio) door (`type=cli` in the session frame) is a
 * plain AmigaDOS program instead: the shim is the DOS handler behind its Input()
 * and Output() and answers the packets itself (reads from the caller, cooked or
 * raw, writes to the caller, WaitForChar, SetMode, Open("*")).  That part follows
 * the fake console handler in NilBBS's src/node/door.c (MIT, see the notice at
 * "CLI doors" below).
 *
 * An ARexx (AIM) door (`type=aim`) is an ARexx script written for
 * AmiExpress's REXXDOOR: the shim publishes the ARexx host port AERexxControl<node>, runs
 * `SYS:Rexxc/RX <script> <node>` and answers the script's host commands (GETUSER, PUTUSTR/
 * PUTUSER, TRANSMIT, SENDSTRING, GETCHAR, PROMPT, ...) from the same tables the XIM path uses.
 * It needs ARexx in the guest (RexxMast, rexxsyslib.library: Workbench 3.1, not AROS); the
 * library is opened only when an AIM session starts.  The command set follows NilBBS's
 * aim_command (src/node/door.c, MIT, notice at "ARexx (AIM) doors" below).
 *
 * A Paragon door (`type=tim`) speaks the Paragon door protocol that
 * Paragon, StarNet and MAX's BBS served and /X ran as TYPE=TIM: the shim publishes
 * DoorControl<line> (line = the node's last digit), runs `<door> <line>` and answers the
 * door's 106-byte DoorMsg requests (print, prompt, hotkey, user numbers and strings, show
 * file, random, add time, shutdown, and MAX's BBS's extensions) with the carrier flag set
 * once the caller is gone.
 *
 * A C-Net ARexx door (`type=cnetrexx`) is an ARexx pfile written for C-Net Amiga 3-5: the
 * shim publishes CNETREXX<port> (port = node - 1, as C-Net counts), hands REXX the script with
 * that port as its host address, as C-Net did, and answers C-Net's commands (TRANSMIT,
 * SENDSTRING, GETCHAR, MAYGETCHAR, PROMPT, QUERY, GETUSER, BBSIDENTIFY, ...) with C-Net's MCI
 * text codes, its GETUSER table and ###PANIC once the caller is gone.  The command set follows
 * NilBBS's C-Net host (src/node/door.c, MIT, notice at "CLI doors" below).
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
#include <dos/var.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include <rexx/storage.h>
#include <rexx/rxslib.h>
/* our own base, not libnix's RexxSysBase: referencing that one makes libnix open
 * rexxsyslib.library at start-up, and fail to start on an image without ARexx */
#define REXXSYSLIB_BASE_NAME axRexxBase
#define __NOLIBBASE__
#include <proto/rexxsyslib.h>
#undef __NOLIBBASE__
#include <stdarg.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <stddef.h>

#define SHIM_VERSION    "1.4"
#define PROTO_VERSION   1
static const char __attribute__((used)) verstag[] = "$VER: axshim " SHIM_VERSION " (17.10.2026)";

extern struct ExecBase *SysBase;
static struct Library *axRexxBase;    /* rexxsyslib: opened by the first AIM session, kept */

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

/* ---- DoorMsg and command numbers (Paragon; AmiExpress axobjects.e / axconsts.e, MAX's BBS) -- */

struct DoorMsg {
    struct Message msg;     /*   0 */
    WORD   command;         /*  20 */
    WORD   data;            /*  22 */
    char   string[80];      /*  24 */
    WORD   carrier;         /* 104: set in every reply once the caller is gone */
};                          /* 106 */
typedef char doormsg_is_106_bytes[sizeof(struct DoorMsg) == 106 ? 1 : -1];

enum {
    PG_SM = 1, PG_CO = 2, PG_SO = 3, PG_CC = 4, PG_CH = 5, PG_PM = 6, PG_SC = 7, PG_HK = 8,
    PG_TWIT = 9, PG_SF = 10, PG_FF = 11, PG_EF = 12, PG_UD = 13, PG_US = 14, PG_PS = 15,
    PG_CS = 16, PG_RD = 17, PG_CL = 18, PG_SG = 19, PG_SHUTDOWN = 20, PG_TM = 21,
    MX_MENU = 100, MX_CHANGEINT = 200, MX_CHECKKEY = 201, MX_PAGED = 202, MX_AUTOINSERT = 203
};

#define RS              0x1E
#define CARRIER_GRACE   30      /* seconds from `d` (or time-up) to X, whatever the door does */
#define BREAK_REPEAT    10      /* seconds between CTRL-C signals to a CLI door that will not end */
#define EXIT_GRACE      2       /* seconds for the process to end after the last JH_SHUTDOWN */
#define REG_TIMEOUT     30      /* default seconds a door has to send JH_REGISTER */
#define LONGNAME        33      /* a path component this long is refused (AROS 20250219 hang) */
#define CN_PANIC        "###PANIC"  /* C-Net's answer to every command once the caller is gone */
#define CN_DEPTH        6       /* C-Net MCI streams: a {* file} inside a file inside a TRANSMIT ... */
#define CN_FILEMAX      (256L * 1024)
#define CN_PANIC_GRACE  10      /* seconds from carrier loss to CTRL-C (NilBBS's panic_grace) */
#define CN_PANIC_MAX    25      /* below CARRIER_GRACE */
#define CN_BREAK_REPEAT 30      /* NilBBS: a second break only 30 s later (a save in progress) */
#define CN_POLL_USECS   40000   /* MAYGETCHAR waits this long for a key before NOCHAR */

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

/* a second request for a CLI door's WaitForChar() timeout, which is finer than the tick */
static struct MsgPort *wport;
static struct timerequest *wreq;
static BOOL wait_busy;

static ULONG wait_sigmask(void) { return wport ? 1UL << wport->mp_SigBit : 0; }

static BOOL wait_timer_open(void)
{
    if (!(wport = CreateMsgPort())) return FALSE;
    if (!(wreq = (struct timerequest *)CreateIORequest(wport, sizeof(struct timerequest)))) return FALSE;
    if (OpenDevice((STRPTR)TIMERNAME, UNIT_VBLANK, (struct IORequest *)wreq, 0)) {
        DeleteIORequest((struct IORequest *)wreq);
        wreq = NULL;
        return FALSE;
    }
    return TRUE;
}

static void wait_disarm(void)
{
    if (!wait_busy) return;
    AbortIO((struct IORequest *)wreq);
    WaitIO((struct IORequest *)wreq);
    wait_busy = FALSE;
}

static void wait_arm(ULONG usecs)
{
    wait_disarm();
    wreq->tr_node.io_Command = TR_ADDREQUEST;
    wreq->tr_time.tv_secs = usecs / 1000000UL;
    wreq->tr_time.tv_micro = usecs % 1000000UL;
    SendIO((struct IORequest *)wreq);
    wait_busy = TRUE;
}

static BOOL wait_expired(void)
{
    if (!wait_busy || !CheckIO((struct IORequest *)wreq)) return FALSE;
    WaitIO((struct IORequest *)wreq);
    wait_busy = FALSE;
    return TRUE;
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
/* a Paragon (TIM) door with crlf=1: CR, LF, CR LF and LF CR each go out as one CR LF (Paragon
 * doors end lines either way; MAX's BBS added the LF after a CR itself).  nl_pair is the byte
 * that would complete the newline just sent: swallowed once. */
static BOOL  tim_eol;
static UBYTE nl_pair;

static void out_bytes(const char *s, LONG n)
{
    LONG i;
    for (i = 0; i < n; i++) {
        UBYTE c = (UBYTE)s[i];
        if (tim_eol) {
            if (nl_pair && c == nl_pair) { nl_pair = 0; continue; }
            nl_pair = 0;
            if (c == '\r' || c == '\n') {
                tx_put('\r');
                tx_put('\n');
                last_out = '\n';
                nl_pair = c == '\r' ? '\n' : '\r';
                continue;
            }
        } else if (c == '\n' && crlf && last_out != '\r') tx_put('\r');
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
    BOOL  cli;                  /* a CLI door: in/out are the shim's handles, not NIL: */
    BPTR  in, out;              /* CLI: owned by the launcher once it runs (it closes them) */
    struct MsgPort *console;    /* CLI: the handler port, the door's console task */
    struct Task *self;          /* the launcher process (its packets are not the door's) */
    BOOL  cnet;                 /* a C-Net script: started with a RexxMsg to REXX, not a shell */
    char  spawn[200];           /* C-Net SPAWN: the script that takes the port when this one ends */
} LN = { .donesig = -1 };

static struct MsgPort *port;    /* AEDoorPort<node>, lives as long as a door may use it */
static struct MsgPort *hport;   /* CLI doors' handler port: made at start-up and never freed, so a
                                 * handle that outlives its session always gets an answer */
static ULONG hgen;              /* CLI session generation, kept in the handles' fh_Args */
#define H_IN        1           /* fh_Args = generation << 4 | one of these */
#define H_OUT       2
#define H_STAR      3           /* a handle the door opened itself (Open("*")) */
#define H_ID(a)     ((ULONG)(a) & 15)
#define H_GEN(a)    ((ULONG)(a) >> 4)
static char  portname[24];
static struct MsgPort *aport;   /* AERexxControl<node>, lives as long as an AIM script may use it */
static char  aportname[24];
static struct MsgPort *dport;   /* DoorControl<line>, lives as long as a Paragon door may use it */
static char  dportname[24];
static struct MsgPort *cport;   /* CNETREXX<port>, lives as long as a C-Net script may use it */
static char  cportname[24];
static BYTE  extsig = -1;      /* JH_SIGBIT: a door Signal()s it to wake a JH_ExtHK */

/* C-Net: a TRANSMIT / SENDSTRING / SENDFILE text or a {* file} going out through the MCI */
struct CnStream {
    struct RexxMsg *msg;        /* answered when the text is out (NULL for a {* file}) */
    UBYTE *buf;
    LONG   len, pos;
    UBYTE  wait;                /* MW_*: what it waits for */
};

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
    /* a CLI door (type=cli): the console handler's side of its Input() and Output() */
    struct {
        BOOL  on;               /* this session's door is a CLI door */
        BOOL  raw;              /* SetMode(fh, 1): bytes as typed, no echo */
        BOOL  eof_pending;      /* cooked: CTRL-\ on an empty line */
        BOOL  timedout;         /* no key for `timeout` seconds while the door wanted one */
        BOOL  broken;           /* the door was told to go (reads EOF, CTRL-C sent) */
        UBYTE esc;              /* cooked: 1 after ESC, 2 inside a CSI sequence (dropped) */
        struct Task *door;      /* who sends us packets on the session's own handles */
        struct DosPacket *readq[8];
        int   nread;
        struct DosPacket *waitpkt;      /* a parked ACTION_WAIT_CHAR */
        UBYTE line[256];        /* cooked: the line being typed */
        int   linelen;
        UBYTE ready[512];       /* finished lines (cooked) not yet read */
        int   readylen;
        LONG  opens;            /* Open("*") handles still open */
        ULONG last_key, want_at, dead_at, sig_at;
    } cli;
    /* an ARexx (AIM) door (type=aim): the host side of the script's AERexxControl<node> */
    struct {
        BOOL  on;
        struct RexxMsg *waiting;        /* GETCHAR / PROMPT / QUERY waiting for the caller */
        UBYTE wait_kind;                /* WK_HK one key, WK_LINE a line */
        char  obj[200];                 /* PUTUSTR: what the next PUTUSER stores */
        LONG  qmax;                     /* RECEIVE n: QUERY / PROMPT take n-1 characters (100) */
        struct Task *script;            /* the script's process (it sends the commands) */
        BOOL  shutdown;                 /* SHUTDOWN seen */
        ULONG shutdown_at;
        BOOL  timedout;                 /* keyboard timeout: every later command gets rc 10 */
        BOOL  broken;                   /* dead (d, time up, timeout): CTRL-C until it ends */
        ULONG dead_at, sig_at;
        char  verbs[200];               /* distinct verbs, for X verbs= */
        char  unknown[128];             /* distinct unknown verbs, for X unknown= */
    } aim;
    /* a Paragon door (type=tim): the BBS side of its DoorControl<line> */
    struct {
        BOOL  on;
        LONG  line;                     /* 0-9: the node's last digit, the door's argv[1][0] */
        struct DoorMsg *waiting;        /* PG_PM / PG_SC / PG_HK waiting for the caller */
        UBYTE wait_kind;                /* WK_HK one key, WK_LINE a line */
        struct DoorMsg *editing;        /* PG_EF waiting for `e` */
        struct Task *door;              /* the door's task (it owns the reply port) */
        BOOL  shutdown;                 /* PG_SHUTDOWN seen */
        ULONG shutdown_at;
        BOOL  timedout;                 /* no key for `timeout` s: the carrier is gone for good */
        BOOL  broken;                   /* dead (d, time up, timeout, twit): CTRL-C until it ends */
        ULONG dead_at, sig_at;
        LONG  addtime;                  /* minutes PG_TM added (X addtime=) */
        ULONG seed;                     /* PG_RD */
        BOOL  short_seen;               /* a request shorter than a DoorMsg (X shortmsg=) */
        UWORD short_len;                /* the first such mn_Length */
    } tim;
    /* a C-Net ARexx door (type=cnetrexx): the host side of the script's CNETREXX<port> */
    struct {
        BOOL  on;
        struct RexxMsg *waiting;        /* GETCHAR / MAYGETCHAR / QUERY / PROMPT waiting */
        UBYTE wait_kind;                /* CK_* */
        BOOL  qhide;                    /* PROMPT HIDE: echo * */
        UBYTE qdef;                     /* PROMPT YESNO 1 / NOYES 0: what Enter answers */
        char  obj[200];                 /* SETOBJECT: what the next PUTUSER stores */
        struct Task *script;
        BOOL  timedout, broken;
        ULONG dead_at, sig_at;
        LONG  panicgrace;               /* seconds from carrier loss to the first CTRL-C */
        ULONG last_key, want_at;        /* the keyboard timeout; want_at: MAYGETCHAR's last poll */
        BOOL  wrap;                     /* word wrap at the caller's width */
        LONG  col;                      /* the cursor's column, -1 unknown */
        BOOL  wordstart;
        UBYTE esc;                      /* inside an escape sequence the door sent */
        UBYTE escn;                     /* its parameter count (9: not a cursor movement) */
        LONG  escp[2], savedcol;        /* its first two parameters; ESC[s's column */
        UBYTE fg, bg;
        BOOL  bold;
        struct CnStream st[CN_DEPTH];
        int   nst;
        UBYTE mreg, mdef;               /* {Gn}: register; {?n}: Enter's answer */
        UWORD mflags;                   /* {In m} */
        LONG  mmax;
        ULONG muntil;                   /* {Wn} */
        char  sreg[5][84];              /* MCI string registers (GETUSER 70-74) */
        LONG  nreg[10];                 /* MCI numeric registers (GETUSER 60-69) */
        char  uov[64][48];              /* PUTUSER n (n < 64): GETUSER n for the rest of the session */
        BOOL  uovset[64];
        LONG  points, addpoints, addtime;
        BOOL  scratch;                  /* LOADSCRATCH of the caller's own account */
        char  where[48];                /* CHANGEWHERE */
        char  verbs[480];               /* distinct verbs, for X verbs= */
        char  unknown[128];             /* distinct unknown verbs, for X unknown= */
    } cn;
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
        if (state == ST_SESSION && (S.editing || S.tim.editing) && S.edit_answer < 0)
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
#define RX_CMD   "SYS:Rexxc/RX"     /* runs an AIM door's script, as /X's REXXDOOR did */

static LONG cn_launch_script(BPTR in, BPTR out);

static void launcher(void)
{
    BPTR in, out, dl, od = 0;
    LN.self = FindTask(NULL);
    if (LN.cli) {               /* the shim's handles: closing them is an ACTION_END to the shim */
        in = LN.in;
        out = LN.out;
    } else {
        in = Open((STRPTR)"NIL:", MODE_OLDFILE);
        out = Open((STRPTR)DOOR_OUT, MODE_NEWFILE);
        if (!out) out = Open((STRPTR)"NIL:", MODE_NEWFILE);
    }
    dl = LN.dir[0] ? Lock((STRPTR)LN.dir, ACCESS_READ) : 0;
    if (dl) od = CurrentDir(dl);
    if (LN.cnet)                /* a C-Net script: REXX runs it, with our port as its host */
        LN.rc = cn_launch_script(in, out);
    else if (LN.cli)            /* Open("*") from the door comes to the handler port too */
        LN.rc = SystemTags((STRPTR)LN.cmd,
                           SYS_Input, in, SYS_Output, out,
                           NP_ConsoleTask, (ULONG)LN.console,
                           NP_StackSize, LN.stack, NP_Priority, 0,
                           TAG_END);
    else
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

/* AIM: the line of RX's / ARexx's output that says what went wrong: the first "+++" line
 * ("+++ Error 41 in line 51: Invalid expression", "+++ Command returned 10"), else the last */
static void script_stdout(char *out, int max)
{
    char line[160];
    BPTR fh = Open((STRPTR)DOOR_OUT, MODE_OLDFILE);
    out[0] = 0;
    if (!fh) return;
    while (FGets(fh, (STRPTR)line, sizeof(line))) {
        char *p = line;
        int n = strlen(line);
        while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
        while (*p == ' ' || *p == '\t') p++;
        if (!*p) continue;
        strncpy(out, p, max - 1);
        out[max - 1] = 0;
        if (!strncmp(p, "+++", 3)) break;
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
static void aim_reply(struct RexxMsg *m, LONG rc, const char *res, LONG len);

/* the AIM host port: after its session every command gets rc 10 (REXXDOOR is gone) */
static void aport_close(void)
{
    struct RexxMsg *m;
    if (!aport) return;
    Forbid();
    RemPort(aport);
    while ((m = (struct RexxMsg *)GetMsg(aport))) aim_reply(m, 10, NULL, 0);
    Permit();
    DeleteMsgPort(aport);
    aport = NULL;
}

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

static void tim_zombie(struct DoorMsg *m);
static void cport_close(void);

static BOOL dport_open(LONG line)
{
    sprintf(dportname, "DoorControl%ld", (long)line);
    Forbid();
    if (FindPort((STRPTR)dportname)) { Permit(); return FALSE; }
    if ((dport = CreateMsgPort())) {
        dport->mp_Node.ln_Name = dportname;
        dport->mp_Node.ln_Pri = 0;
        AddPort(dport);
    }
    Permit();
    return dport != NULL;
}

/* the Paragon port: after its session every request gets the carrier-lost answer */
static void dport_close(void)
{
    struct DoorMsg *m;
    if (!dport) return;
    Forbid();
    RemPort(dport);
    while ((m = (struct DoorMsg *)GetMsg(dport))) tim_zombie(m);
    Permit();
    DeleteMsgPort(dport);
    dport = NULL;
}

/* the launcher finished: free what it used, and the port if no session needs it */
static void reap(void)
{
    if (!LN.busy || !LN.done) return;
    if (LN.donesig >= 0) { FreeSignal(LN.donesig); LN.donesig = -1; }
    LN.busy = FALSE;
    if (state != ST_SESSION) { port_close(); aport_close(); dport_close(); cport_close(); DeleteFile((STRPTR)DOOR_OUT); }
}

/* XIM: `"door" <node> args`.  CLI: `"door" args` (no node number; a CLI door takes what
 * its own documentation says, which the host puts in args).  AIM: `RX door <node>`.  TIM:
 * `"door" <line>`.  in/out: CLI handles. */
static BOOL launch(const char *door, BPTR in, BPTR out)
{
    char *slash;
    const char *dir = get("dir", NULL);
    memset(LN.cmd, 0, sizeof(LN.cmd));
    LN.cli = S.cli.on;
    LN.cnet = S.cn.on;
    LN.spawn[0] = 0;
    LN.in = in;
    LN.out = out;
    LN.console = hport;
    LN.self = NULL;
    if (LN.cli) snprintf(LN.cmd, sizeof(LN.cmd), "\"%s\" %s", door, get("args", ""));
    else if (S.aim.on) {        /* REXXDOOR's "RX <script> <node>"; no trailing blank: PARSE ARG
                                 * NODE keeps it, and "AERexxControl0 " names no port */
        const char *args = get("args", "");
        snprintf(LN.cmd, sizeof(LN.cmd), strchr(door, ' ') ? "%s \"%s\" %ld%s%s" : "%s %s %ld%s%s",
                 RX_CMD, door, (long)S.node, *args ? " " : "", args);
    } else if (S.cn.on) {       /* C-Net: "<script>[ args]" in a RexxMsg; pfiles get no port number */
        const char *args = get("args", "");
        snprintf(LN.cmd, sizeof(LN.cmd), "%s%s%s", door, *args ? " " : "", args);
    } else if (S.tim.on) {      /* Paragon: "<door> <line>"; the door reads argv[1][0] */
        const char *args = get("args", "");
        snprintf(LN.cmd, sizeof(LN.cmd), "\"%s\" %ld%s%s", door, (long)S.tim.line, *args ? " " : "", args);
    } else snprintf(LN.cmd, sizeof(LN.cmd), "\"%s\" %ld %s", door, (long)S.node, get("args", ""));
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
static void cli_flush(void);
static BPTR cli_handle(ULONG id);
static struct Task *cli_zombie;         /* a CLI door that outlived its session */
static ULONG cli_zombie_sig;
static void reply(struct JHMessage *m) { ReplyMsg((struct Message *)m); }

static void cn_reset(void);

/* X, then back to R.  status: ok carrier timeout break error */
static void end_session(const char *status, const char *error)
{
    char b[16];
    int i;
    UWORD o;

    if (S.waiting) fail_waiting(FALSE);
    if (S.editing) { S.editing->Data = -1; reply(S.editing); S.editing = NULL; }
    if (S.cli.on) cli_flush();  /* reads EOF; later packets get the zombie answers */
    if (S.aim.waiting) { aim_reply(S.aim.waiting, 10, NULL, 0); S.aim.waiting = NULL; }
    if (S.tim.waiting) { tim_zombie(S.tim.waiting); S.tim.waiting = NULL; }
    if (S.tim.editing) { tim_zombie(S.tim.editing); S.tim.editing = NULL; }
    if (S.cn.waiting) { wait_disarm(); aim_reply(S.cn.waiting, 0, CN_PANIC, 8); S.cn.waiting = NULL; }
    if (S.cn.on) cn_reset();
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
    if (S.nunknown || S.aim.unknown[0] || S.cn.unknown[0]) {
        f_kv("unknown", "");
        o = flen;
        for (i = 0; i < S.nunknown; i++) {
            sprintf(b, "%s%ld", flen > o ? " " : "", (long)S.unknown[i]);
            f_str(b);
        }
        if (S.aim.unknown[0]) {         /* AIM: verbs the shim does not know */
            if (flen > o) f_byte(' ');
            f_str(S.aim.unknown);
        }
        if (S.cn.unknown[0]) {          /* C-Net: the same */
            if (flen > o) f_byte(' ');
            f_str(S.cn.unknown);
        }
    }
    if (S.aim.on || S.cn.on) {
        f_kv("verbs", S.aim.on ? S.aim.verbs : S.cn.verbs);
        if (S.launched && LN.done && LN.rc) {   /* what RX or ARexx said (+++ Error ...) */
            char out[160];
            script_stdout(out, sizeof(out));
            if (out[0]) f_kv("out", out);
        }
    }
    if (S.tim.on && S.tim.addtime) f_kvn("addtime", S.tim.addtime);
    if (S.tim.on && S.tim.short_seen) f_kvn("shortmsg", S.tim.short_len);
    if (S.cn.on && S.cn.addtime) f_kvn("addtime", S.cn.addtime / 10);
    if (S.cn.on && S.cn.addpoints) f_kvn("addpoints", S.cn.addpoints);
    if (S.cn.on && S.cn.where[0]) f_kv("where", S.cn.where);
    if (changed[0]) f_kv("changed", changed);
    if (S.dtr) f_kvn("dropdtr", 1);
    if (S.indrop) f_kvn("indrop", (LONG)S.indrop);
    if (tx_polled) f_kvn("txpoll", 1);
    f_end();

    state = ST_READY;
    inq_head = inq_tail = 0;
    if (LN.busy && LN.done) reap();
    if (!LN.busy) { port_close(); aport_close(); dport_close(); cport_close(); DeleteFile((STRPTR)DOOR_OUT); }
    /* else the door outlived the session: the port stays up and answers "carrier lost" */
    if (S.cli.on && LN.busy && !LN.done) { cli_zombie = S.cli.door; cli_zombie_sig = now_s; }
    if (S.aim.on && LN.busy && !LN.done) { cli_zombie = S.aim.script; cli_zombie_sig = now_s; }
    if (S.tim.on && LN.busy && !LN.done) { cli_zombie = S.tim.door; cli_zombie_sig = now_s; }
    if (S.cn.on && LN.busy && !LN.done) { cli_zombie = S.cn.script; cli_zombie_sig = now_s; }
    tim_eol = FALSE;
    nl_pair = 0;
    memset(&S, 0, sizeof(S));
    nkv = 0;
    emit_ready();
}

static void error_session(const char *error) { end_session("error", error); }

static const char *aim_open(LONG node);
static const char *cn_open(void);

/* `assign=NAME=PATH[;NAME=PATH...]` and `env=NAME=VALUE[;NAME=VALUE...]`: what a
 * door's installation asks of the sysop's Startup-Sequence (Master Space Empire: an MSE: assign
 * and the variable MSE).  Any door type; a session without them changes nothing. */
static const char *session_env(void)
{
    static char err[80];
    char buf[200], *p, *e, *eq;
    const char *v;
    BPTR l;
    int n;

    if ((v = get("assign", NULL)) && *v) {
        strncpy(buf, v, sizeof(buf) - 1);
        buf[sizeof(buf) - 1] = 0;
        for (p = buf; p && *p; p = e) {
            if ((e = strchr(p, ';'))) *e++ = 0;
            if (!(eq = strchr(p, '=')) || eq == p) return "bad assign";
            *eq++ = 0;
            n = strlen(p);
            if (n && p[n - 1] == ':') p[--n] = 0;
            if (!n || n > 30 || strchr(p, ':') || strchr(p, '/')) return "bad assign";
            if (!*eq || !path_ok(eq) || !(l = Lock((STRPTR)eq, ACCESS_READ))) {
                snprintf(err, sizeof(err), "assign %s: %s not found", p, eq);
                return err;
            }
            if (!AssignLock((STRPTR)p, l)) {
                UnLock(l);
                snprintf(err, sizeof(err), "assign %s: failed", p);
                return err;
            }
        }
    }
    if ((v = get("env", NULL)) && *v) {
        if ((l = Lock((STRPTR)"ENV:", ACCESS_READ))) UnLock(l);
        else {                  /* no ENV: on a minimal image: one in RAM: */
            if ((l = CreateDir((STRPTR)"RAM:Env"))) UnLock(l);
            if (!(l = Lock((STRPTR)"RAM:Env", ACCESS_READ))) return "no ENV:";
            if (!AssignLock((STRPTR)"ENV", l)) { UnLock(l); return "no ENV:"; }
        }
        strncpy(buf, v, sizeof(buf) - 1);
        buf[sizeof(buf) - 1] = 0;
        for (p = buf; p && *p; p = e) {
            if ((e = strchr(p, ';'))) *e++ = 0;
            if (!(eq = strchr(p, '=')) || eq == p || strchr(p, ':') || strchr(p, '/')) return "bad env";
            *eq++ = 0;
            if (!SetVar((STRPTR)p, (STRPTR)eq, -1, GVF_GLOBAL_ONLY)) {
                snprintf(err, sizeof(err), "env %s: failed", p);
                return err;
            }
        }
    }
    return NULL;
}

static void start_session(void)
{
    const char *door, *v, *type;
    BPTR l, in = 0, out = 0;

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
    type = get("type", "xim");
    if (!strcmp(type, "cli")) S.cli.on = TRUE;
    else if (!strcmp(type, "aim")) S.aim.on = TRUE;
    else if (!strcmp(type, "tim")) S.tim.on = TRUE;
    else if (!strcmp(type, "cnetrexx")) S.cn.on = TRUE;
    else if (*type && strcmp(type, "xim")) { error_session("unknown door type"); return; }
    if (S.cli.on) {                     /* the console's mode before the door's first SetMode() */
        v = get("console", "cooked");
        if (!strcmp(v, "raw")) S.cli.raw = TRUE;
        else if (*v && strcmp(v, "cooked")) { error_session("unknown console mode"); return; }
    }
    door = get("door", "");
    if (!*door) { error_session("no door"); return; }
    if (LN.busy) { error_session("busy: the previous door is still running"); return; }
    if (!path_ok(door)) { error_session("door path has a name of 33 or more characters"); return; }
    if ((v = session_env())) { error_session(v); return; }     /* the door path may use an assign */
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
    tim_eol = S.tim.on && crlf;
    nl_pair = 0;
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
    S.cli.last_key = now_s;

    if (S.cli.on) {                     /* the door's Input() and Output(): our handles */
        hgen++;
        if (!hport || !(in = cli_handle(H_IN)) || !(out = cli_handle(H_OUT))) {
            if (in) FreeDosObject(DOS_FILEHANDLE, BADDR(in));
            S.cli.on = FALSE;
            error_session("cannot make the door's console handles");
            return;
        }
    } else if (S.aim.on) {
        const char *err = aim_open(S.node);
        if (err) { error_session(err); return; }
    } else if (S.cn.on) {
        const char *err;
        S.cn.panicgrace = geti("panicgrace", CN_PANIC_GRACE);
        if (S.cn.panicgrace < 0) S.cn.panicgrace = 0;
        if (S.cn.panicgrace > CN_PANIC_MAX) S.cn.panicgrace = CN_PANIC_MAX;
        S.cn.wrap = geti("wrap", 1) != 0;
        S.cn.wordstart = TRUE;
        S.cn.fg = 7;
        S.cn.last_key = now_s;
        if ((err = cn_open())) { error_session(err); return; }
    } else if (S.tim.on) {
        S.tim.line = (S.node < 0 ? -S.node : S.node) % 10;
        S.tim.seed = now_s * 69069UL + sys_secs();
        if (!dport_open(S.tim.line)) { error_session("door port busy"); return; }
    } else if (!port_open(S.node)) { error_session("door port busy"); return; }
    if (!launch(door, in, out)) {
        if (S.cli.on) {
            FreeDosObject(DOS_FILEHANDLE, BADDR(in));
            FreeDosObject(DOS_FILEHANDLE, BADDR(out));
            S.cli.on = FALSE;
        } else if (S.aim.on) aport_close();
        else if (S.tim.on) dport_close();
        else if (S.cn.on) cport_close();
        else port_close();
        error_session("cannot start the launcher");
        return;
    }
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

/* answer m in place; FALSE: it waits (input, JH_EF) and is replied to later */
static BOOL xim_answer(struct JHMessage *m)
{
    LONG cmd = m->Command, linenum = m->LineNum;
    UWORD len = m->msg.mn_Length;
    char s[220];

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
        return FALSE;
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
        return FALSE;
    case JH_ExtHK:      park_input(m, WK_EXTHK); return FALSE;
    case JH_20: case QUICK_KEY: park_input(m, WK_RAWKEY); return FALSE;
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
        return FALSE;
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
    return TRUE;
}

static void xim_command(struct JHMessage *m)
{
    S.cmds++;
    mark_seen(m->Command);
    if (S.log) log_cmd(m);
    if (xim_answer(m)) reply(m);
}

/* ---- CLI doors: the shim is the DOS handler behind the door's Input() and Output() ---------
 *
 * A CLI door is started (SystemTags) with Input() and Output() on two file handles whose
 * handler is hport, and with hport as its console task, so Open("*") comes here too.  The shim
 * answers the packets itself:
 *
 *   ACTION_READ         from the caller: cooked (line editing and echo, as the Amiga console
 *                       does; CR ends a line, the door gets it with LF) or raw (bytes as typed)
 *   ACTION_WRITE        to the caller, unframed, exactly like XIM door output
 *   ACTION_SCREEN_MODE  SetMode(): 0 cooked, anything else raw
 *   ACTION_WAIT_CHAR    WaitForChar() with its timeout (a cooked console has a key when it has
 *                       a whole line)
 *   ACTION_FINDINPUT/OUTPUT/UPDATE   Open("*") / Open("CONSOLE:"): another interactive handle
 *   ACTION_END, FLUSH, CHANGE_SIGNAL  accepted; IS_FILESYSTEM false; anything else refused
 *
 * When the session is over for the door (`d`, time up, input timeout), reads return EOF (0),
 * WaitForChar says yes (so a polling door reads the EOF), writes fail (-1), and the door gets
 * CTRL-C (and D, E, F once), CTRL-C again every BREAK_REPEAT seconds.
 *
 * The handler's packet set and its cooked-mode editor follow NilBBS's fake console handler
 * (src/node/door.c, https://github.com/lainejones/NilBBS), whose licence applies to those parts:
 *
 *   Copyright (c) 2026 Laine Jones
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this
 *   software and associated documentation files (the "Software"), to deal in the Software
 *   without restriction, including without limitation the rights to use, copy, modify, merge,
 *   publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
 *   to whom the Software is furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 *   INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
 *   PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
 *   FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 *   OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 *   DEALINGS IN THE SOFTWARE.
 */

#define CLI_ERR     ERROR_OBJECT_NOT_FOUND  /* a failed write: never a disk error (requesters) */

static BPTR cli_handle(ULONG id)
{
    struct FileHandle *fh = (struct FileHandle *)AllocDosObject(DOS_FILEHANDLE, NULL);
    if (!fh) return 0;
    fh->fh_Type = hport;
    fh->fh_Port = (struct MsgPort *)DOSTRUE;    /* interactive: IsInteractive() is true */
    fh->fh_Args = (LONG)((hgen << 4) | id);
    return MKBADDR(fh);
}

/* signal t if it is still a task: a door that has ended must not be Signal()led */
static void cli_signal(struct Task *t, ULONG sigs)
{
    struct Node *n;
    BOOL found = FALSE;
    if (!t) return;
    Forbid();                   /* the list walk and the Signal() under one Forbid() */
    for (n = SysBase->TaskReady.lh_Head; !found && n->ln_Succ; n = n->ln_Succ) found = (struct Task *)n == t;
    for (n = SysBase->TaskWait.lh_Head; !found && n->ln_Succ; n = n->ln_Succ) found = (struct Task *)n == t;
    if (found) Signal(t, sigs);
    Permit();
}

static BOOL cli_dead(void) { return S.lost || S.timeup || S.cli.timedout; }

/* the next caller byte for the door, -1 = none: LF or NUL right after CR is telnet's CR LF /
 * CR NUL and is swallowed (Return is one CR on an Amiga), DEL is backspace */
static int cli_byte(void)
{
    int c;
    for (;;) {
        if ((c = inq_get()) < 0) return -1;
        if (last_cr && (c == '\n' || c == 0)) { last_cr = FALSE; continue; }
        last_cr = (c == '\r');
        S.cli.last_key = now_s;
        return c == 0x7F ? 8 : c;
    }
}

/* raw: is a byte there that cli_byte() will not swallow? */
static BOOL cli_raw_avail(void)
{
    while (inq_tail != inq_head) {
        UBYTE c = inq[inq_tail];
        if (!(last_cr && (c == '\n' || c == 0))) return TRUE;
        inq_tail = (inq_tail + 1) & (INQSIZE - 1);
        last_cr = FALSE;
    }
    return FALSE;
}

/* cooked mode: the console's line editor over whatever the caller typed, echoing as it goes.
 * Backspace/DEL rubs out, CTRL-U/X kill the line, CR or LF ends it, CTRL-\ on an empty line is
 * end of file, CTRL-C/D/E/F signal the door, escape sequences (cursor keys) are dropped. */
static void cli_cooked(void)
{
    int c;
    while (S.cli.readylen + (int)sizeof(S.cli.line) + 1 <= (int)sizeof(S.cli.ready)
           && (c = cli_byte()) >= 0) {
        if (S.cli.esc == 1) {
            S.cli.esc = 0;
            if (c == '[' || c == 'O') { S.cli.esc = 2; continue; }
        } else if (S.cli.esc == 2) {
            if (c >= 0x40 && c <= 0x7E) S.cli.esc = 0;
            continue;
        }
        if (c == 27) { S.cli.esc = 1; continue; }
        if (c == 0x9B) { S.cli.esc = 2; continue; }
        if (c == '\r' || c == '\n') {
            memcpy(S.cli.ready + S.cli.readylen, S.cli.line, S.cli.linelen);
            S.cli.readylen += S.cli.linelen;
            S.cli.ready[S.cli.readylen++] = '\n';
            S.cli.linelen = 0;
            out_bytes("\r\n", 2);
        } else if (c == 8) {
            if (S.cli.linelen > 0) { S.cli.linelen--; out_bytes("\b \b", 3); }
        } else if (c == 21 || c == 24) {
            while (S.cli.linelen > 0) { S.cli.linelen--; out_bytes("\b \b", 3); }
        } else if (c >= 3 && c <= 6) {          /* CTRL-C D E F */
            cli_signal(S.cli.door, SIGBREAKF_CTRL_C << (c - 3));
            if (c == 3) out_bytes("^C", 2);
        } else if (c == 28) {
            if (S.cli.linelen == 0) S.cli.eof_pending = TRUE;
        } else if (((c >= 32 && c < 127) || c >= 0xA0) && S.cli.linelen < (int)sizeof(S.cli.line) - 1) {
            char b = (char)c;
            S.cli.line[S.cli.linelen++] = (UBYTE)c;
            out_bytes(&b, 1);
        }
    }
}

static BOOL cli_input_ready(void)
{
    if (cli_dead() || S.cli.readylen > 0) return TRUE;
    return S.cli.raw ? cli_raw_avail() : S.cli.eof_pending;
}

/* answer the oldest read if it can be answered */
static BOOL cli_serve_read(struct DosPacket *p)
{
    UBYTE *buf = (UBYTE *)p->dp_Arg2;
    LONG want = p->dp_Arg3, got = 0;
    int c;
    if (cli_dead() || want <= 0) { ReplyPkt(p, 0, 0); return TRUE; }
    if (S.cli.readylen > 0) {   /* lines (or bytes typed before SetMode raw) first */
        got = S.cli.readylen < want ? S.cli.readylen : want;
        memcpy(buf, S.cli.ready, got);
        memmove(S.cli.ready, S.cli.ready + got, S.cli.readylen - got);
        S.cli.readylen -= got;
    } else if (S.cli.raw) {
        while (got < want && (c = cli_byte()) >= 0) buf[got++] = (UBYTE)c;
        if (!got) return FALSE;
    } else {
        if (!S.cli.eof_pending) return FALSE;
        S.cli.eof_pending = FALSE;  /* got = 0: end of file */
    }
    ReplyPkt(p, got, 0);
    return TRUE;
}

/* the door is done for (d, time up, input timeout): every pending read gets EOF */
static void cli_flush(void)
{
    while (S.cli.nread > 0) ReplyPkt(S.cli.readq[--S.cli.nread], 0, 0);
    if (S.cli.waitpkt) { ReplyPkt(S.cli.waitpkt, DOSTRUE, 0); S.cli.waitpkt = NULL; }
    wait_disarm();
}

static void cli_service(void)
{
    if (!cli_dead() && !S.cli.raw) cli_cooked();
    while (S.cli.nread > 0 && cli_serve_read(S.cli.readq[0])) {
        memmove(S.cli.readq, S.cli.readq + 1, (S.cli.nread - 1) * sizeof(S.cli.readq[0]));
        S.cli.nread--;
    }
    if (S.cli.waitpkt) {
        if (cli_input_ready()) {
            ReplyPkt(S.cli.waitpkt, DOSTRUE, 0);
            S.cli.waitpkt = NULL;
            wait_disarm();
        } else if (wait_expired()) {
            ReplyPkt(S.cli.waitpkt, DOSFALSE, 0);
            S.cli.waitpkt = NULL;
        }
    }
}

/* a packet for a handle of no live session (a door that outlived its session, a stale
 * Open("*") handle): end of file, failed writes, nothing to wait for */
static void cli_zombie_packet(struct DosPacket *p)
{
    switch (p->dp_Type) {
    case ACTION_READ:           ReplyPkt(p, 0, 0); break;
    case ACTION_WRITE:          ReplyPkt(p, -1, CLI_ERR); break;
    case ACTION_FINDINPUT: case ACTION_FINDOUTPUT: case ACTION_FINDUPDATE: {
        struct FileHandle *fh = (struct FileHandle *)BADDR(p->dp_Arg1);
        fh->fh_Port = (struct MsgPort *)DOSTRUE;
        fh->fh_Args = 0;        /* generation 0 is never live */
        ReplyPkt(p, DOSTRUE, 0);
        break;
    }
    case ACTION_WAIT_CHAR: case ACTION_SCREEN_MODE: case ACTION_END:
    case ACTION_FLUSH: case ACTION_CHANGE_SIGNAL:
        ReplyPkt(p, DOSTRUE, 0);
        break;
    case ACTION_IS_FILESYSTEM:  ReplyPkt(p, DOSFALSE, 0); break;
    default:                    ReplyPkt(p, DOSFALSE, ERROR_ACTION_NOT_KNOWN); break;
    }
}

static void cli_packet(struct DosPacket *p)
{
    LONG type = p->dp_Type;
    BOOL live = state == ST_SESSION && S.cli.on;

    /* READ, WRITE and END name their handle: one of an earlier session is a zombie */
    if (live && (type == ACTION_READ || type == ACTION_WRITE || type == ACTION_END)
        && H_GEN(p->dp_Arg1) != hgen)
        live = FALSE;
    if (!live) { cli_zombie_packet(p); return; }

    /* the process reading and writing the session's own handles is the door (and its shell) */
    if ((type == ACTION_READ || type == ACTION_WRITE) && H_ID(p->dp_Arg1) != H_STAR
        && p->dp_Port && p->dp_Port->mp_SigTask && (struct Task *)p->dp_Port->mp_SigTask != LN.self)
        S.cli.door = (struct Task *)p->dp_Port->mp_SigTask;

    switch (type) {
    case ACTION_READ:
        S.cli.want_at = now_s;
        if (cli_dead()) ReplyPkt(p, 0, 0);
        else if (S.cli.nread < (int)(sizeof(S.cli.readq) / sizeof(S.cli.readq[0])))
            S.cli.readq[S.cli.nread++] = p;
        else ReplyPkt(p, -1, ERROR_NO_FREE_STORE);
        break;

    case ACTION_WRITE:
        if (cli_dead()) { ReplyPkt(p, -1, CLI_ERR); break; }
        if (p->dp_Arg3 > 0) out_bytes((const char *)p->dp_Arg2, p->dp_Arg3);
        ReplyPkt(p, p->dp_Arg3 > 0 ? p->dp_Arg3 : 0, 0);
        break;

    case ACTION_SCREEN_MODE:            /* SetMode(fh, mode) */
        if (p->dp_Arg1 && !S.cli.raw && S.cli.linelen) {
            /* to raw with a line half typed: the door reads those bytes first */
            memcpy(S.cli.ready + S.cli.readylen, S.cli.line, S.cli.linelen);
            S.cli.readylen += S.cli.linelen;
            S.cli.linelen = 0;
        }
        S.cli.raw = p->dp_Arg1 != 0;
        S.cli.esc = 0;
        ReplyPkt(p, DOSTRUE, 0);
        break;

    case ACTION_WAIT_CHAR: {            /* dp_Arg1 = microseconds */
        LONG usecs = p->dp_Arg1;
        S.cli.want_at = now_s;
        if (!cli_dead() && !S.cli.raw) cli_cooked();
        if (cli_input_ready()) ReplyPkt(p, DOSTRUE, 0);
        else if (usecs <= 0) ReplyPkt(p, DOSFALSE, 0);
        else {
            if (S.cli.waitpkt) ReplyPkt(S.cli.waitpkt, DOSFALSE, 0);
            S.cli.waitpkt = p;
            wait_arm((ULONG)usecs);
        }
        break;
    }

    case ACTION_FINDINPUT: case ACTION_FINDOUTPUT: case ACTION_FINDUPDATE: {
        struct FileHandle *fh = (struct FileHandle *)BADDR(p->dp_Arg1);
        fh->fh_Port = (struct MsgPort *)DOSTRUE;
        fh->fh_Args = (LONG)((hgen << 4) | H_STAR);
        S.cli.opens++;
        ReplyPkt(p, DOSTRUE, 0);
        break;
    }

    case ACTION_END:
        if (H_ID(p->dp_Arg1) == H_STAR && S.cli.opens > 0) S.cli.opens--;
        ReplyPkt(p, DOSTRUE, 0);
        break;

    case ACTION_FLUSH: case ACTION_CHANGE_SIGNAL:
        ReplyPkt(p, DOSTRUE, 0);
        break;

    case ACTION_IS_FILESYSTEM:
        ReplyPkt(p, DOSFALSE, 0);
        break;

    default:                            /* DISK_INFO, SEEK, EXAMINE_FH, LOCATE_OBJECT, ... */
        mark_unknown(type);
        ReplyPkt(p, DOSFALSE, ERROR_ACTION_NOT_KNOWN);
        break;
    }
}

static void hport_drain(void)
{
    struct Message *m;
    if (!hport) return;
    while ((m = GetMsg(hport))) cli_packet((struct DosPacket *)m->mn_Node.ln_Name);
}

/* the CLI half of session_service(): input, the door's end, X */
static void cli_session_service(void)
{
    BOOL ended = FALSE;

    if (!S.timeup && time_left() <= 0) { S.timeup = TRUE; S.timeup_at = now_s; }
    /* the inactivity timeout runs while the door waits for a key: a read is parked, or it
     * polled WaitForChar() within the last 2 seconds */
    if (!cli_dead() && S.timeout > 0 && (S.cli.nread > 0 || now_s - S.cli.want_at <= 2)
        && now_s - S.cli.last_key >= (ULONG)S.timeout) {
        S.cli.timedout = TRUE;
        S.input_failed = TRUE;
    }
    hport_drain();
    cli_service();

    if (cli_dead()) {                   /* tell the door to go: EOF, then CTRL-C until it does */
        if (!S.cli.broken) {
            S.cli.broken = TRUE;
            S.cli.dead_at = now_s;
            S.cli.sig_at = now_s;
            cli_flush();
            cli_signal(S.cli.door, SIGBREAKF_CTRL_C | SIGBREAKF_CTRL_D | SIGBREAKF_CTRL_E | SIGBREAKF_CTRL_F);
        } else if (now_s - S.cli.sig_at >= BREAK_REPEAT && !LN.done) {
            S.cli.sig_at = now_s;
            cli_signal(S.cli.door, SIGBREAKF_CTRL_C);
        }
    }

    if (LN.done) {                      /* System() returned: the door has ended */
        hport_drain();
        if (LN.rc == -1 && !S.lost) { reap(); error_session("the door could not be started"); return; }
        ended = TRUE;
    } else if (S.cli.broken && now_s - S.cli.dead_at >= CARRIER_GRACE) {
        ended = TRUE;
    }
    if (!ended) return;

    if (S.lost == LOST_HANGUP) end_session("carrier", NULL);
    else if (S.lost == LOST_TIMEUP) end_session("timeout", NULL);
    else if (S.lost == LOST_BREAK) end_session("break", NULL);
    else if (S.timeup || S.cli.timedout) end_session("timeout", NULL);
    else end_session("ok", NULL);
}

/* ready state: answer a door that outlived its session, and keep telling it to go */
static void cli_zombie_service(void)
{
    hport_drain();
    if (cli_zombie && (LN.done || !LN.busy)) cli_zombie = NULL;
    if (cli_zombie && now_s - cli_zombie_sig >= BREAK_REPEAT) {
        cli_zombie_sig = now_s;
        cli_signal(cli_zombie, SIGBREAKF_CTRL_C);
    }
}

/* ---- ARexx (AIM) doors: the shim is AmiExpress's REXXDOOR -------------------------------
 *
 * An AIM door is an ARexx script.  /X ran it through REXXDOOR, which published the host port
 * AERexxControl<node> and started the script with the node number as its argument; the script
 * does
 *
 *   parse arg NODE; options results; address value "AERexxControl"NODE
 *
 * and then sends host commands.  The shim publishes the same port, runs "RX <script> <node>"
 * on the launcher (so the script's end is RX's end) and answers:
 *
 *   GETUSER n          /X function n read (DT_NAME 100, JH_BBSNAME 11, ...) -> RESULT
 *   PUTUSTR text       the value the next PUTUSER stores
 *   PUTUSER n          /X function n written (136 RETURNCOMMAND, 4 JH_SM text, ...)
 *   TRANSMIT text      text, then CR LF
 *   SENDSTRING / SENDMESSAGE text   text as it is
 *   GETCHAR            one key, not echoed -> RESULT
 *   QUERY text         text, then an edited, echoed line of up to 99 characters -> RESULT
 *   RECEIVE n          the next QUERY takes up to n-1 characters
 *   PROMPT "text"      as QUERY (a later /X verb; a pair of double quotes is dropped)
 *   SHOWFILE / SENDFILE / SHOWGFILE file   a text file (SHOWGFILE: .txt .ans .gr .asc too)
 *   REMOVERESERVED s   s with / * ? # and blanks as _ (a file name from a user name) -> RESULT
 *   VERREXXDOOR        "13"
 *   BUFFERFLUSH        typed-ahead keys thrown away
 *   FLAGFILE, EDITFILE accepted (no editor: the file stays as it is)
 *   SHUTDOWN           the script is done (it should exit now)
 *
 * n goes through the XIM tables (xim_answer), so GETUSER and PUTUSER answer exactly what an XIM
 * door's DT_* requests get.  After carrier loss, time-up or the keyboard timeout every command
 * gets rc 10 (REXXDOOR's "carrier lost / timeout", after which it closed its ports), which
 * SIGNAL ON ERROR scripts take as the cue to save and leave; a script still running 5 s later
 * gets CTRL-C (ARexx halts it) every 10 s.  Unknown verbs get rc 0 and an empty RESULT.
 *
 * The verb table and the arguments' reading come from REXXDOOR 1.3 (Joseph Hodge; the verb
 * strings and its dispatcher read from the binary, nothing of it copied): a verb is the start of
 * the command line ("sm'x'" arrives as SENDMESSAGEx), the argument is the rest after one blank,
 * as it is.  The host-port handling follows NilBBS's aim_command (src/node/door.c,
 * https://github.com/lainejones/NilBBS), under the MIT licence quoted at "CLI doors" above
 * (Copyright (c) 2026 Laine Jones).
 */

#define AIM_BREAK_AFTER 5       /* seconds from carrier loss / time-up to the first CTRL-C */
#define AIM_EXIT_GRACE  10      /* seconds a script may run on after SHUTDOWN */

static const char *const aim_verbs[] = {
    "GETUSER", "PUTUSER", "PUTUSTR", "TRANSMIT", "SENDMESSAGE", "SENDSTRING", "GETCHAR", "PROMPT",
    "QUERY", "RECEIVE", "SHOWFILE", "SENDFILE", "SHOWGFILE", "FLAGFILE", "SHUTDOWN", "BUFFERFLUSH",
    "REMOVERESERVED", "VERREXXDOOR", "EDITFILE", NULL
};

static int upc(int c) { return c >= 'a' && c <= 'z' ? c - 32 : c; }

static BOOL prefix_icase(const char *s, LONG n, const char *w)
{
    LONG i;
    for (i = 0; w[i]; i++) if (i >= n || upc((UBYTE)s[i]) != w[i]) return FALSE;
    return TRUE;
}

static void aim_reply(struct RexxMsg *m, LONG rc, const char *res, LONG len)
{
    m->rm_Result1 = rc;
    m->rm_Result2 = 0;
    if (rc == 0 && res && axRexxBase && (m->rm_Action & RXFF_RESULT))
        m->rm_Result2 = (LONG)CreateArgstring((STRPTR)res, len);
    ReplyMsg((struct Message *)m);
}

/* a word into a space-separated set (X verbs= / unknown=) */
static void word_note(char *set, int size, const char *w)
{
    int n = strlen(w), sl = strlen(set);
    const char *p = set;
    while ((p = strstr(p, w))) {
        if ((p == set || p[-1] == ' ') && (p[n] == ' ' || !p[n])) return;
        p++;
    }
    if (sl + n + 2 > size) return;
    if (sl) set[sl++] = ' ';
    strcpy(set + sl, w);
}

static BOOL aim_dead(void) { return S.lost || S.timeup || S.dtr || S.aim.timedout; }

/* the session's AERexxControl<node>, and ARexx itself */
/* REXX is there (started if need be) and rexxsyslib is open: AIM and C-Net doors */
static const char *rexx_ready(void)
{
    struct MsgPort *rexx;
    BPTR l;
    int i;
    if (!axRexxBase && !(axRexxBase = OpenLibrary((STRPTR)"rexxsyslib.library", 0)))
        return "no rexxsyslib";
    for (i = 0;; i++) {
        Forbid();
        rexx = FindPort((STRPTR)"REXX");
        Permit();
        if (rexx) return NULL;
        if (i == 0 && (l = Lock((STRPTR)"SYS:System/RexxMast", ACCESS_READ))) {
            UnLock(l);          /* the image's S:Startup-Sequence should have started it */
            SystemTags((STRPTR)"SYS:System/RexxMast >NIL:", TAG_END);
        }
        if (i >= 10) return "ARexx is not running (no REXX port)";
        Delay(25);
        pump();
    }
}

static const char *aim_open(LONG node)
{
    const char *err;
    BPTR l;
    if (!axRexxBase && !(axRexxBase = OpenLibrary((STRPTR)"rexxsyslib.library", 0)))
        return "no rexxsyslib";
    if (!(l = Lock((STRPTR)RX_CMD, ACCESS_READ))) return "no " RX_CMD;
    UnLock(l);
    if ((err = rexx_ready())) return err;
    sprintf(aportname, "AERexxControl%ld", (long)node);
    Forbid();
    if (FindPort((STRPTR)aportname)) { Permit(); return "door port busy"; }
    if ((aport = CreateMsgPort())) {
        aport->mp_Node.ln_Name = aportname;
        aport->mp_Node.ln_Pri = 0;
        AddPort(aport);
    }
    Permit();
    return aport ? NULL : "door port busy";
}

/* codes that would wait for input, register or hand over in the XIM tables: GETCHAR and PROMPT
 * are the script's input, and REXXDOOR itself was the registered door */
static BOOL aim_refused(LONG n)
{
    switch (n) {
    case JH_LI: case JH_REGISTER: case JH_SHUTDOWN: case JH_PM: case JH_HK: case JH_EF:
    case JH_ExtHK: case JH_FetchKey: case JH_20: case QUICK_KEY: case CHAIN:
        return TRUE;
    default:
        return FALSE;
    }
}

/* GETUSER n / PUTUSER n through the XIM tables */
static void aim_user(struct RexxMsg *m, BOOL get, LONG n)
{
    struct JHMessage jm;
    char out[24];
    mark_seen(n);
    if (aim_refused(n)) { aim_reply(m, 0, "", 0); return; }
    memset(&jm, 0, sizeof(jm));
    jm.msg.mn_Length = sizeof(jm);
    jm.Command = n;
    if (get) jm.Data = 1;
    else strcpy(jm.String, S.aim.obj);
    xim_answer(&jm);            /* never parks: aim_refused() took those */
    if (!get) { aim_reply(m, 0, "", 0); return; }
    switch (n) {                /* the answers XIM doors find in Data */
    case BB_LOGONTYPE: case BB_SCRWIDTH: case BB_SCRHEIGHT: case DT_ISANSI: case GET_XIMPORT:
    case JH_SIGBIT: case MOD_TYPE:
        sprintf(out, "%ld", (long)jm.Data);
        aim_reply(m, 0, out, strlen(out));
        break;
    default:
        aim_reply(m, 0, jm.String, strlen(jm.String));
        break;
    }
}

/* the caller typed something: finish a waiting GETCHAR / PROMPT / QUERY */
static void aim_service_input(void)
{
    struct RexxMsg *m = S.aim.waiting;
    LONG c;
    if (!m) return;
    if (aim_dead()) { aim_reply(m, 10, NULL, 0); S.aim.waiting = NULL; return; }
    if (S.aim.wait_kind == WK_HK) {
        char b;
        do c = next_key(); while (c == -2);
        if (c < 0) return;
        b = (char)c;
        aim_reply(m, 0, &b, 1);
        S.aim.waiting = NULL;
        return;
    }
    while ((c = next_key()) != -1) {
        if (c == -2) continue;
        S.wait_since = now_s;   /* the keyboard timeout counts from the last key */
        if (c == '\r' || c == '\n') {
            out_bytes("\r\n", 2);
            aim_reply(m, 0, S.line, S.len);
            S.aim.waiting = NULL;
            return;
        } else if (c == 8 || c == 127) {
            if (S.len > 0) { S.len--; out_bytes("\b \b", 3); }
        } else if (c == 21 || c == 24) {
            while (S.len > 0) { S.len--; out_bytes("\b \b", 3); }
        } else if (c >= 32 && S.len < S.maxlen) {
            char b = (char)c;
            S.line[S.len++] = b;
            out_bytes(&b, 1);
        }
    }
}

static void aim_park(struct RexxMsg *m, UBYTE kind)
{
    if (S.aim.waiting) { aim_reply(m, 10, NULL, 0); return; }     /* one at a time */
    S.aim.waiting = m;
    S.aim.wait_kind = kind;
    S.wait_since = now_s;
    S.len = 0;
    S.maxlen = S.aim.qmax > 0 && S.aim.qmax < 200 ? S.aim.qmax : 100;
    aim_service_input();
}

static void aim_command(struct RexxMsg *m)
{
    const char *a = (const char *)m->rm_Args[0], *arg, *w = NULL;
    LONG len, arglen, wl = 0, n = -1;
    char t[200];
    int i;

    if ((m->rm_Action & RXCODEMASK) != RXCOMM || !a) { aim_reply(m, 20, NULL, 0); return; }
    if (m->rm_Node.mn_ReplyPort && m->rm_Node.mn_ReplyPort->mp_SigTask)
        S.aim.script = (struct Task *)m->rm_Node.mn_ReplyPort->mp_SigTask;
    S.cmds++;
    len = ((const struct RexxArg *)(a - offsetof(struct RexxArg, ra_Buff)))->ra_Length;

    /* the verb: the first word, or the longest verb the line starts with ("sm'x'" arrives as
     * SENDMESSAGEx, "query'>'" as QUERY>: ARexx glues a command to a string right after it) */
    while (wl < len && a[wl] != ' ') wl++;
    for (i = 0; aim_verbs[i]; i++)
        if ((LONG)strlen(aim_verbs[i]) == wl && prefix_icase(a, len, aim_verbs[i])) { w = aim_verbs[i]; break; }
    if (!w) {
        int best = 0;
        for (i = 0; aim_verbs[i]; i++) {
            int l = strlen(aim_verbs[i]);
            if (l > best && prefix_icase(a, len, aim_verbs[i])) { w = aim_verbs[i]; best = l; }
        }
        if (w) wl = best;
    }
    arg = a + wl;
    arglen = len - wl;
    if (w && arglen > 0 && *arg == ' ') { arg++; arglen--; }
    /* REXXDOOR takes the rest of the line as it is; only PROMPT (a later verb, documented as
     * PROMPT "text") drops a pair of double quotes around it */
    if (w && !strcmp(w, "PROMPT") && arglen >= 2 && arg[0] == '"' && arg[arglen - 1] == '"') { arg++; arglen -= 2; }
    i = arglen < (LONG)sizeof(t) - 1 ? arglen : (LONG)sizeof(t) - 1;
    memcpy(t, arg, i);
    t[i] = 0;
    if (w && (!strcmp(w, "GETUSER") || !strcmp(w, "PUTUSER"))) n = atol(t);

    if (S.log) {
        f_begin('C');
        if (w) f_kv("verb", w);
        else { char u[16]; for (i = 0; i < 15 && i < wl; i++) u[i] = upc((UBYTE)a[i]); u[i] = 0; f_kv("verb", u); }
        if (n >= 0) f_kvn("cmd", n);
        f_kv_escaped("str", arg, arglen < 200 ? arglen : 200);
        f_end();
    }
    if (!w) {
        char u[16];
        for (i = 0; i < 15 && i < wl; i++) u[i] = upc((UBYTE)a[i]);
        u[i] = 0;
        word_note(S.aim.unknown, sizeof(S.aim.unknown), u[0] ? u : "?");
        aim_reply(m, aim_dead() ? 10 : 0, "", 0);
        return;
    }
    word_note(S.aim.verbs, sizeof(S.aim.verbs), w);
    if (aim_dead()) { aim_reply(m, 10, NULL, 0); return; }

    if (!strcmp(w, "GETUSER") || !strcmp(w, "PUTUSER")) aim_user(m, w[0] == 'G', n);
    else if (!strcmp(w, "PUTUSTR")) {
        strcpy(S.aim.obj, t);
        aim_reply(m, 0, "", 0);
    } else if (!strcmp(w, "TRANSMIT")) {
        out_bytes(arg, arglen);
        out_bytes("\r\n", 2);
        aim_reply(m, 0, "", 0);
    } else if (!strcmp(w, "SENDSTRING") || !strcmp(w, "SENDMESSAGE")) {
        out_bytes(arg, arglen);
        aim_reply(m, 0, "", 0);
    } else if (!strcmp(w, "GETCHAR")) {
        aim_park(m, WK_HK);
    } else if (!strcmp(w, "PROMPT") || !strcmp(w, "QUERY")) {
        out_bytes(arg, arglen);
        aim_park(m, WK_LINE);
    } else if (!strcmp(w, "RECEIVE")) {         /* the next QUERY's length (REXXDOOR: n - 1) */
        S.aim.qmax = atol(t) - 1;
        aim_reply(m, 0, "", 0);
    } else if (!strcmp(w, "REMOVERESERVED")) {  /* a file name from a user name: / * ? # and
                                                 * blanks become _ (REXXDOOR 1.3) */
        for (i = 0; t[i]; i++) if (strchr("/*?# ", t[i])) t[i] = '_';
        aim_reply(m, 0, t, strlen(t));
    } else if (!strcmp(w, "VERREXXDOOR")) {
        aim_reply(m, 0, "13", 2);               /* REXXDOOR 1.3, the version described here */
    } else if (!strcmp(w, "SHOWFILE") || !strcmp(w, "SENDFILE") || !strcmp(w, "SHOWGFILE")) {
        static const char *ext[] = { "", ".txt", ".ans", ".gr", ".asc", NULL };
        char f[210];
        BOOL ok = FALSE;
        for (i = 0; ext[i] && !ok; i++) {
            if (w[4] != 'G' && i > 0) break;
            snprintf(f, sizeof(f), "%s%s", t, ext[i]);
            ok = show_file(f);
        }
        aim_reply(m, 0, "", 0);
    } else if (!strcmp(w, "BUFFERFLUSH")) {
        pump();
        inq_head = inq_tail = 0;
        aim_reply(m, 0, "", 0);
    } else if (!strcmp(w, "SHUTDOWN")) {
        if (!S.aim.shutdown) { S.aim.shutdown = TRUE; S.aim.shutdown_at = now_s; }
        aim_reply(m, 0, "", 0);
    } else aim_reply(m, 0, "", 0);      /* FLAGFILE; EDITFILE (no editor: the file is left as it is) */
}

/* a command after the session that ran it: REXXDOOR has gone */
static void aim_zombie(struct RexxMsg *m) { aim_reply(m, 10, NULL, 0); }

/* the AIM half of session_service(): input, timeouts, the script's end, X */
static void aim_session_service(void)
{
    struct RexxMsg *m;
    BOOL ended = FALSE;

    if (!S.timeup && time_left() <= 0) { S.timeup = TRUE; S.timeup_at = now_s; }
    if (S.aim.waiting && !aim_dead() && S.timeout > 0 && now_s - S.wait_since >= (ULONG)S.timeout) {
        S.aim.timedout = TRUE;  /* REXXDOOR: the keyboard timeout ends the door */
        S.input_failed = TRUE;
    }
    aim_service_input();

    if (aim_dead()) {
        if (!S.aim.broken) {
            S.aim.broken = TRUE;
            S.aim.dead_at = now_s;
        } else if (!LN.done && now_s - S.aim.dead_at >= AIM_BREAK_AFTER
                   && (!S.aim.sig_at || now_s - S.aim.sig_at >= BREAK_REPEAT)) {
            S.aim.sig_at = now_s;       /* ARexx halts a script on CTRL-C */
            cli_signal(S.aim.script, SIGBREAKF_CTRL_C);
        }
    }

    if (LN.done) {              /* RX returned: the script has ended */
        while (aport && (m = (struct RexxMsg *)GetMsg(aport))) aim_command(m);
        if (!S.cmds && LN.rc && !S.lost) {
            char out[120], err[200];
            script_stdout(out, sizeof(out));
            snprintf(err, sizeof(err), "script ended without a host command (rc=%ld)%s%s", (long)LN.rc,
                     out[0] ? ": " : "", out);
            reap();
            error_session(err);
            return;
        }
        ended = TRUE;
    } else if (S.aim.shutdown && now_s - S.aim.shutdown_at >= AIM_EXIT_GRACE) {
        ended = TRUE;
    } else if (S.aim.broken && now_s - S.aim.dead_at >= CARRIER_GRACE) {
        ended = TRUE;
    }
    if (!ended) return;

    if (S.lost == LOST_HANGUP) end_session("carrier", NULL);
    else if (S.lost == LOST_TIMEUP) end_session("timeout", NULL);
    else if (S.lost == LOST_BREAK) end_session("break", NULL);
    else if (S.timeup || S.aim.timedout) end_session("timeout", NULL);
    else end_session("ok", NULL);
}

/* ---- Paragon (TIM) doors: the shim is the BBS behind DoorControl<line> --------------------
 *
 * A Paragon door takes its line from argv[1][0], makes its own reply port DoorReply<line>,
 * finds the BBS's public port DoorControl<line> and sends it a 106-byte DoorMsg per request,
 * waiting for each reply.  It never registers; PG_SHUTDOWN (20) is its last request.  After
 * every reply it tests `carrier`.  The shim publishes DoorControl<line>, runs `<door> <line>`
 * on the launcher and answers:
 *
 *   1 SM   string (+ CR LF when data)       2 CO, 4 CC  the sysop's console only: nothing
 *   3 SO, 5 CH   the character in data      6 PM, 7 SC  string, then a line of up to data
 *   8 HK   string, then one key -> string[0], data 1 (MAX's: "from the remote caller")
 *   9 TWIT (MAX's) hang up                  10 SF, 19 SG  show a file (SG: .gr1/.txt first)
 *   11 FF  data 1 when the file exists, -1 when not            12 EF  E/e, the host's editor
 *   13 UD  user numbers (AmiExpress's table: 1 access/10, 2 expert, 4/5 calls, 6 ANSI,
 *          7 minutes left, 8 columns, 9 rows)  14 US  user strings (1 name, 3-6 location,
 *          7 PGDOORS:, 8 BBS:, 9 date, 10 time, 100 phone, 101 computer)
 *   15 PS, 16 CS (MAX's) set access / location for the session    17 RD  random 0..data-1
 *   20 SHUTDOWN   21 TM  add data minutes (signed) to the session's time
 *   MAX's: 113/114 type a file, 200 change a user number (accepted), 201 check for a key,
 *          202 paged (0), 203 auto-insert text (empty)
 *
 * The text of SM/PM/SC/HK is read up to its NUL even past string[80], as the BBSes printed it
 * (doors strcpy() longer texts into the message).  A reply writes string[] and carrier only
 * when mn_Length says the door sent a whole 106-byte DoorMsg; a shorter one gets the other
 * answers with its tail untouched, and X reports the first such length once (shortmsg=).
 * From carrier loss, time-up, the input
 * timeout or a twit on, every reply has carrier = 1 and input requests return empty; a door
 * still running 5 s later gets CTRL-C, again every 10 s.  The command set comes from
 * AmiExpress's own Paragon service (express.e runDoor, MIT) and MAX's BBS's door kits
 * (DoorStarter.asm, DoorPack, CDoorExample).
 */

#define TIM_BREAK_AFTER 5       /* seconds from carrier loss / time-up to the first CTRL-C */
#define TIM_EXIT_GRACE  10      /* seconds a door may run on after PG_SHUTDOWN */
#define TIM_TEXT        1024    /* a door's text is read up to its NUL, this far at most */

static BOOL tim_dead(void) { return S.lost || S.timeup || S.dtr || S.tim.timedout; }

/* TRUE: m is a whole DoorMsg, its string[] and carrier may be written; FALSE: the door sent
 * fewer bytes (mn_Length), the bytes past them are not its message and stay untouched */
static BOOL tim_whole(const struct DoorMsg *m)
{
    if (m->msg.mn_Length >= sizeof(struct DoorMsg)) return TRUE;
    if (!S.tim.short_seen) { S.tim.short_seen = TRUE; S.tim.short_len = m->msg.mn_Length; }
    return FALSE;
}

static void tim_reply(struct DoorMsg *m)
{
    if (tim_whole(m)) m->carrier = tim_dead() ? 1 : 0;
    ReplyMsg((struct Message *)m);
}

/* the carrier-lost answer: an input request gets an empty string */
static void tim_zombie(struct DoorMsg *m)
{
    BOOL whole = tim_whole(m);
    switch (m->command) {
    case PG_PM: case PG_SC: case PG_HK: case MX_CHECKKEY:
        if (whole) m->string[0] = 0;
        m->data = 0;
        break;
    default:
        break;
    }
    if (whole) m->carrier = 1;
    ReplyMsg((struct Message *)m);
}

/* the length of the door's text: to its NUL, TIM_TEXT at most (it may run past string[80]) */
static LONG tim_textlen(const struct DoorMsg *m)
{
    const char *s = m->string;
    LONG n = 0;
    while (n < TIM_TEXT && s[n]) n++;
    return n;
}

static void tim_text(const struct DoorMsg *m) { out_bytes(m->string, tim_textlen(m)); }

/* a file name from the message: 79 characters at most */
static void tim_path(const struct DoorMsg *m, char *out)
{
    memcpy(out, m->string, 79);
    out[79] = 0;
}

/* an answer string, cut to max characters (79 at most: string[80]) */
static void tim_sets(struct DoorMsg *m, const char *s, int max)
{
    int n = strlen(s);
    if (!tim_whole(m)) return;
    if (max > 79) max = 79;
    if (n > max) n = max;
    memcpy(m->string, s, n);
    m->string[n] = 0;
}

static void tim_log(struct DoorMsg *m)
{
    f_begin('C');
    f_kvn("cmd", m->command);
    f_kvn("data", m->data);
    f_kvn("len", m->msg.mn_Length);
    f_kv_escaped("str", m->string, 80);
    f_end();
}

/* PG_US 9 and 10: "MM-DD-YY" and "HH:MM:SS" (AmiExpress's FORMAT_USA) from the Amiga clock */
static void tim_date(char *out, BOOL date)
{
    static const UBYTE md[12] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    ULONG t = sys_secs(), days = t / 86400UL, secs = t % 86400UL;
    int y = 1978, m = 0;
    if (!date) {
        sprintf(out, "%02lu:%02lu:%02lu", (unsigned long)(secs / 3600),
                (unsigned long)((secs / 60) % 60), (unsigned long)(secs % 60));
        return;
    }
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
    sprintf(out, "%02d-%02lu-%02d", m + 1, (unsigned long)days + 1, y % 100);
}

/* PG_UD: AmiExpress's table (express.e); MAX's numbers past 9 answer 0 */
static LONG tim_number(LONG code)
{
    LONG v;
    switch (code) {
    case 1:  v = S.level / 10; break;           /* /X: the access level / 10 */
    case 2:  v = S.expert ? 1 : 0; break;
    case 4: case 5: v = geti("calls", 1); break;
    case 6:  v = S.ansi ? 1 : 0; break;         /* graphics mode */
    case 7:  v = time_left() / 60; break;
    case 8:  v = S.cols; break;
    case 9:  v = S.rows; break;
    default: v = 0; break;                      /* 3 net credits, MAX's 10-110 */
    }
    return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/* PG_US: AmiExpress's table (its cuts: the name 21 characters, the location 39/29/2/7) */
static void tim_string(struct DoorMsg *m)
{
    const char *loc = get("location", "");
    char s[24];
    switch (m->data) {
    case 1:   tim_sets(m, get("name", "User"), 21); break;
    case 3:   tim_sets(m, loc, 39); break;
    case 4:   tim_sets(m, loc, 29); break;
    case 5:   tim_sets(m, loc, 2); break;
    case 6:   tim_sets(m, loc, 7); break;
    case 7:   tim_sets(m, "PGDOORS:", 79); break;
    case 8:   tim_sets(m, "BBS:", 79); break;
    case 9: case 10: tim_date(s, m->data == 9); tim_sets(m, s, 79); break;
    case 100: tim_sets(m, "000-000-0000", 79); break;
    case 101: tim_sets(m, "Amiga", 79); break;
    default:  tim_sets(m, "", 0); break;        /* 2 the password: never; 102 comment */
    }
}

/* PG_SF a file as named; PG_SG a "graphics" file: name.gr1 (ANSI callers), name.txt, the name,
 * then the XIM list (.ans .gr .asc) */
static void tim_show(const struct DoorMsg *m, BOOL graphics)
{
    static const char *ext[] = { ".gr1", ".txt", "", ".ans", ".gr", ".asc", NULL };
    char path[80], f[90];
    int i;
    tim_path(m, path);
    if (!graphics) { show_file(path); return; }
    for (i = 0; ext[i]; i++) {
        if (i == 0 && !S.ansi) continue;
        snprintf(f, sizeof(f), "%s%s", path, ext[i]);
        if (show_file(f)) return;
    }
}

/* the caller typed something: finish a waiting PG_PM / PG_SC / PG_HK */
static void tim_service_input(void)
{
    struct DoorMsg *m = S.tim.waiting;
    LONG c;
    if (!m) return;
    if (tim_dead()) { tim_zombie(m); S.tim.waiting = NULL; return; }
    if (S.tim.wait_kind == WK_HK) {
        do c = next_key(); while (c == -2);
        if (c < 0) return;
        if (tim_whole(m)) { m->string[0] = (char)c; m->string[1] = 0; }
        m->data = 1;            /* the byte before the string: 1 = the remote caller's key */
        tim_reply(m);
        S.tim.waiting = NULL;
        return;
    }
    while ((c = next_key()) != -1) {
        if (c == -2) continue;
        S.wait_since = now_s;   /* the input timeout counts from the last key */
        if (c == '\r' || c == '\n') {
            out_bytes("\r\n", 2);       /* MAX's: "a carriage return is printed after command 6" */
            if (tim_whole(m)) { memcpy(m->string, S.line, S.len); m->string[S.len] = 0; }
            tim_reply(m);
            S.tim.waiting = NULL;
            return;
        } else if (c == 8 || c == 127) {
            if (S.len > 0) { S.len--; out_bytes("\b \b", 3); }
        } else if (c == 21 || c == 24) {
            while (S.len > 0) { S.len--; out_bytes("\b \b", 3); }
        } else if (c >= 32 && S.len < S.maxlen) {
            char b = (char)c;
            S.line[S.len++] = b;
            out_bytes(&b, 1);
        }
    }
}

static void tim_park(struct DoorMsg *m, UBYTE kind, LONG maxlen)
{
    if (S.tim.waiting) {        /* one at a time: a second one gets an empty answer */
        if (tim_whole(m)) m->string[0] = 0;
        tim_reply(m);
        return;
    }
    S.tim.waiting = m;
    S.tim.wait_kind = kind;
    S.wait_since = now_s;
    S.len = 0;
    S.maxlen = maxlen > 0 && maxlen < 80 ? maxlen : 79;
    tim_service_input();
}

/* answer m in place; FALSE: it waits (input, PG_EF) and is replied to later */
static BOOL tim_answer(struct DoorMsg *m)
{
    LONG cmd = m->command;
    char path[80];
    BPTR l;

    switch (cmd) {
    case PG_SM:
        tim_text(m);
        if (m->data) out_bytes("\r\n", 2);
        break;
    case PG_CO: case PG_CC: break;      /* the sysop's console only */
    case PG_SO: case PG_CH: {
        char b = (char)m->data;
        out_bytes(&b, 1);
        break;
    }
    case PG_PM: case PG_SC:             /* SC: MAX's "stacked commands" prompt; none here */
        if (!S.tim.waiting) tim_text(m);
        tim_park(m, WK_LINE, m->data);
        return FALSE;
    case PG_HK:
        if (!S.tim.waiting) tim_text(m);
        tim_park(m, WK_HK, 1);
        return FALSE;
    case PG_TWIT:       S.dtr = TRUE; break;        /* reported as dropdtr=1 in X */
    case PG_SF:         tim_show(m, FALSE); break;
    case PG_SG:         tim_show(m, TRUE); break;
    case PG_FF:
        tim_path(m, path);
        if (path[0] && path_ok(path) && (l = Lock((STRPTR)path, ACCESS_READ))) { UnLock(l); m->data = 1; }
        else m->data = -1;
        break;
    case PG_EF:                         /* hand the editor to the host: E, then wait for e */
        tim_path(m, path);
        if (!path[0] || !path_ok(path) || S.tim.editing || tim_dead()) break;
        S.tim.editing = m;
        S.edit_since = now_s;
        S.edit_answer = -1;
        f_begin('E');
        f_kv("file", path);
        f_end();
        return FALSE;
    case PG_UD:         m->data = (WORD)tim_number(m->data); break;
    case PG_US:         tim_string(m); break;
    case PG_PS:         S.level = m->data; S.wrote = TRUE; break;
    case PG_CS:         tim_path(m, path); put("location", path); S.wrote = TRUE; break;
    case PG_RD:
        if (m->data > 0) {
            S.tim.seed = S.tim.seed * 1103515245UL + 12345UL;
            m->data = (WORD)((S.tim.seed >> 16) % (ULONG)m->data);
        }
        break;
    case PG_SHUTDOWN:
        if (!S.tim.shutdown) { S.tim.shutdown = TRUE; S.tim.shutdown_at = now_s; }
        break;
    case PG_TM:                         /* minutes on (or off) the session's clock; a `t` resets it */
        if (!tim_dead()) {
            LONG left = time_left() + (LONG)m->data * 60;
            S.budget = left > 0 ? left : 0;
            S.budget_base = now_s;
            S.tim.addtime += m->data;
        }
        break;
    case MX_MENU + 13: case MX_MENU + 14: tim_show(m, FALSE); break;   /* menu 13/14: type a file */
    case MX_CHANGEINT:  S.wrote = TRUE; break;      /* accepted; the session has no MAX's record */
    case MX_CHECKKEY: {
        LONG c = -1;
        if (!tim_dead()) do c = next_key(); while (c == -2);
        if (tim_whole(m)) { m->string[0] = c > 0 ? (char)c : 0; m->string[1] = 0; }
        break;
    }
    case MX_PAGED:      m->data = 0; break;
    case MX_AUTOINSERT: if (tim_whole(m)) m->string[0] = 0; break;
    default:                            /* PG_CL, other menu functions: replied unchanged */
        mark_unknown(cmd);
        break;
    }
    return TRUE;
}

static void tim_command(struct DoorMsg *m)
{
    if (m->msg.mn_ReplyPort && m->msg.mn_ReplyPort->mp_SigTask)
        S.tim.door = (struct Task *)m->msg.mn_ReplyPort->mp_SigTask;
    S.cmds++;
    mark_seen(m->command);
    if (S.log) tim_log(m);
    if (tim_answer(m)) tim_reply(m);
}

/* the TIM half of session_service(): input, the editor, timeouts, the door's end, X */
static void tim_session_service(void)
{
    struct DoorMsg *m;
    BOOL ended = FALSE;

    if (!S.timeup && time_left() <= 0) { S.timeup = TRUE; S.timeup_at = now_s; }
    if (S.tim.editing) {
        BYTE a = S.edit_answer;
        if (tim_dead()) a = -2;
        else if (a < 0 && S.timeout > 0 && now_s - S.edit_since >= (ULONG)S.timeout) a = 0;
        if (a != -1) {
            if (a == 1) S.wrote = TRUE;
            tim_reply(S.tim.editing);
            S.tim.editing = NULL;
        }
    }
    if (S.tim.waiting && !tim_dead() && S.timeout > 0 && now_s - S.wait_since >= (ULONG)S.timeout) {
        S.tim.timedout = TRUE;  /* Paragon logged the caller off: the carrier is gone for good */
        S.input_failed = TRUE;
    }
    tim_service_input();

    if (tim_dead()) {
        if (!S.tim.broken) {
            S.tim.broken = TRUE;
            S.tim.dead_at = now_s;
        } else if (!LN.done && now_s - S.tim.dead_at >= TIM_BREAK_AFTER
                   && (!S.tim.sig_at || now_s - S.tim.sig_at >= BREAK_REPEAT)) {
            S.tim.sig_at = now_s;
            cli_signal(S.tim.door, SIGBREAKF_CTRL_C);
        }
    }

    if (LN.done) {              /* the door process is gone: whatever it left, then X */
        while (dport && (m = (struct DoorMsg *)GetMsg(dport))) tim_command(m);
        if (!S.cmds && !S.lost) {
            char out[120], err[200];
            door_stdout(out, sizeof(out));
            snprintf(err, sizeof(err), "door exited without a DoorControl request (rc=%ld)%s%s",
                     (long)LN.rc, out[0] ? ": " : "", out);
            reap();
            error_session(err);
            return;
        }
        ended = TRUE;
    } else if (!S.cmds && S.regtimeout > 0 && now_s - S.start_s >= (ULONG)S.regtimeout && !S.lost) {
        char err[64];
        sprintf(err, "door sent no DoorControl request within %ld s", (long)S.regtimeout);
        error_session(err);
        return;
    } else if (S.tim.shutdown && now_s - S.tim.shutdown_at >= TIM_EXIT_GRACE) {
        ended = TRUE;
    } else if (S.tim.broken && now_s - S.tim.dead_at >= CARRIER_GRACE) {
        ended = TRUE;
    }
    if (!ended) return;

    if (S.lost == LOST_HANGUP) end_session("carrier", NULL);
    else if (S.lost == LOST_TIMEUP) end_session("timeout", NULL);
    else if (S.lost == LOST_BREAK) end_session("break", NULL);
    else if (S.timeup || S.tim.timedout) end_session("timeout", NULL);
    else end_session("ok", NULL);
}

/* ---- C-Net ARexx doors: the shim is the C-Net port behind CNETREXX<port> ----------------------
 *
 * A C-Net ARexx pfile is an ARexx script C-Net Amiga (3.x to 5.x) started with its port's host
 * address already set: the script says "options results" and sends bare commands, which reach
 * CNETREXX<port> (C-Net counts ports from 0, so ENiGMA's node 1 is CNETREXX0).  The shim makes
 * that port and starts the script the way C-Net did, with a RexxMsg to the REXX port whose host
 * address is CNETREXX<port> (no RX, no node argument), and answers:
 *
 *   TRANSMIT / PRINT text      text with its MCI codes, then CR LF;  SENDSTRING: no CR LF
 *   SEND text                  text as it is (no MCI);  NEWLINE CR LF;  CLS clears the screen
 *   SENDFILE file              a text file with its MCI codes (to a ^Z)
 *   GETCHAR / GETKEY           one key (letters in capitals) -> RESULT
 *   MAYGETCHAR                 a key if one comes within 40 ms, else NOCHAR
 *   QUERY text                 text, then a line of up to 80 -> RESULT
 *   PROMPT len NORMAL|HIDE|YESNO|NOYES text   a line of up to len (HIDE echoes *), or Yes/No
 *   GETUSER n                  the caller (C-Net's code table 1-92; 7-digit structure peeks get
 *                              0 or an empty string) -> RESULT;  SETOBJECT v + PUTUSER n set it
 *   BBSIDENTIFY USER|TERM|BBS|NAME|SYSOP|EMULATION|ABBEREXX, VERSION, GETCARRIER, CARRIER,
 *   CHECKCARRIER, CHECKIO, BUFFERFLUSH, ADDKEYS, FINDACCOUNT, GETPORTID, LOAD/GET/PUT/SAVESCRATCH
 *   (the caller's own account only), ADDPOINTS, ADDTIME, CHANGEWHERE / CHANGEWHAT, LOGENTRY /
 *   SYSOPLOG, SPAWN (the next script on the same port), BYE / HANGUP (drop the line)
 *   CLEAREDITOR ... WRITEMAIL, XUP / XDN: refused ("0"); BBSCOMMAND and the modem verbs: nothing
 *
 * Text goes out through C-Net's MCI: ^Q<cmd><args>} and ^Y<cmd><char> codes for colour, clear,
 * cursor and repeat (C Z F N B H O R U Q ^ ! > < .), plus the ones that wait or act: {G} a key,
 * {I} a line, {?} yes/no (into the string registers 70-74), {W} seconds, {* file} a file, {$ cmd}
 * an AmigaDOS command, {V n} a GETUSER value, {L n m} a register.  A command whose text waits is
 * answered when its text is out.  Text is word-wrapped at the caller's width while the column is
 * known (C-Net's "word wrap"; a cursor movement makes it unknown until the next line).
 *
 * From carrier loss, time-up, the keyboard timeout or BYE on, input commands answer ###PANIC
 * (C-Net's word for it), GETCARRIER FALSE, CARRIER 0, every other command ###PANIC, all with rc 0
 * (scripts SIGNAL ON ERROR); the script gets CTRL-C `panicgrace` seconds later (default 10; 0
 * breaks it before its waiting command is answered, for doors that would save "###PANIC" as a
 * name), again every 30 s.
 *
 * The command set, the GETUSER table, MCI and ###PANIC follow NilBBS's C-Net host (rx_command,
 * getuser, mci_act and run_cnetrexx in src/node/door.c, https://github.com/lainejones/NilBBS),
 * under the MIT licence quoted at "CLI doors" above (Copyright (c) 2026 Laine Jones), with the
 * C-Net 5 SDK's ARexx guide (tbdye/cnet-sdk docs/arexx.md) for PROMPT, BBSIDENTIFY and ADDTIME.
 */


enum { MW_NONE, MW_KEY, MW_LINE, MW_YESNO, MW_TIME };
enum { CK_KEY = 1, CK_LINE, CK_YESNO, CK_MAYBE };

static const char *const cn_verbs[] = {
    "TRANSMIT", "PRINT", "SENDSTRING", "SEND", "NEWLINE", "SENDFILE", "GETCHAR", "GETKEY",
    "MAYGETCHAR", "BUFFERFLUSH", "CHECKIO", "IREADY", "QUERY", "RECEIVE", "PROMPT", "GETCARRIER",
    "BBSIDENTIFY", "VERSION", "LOGENTRY", "SYSOPLOG", "CHANGEWHERE", "SETNODELOCATION", "CHANGEWHAT",
    "ADDTIME", "ADDKEYS", "SPAWN", "SHUTDOWN", "SCREENOUT", "BBSCOMMAND", "OPENDISPLAY",
    "CLOSEDISPLAY", "BAUD", "MODEM", "SENDMODEM", "GETUSER", "CLS", "BYE", "HANGUP", "DROPCARRIER",
    "CARRIER", "CHECKCARRIER", "SETOBJECT", "PUTUSER", "SETLENGTH", "CLEAREDITOR", "LOADEDITOR",
    "SAVEEDITOR", "CALLEDITOR", "SETMAILSUBJ", "WRITEMAIL", "LOADSCRATCH", "GETSCRATCH", "PUTSCRATCH",
    "SAVESCRATCH", "FINDACCOUNT", "GETPORTID", "ADDPOINTS", "CHECKABORT", "FEEDBACK", "RESETMODEM",
    "SETMINFREE", "SETPROTOCOL", "XDN", "XUP", NULL
};

static BOOL cn_dead(void) { return S.lost || S.timeup || S.dtr || S.cn.timedout; }

static LONG cn_account(void) { LONG a = geti("account", 1); return a > 0 ? a : 1; }

static BOOL ieq(const char *a, const char *b)
{
    while (*a && upc((UBYTE)*a) == upc((UBYTE)*b)) { a++; b++; }
    return upc((UBYTE)*a) == upc((UBYTE)*b);
}

static LONG cn_port(void) { return S.node > 0 ? S.node - 1 : 0; }

static void cn_reply(struct RexxMsg *m, const char *res) { aim_reply(m, 0, res, res ? strlen(res) : 0); }

/* ---- output: the column (for word wrap) and the colour C-Net's codes set ---------------------- */

/* every byte that goes to the caller: where the cursor is, -1 when nobody knows */
static void cn_track(UBYTE c)
{
    if (S.cn.esc == 1) {                    /* after ESC */
        S.cn.esc = c == '[' ? 2 : 0;
        S.cn.escn = 0;
        S.cn.escp[0] = S.cn.escp[1] = 0;
        return;
    }
    if (S.cn.esc == 2) {                    /* inside a CSI: the cursor movements move the column */
        LONG p1 = S.cn.escp[0], p2 = S.cn.escp[1], col = S.cn.col;
        if (c >= '0' && c <= '9') {
            if (S.cn.escn < 2 && S.cn.escp[S.cn.escn] < 10000) S.cn.escp[S.cn.escn] = S.cn.escp[S.cn.escn] * 10 + c - '0';
            return;
        }
        if (c == ';') { if (S.cn.escn < 8) S.cn.escn++; return; }
        if (c < 0x40 || c > 0x7E) {         /* an intermediate (SyncTERM's "0;40 SP D") or private
                                             * marker (ESC[?25l): not a cursor movement */
            if (c != ';') S.cn.escn = 9;
            return;
        }
        S.cn.esc = 0;
        if (S.cn.escn == 9) c = 'm';
        switch (c) {
        case 'H': case 'f': col = p2 > 0 ? p2 - 1 : 0; break;
        case 'G':           col = p1 > 0 ? p1 - 1 : 0; break;
        case 'C':           if (col >= 0) col += p1 > 0 ? p1 : 1; break;
        case 'D':           if (col >= 0) { col -= p1 > 0 ? p1 : 1; if (col < 0) col = 0; } break;
        case 'J':           if (p1 == 2) col = 0; break;    /* ANSI.SYS and SyncTERM home on 2J */
        case 's':           S.cn.savedcol = col; break;
        case 'u':           col = S.cn.savedcol; break;
        case 'A': case 'B': case 'm': case 'K': case ' ': break;
        default:            col = -1; break;
        }
        if (col >= S.cols) col = S.cols - 1;
        S.cn.col = col;
        S.cn.wordstart = TRUE;
        return;
    }
    if (c == 27) { S.cn.esc = 1; return; }
    if (c == 0x9B) { S.cn.esc = 1; cn_track('['); return; }
    if (c == '\r' || c == '\n') { S.cn.col = 0; S.cn.wordstart = TRUE; return; }
    if (c == 8) { if (S.cn.col > 0) S.cn.col--; return; }
    if (c == 12) { S.cn.col = 0; return; }
    if (c == 9) { if (S.cn.col >= 0) S.cn.col = (S.cn.col + 8) & ~7; S.cn.wordstart = TRUE; return; }
    if (c < 32 || c == 0x7F) return;
    if (S.cn.col >= 0 && ++S.cn.col >= S.cols) S.cn.col = 0;    /* the terminal wraps */
    S.cn.wordstart = c == ' ';
}

static void cn_raw(const char *s, LONG n)
{
    LONG i;
    for (i = 0; i < n; i++) cn_track((UBYTE)s[i]);
    out_bytes(s, n);
}

static void cn_rawstr(const char *s) { cn_raw(s, strlen(s)); }

/* the visible length of the word at p: up to a blank or a control, skipping MCI and escape codes */
static LONG cn_wordlen(const UBYTE *p, const UBYTE *end)
{
    LONG n = 0;
    while (p < end) {
        UBYTE c = *p;
        if (c == 0x11) { while (p < end && *p != '}') p++; if (p < end) p++; continue; }
        if (c == 0x19) { p += 3; continue; }
        if (c == 27) {
            p++;
            if (p < end && *p == '[') for (p++; p < end && !(*p >= 0x40 && *p <= 0x7E); p++) ;
            if (p < end) p++;
            continue;
        }
        if (c <= ' ' || c == 0x7F || c == 0x9B) break;
        n++;
        p++;
    }
    return n;
}

/* plain text [p, run) of a stream that ends at end: word-wrapped while the column is known */
static void cn_text(const UBYTE *p, const UBYTE *run, const UBYTE *end)
{
    const UBYTE *seg = p;
    for (; p < run; p++) {
        UBYTE c = *p;
        if (S.cn.wrap && S.cn.esc == 0 && S.cn.wordstart && S.cn.col > 0 && c > ' ' && c != 0x7F
            && c != 0x9B) {
            LONG w = cn_wordlen(p, end);
            if (w <= S.cols && S.cn.col + w > S.cols) {
                if (p > seg) out_bytes((const char *)seg, p - seg);
                seg = p;
                out_bytes("\r\n", 2);
                S.cn.col = 0;
            }
        }
        cn_track(c);
    }
    if (p > seg) out_bytes((const char *)seg, p - seg);
}

/* C-Net's colours are in ANSI order (1 red); 8-f are the bright ones */
static void cn_sgr(void)
{
    char b[24];
    if (!S.ansi) return;
    sprintf(b, "\x1b[0;%s3%d;4%dm", S.cn.bold ? "1;" : "", S.cn.fg & 7, S.cn.bg & 7);
    cn_rawstr(b);
}

static int hexval(UBYTE c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* a code that only draws: colour, clear, cursor, repeats */
static void cn_draw(UBYTE cmd, const char *arg)
{
    char s[24];
    int n = atoi(arg), i, h = arg[0] ? hexval((UBYTE)arg[0]) : -1;
    if (arg[0] && !arg[1] && h >= 0) n = h;     /* a ^Y code's argument is one hex digit */
    switch (cmd | 0x20) {
    case 'c': if (h >= 0) { S.cn.fg = h & 7; S.cn.bold = (h & 8) != 0; cn_sgr(); } break;
    case 'z': if (h >= 0) { S.cn.bg = h & 7; cn_sgr(); } break;
    case 'f': cn_rawstr(n == 1 ? "\x1b[2J\x1b[H" : "\x1b[H"); if (n == 1) S.cn.col = 0; break;
    case 'n': for (i = 0; i < (n ? n : 1) && i < 40; i++) cn_raw("\r\n", 2); break;
    case 'b': for (i = 0; i < (n ? n : 1) && i < 5; i++) cn_raw("\a", 1); break;
    case 'h': for (i = 0; i < n && i < 80; i++) cn_raw("\b", 1); break;
    case 'o': if (S.ansi) cn_rawstr(n ? "\x1b[1m" : "\x1b[22m"); break;
    case 'r': if (S.ansi) cn_rawstr(n ? "\x1b[7m" : "\x1b[27m"); break;
    case 'u': if (S.ansi) cn_rawstr(n ? "\x1b[4m" : "\x1b[24m"); break;
    case 'q': if (n <= 1) { S.cn.fg = 7; S.cn.bg = 0; S.cn.bold = FALSE; if (S.ansi) cn_rawstr("\x1b[0m"); } break;
    default:
        if (!S.ansi) break;
        s[0] = 0;
        switch (cmd) {
        case '^': sprintf(s, "\x1b[%dA", n ? n : 1); break;
        case '!': sprintf(s, "\x1b[%dB", n ? n : 1); break;
        case '>': sprintf(s, "\x1b[%dC", n ? n : 1); break;
        case '<': sprintf(s, "\x1b[%dD", n ? n : 1); break;
        case '.': sprintf(s, "\x1b[%dG", n ? n : 1); break;
        }
        if (s[0]) cn_rawstr(s);
    }
}

/* ---- the caller (GETUSER) --------------------------------------------------------------------- */

/* "DD-Mon-YY" (NilBBS's form) and the weekday, from Amiga seconds */
static void cn_date(ULONG t, char *out, BOOL weekday, BOOL time)
{
    static const char *wd[7] = { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" };
    static const char *mn[12] = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" };
    static const UBYTE md[12] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
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
    out[0] = 0;
    if (weekday) { strcpy(out, wd[dow]); strcat(out, " "); }
    sprintf(out + strlen(out), "%02lu-%s-%02d", (unsigned long)days + 1, mn[m], y % 100);
    if (time) sprintf(out + strlen(out), " %02lu:%02lu", (unsigned long)(secs / 3600), (unsigned long)((secs / 60) % 60));
}

static BOOL cn_sysop(void) { return S.level >= 255 || cn_account() == 1; }

/* GETUSER n, C-Net's table (SDK arexx.md, NilBBS getuser) over the session's user block */
static void cn_getuser(LONG n, char *out)
{
    LONG t;
    ULONG now = sys_secs();
    out[0] = 0;
    if (n >= 1000000) {         /* STOOOOO: a peek into C-Net's PortData / MainPort: nothing here */
        if ((n / 100000) % 10 != 3) strcpy(out, "0");
        return;
    }
    if (n >= 60 && n <= 69) { sprintf(out, "%ld", (long)S.cn.nreg[n - 60]); return; }
    if (n >= 70 && n <= 74) { strcpy(out, S.cn.sreg[n - 70]); return; }
    if (n > 0 && n < 64 && S.cn.uovset[n]) { strcpy(out, S.cn.uov[n]); return; }    /* PUTUSER'd */
    switch (n) {
    case 1:  strncpy(out, get("name", "User"), 80); out[80] = 0; break;
    case 2:  break;                                     /* the password: never */
    case 3:  strncpy(out, get("realname", get("name", "User")), 80); out[80] = 0; break;
    case 4:  strncpy(out, get("location", ""), 80); out[80] = 0; break;
    case 7:  sprintf(out, "%ld", (long)(time_left() / 6)); break;       /* tenths of a minute */
    case 11: cn_date(S.laston_ae >= AE_EPOCH ? S.laston_ae - AE_EPOCH : now, out, FALSE, FALSE); break;
    case 12: cn_date(now, out, TRUE, TRUE); break;
    case 15: sprintf(out, "%ld", (long)(cn_sysop() ? 31 : (S.level > 255 ? 255 : S.level < 0 ? 0 : S.level) * 31 / 255)); break;
    case 16: strcpy(out, cn_sysop() ? "SysOp" : "Member"); break;
    case 17: strcpy(out, cn_sysop() ? "1" : "0"); break;
    case 18:                                            /* minutes online today, in tenths */
        t = geti("timeused", 0) * 60 + (LONG)(now_s - S.start_s);
        sprintf(out, "%ld", (long)(t / 6));
        break;
    case 19: strcpy(out, "12"); break;                  /* the clear-screen code */
    case 21: sprintf(out, "%ld", (long)S.cn.points); break;
    case 22: sprintf(out, "%ld", (long)geti("calls", 1)); break;
    case 23: sprintf(out, "%ld", (long)cn_port()); break;
    case 24: strcpy(out, "11520"); break;               /* CPS, as NilBBS */
    case 27: sprintf(out, "%ld", (long)S.cols); break;
    case 28: strcpy(out, S.ansi ? "2" : "0"); break;    /* 0 dumb, 2 ANSI */
    case 29: strcpy(out, "90"); break;                  /* the protocol as its letter's code: Z */
    case 30: sprintf(out, "%lu", strtoul(get("ulbytes", "0"), NULL, 10) / 1024UL); break;
    case 31: sprintf(out, "%ld", (long)geti("uploads", 0)); break;
    case 32: sprintf(out, "%lu", strtoul(get("dlbytes", "0"), NULL, 10) / 1024UL); break;
    case 33: sprintf(out, "%ld", (long)geti("downloads", 0)); break;
    case 36: sprintf(out, "%ld", (long)geti("posts", 0)); break;
    case 39: case 40: case 41: sprintf(out, "%ld", (long)cn_account()); break;   /* UUCP id, account, serial */
    case 46: t = (LONG)((now % 86400UL) / 3600UL); strcpy(out, t < 12 ? "Morning" : t < 18 ? "Afternoon" : "Evening"); break;
    case 47: sprintf(out, "%ld", (long)geti("calls", 1)); break;
    case 48: strcpy(out, "1"); break;
    case 51: case 52: case 53: case 54: strcpy(out, "1"); break;
    case 55: strcpy(out, S.expert ? "2" : "1"); break;  /* help level */
    case 57: cn_date(now - (now_s - S.start_s), out, TRUE, TRUE); break;   /* logon time */
    case 13: case 14: case 20: case 25: case 26: case 34: case 35: case 37:
    case 42: case 43: case 44: case 45: case 81: case 82: case 83: case 84: case 85: case 86:
        strcpy(out, "0");
        break;
    default:                    /* 5 6 8 9 10 38 49 50 56 58 59 75-80 87-92: empty, as an empty account */
        if (n < 1 || n > 92) mark_unknown(n);
        break;
    }
}

/* PUTUSER n with SETOBJECT's value: 7 is the time left (tenths); 1-63 stay for this session's
 * GETUSERs; a 7-digit structure poke changes nothing */
static void cn_putuser(LONG n)
{
    if (n == 7) {
        LONG left = atol(S.cn.obj) * 6;
        S.budget = left > 0 ? left : 0;
        S.budget_base = now_s;
        if (S.budget > 0) { S.timeup = FALSE; S.timeup_at = 0; }
        S.wrote = TRUE;
    } else if (n == 21) {
        S.cn.points = atol(S.cn.obj);
        S.wrote = TRUE;
    } else if (n > 0 && n < 64) {
        strncpy(S.cn.uov[n], S.cn.obj, sizeof(S.cn.uov[n]) - 1);
        S.cn.uov[n][sizeof(S.cn.uov[n]) - 1] = 0;
        S.cn.uovset[n] = TRUE;
        S.wrote = TRUE;
    } else if (n < 1000000) mark_unknown(n);
}

/* ---- MCI streams: text that may wait for the caller ---------------------------------------- */

static void cn_pop(void)
{
    struct CnStream *s = &S.cn.st[--S.cn.nst];
    if (s->msg) cn_reply(s->msg, "");
    if (s->buf) FreeVec(s->buf);
    s->msg = NULL;
    s->buf = NULL;
}

/* drop every stream: the caller has gone (their commands are answered), or the session ends */
static void cn_reset(void) { while (S.cn.nst > 0) cn_pop(); }

/* buf becomes the stream's (freed when it is done); msg (NULL for a {* file}) is answered then */
static void cn_push(struct RexxMsg *msg, UBYTE *buf, LONG len)
{
    struct CnStream *s;
    if (S.cn.nst >= CN_DEPTH) {
        if (buf) FreeVec(buf);
        if (msg) cn_reply(msg, "");
        return;
    }
    s = &S.cn.st[S.cn.nst++];
    s->msg = msg;
    s->buf = buf;
    s->len = buf ? len : 0;
    s->pos = 0;
    s->wait = MW_NONE;
}

/* a text file for SENDFILE / {*}: up to a ^Z, CN_FILEMAX at most */
static UBYTE *cn_load(const char *path, LONG *len)
{
    BPTR fh;
    LONG size, n;
    UBYTE *buf, *z;
    *len = 0;
    if (!path[0] || !path_ok(path) || !(fh = Open((STRPTR)path, MODE_OLDFILE))) return NULL;
    Seek(fh, 0, OFFSET_END);
    size = Seek(fh, 0, OFFSET_BEGINNING);
    if (size < 0) size = 0;
    if (size > CN_FILEMAX) size = CN_FILEMAX;
    if (!(buf = AllocVec(size + 1, MEMF_ANY))) { Close(fh); return NULL; }
    n = size ? Read(fh, buf, size) : 0;
    Close(fh);
    if (n < 0) n = 0;
    if ((z = memchr(buf, 0x1A, n))) n = z - buf;
    *len = n;
    return buf;
}

/* "{*0 file}" / "{$ cmd}": the part after the digits */
static const char *cn_path(const char *arg)
{
    while (*arg >= '0' && *arg <= '9') arg++;
    while (*arg == ' ') arg++;
    return arg;
}

/* {$ cmd}: an AmigaDOS command, NIL: in and out, synchronously (TradeWars cleans up with it) */
static void cn_dos(const char *cmd)
{
    BPTR nin, nout;
    if (!cmd[0]) return;
    nin = Open((STRPTR)"NIL:", MODE_OLDFILE);
    nout = Open((STRPTR)"NIL:", MODE_NEWFILE);
    if (nin && nout) SystemTags((STRPTR)cmd, SYS_Input, nin, SYS_Output, nout, TAG_END);
    if (nin) Close(nin);
    if (nout) Close(nout);
}

/* one MCI code.  nowait: a prompt's text, where the codes that wait or show files do nothing.
 * TRUE: the top stream now waits, or a {* file} went on top of it */
static BOOL cn_act(UBYTE cmd, const char *arg, BOOL nowait)
{
    struct CnStream *s = S.cn.nst ? &S.cn.st[S.cn.nst - 1] : NULL;
    char out[200];
    LONG n;
    switch (cmd | 0x20) {
    case 'g':                                   /* {Gn} a key into register 70+n */
        if (nowait || !s) return FALSE;
        S.cn.mreg = (UBYTE)(atoi(arg) % 5);
        s->wait = MW_KEY;
        return TRUE;
    case 'i': {                                 /* {In m} a line (m long) into register 70 */
        const char *m = strchr(arg, ' ');
        if (nowait || !s) return FALSE;
        S.cn.mflags = (UWORD)atoi(arg);
        S.cn.mmax = m ? atoi(m + 1) : 40;
        if (S.cn.mmax <= 0 || S.cn.mmax > 80) S.cn.mmax = 40;
        S.len = 0;
        s->wait = MW_LINE;
        return TRUE;
    }
    case 'w':                                   /* {Wn} n seconds (30 at most) */
        n = atoi(arg);
        if (nowait || !s || n <= 0) return FALSE;
        S.cn.muntil = now_s + (n > 30 ? 30 : n);
        s->wait = MW_TIME;
        return TRUE;
    case 'v':                                   /* {Vn} a GETUSER value */
        cn_getuser(atol(arg), out);
        cn_text((const UBYTE *)out, (const UBYTE *)out + strlen(out), (const UBYTE *)out + strlen(out));
        return FALSE;
    case 'l': {                                 /* {Ln m} a register: m = #literal or a GETUSER */
        const char *m = strchr(arg, ' ');
        n = atol(arg);
        if (!m) return FALSE;
        m++;
        if (*m == '#' || *m == '\'') { strncpy(out, m + 1, 83); out[83] = 0; }
        else cn_getuser(atol(m), out);
        if (n >= 60 && n <= 69) S.cn.nreg[n - 60] = atol(out);
        else if (n >= 70 && n <= 74) { strncpy(S.cn.sreg[n - 70], out, 83); S.cn.sreg[n - 70][83] = 0; }
        return FALSE;
    }
    case '+':                                   /* {+ text} for the call log: nothing here */
        return FALSE;
    case '$':                                   /* {$ cmd} */
        cn_dos(cn_path(arg));
        return FALSE;
    default:
        break;
    }
    switch (cmd) {
    case '?':                                   /* {?n} yes/no: "1" / "0" into register 70 */
        if (nowait || !s) return FALSE;
        S.cn.mdef = (UBYTE)(atoi(arg) ? 1 : 0);
        s->wait = MW_YESNO;
        return TRUE;
    case '*': {                                 /* {*n file} a file */
        LONG len;
        UBYTE *b;
        if (nowait || !s) return FALSE;
        if (!(b = cn_load(cn_path(arg), &len))) return FALSE;
        cn_push(NULL, b, len);
        return TRUE;
    }
    case '#':                                   /* {#n file} a sub-pfile: not run here */
        word_note(S.cn.unknown, sizeof(S.cn.unknown), "{#}");
        return FALSE;
    case '@': case ':': case '&': case '=': case '%': case '-':
        return FALSE;                           /* MCI modes, BBS commands, prompt defaults */
    default:
        switch (cmd | 0x20) {                   /* speed, kolorific, direction, tests, maths */
        case 's': case 'k': case 'p': case 't': case 'j': case 'x': case 'm': case 'a': case 'd': case 'e':
            return FALSE;
        }
        cn_draw(cmd, arg);
        return FALSE;
    }
}

/* run s from its position: text and codes, until its end (TRUE) or a code that waits (FALSE) */
static BOOL cn_scan(struct CnStream *s, BOOL nowait)
{
    const UBYTE *buf = s->buf, *end = s->buf + s->len, *p = buf + s->pos, *run = p;
    int depth = S.cn.nst;
    while (p < end) {
        if (*p == 0x11 && p + 1 < end) {        /* ^Q cmd args } */
            char arg[200];
            int n = 0;
            UBYTE cmd;
            cn_text(run, p, end);
            cmd = p[1];
            p += 2;
            while (p < end && *p != '}' && n < (int)sizeof(arg) - 1) arg[n++] = *p++;
            arg[n] = 0;
            if (p < end && *p == '}') p++;
            s->pos = p - buf;
            run = p;
            if (cn_act(cmd, arg, nowait) || S.cn.nst != depth) return FALSE;
        } else if (*p == 0x19 && p + 2 < end) { /* ^Y cmd char */
            char arg[2];
            UBYTE cmd = p[1];
            cn_text(run, p, end);
            arg[0] = p[2];
            arg[1] = 0;
            p += 3;
            s->pos = p - buf;
            run = p;
            if (cn_act(cmd, arg, nowait) || S.cn.nst != depth) return FALSE;
        } else p++;
    }
    cn_text(run, p, end);
    s->pos = p - buf;
    return TRUE;
}

/* the top stream until it ends (its command is answered) or something waits */
static void cn_run(void)
{
    while (S.cn.nst > 0 && S.cn.st[S.cn.nst - 1].wait == MW_NONE) {
        if (cn_dead()) { cn_reset(); return; }
        if (cn_scan(&S.cn.st[S.cn.nst - 1], FALSE)) cn_pop();
    }
}

/* a prompt's text: the codes that only draw */
static void cn_write(const char *t, LONG n)
{
    struct CnStream tmp;
    memset(&tmp, 0, sizeof(tmp));
    tmp.buf = (UBYTE *)t;
    tmp.len = n;
    cn_scan(&tmp, TRUE);
}

/* text sent after the caller has gone: nothing shown, but {$ cmd} still runs (TradeWars deletes
 * its "game in use" file that way on the way out) */
static void cn_offline(const char *s, LONG len)
{
    const char *end = s + len;
    while (s < end) {
        if (*s == 0x11 && s + 1 < end) {
            char arg[200];
            int n = 0;
            UBYTE cmd = s[1];
            s += 2;
            while (s < end && *s != '}' && n < (int)sizeof(arg) - 1) arg[n++] = *s++;
            arg[n] = 0;
            if (s < end) s++;
            if (cmd == '$') cn_dos(cn_path(arg));
        } else s++;
    }
}

/* ---- input --------------------------------------------------------------------------------- */

/* the caller's next byte, -1 = none: telnet's LF or NUL after CR is swallowed */
static int cn_key(void)
{
    int c;
    pump();
    for (;;) {
        if ((c = inq_get()) < 0) return -1;
        if (last_cr && (c == '\n' || c == 0)) { last_cr = FALSE; continue; }
        last_cr = (c == '\r');
        S.cn.last_key = now_s;
        return c;
    }
}

static int cn_caps(int c) { return c >= 'a' && c <= 'z' ? c - 32 : c; }  /* C-Net's GETCHAR */

/* a line being typed: TRUE when it ended (CR or LF); echo as typed, * for HIDE */
static BOOL cn_line(int c, LONG max, BOOL hide, UWORD flags)
{
    char b;
    if (c == '\r' || c == '\n') { cn_raw("\r\n", 2); S.line[S.len] = 0; return TRUE; }
    if (c == 8 || c == 127) { if (S.len > 0) { S.len--; cn_raw("\b \b", 3); } return FALSE; }
    if (c == 21 || c == 24) { while (S.len > 0) { S.len--; cn_raw("\b \b", 3); } return FALSE; }
    if (c < 32 || (c > 126 && c < 160) || S.len >= max || S.len >= 199) return FALSE;
    if ((flags & 64) && (c < '0' || c > '9')) return FALSE;    /* {I} numbers only */
    if (flags & 1) c = cn_caps(c);
    S.line[S.len++] = (char)c;
    b = hide ? '*' : (char)c;
    cn_raw(&b, 1);
    return FALSE;
}

/* a yes/no key: 1 yes, 0 no, -1 not one of them (Enter gives def) */
static int cn_yesno(int c, int def)
{
    if (c == 'y' || c == 'Y') return 1;
    if (c == 'n' || c == 'N') return 0;
    if (c == '\r' || c == '\n') return def;
    return -1;
}

/* the caller typed something (or a wait ran out): a waiting {G}/{I}/{?}/{W}, or the command */
static void cn_service_input(void)
{
    struct CnStream *s = S.cn.nst ? &S.cn.st[S.cn.nst - 1] : NULL;
    struct RexxMsg *m = S.cn.waiting;
    int c, yn;

    if (s && s->wait != MW_NONE) {
        if (s->wait == MW_TIME) {
            if (now_s >= S.cn.muntil) { s->wait = MW_NONE; cn_run(); }
            return;
        }
        while (s->wait != MW_NONE && (c = cn_key()) >= 0) {
            if (s->wait == MW_KEY) {
                S.cn.sreg[S.cn.mreg][0] = (char)c;
                S.cn.sreg[S.cn.mreg][1] = 0;
                s->wait = MW_NONE;
            } else if (s->wait == MW_YESNO) {
                if ((yn = cn_yesno(c, S.cn.mdef)) < 0) continue;
                cn_rawstr(yn ? "Yes\r\n" : "No\r\n");
                strcpy(S.cn.sreg[0], yn ? "1" : "0");
                s->wait = MW_NONE;
            } else if (cn_line(c, S.cn.mmax, FALSE, S.cn.mflags)) {
                strncpy(S.cn.sreg[0], S.line, 83);
                S.cn.sreg[0][83] = 0;
                s->wait = MW_NONE;
            }
        }
        if (s->wait == MW_NONE) cn_run();
        return;
    }
    if (!m) return;
    switch (S.cn.wait_kind) {
    case CK_KEY:
        if ((c = cn_key()) < 0) return;
        { char b = (char)cn_caps(c); aim_reply(m, 0, &b, 1); }
        break;
    case CK_MAYBE:
        if ((c = cn_key()) >= 0) { char b = (char)cn_caps(c); aim_reply(m, 0, &b, 1); wait_disarm(); }
        else if (wait_expired()) cn_reply(m, "NOCHAR");
        else return;
        break;
    case CK_YESNO:
        for (;;) {
            if ((c = cn_key()) < 0) return;
            if ((yn = cn_yesno(c, S.cn.qdef)) >= 0) break;
        }
        cn_rawstr(yn ? "Yes\r\n" : "No\r\n");
        cn_reply(m, yn ? "Yes" : "No");
        break;
    default:
        for (;;) {
            if ((c = cn_key()) < 0) return;
            if (cn_line(c, S.maxlen, S.cn.qhide, 0)) break;
        }
        aim_reply(m, 0, S.line, S.len);
        break;
    }
    S.cn.waiting = NULL;
}

static void cn_park(struct RexxMsg *m, UBYTE kind, LONG maxlen)
{
    if (S.cn.waiting) { cn_reply(m, ""); return; }      /* one at a time */
    if (now_s - S.cn.want_at > 2) S.cn.last_key = now_s;  /* the keyboard timeout starts now */
    S.cn.want_at = now_s;
    S.cn.waiting = m;
    S.cn.wait_kind = kind;
    S.len = 0;
    S.maxlen = maxlen > 0 && maxlen < 200 ? maxlen : 199;
    if (kind == CK_MAYBE) {
        if (inq_avail()) { cn_service_input(); return; }
        if (wreq) wait_arm(CN_POLL_USECS);
        else { cn_reply(m, "NOCHAR"); S.cn.waiting = NULL; return; }
    }
    cn_service_input();
}

/* ---- commands ------------------------------------------------------------------------------ */

/* after the caller has gone: the carrier questions say so, everything else is ###PANIC */
static void cn_dead_reply(struct RexxMsg *m, const char *w)
{
    if (w && !strcmp(w, "GETCARRIER")) cn_reply(m, "FALSE");
    else if (w && (!strcmp(w, "CARRIER") || !strcmp(w, "CHECKCARRIER"))) cn_reply(m, "0");
    else cn_reply(m, CN_PANIC);
}

/* the verb of a command line: the first word, or the longest verb the line starts with (ARexx
 * glues a command to a string right after it: ss'x' with ss=SENDSTRING is SENDSTRINGx) */
static const char *cn_verb(const char *a, LONG len, LONG *wl)
{
    const char *w = NULL;
    int i, best = 0;
    *wl = 0;
    while (*wl < len && a[*wl] != ' ') (*wl)++;
    for (i = 0; cn_verbs[i]; i++)
        if ((LONG)strlen(cn_verbs[i]) == *wl && prefix_icase(a, len, cn_verbs[i])) return cn_verbs[i];
    for (i = 0; cn_verbs[i]; i++) {
        int l = strlen(cn_verbs[i]);
        if (l > best && prefix_icase(a, len, cn_verbs[i])) { w = cn_verbs[i]; best = l; }
    }
    if (w) *wl = best;
    return w;
}

/* a copy of the argument for a text answer: trimmed, one pair of double quotes dropped */
static void cn_arg(const char *arg, LONG arglen, char *t, int size)
{
    int i = arglen < size - 1 ? arglen : size - 1, n;
    char *p = t;
    memcpy(t, arg, i);
    t[i] = 0;
    while (*p == ' ') p++;
    if (p != t) memmove(t, p, strlen(p) + 1);
    n = strlen(t);
    while (n > 0 && t[n - 1] == ' ') t[--n] = 0;
    if (n >= 2 && t[0] == '"' && t[n - 1] == '"') { memmove(t, t + 1, n - 2); t[n - 2] = 0; }
}

static UBYTE *cn_copy(const char *s, LONG n, BOOL nl)
{
    UBYTE *b = AllocVec(n + 3, MEMF_ANY);
    if (!b) return NULL;
    memcpy(b, s, n);
    if (nl) { b[n] = '\r'; b[n + 1] = '\n'; }
    return b;
}

static void cn_command(struct RexxMsg *m)
{
    const char *a = (const char *)m->rm_Args[0], *arg, *w;
    LONG len, arglen, wl, n;
    char t[200], out[200];
    int i;

    if ((m->rm_Action & RXCODEMASK) != RXCOMM || !a) { aim_reply(m, 20, NULL, 0); return; }
    if (m->rm_Node.mn_ReplyPort && m->rm_Node.mn_ReplyPort->mp_SigTask)
        S.cn.script = (struct Task *)m->rm_Node.mn_ReplyPort->mp_SigTask;
    S.cmds++;
    len = ((const struct RexxArg *)(a - offsetof(struct RexxArg, ra_Buff)))->ra_Length;
    w = cn_verb(a, len, &wl);
    arg = a + wl;
    arglen = len - wl;
    if (w && arglen > 0 && *arg == ' ') { arg++; arglen--; }
    cn_arg(arg, arglen, t, sizeof(t));
    n = (w && (!strcmp(w, "GETUSER") || !strcmp(w, "PUTUSER") || !strcmp(w, "GETSCRATCH"))) ? atol(t) : -1;
    if (n >= 0 && w[0] != 'P') mark_seen(n);

    if (S.log) {
        f_begin('C');
        if (w) f_kv("verb", w);
        else { char u[16]; for (i = 0; i < 15 && i < wl; i++) u[i] = upc((UBYTE)a[i]); u[i] = 0; f_kv("verb", u); }
        if (n >= 0) f_kvn("cmd", n);
        f_kv_escaped("str", arg, arglen < 200 ? arglen : 200);
        f_end();
    }
    if (w) word_note(S.cn.verbs, sizeof(S.cn.verbs), w);
    if (cn_dead()) {
        if (w && (!strcmp(w, "TRANSMIT") || !strcmp(w, "PRINT") || !strcmp(w, "SENDSTRING")))
            cn_offline(arg, arglen);
        cn_dead_reply(m, w);
        return;
    }
    if (!w) {
        /* a bare function call's value as a statement ("call" forgotten): C-Net ignores it */
        if (wl && a[0] >= '0' && a[0] <= '9') { cn_reply(m, ""); return; }
        { char u[16]; for (i = 0; i < 15 && i < wl; i++) u[i] = upc((UBYTE)a[i]); u[i] = 0;
          word_note(S.cn.unknown, sizeof(S.cn.unknown), u[0] ? u : "?"); }
        cn_reply(m, "");
        return;
    }

    if (!strcmp(w, "TRANSMIT") || !strcmp(w, "PRINT") || !strcmp(w, "SENDSTRING")) {
        BOOL nl = w[0] != 'S';
        UBYTE *b = cn_copy(arg, arglen, nl);
        if (!b) { cn_reply(m, ""); return; }
        cn_push(m, b, arglen + (nl ? 2 : 0));
        cn_run();
    } else if (!strcmp(w, "SEND") || !strcmp(w, "SENDMODEM")) {
        cn_raw(arg, arglen);
        cn_reply(m, "");
    } else if (!strcmp(w, "NEWLINE")) {
        cn_raw("\r\n", 2);
        cn_reply(m, "");
    } else if (!strcmp(w, "CLS")) {
        cn_rawstr("\x1b[2J\x1b[H");
        S.cn.col = 0;
        cn_reply(m, "");
    } else if (!strcmp(w, "SENDFILE")) {
        LONG flen;
        UBYTE *b = cn_load(t, &flen);
        if (b) { cn_push(m, b, flen); cn_run(); }
        else cn_reply(m, "");
    } else if (!strcmp(w, "GETCHAR") || !strcmp(w, "GETKEY")) {
        cn_park(m, CK_KEY, 1);
    } else if (!strcmp(w, "MAYGETCHAR")) {
        cn_park(m, CK_MAYBE, 1);
    } else if (!strcmp(w, "BUFFERFLUSH")) {
        pump();
        inq_head = inq_tail = 0;
        cn_reply(m, "");
    } else if (!strcmp(w, "CHECKIO") || !strcmp(w, "IREADY")) {
        pump();
        cn_reply(m, inq_avail() ? "1" : "0");
    } else if (!strcmp(w, "QUERY") || !strcmp(w, "RECEIVE")) {
        cn_write(arg, arglen);
        S.cn.qhide = FALSE;
        cn_park(m, CK_LINE, 80);
    } else if (!strcmp(w, "PROMPT")) {
        /* PROMPT <len> NORMAL|HIDE|YESNO|NOYES <text>; the text in double quotes or not */
        const char *p = arg, *e = arg + arglen, *mode = NULL;
        LONG max = 0, ml = 0;
        UBYTE kind = CK_LINE;
        while (p < e && *p == ' ') p++;
        if (p < e && *p >= '0' && *p <= '9') {
            max = atol(p);
            while (p < e && *p != ' ') p++;
            while (p < e && *p == ' ') p++;
        }
        mode = p;
        while (p + ml < e && p[ml] != ' ') ml++;
        S.cn.qhide = FALSE;
        if (ml == 4 && prefix_icase(mode, ml, "HIDE")) S.cn.qhide = TRUE;
        else if (ml == 5 && (prefix_icase(mode, ml, "YESNO") || prefix_icase(mode, ml, "NOYES"))) {
            kind = CK_YESNO;
            S.cn.qdef = upc((UBYTE)mode[0]) == 'Y';
        } else if (!(ml == 6 && prefix_icase(mode, ml, "NORMAL"))) ml = 0;     /* no mode: all text */
        p += ml;
        if (ml && p < e && *p == ' ') p++;
        if (e - p >= 2 && *p == '"' && e[-1] == '"') { p++; e--; }
        else if (e - p >= 1 && *p == '"') p++;
        if (e > p) cn_write(p, e - p);
        cn_park(m, kind, max > 0 && max < 200 ? max : 199);
    } else if (!strcmp(w, "GETUSER")) {
        cn_getuser(n, out);
        cn_reply(m, out);
    } else if (!strcmp(w, "SETOBJECT")) {
        strncpy(S.cn.obj, t, sizeof(S.cn.obj) - 1);
        S.cn.obj[sizeof(S.cn.obj) - 1] = 0;
        cn_reply(m, "");
    } else if (!strcmp(w, "PUTUSER")) {
        cn_putuser(n);
        cn_reply(m, "");
    } else if (!strcmp(w, "GETCARRIER")) {
        cn_reply(m, "TRUE");
    } else if (!strcmp(w, "CARRIER") || !strcmp(w, "CHECKCARRIER")) {
        cn_reply(m, "1");
    } else if (!strcmp(w, "BBSIDENTIFY")) {
        out[0] = 0;
        if (prefix_icase(t, strlen(t), "EMULATION")) strcpy(out, S.ansi ? "ANSI" : "ASCII");
        else if (prefix_icase(t, strlen(t), "ABBEREXX")) strcpy(out, "1.0");
        else if (prefix_icase(t, strlen(t), "BBS")) strcpy(out, "5.36c");
        else if (prefix_icase(t, strlen(t), "NAME")) { strncpy(out, get("bbsname", "ENiGMA"), 80); out[80] = 0; }
        else if (prefix_icase(t, strlen(t), "SYSOP")) { strncpy(out, get("sysop", "SysOp"), 80); out[80] = 0; }
        else if (prefix_icase(t, strlen(t), "TERM"))
            sprintf(out, "38400 %ld %ld %ld", (long)S.cols, (long)S.rows, (long)cn_port());
        else if (prefix_icase(t, strlen(t), "USER")) {
            char nm[84], lo[84];
            strncpy(nm, get("name", "User"), 80); nm[80] = 0;
            strncpy(lo, get("location", ""), 80); lo[80] = 0;
            snprintf(out, sizeof(out), "\"%s\" \"%s\" %s", nm, lo,
                     cn_account() == 1 ? "SYSOP" : cn_sysop() ? "CO-SYSOP" : "MEMBER");
        }
        cn_reply(m, out);
    } else if (!strcmp(w, "VERSION")) {
        cn_reply(m, "CNet AMIGA 5.36c (axshim " SHIM_VERSION ")");
    } else if (!strcmp(w, "CHANGEWHERE") || !strcmp(w, "SETNODELOCATION") || !strcmp(w, "CHANGEWHAT")) {
        strcpy(out, S.cn.where);        /* C-Net answers the one before */
        strncpy(S.cn.where, t, sizeof(S.cn.where) - 1);
        S.cn.where[sizeof(S.cn.where) - 1] = 0;
        cn_reply(m, out);
    } else if (!strcmp(w, "ADDTIME")) {         /* tenths of a minute (SDK), signed */
        LONG left = time_left() + atol(t) * 6;
        S.budget = left > 0 ? left : 0;
        S.budget_base = now_s;
        S.cn.addtime += atol(t);
        cn_reply(m, "");
    } else if (!strcmp(w, "ADDPOINTS")) {
        S.cn.points += atol(t);
        S.cn.addpoints += atol(t);
        S.wrote = TRUE;
        cn_reply(m, "");
    } else if (!strcmp(w, "ADDKEYS")) {         /* typed ahead of whatever is waiting */
        for (i = arglen - 1; i >= 0; i--) {
            UWORD prev = (inq_tail - 1) & (INQSIZE - 1);
            if (prev == inq_head) break;
            inq_tail = prev;
            inq[inq_tail] = (UBYTE)arg[i];
        }
        cn_reply(m, "");
        if (S.cn.waiting) cn_service_input();
    } else if (!strcmp(w, "FINDACCOUNT")) {     /* the caller's own handle or number, else 0 */
        n = 0;
        if (t[0] >= '0' && t[0] <= '9') n = atol(t) == cn_account() ? cn_account() : 0;
        else if (t[0] && ieq(t, get("name", "User"))) n = cn_account();
        sprintf(out, "%ld", (long)n);
        cn_reply(m, out);
    } else if (!strcmp(w, "GETPORTID")) {
        sprintf(out, "%ld", (long)(atol(t) == cn_port() ? cn_account() : -1));
        cn_reply(m, out);
    } else if (!strcmp(w, "LOADSCRATCH")) {     /* only the caller's own account is there */
        S.cn.scratch = atol(t) == cn_account();
        cn_reply(m, S.cn.scratch ? "1" : "0");
    } else if (!strcmp(w, "GETSCRATCH")) {
        out[0] = 0;
        if (S.cn.scratch) cn_getuser(n, out);
        cn_reply(m, out);
    } else if (!strcmp(w, "SAVESCRATCH")) {     /* other accounts are never written */
        S.cn.scratch = FALSE;
        cn_reply(m, "0");
    } else if (!strcmp(w, "CLEAREDITOR") || !strcmp(w, "SETMAILSUBJ") || !strcmp(w, "PUTSCRATCH")
               || !strcmp(w, "SETPROTOCOL")) {
        cn_reply(m, "");
    } else if (!strcmp(w, "LOADEDITOR") || !strcmp(w, "SAVEEDITOR") || !strcmp(w, "CALLEDITOR")
               || !strcmp(w, "WRITEMAIL") || !strcmp(w, "XUP") || !strcmp(w, "XDN")) {
        cn_reply(m, "0");                       /* no editor, no mail, no transfers */
    } else if (!strcmp(w, "CHECKABORT")) {
        cn_reply(m, "0");
    } else if (!strcmp(w, "SPAWN")) {          /* the named script takes the port when this ends */
        Forbid();
        strncpy(LN.spawn, t, sizeof(LN.spawn) - 1);
        LN.spawn[sizeof(LN.spawn) - 1] = 0;
        Permit();
        cn_reply(m, "");
    } else if (!strcmp(w, "BYE") || !strcmp(w, "HANGUP") || !strcmp(w, "DROPCARRIER")) {
        S.dtr = TRUE;                           /* reported as dropdtr=1 in X */
        cn_reply(m, "");
    } else cn_reply(m, "");     /* LOGENTRY SYSOPLOG SHUTDOWN SCREENOUT BBSCOMMAND OPENDISPLAY
                                 * CLOSEDISPLAY BAUD MODEM RESETMODEM SETMINFREE SETLENGTH FEEDBACK */
}

/* a command after its session: the caller has gone */
static void cn_zombie(struct RexxMsg *m)
{
    const char *a = (const char *)m->rm_Args[0];
    LONG wl;
    if ((m->rm_Action & RXCODEMASK) != RXCOMM || !a) { aim_reply(m, 20, NULL, 0); return; }
    cn_dead_reply(m, cn_verb(a, ((const struct RexxArg *)(a - offsetof(struct RexxArg, ra_Buff)))->ra_Length, &wl));
}

/* the session's CNETREXX<port>, and ARexx itself; CNET:Mail/Users/<account> when the image keeps
 * C-Net's mail tree (pfiles leave per-caller files there) */
static const char *cn_open(void)
{
    const char *err = rexx_ready();
    char dir[48];
    BPTR l;
    if (err) return err;
    if ((l = Lock((STRPTR)"CNET:Mail/Users", ACCESS_READ))) {
        UnLock(l);
        sprintf(dir, "CNET:Mail/Users/%ld", (long)cn_account());
        if ((l = Lock((STRPTR)dir, ACCESS_READ)) || (l = CreateDir((STRPTR)dir))) UnLock(l);
    }
    sprintf(cportname, "CNETREXX%ld", (long)cn_port());
    Forbid();
    if (FindPort((STRPTR)cportname)) { Permit(); return "door port busy"; }
    if ((cport = CreateMsgPort())) {
        cport->mp_Node.ln_Name = cportname;
        cport->mp_Node.ln_Pri = 0;
        AddPort(cport);
    }
    Permit();
    return cport ? NULL : "door port busy";
}

static void cport_close(void)
{
    struct RexxMsg *m;
    if (!cport) return;
    Forbid();
    RemPort(cport);
    while ((m = (struct RexxMsg *)GetMsg(cport))) cn_zombie(m);
    Permit();
    DeleteMsgPort(cport);
    cport = NULL;
}

/* the launcher's side: the script (and any it SPAWNs) as C-Net started pfiles, a RexxMsg to REXX
 * with CNETREXX<port> as its host; returns the last script's return code, -1 if none ran */
static LONG cn_launch_script(BPTR in, BPTR out)
{
    struct MsgPort *rp = CreateMsgPort(), *rexx;
    struct RexxMsg *m;
    char cmd[300];
    LONG rc = -1;
    if (!rp) return -1;
    strcpy(cmd, LN.cmd);
    for (;;) {
        if (!(m = CreateRexxMsg(rp, (STRPTR)"rexx", (STRPTR)cportname))) break;
        if (!(m->rm_Args[0] = CreateArgstring((STRPTR)cmd, strlen(cmd)))) { DeleteRexxMsg(m); break; }
        m->rm_Action = RXCOMM;
        m->rm_Stdin = in;
        m->rm_Stdout = out;
        Forbid();
        if ((rexx = FindPort((STRPTR)"REXX"))) PutMsg(rexx, (struct Message *)m);
        Permit();
        if (!rexx) { DeleteArgstring(m->rm_Args[0]); DeleteRexxMsg(m); break; }
        WaitPort(rp);
        GetMsg(rp);
        rc = m->rm_Result1;
        DeleteArgstring(m->rm_Args[0]);
        DeleteRexxMsg(m);
        Forbid();               /* SPAWN: the next script, on the same port */
        strcpy(cmd, LN.spawn);
        LN.spawn[0] = 0;
        Permit();
        if (!cmd[0]) break;
    }
    DeleteMsgPort(rp);
    return rc;
}

/* the C-Net half of session_service(): input, waits, timeouts, the script's end, X */
static void cn_session_service(void)
{
    struct RexxMsg *m;
    struct CnStream *s = S.cn.nst ? &S.cn.st[S.cn.nst - 1] : NULL;
    BOOL ended = FALSE, wants;

    if (!S.timeup && time_left() <= 0) { S.timeup = TRUE; S.timeup_at = now_s; }
    /* the keyboard timeout: while a command or a {G}/{I}/{?} waits, or the script polled
     * MAYGETCHAR within the last 2 seconds */
    wants = (S.cn.waiting && S.cn.wait_kind != CK_MAYBE) || (s && s->wait != MW_NONE && s->wait != MW_TIME)
            || now_s - S.cn.want_at <= 2;
    if (!cn_dead() && S.timeout > 0 && wants && now_s - S.cn.last_key >= (ULONG)S.timeout) {
        S.cn.timedout = TRUE;
        S.input_failed = TRUE;
    }
    if (!cn_dead()) cn_service_input();

    if (cn_dead()) {
        if (!S.cn.broken) {
            S.cn.broken = TRUE;
            S.cn.dead_at = now_s;
            Forbid();
            LN.spawn[0] = 0;
            Permit();
            /* panicgrace 0: break the script BEFORE it gets its answer (ARexx halts at the end of
             * the clause, so a door that would save "###PANIC" as a name writes nothing) */
            if (S.cn.panicgrace <= 0 && !LN.done) { cli_signal(S.cn.script, SIGBREAKF_CTRL_C); S.cn.sig_at = now_s ? now_s : 1; }
            if (S.cn.waiting) { wait_disarm(); cn_reply(S.cn.waiting, CN_PANIC); S.cn.waiting = NULL; }
            cn_reset();
        } else if (!LN.done && now_s - S.cn.dead_at >= (ULONG)S.cn.panicgrace
                   && (!S.cn.sig_at || now_s - S.cn.sig_at >= CN_BREAK_REPEAT)) {
            S.cn.sig_at = now_s;
            cli_signal(S.cn.script, SIGBREAKF_CTRL_C);
        }
    }

    if (LN.done) {              /* the script (and what it spawned) has ended */
        while (cport && (m = (struct RexxMsg *)GetMsg(cport))) cn_command(m);
        if (!S.cmds && LN.rc && !S.lost) {
            char out[120], err[200];
            script_stdout(out, sizeof(out));
            snprintf(err, sizeof(err), "script ended without a host command (rc=%ld)%s%s", (long)LN.rc,
                     out[0] ? ": " : "", out);
            reap();
            error_session(err);
            return;
        }
        ended = TRUE;
    } else if (S.cn.broken && now_s - S.cn.dead_at >= CARRIER_GRACE) {
        ended = TRUE;
    }
    if (!ended) return;

    if (S.lost == LOST_HANGUP) end_session("carrier", NULL);
    else if (S.lost == LOST_TIMEUP) end_session("timeout", NULL);
    else if (S.lost == LOST_BREAK) end_session("break", NULL);
    else if (S.timeup || S.cn.timedout) end_session("timeout", NULL);
    else end_session("ok", NULL);
}

/* ---- the session's clock work: input, editor, exit ------------------------------------ */

static void session_service(void)
{
    struct JHMessage *m;
    BOOL ended = FALSE;

    if (S.cli.on) { cli_session_service(); return; }
    if (S.aim.on) { aim_session_service(); return; }
    if (S.tim.on) { tim_session_service(); return; }
    if (S.cn.on) { cn_session_service(); return; }

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
    struct RexxMsg *rm;
    struct DoorMsg *dm;
    int pass;
    timer_poll();
    pump();
    hport_drain();              /* CLI handles: a live session's packets, or zombie answers */
    for (pass = 0; pass < 2; pass++) {  /* a session that ends here may already have its next s */
        if (state == ST_READY) {
            if (port) while ((m = (struct JHMessage *)GetMsg(port))) zombie_reply(m);
            if (aport) while ((rm = (struct RexxMsg *)GetMsg(aport))) aim_zombie(rm);
            if (dport) while ((dm = (struct DoorMsg *)GetMsg(dport))) tim_zombie(dm);
            if (cport) while ((rm = (struct RexxMsg *)GetMsg(cport))) cn_zombie(rm);
            cli_zombie_service();
            if (LN.busy && LN.done) reap();
            if (s_pending) {
                s_pending = FALSE;
                start_session();
            }
        }
        if (state == ST_SESSION) {
            if (port) while ((m = (struct JHMessage *)GetMsg(port))) {
                xim_command(m);
                pump();
            }
            if (aport) while ((rm = (struct RexxMsg *)GetMsg(aport))) {
                if (S.aim.on) aim_command(rm); else aim_zombie(rm);
                pump();
            }
            if (dport) while ((dm = (struct DoorMsg *)GetMsg(dport))) {
                if (S.tim.on) tim_command(dm); else tim_zombie(dm);
                pump();
            }
            if (cport) while ((rm = (struct RexxMsg *)GetMsg(cport))) {
                if (S.cn.on) cn_command(rm); else cn_zombie(rm);
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
    if (!wait_timer_open() || !(hport = CreateMsgPort())) hport = NULL;    /* no CLI doors then */
    assign("BBS", "SYS:");
    assign("DOORS", "SYS:Doors");
    assign("PGDOORS", "SYS:Doors");     /* Paragon doors' door path (PG_US 7, as /X answers) */
    assign("PFILES", "SYS:PFiles");     /* C-Net's pfile and system trees, when the image has them */
    assign("CNET", "SYS:CNet");

    emit_hello(baud);
    emit_ready();
    for (;;) {
        ULONG sigs = rx.sigmask | timer_sigmask() | SIGBREAKF_CTRL_C, got;
        if (port) sigs |= 1UL << port->mp_SigBit;
        if (aport) sigs |= 1UL << aport->mp_SigBit;
        if (dport) sigs |= 1UL << dport->mp_SigBit;
        if (cport) sigs |= 1UL << cport->mp_SigBit;
        if (wport) sigs |= wait_sigmask();          /* MAYGETCHAR's wait, too */
        if (LN.busy && LN.donesig >= 0) sigs |= 1UL << LN.donesig;
        if (extsig >= 0) sigs |= 1UL << extsig;
        if (hport) sigs |= (1UL << hport->mp_SigBit) | wait_sigmask();
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
