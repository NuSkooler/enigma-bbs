| NOTICE: from NilBBS (https://github.com/lainejones/NilBBS, 4f9c0c3, src/aedoor/),
| MIT licence, Copyright (c) 2026 Laine Jones, see LICENSE.  ENiGMA½ applied
| patches/0001-aedoor-preserve-d1-a0-a1.patch (lines marked "ENiGMA:").
|
| aedoor_start.S - NilBBS's own AEDoor.library: ROM tag, jump table and the
| register stubs.  The functions themselves are in aedoor.c (C, stack args).
|
| The API is the published one (AEDoor 2.x autodocs and pragmas): 19 calls
| from LVO -30, arguments in registers.  Each stub pushes them for C and,
| on the way out, sets the flags the docs promise assembler doors:
| Prompt / GetStr set Z on a NULL (lost carrier), HotKey sets N on -1.
| (A plain "tst.l d0" after the call does both.)
|
| No RTF_AUTOINIT: rt_Init is our own Init, which calls MakeLibrary and
| AddLibrary itself (as a314bsd's bsdsocket.library does).

    .equ    VERSION,        3
    .equ    REVISION,       0

    .equ    LN_TYPE,        8
    .equ    LN_NAME,        10
    .equ    LIB_FLAGS,      14
    .equ    LIB_NEGSIZE,    16
    .equ    LIB_POSSIZE,    18
    .equ    LIB_VERSION,    20
    .equ    LIB_REVISION,   22
    .equ    LIB_IDSTRING,   24
    .equ    LIB_OPENCNT,    32
    .equ    LIBF_CHANGED,   2
    .equ    LIBF_DELEXP,    8
    .equ    NT_LIBRARY,     9

    .equ    BASE_SIZE,      40      | struct Library (34) + SegList + pad
    .equ    base_SegList,   34
    .equ    NEGSIZE,        (4 + 19) * 6

    .text

Start:
    moveq   #-1,d0
    rts
    .even

RomTag:
    .word   0x4AFC
    .long   RomTag
    .long   EndSkip
    .byte   0                   | no RTF_AUTOINIT
    .byte   VERSION
    .byte   NT_LIBRARY
    .byte   0
    .long   LibName
    .long   IDString
    .long   Init
EndSkip:
    .even

LibName:
    .ascii  "AEDoor.library"
    .byte   0
    .even
IDString:
    .ascii  "AEDoor.library 3.0 (29.9.2026) NilBBS"
    .byte   13,10,0
    .even

FuncTable:
    .long   Open
    .long   Close
    .long   Expunge
    .long   Null
    .long   LCreateComm         | -30  0x1e
    .long   LDeleteComm         | -36  0x24
    .long   LSendCmd            | -42  0x2a
    .long   LSendStrCmd         | -48  0x30
    .long   LSendDataCmd        | -54  0x36
    .long   LSendStrDataCmd     | -60  0x3c
    .long   LGetData            | -66  0x42
    .long   LGetString          | -72  0x48
    .long   LPrompt             | -78  0x4e
    .long   LWriteStr           | -84  0x54
    .long   LShowGFile          | -90  0x5a
    .long   LShowFile           | -96  0x60
    .long   LSetDT              | -102 0x66
    .long   LGetDT              | -108 0x6c
    .long   LGetStr             | -114 0x72
    .long   LCopyStr            | -120 0x78
    .long   LHotKey             | -126 0x7e
    .long   LPreCreateComm      | -132 0x84
    .long   LPostDeleteComm     | -138 0x8a
    .long   -1

| ---- Init: d0 = segList, a6 = SysBase ----------------------------------------
Init:
    movem.l d2-d7/a2-a6,-(sp)
    move.l  d0,d6
    move.l  a6,_SysBase
    lea     FuncTable(pc),a0
    sub.l   a1,a1
    sub.l   a2,a2
    move.l  #BASE_SIZE,d0
    move.l  d6,d1
    jsr     -84(a6)             | MakeLibrary
    move.l  d0,d5
    beq.s   1f
    movea.l d5,a1
    move.l  d6,base_SegList(a1)
    move.b  #NT_LIBRARY,LN_TYPE(a1)
    lea     LibName(pc),a0
    move.l  a0,LN_NAME(a1)
    lea     IDString(pc),a0
    move.l  a0,LIB_IDSTRING(a1)
    move.b  #LIBF_CHANGED,LIB_FLAGS(a1)
    move.w  #VERSION,LIB_VERSION(a1)
    move.w  #REVISION,LIB_REVISION(a1)
    move.l  d5,-(sp)
    jsr     -396(a6)            | AddLibrary
    move.l  (sp)+,d0
    bra.s   2f
1:  moveq   #0,d0
2:  movem.l (sp)+,d2-d7/a2-a6
    rts

| ---- Open / Close / Expunge / Null (a6 = our base) ---------------------------
Open:
    addq.w  #1,LIB_OPENCNT(a6)
    bclr    #3,LIB_FLAGS(a6)    | LIBF_DELEXP
    move.l  a6,d0
    rts

Close:
    moveq   #0,d0
    subq.w  #1,LIB_OPENCNT(a6)
    bne.s   1f
    btst    #3,LIB_FLAGS(a6)    | an expunge waiting for the last close?
    beq.s   1f
    bra.s   Expunge
1:  rts

| Expunge: a6 = our base.  Still open -> mark LIBF_DELEXP and stay; else
| unlink, free the base and hand the segment list back to ramlib.
Expunge:
    tst.w   LIB_OPENCNT(a6)
    beq.s   1f
    bset    #3,LIB_FLAGS(a6)
    moveq   #0,d0
    rts
1:  movem.l d2/a5/a6,-(sp)
    move.l  a6,a5               | a5 = our base
    move.l  base_SegList(a5),d2
    move.l  a5,a1
    move.l  _SysBase,a6
    jsr     -252(a6)            | Remove(node/a1)
    moveq   #0,d0
    move.l  a5,a1
    move.w  LIB_NEGSIZE(a5),d0
    sub.l   d0,a1               | the block starts at the jump table
    add.w   LIB_POSSIZE(a5),d0
    jsr     -210(a6)            | FreeMem(a1, d0)
    move.l  d2,d0               | the segment list: ramlib unloads it
    movem.l (sp)+,d2/a5/a6
    rts

Null:
    moveq   #0,d0
    rts

| ---- the 19 calls ------------------------------------------------------------
| C prototypes (aedoor.c):
|   APTR aed_CreateComm(ULONG node)
|   void aed_DeleteComm(APTR dif)
|   void aed_SendStrDataCmd(APTR dif, ULONG cmd, char *s, ULONG data, LONG flags)
|   ...  (flags: 1 = string given, 2 = data given)

LCreateComm:                    | d0 = node (ASCII, obsolete)
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    move.l  d0,-(sp)
    jsr     _aed_CreateComm
    addq.l  #4,sp
    tst.l   d0
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LDeleteComm:                    | a1 = dif
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    move.l  a1,-(sp)
    jsr     _aed_DeleteComm
    addq.l  #4,sp
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LSendCmd:                       | a1 = dif, d0 = cmd
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    pea     0.w                 | flags: neither string nor data
    clr.l   -(sp)
    clr.l   -(sp)
    move.l  d0,-(sp)
    move.l  a1,-(sp)
    jsr     _aed_Send
    lea     20(sp),sp
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LSendStrCmd:                    | a1 = dif, d0 = cmd, a0 = string
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    pea     1.w
    clr.l   -(sp)
    move.l  a0,-(sp)
    move.l  d0,-(sp)
    move.l  a1,-(sp)
    jsr     _aed_Send
    lea     20(sp),sp
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LSendDataCmd:                   | a1 = dif, d0 = cmd, d1 = data
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    pea     2.w
    move.l  d1,-(sp)
    clr.l   -(sp)
    move.l  d0,-(sp)
    move.l  a1,-(sp)
    jsr     _aed_Send
    lea     20(sp),sp
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LSendStrDataCmd:                | a1 = dif, d0 = cmd, a0 = string, d1 = data
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    pea     3.w
    move.l  d1,-(sp)
    move.l  a0,-(sp)
    move.l  d0,-(sp)
    move.l  a1,-(sp)
    jsr     _aed_Send
    lea     20(sp),sp
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LGetData:                       | a1 = dif -> d0 = &Data
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    move.l  a1,-(sp)
    jsr     _aed_GetData
    addq.l  #4,sp
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LGetString:                     | a1 = dif -> d0 = String
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    move.l  a1,-(sp)
    jsr     _aed_GetString
    addq.l  #4,sp
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LPrompt:                        | a1 = dif, d1 = length, a0 = prompt -> String / NULL (Z)
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    move.l  a0,-(sp)
    move.l  d1,-(sp)
    move.l  a1,-(sp)
    jsr     _aed_Prompt
    lea     12(sp),sp
    tst.l   d0
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LWriteStr:                      | a1 = dif, a0 = string, d1 = flags
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    move.l  d1,-(sp)
    move.l  a0,-(sp)
    move.l  a1,-(sp)
    jsr     _aed_WriteStr
    lea     12(sp),sp
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LShowGFile:                     | a1 = dif, a0 = file
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    move.l  a0,-(sp)
    move.l  a1,-(sp)
    jsr     _aed_ShowGFile
    addq.l  #8,sp
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LShowFile:                      | a1 = dif, a0 = file
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    move.l  a0,-(sp)
    move.l  a1,-(sp)
    jsr     _aed_ShowFile
    addq.l  #8,sp
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LSetDT:                         | a1 = dif, d0 = id, a0 = str
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    move.l  a0,-(sp)
    move.l  d0,-(sp)
    move.l  a1,-(sp)
    jsr     _aed_SetDT
    lea     12(sp),sp
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LGetDT:                         | a1 = dif, d0 = id, a0 = str (or NULL)
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    move.l  a0,-(sp)
    move.l  d0,-(sp)
    move.l  a1,-(sp)
    jsr     _aed_GetDT
    lea     12(sp),sp
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LGetStr:                        | a1 = dif, d1 = length, a0 = default -> String / NULL (Z)
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    move.l  a0,-(sp)
    move.l  d1,-(sp)
    move.l  a1,-(sp)
    jsr     _aed_GetStr
    lea     12(sp),sp
    tst.l   d0
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LCopyStr:                       | a1 = dif, a0 = buffer
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    move.l  a0,-(sp)
    move.l  a1,-(sp)
    jsr     _aed_CopyStr
    addq.l  #8,sp
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LHotKey:                        | a1 = dif, a0 = prompt (or NULL) -> key / -1 (N)
    movem.l d1/a0-a1,-(sp)      | ENiGMA: keep the caller's d1/a0/a1, as AEDoor 2.x does
    move.l  a0,-(sp)
    move.l  a1,-(sp)
    jsr     _aed_HotKey
    addq.l  #8,sp
    tst.l   d0
    movem.l (sp)+,d1/a0-a1      | (movem leaves the condition codes alone)
    rts

LPreCreateComm:                 | private multi-door calls: nothing to do here
LPostDeleteComm:
    moveq   #0,d0
    rts
