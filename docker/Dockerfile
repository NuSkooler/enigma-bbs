#  Three stages. The first installs a compiler toolchain and runs npm ci; the
#  second builds unarc; the last is what ships, and it copies node_modules and
#  the unarc binary out of the other two rather than building them in place.
#  A single-stage image that installs the toolchain and then apt-get removes
#  it does not get smaller -- a layer can only add to an image, and a later
#  delete records a whiteout over bytes that are still pulled. That was #814:
#  four fifths of the published image was the layer that installed the
#  toolchain.
#
#  No --platform on the build or runtime FROM, on purpose. Pinning it to
#  BUILDPLATFORM builds every target on the builder's own architecture, which
#  is only correct if the stage then cross compiles -- and these do not, they
#  just run npm ci and copy the tree. The result was four tags whose contents
#  were all amd64 (#794). The two must also name the *same* base image: see
#  the comment on the COPY --from below.
#
#  The unarc stage further down is the one exception, and it is one because it
#  really does cross compile.

#  The unarc release to build (crates.io unarc-cli), pinned so an image build is
#  reproducible (#801). Declared here so the stage that builds it and the check
#  in the runtime stage cannot disagree.
ARG UNARC_VERSION=0.8.0

FROM node:22-bookworm-slim AS build

ENV DEBIAN_FRONTEND=noninteractive

#  git is not optional here: package-lock.json resolves one dependency from a
#  git URL, so npm ci clones it. None of this stage's packages reach the
#  final image, so what is installed here costs nothing at pull time.
RUN apt-get update \
    && apt-get install -y \
    git \
    curl \
    build-essential \
    python3 \
    libssl-dev \
    && npm set progress=false

#  Just the manifest and its lockfile, so the native modules only rebuild when
#  a dependency changes rather than on every source change.
COPY package.json package-lock.json /enigma-bbs/

RUN cd /enigma-bbs && npm ci


#  unarc (https://github.com/mkrueger/unarc-rs) reads ARC/PAK, ZOO, ACE, SQZ,
#  UC2, .Z, xz, Zstandard, CAB, the C64 formats and Amiga DMS, and stands in for
#  unlzx and atr, which Debian does not package (#906). It is pure Rust bar
#  zstd-sys's C, links only glibc and libgcc_s, and upstream publishes no
#  binaries, so it is built here and only the binary is copied out.
#
#  This stage runs on the builder's own architecture and cross compiles for
#  TARGETARCH. Under QEMU the arm builds would take many times as long as a
#  native one; cross compiled, each takes about as long as the native build. The
#  toolchain image is bookworm, like the runtime stage, so the binary needs no
#  newer glibc than the image has. Bump UNARC_VERSION at the top to update it;
#  the runtime stage checks `unarc --version` against it.
FROM --platform=$BUILDPLATFORM rust:1.96-slim-bookworm AS unarc

ARG TARGETARCH
ARG UNARC_VERSION

RUN set -e \
    && case "$TARGETARCH" in \
        amd64) deb=amd64; rust=x86_64-unknown-linux-gnu;      gnu=x86_64-linux-gnu;    gcc=gcc-x86-64-linux-gnu ;; \
        arm64) deb=arm64; rust=aarch64-unknown-linux-gnu;     gnu=aarch64-linux-gnu;   gcc=gcc-aarch64-linux-gnu ;; \
        arm)   deb=armhf; rust=armv7-unknown-linux-gnueabihf; gnu=arm-linux-gnueabihf; gcc=gcc-arm-linux-gnueabihf ;; \
        *)     echo "no unarc build for TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && if [ "$(dpkg --print-architecture)" != "$deb" ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends "$gcc" "libc6-dev-${deb}-cross" \
        && rustup target add "$rust" ; \
       fi \
    && target=$(echo "$rust" | tr - _) \
    && export "CC_${target}=${gnu}-gcc" \
        "CARGO_TARGET_$(echo "$target" | tr a-z A-Z)_LINKER=${gnu}-gcc" \
    && CARGO_PROFILE_RELEASE_STRIP=true cargo install --locked unarc-cli \
        --version "$UNARC_VERSION" --target "$rust" --root /opt/unarc \
    && src=$(echo "$CARGO_HOME"/registry/src/*/"unarc-cli-${UNARC_VERSION}") \
    && mkdir -p /opt/unarc/share/doc/unarc \
    && cp "$src/LICENSE" /opt/unarc/share/doc/unarc/ \
    && grep -E '^(license|repository) =' "$src/Cargo.toml" > /opt/unarc/share/doc/unarc/copyright \
    && rm -rf "$CARGO_HOME/registry"


FROM node:22-bookworm-slim

LABEL maintainer="dave@force9.org"

ENV DEBIAN_FRONTEND=noninteractive

#  Runtime packages only: the archivers, the description tools and lrzsz are
#  executed by the BBS, the toolchain is not. pm2 is pure JavaScript, so it
#  needs no compiler.
#
#  These are the tools the defaults in core/config_default.js call (#905):
#  zip/unzip for InfoZip, exiftool for Exiftool and Exiftool2Desc, xdms for
#  DMS descriptions, and poppler-utils for pdftotext. The check_tools step
#  below fails the build if one goes missing.
#
#  unrar is RARLAB's, from non-free, on every platform we publish. The Rar
#  archiver's list pattern is written for it; unrar-free, the main-archive
#  stand-in, prints each entry over two lines, so every RAR looked empty.
RUN sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
    lrzsz \
    arj \
    lhasa \
    unrar \
    p7zip-full \
    zip \
    unzip \
    libimage-exiftool-perl \
    poppler-utils \
    xdms \
    && rm -rf /var/lib/apt/lists/* \
    && npm set progress=false \
    && npm install -g pm2 \
    && npm cache clean --force

#  node_modules carries compiled native modules -- node-pty, better-sqlite3,
#  cpu-features, ssh2's crypto binding. Copying them between stages is sound
#  only because both stages run on the same base image and the build is
#  native per platform rather than cross compiled (#794). A move to cross
#  compilation, or a different base image in either stage, breaks this copy.
COPY --from=build /enigma-bbs/node_modules /enigma-bbs/node_modules

#  The binary, which needs no runtime files of its own, and its licence:
#  unarc is MIT OR Apache-2.0, and the crate ships the Apache-2.0 text.
COPY --from=unarc /opt/unarc/bin/unarc /usr/local/bin/unarc
COPY --from=unarc /opt/unarc/share/doc/unarc/ /usr/share/doc/unarc/

#  Do this after node_modules so a source change does not invalidate it.
#  node_modules is in .dockerignore, so this cannot overwrite the copy above.
COPY . /enigma-bbs

#  Supplied by BuildKit for each target of the arch matrix. One sexyz is built
#  per published platform -- see docker/sexyz/build.sh -- so the right one has
#  to be selected here. A single binary copied onto every target is what #797
#  was: an x86-64 ELF giving every default X/Y/ZModem handler an "exec format
#  error" on arm. TARGETARCH names amd64/arm64/arm; arm/v7 is the only 32-bit
#  arm we publish, so it maps to the armv7 build.
ARG TARGETARCH
ARG UNARC_VERSION

#  Debian packages neither unlzx nor atr, so the image reads LZX and ATR with
#  unarc instead, as the Archivers docs suggest for any board that has it.
#  The config loader points the archivers named here at the Unarc archiver
#  (core/config/unarc_archivers.js); a complete Atr or Lzx entry in
#  config.hjson replaces that. Rar stays on unrar, which the image has.
ENV ENIGMA_UNARC_ARCHIVERS=Atr,Lzx

#  Post source copy steps that have to happen every time. The entrypoint may
#  arrive with CRLF line endings from a Windows checkout; sed strips them
#  rather than installing dos2unix for one file.
#
#  Nothing here starts the BBS. The old image ran `pm2 start main.js` at this
#  point, which really did launch main.js during the build: it left a pm2
#  daemon's state under /root/.pm2 and, on a checkout that had a config, a
#  set of freshly created sqlite databases under /enigma-bbs/db -- all of it
#  shipped in the image. The entrypoint runs pm2-runtime, which needs none
#  of it.
RUN sed -i 's/\r$//' /enigma-bbs/docker/bin/docker-entrypoint.sh \
    && chmod +x /enigma-bbs/docker/bin/docker-entrypoint.sh \
    && case "$TARGETARCH" in \
        amd64) sexyz_build=amd64 ;; \
        arm64) sexyz_build=arm64 ;; \
        arm)   sexyz_build=armv7 ;; \
        *)     echo "no sexyz build for TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && cp -f "/enigma-bbs/docker/bin/sexyz-${sexyz_build}" /usr/local/bin/sexyz \
    && chmod +x /usr/local/bin/sexyz \
    && sexyz v \
    && node /enigma-bbs/docker/check_tools.js --unarc-version "$UNARC_VERSION" \
    && cd /enigma-bbs \
    && mkdir -p /enigma-bbs-pre/art \
    && mkdir /enigma-bbs-pre/mods \
    && mkdir /enigma-bbs-pre/config \
    && cp -rp art/* ../enigma-bbs-pre/art/ \
    && cp -rp mods/* ../enigma-bbs-pre/mods/ \
    && cp -rp config/* ../enigma-bbs-pre/config/

# enigma storage mounts
VOLUME /enigma-bbs/art
VOLUME /enigma-bbs/config
VOLUME /enigma-bbs/db
VOLUME /enigma-bbs/filebase
VOLUME /enigma-bbs/logs
VOLUME /enigma-bbs/mods
VOLUME /mail

# Enigma default port
EXPOSE 8888

WORKDIR /enigma-bbs

ENTRYPOINT ["/enigma-bbs/docker/bin/docker-entrypoint.sh"]
