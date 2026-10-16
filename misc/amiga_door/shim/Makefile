# Makefile - build the Amiga side of ENiGMA½'s Amiga door support:
#   ../bin/axshim           the host shim (C, libnix, -noixemul)
#   ../bin/AEDoor.library   NilBBS's MIT AEDoor.library (../aedoor), freestanding
#
# Needs bebbo's m68k-amigaos-gcc; build.sh runs this inside the
# amigadev/crosstools:m68k-amigaos Docker image.  From this directory: make
#
# Copyright (c) 2026, Bryan Ashby (NuSkooler)
# SPDX-License-Identifier: BSD-2-Clause

CC      ?= m68k-amigaos-gcc
BIN     := ../bin
OBJ     := build
AEDOOR  := ../aedoor

# -m68000: the same binaries run on a 68000 (KS 3.1 A500) and on AROS's 68EC020 setup
SHIM_CFLAGS   := -noixemul -m68000 -O2 -Wall -s
AEDOOR_CFLAGS := -m68000 -O2 -fomit-frame-pointer -ffreestanding -fno-builtin \
                 -fno-tree-loop-distribute-patterns -Wall -nostdlib

.PHONY: all clean

all: $(BIN)/axshim $(BIN)/AEDoor.library

$(BIN)/axshim: axshim.c
	@mkdir -p $(BIN)
	$(CC) $(SHIM_CFLAGS) -o $@ axshim.c

$(OBJ)/aedoor_start.o: $(AEDOOR)/aedoor_start.S
	@mkdir -p $(OBJ)
	$(CC) -m68000 -c -o $@ $<

$(OBJ)/aedoor.o: $(AEDOOR)/aedoor.c
	@mkdir -p $(OBJ)
	$(CC) $(AEDOOR_CFLAGS) -c -o $@ $<

$(BIN)/AEDoor.library: $(OBJ)/aedoor_start.o $(OBJ)/aedoor.o
	@mkdir -p $(BIN)
	$(CC) -m68000 -nostartfiles -nostdlib -s -o $@ $^

clean:
	rm -rf $(OBJ) $(BIN)/axshim $(BIN)/AEDoor.library
