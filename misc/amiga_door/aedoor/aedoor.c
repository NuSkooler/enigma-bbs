/*
 * NOTICE: from NilBBS (https://github.com/lainejones/NilBBS, 4f9c0c3, src/aedoor/),
 * MIT licence, Copyright (c) 2026 Laine Jones, see LICENSE.  Unmodified in ENiGMA½.
 *
 * aedoor.c - NilBBS's own AEDoor.library, written from the published API
 * (the AEDoor 2.x autodocs, pragmas and libraries/aedoor.h): a door talks to
 * the BBS by sending JHMessages to the public port AEDoorPort<node> and
 * waiting for each reply.  Works with AmiExpress and NilBBS alike.
 *
 * Built freestanding (-nostdlib): exec only, no C library.  The register
 * stubs and the library frame are in aedoor_start.S.
 *
 * struct DIFace is public (doors read dif_Data / dif_String directly), so its
 * layout is fixed: AEPort, MsgPort, Message, ReplyName[16], Data*, String*.
 */
#include <exec/types.h>
#include <exec/ports.h>
#include <exec/memory.h>
#include <dos/dosextens.h>
#include <proto/exec.h>

struct ExecBase *SysBase;               /* set by Init (aedoor_start.S) */

#define AEMAXCHARS 200

struct JHMessage {                      /* the /X door message ("extended", 2.3+) */
    struct Message msg;
    char   String[AEMAXCHARS];
    LONG   Data;
    LONG   Command;
    LONG   NodeID;
    LONG   LineNum;
    ULONG  signal;
    struct Process *task;
    LONG   Semi;
    LONG   Filler1, Filler2;
    char  *strptr;
    LONG   filler3;
};

struct DIFace {
    struct MsgPort   *dif_AEPort;       /* AEDoorPort<n>: where messages go */
    struct MsgPort   *dif_MsgPort;      /* our reply port */
    struct JHMessage *dif_Message;
    char              dif_ReplyName[16];
    LONG             *dif_Data;         /* -> dif_Message->Data */
    char             *dif_String;       /* -> dif_Message->String */
};

/* one allocation for all of it (as 2.8 does) */
struct Comm {
    struct DIFace    dif;
    struct JHMessage jm;
};

#define JH_LI       0
#define JH_REGISTER 1
#define JH_SHUTDOWN 2
#define JH_SM       4
#define JH_PM       5
#define JH_HK       6
#define JH_SG       7
#define JH_SF       8

/* ---- tiny string helpers (no C library here) ---------------------------------------- */
static ULONG slen(const char *s) { ULONG n = 0; if (s) while (s[n]) n++; return n; }

static void scopy(char *d, const char *s, ULONG max)    /* at most max-1 chars + NUL */
{
    ULONG i = 0;
    if (s) while (s[i] && i < max - 1) { d[i] = s[i]; i++; }
    d[i] = 0;
}

/* the node number from the door's argument line: /X starts a door as
 * "<command> [args] <node>", so the last all-digit word wins; the first
 * digit in the line when there's none of those.  -1 = no number. */
static LONG node_from_args(void)
{
    struct Process *pr = (struct Process *)FindTask(NULL);
    const char *a;
    LONG last = -1, cur = -1;
    BOOL digits = FALSE, other = FALSE;
    if (pr->pr_Task.tc_Node.ln_Type != NT_PROCESS || !(a = (const char *)pr->pr_Arguments)) return -1;
    for (;; a++) {
        char c = *a;
        if (c >= '0' && c <= '9' && !other) {
            cur = (digits ? cur * 10 : 0) + (c - '0');
            digits = TRUE;
        } else if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == 0) {
            if (digits && !other) last = cur;
            digits = other = FALSE;
            cur = -1;
            if (!c) break;
        } else other = TRUE;
    }
    return last;
}

/* "AEDoorPort" + n: the number in decimal, 0-9999 (no divide on a 68000
 * without a C library: subtract powers of ten) */
static void put_num(char *d, LONG n)
{
    static const LONG pw[4] = { 1000, 100, 10, 1 };
    int i;
    BOOL started = FALSE;
    if (n < 0) n = 0;
    if (n > 9999) n = 9999;
    for (i = 0; i < 4; i++) {
        char digit = '0';
        while (n >= pw[i]) { n -= pw[i]; digit++; }
        if (digit != '0' || started || i == 3) { *d++ = digit; started = TRUE; }
    }
    *d = 0;
}

/* send the message and wait for the BBS to reply */
static void transact(struct DIFace *dif)
{
    struct JHMessage *m = dif->dif_Message;
    m->msg.mn_Node.ln_Type = NT_MESSAGE;
    m->msg.mn_ReplyPort = dif->dif_MsgPort;
    m->msg.mn_Length = sizeof(struct JHMessage);
    PutMsg(dif->dif_AEPort, (struct Message *)m);
    WaitPort(dif->dif_MsgPort);
    GetMsg(dif->dif_MsgPort);
}

/* ---- the library calls --------------------------------------------------------------- */

APTR aed_CreateComm(ULONG node_ascii)
{
    struct Comm *c;
    struct MsgPort *bbs;
    char name[24];
    LONG node = node_from_args();

    if (node < 0 && node_ascii >= '0' && node_ascii <= '9') node = (LONG)(node_ascii - '0');  /* V1 style */
    if (node < 0) node = 0;
    scopy(name, "AEDoorPort", sizeof(name));
    put_num(name + 10, node);

    Forbid();
    bbs = FindPort((STRPTR)name);
    Permit();
    if (!bbs) return NULL;                  /* no BBS node: started from the CLI or WB */

    while (!(c = AllocVec(sizeof(struct Comm), MEMF_PUBLIC | MEMF_CLEAR))) {
        /* "no way to tell the BBS we're out of memory": wait and retry.  (exec's
           own Delay is dos.library's, which we don't open: a short busy pause) */
        volatile ULONG i;
        for (i = 0; i < 200000; i++) ;
    }
    if (!(c->dif.dif_MsgPort = CreateMsgPort())) { FreeVec(c); return NULL; }
    c->dif.dif_AEPort = bbs;
    c->dif.dif_Message = &c->jm;
    scopy(c->dif.dif_ReplyName, "DoorReplyPort", 16);
    put_num(c->dif.dif_ReplyName + 13, node);
    c->dif.dif_Data = &c->jm.Data;
    c->dif.dif_String = c->jm.String;

    c->jm.Command = JH_REGISTER;
    c->jm.Data = 0;
    c->jm.String[0] = 0;
    transact(&c->dif);
    return c;
}

void aed_DeleteComm(struct DIFace *dif)
{
    if (!dif) return;
    dif->dif_Message->Command = JH_SHUTDOWN;
    dif->dif_Message->Data = 0;
    dif->dif_Message->String[0] = 0;
    transact(dif);
    DeleteMsgPort(dif->dif_MsgPort);
    FreeVec(dif);                           /* the Comm block starts with the DIFace */
}

/* SendCmd / SendStrCmd / SendDataCmd / SendStrDataCmd: flags 1 = the string,
 * 2 = the data (a NULL string counts as "", as in 2.8) */
void aed_Send(struct DIFace *dif, ULONG cmd, const char *s, ULONG data, LONG flags)
{
    struct JHMessage *m;
    if (!dif) return;
    m = dif->dif_Message;
    m->Command = (LONG)cmd;
    if (flags & 1) scopy(m->String, s, AEMAXCHARS);
    if (flags & 2) m->Data = (LONG)data;
    transact(dif);
}

LONG *aed_GetData(struct DIFace *dif)   { return dif ? dif->dif_Data : NULL; }
char *aed_GetString(struct DIFace *dif) { return dif ? dif->dif_String : NULL; }

char *aed_Prompt(struct DIFace *dif, ULONG len, const char *prompt)
{
    if (!dif) return NULL;
    aed_Send(dif, JH_PM, prompt, len, 3);
    return dif->dif_Message->Data == -1 ? NULL : dif->dif_String;
}

char *aed_GetStr(struct DIFace *dif, ULONG len, const char *def)
{
    if (!dif) return NULL;
    aed_Send(dif, JH_LI, def, len, 3);
    return dif->dif_Message->Data == -1 ? NULL : dif->dif_String;
}

/* flags bit 0 = line feed after it; bit 1 (SAFE) no longer needed: a string
 * of any length goes out in 199-character pieces, the line feed on the last */
void aed_WriteStr(struct DIFace *dif, const char *s, ULONG flags)
{
    struct JHMessage *m;
    ULONG n;
    if (!dif) return;
    m = dif->dif_Message;
    n = slen(s);
    do {
        ULONG part = n > AEMAXCHARS - 1 ? AEMAXCHARS - 1 : n, i;
        for (i = 0; i < part; i++) m->String[i] = s[i];
        m->String[part] = 0;
        s += part; n -= part;
        m->Command = JH_SM;
        m->Data = (n == 0 && (flags & 1)) ? 1 : 0;
        transact(dif);
    } while (n > 0);
}

void aed_ShowGFile(struct DIFace *dif, const char *f) { aed_Send(dif, JH_SG, f, 0, 1); }
void aed_ShowFile(struct DIFace *dif, const char *f)  { aed_Send(dif, JH_SF, f, 0, 1); }

void aed_SetDT(struct DIFace *dif, ULONG id, const char *s) { aed_Send(dif, id, s, 0, 3); }   /* WRITEIT */
void aed_GetDT(struct DIFace *dif, ULONG id, const char *s) { aed_Send(dif, id, s, 1, 3); }   /* READIT */

void aed_CopyStr(struct DIFace *dif, char *buf)
{
    if (dif && buf) scopy(buf, dif->dif_String, AEMAXCHARS);
}

/* -1 = carrier lost (or a failed request); else the key, 0-255 */
LONG aed_HotKey(struct DIFace *dif, const char *prompt)
{
    if (!dif) return -1;
    aed_Send(dif, JH_HK, prompt, 0, 1);
    if (dif->dif_Message->Data == -1) return -1;
    return (LONG)(UBYTE)dif->dif_Message->String[0];
}
