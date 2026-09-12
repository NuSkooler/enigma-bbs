#  Two stages. The first installs a compiler toolchain and runs npm ci; the
#  second is what ships, and it copies node_modules out of the first rather
#  than building it in place. A single-stage image that installs the toolchain
#  and then apt-get removes it does not get smaller -- a layer can only add to
#  an image, and a later delete records a whiteout over bytes that are still
#  pulled. That was #814: four fifths of the published image was the layer
#  that installed the toolchain.
#
#  No --platform on either FROM, on purpose. Pinning it to BUILDPLATFORM builds
#  every target on the builder's own architecture, which is only correct if the
#  rest of the file then cross compiles -- and it does not, it just runs npm ci
#  and copies the tree. The result was four tags whose contents were all amd64
#  (#794). Both stages must also name the *same* base image: see the comment
#  on the COPY --from below.
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


FROM node:22-bookworm-slim

LABEL maintainer="dave@force9.org"

ENV DEBIAN_FRONTEND=noninteractive

#  Runtime packages only: the archivers and lrzsz are executed by the BBS,
#  the toolchain is not. pm2 is pure JavaScript, so it needs no compiler.
RUN apt-get update \
    && apt-get install -y \
    lrzsz \
    arj \
    lhasa \
    unrar-free \
    p7zip-full \
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
