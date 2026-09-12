#  No --platform here on purpose. Pinning this to BUILDPLATFORM builds every
#  target on the builder's own architecture, which is only correct if the rest
#  of the file then cross compiles -- and it does not, it just runs npm install
#  and copies the tree. The result was four tags whose contents were all amd64.
FROM node:22-bookworm-slim

LABEL maintainer="dave@force9.org"

ENV NVM_DIR /root/.nvm
ENV DEBIAN_FRONTEND noninteractive


# Just copy the manifest and its lockfile so it only needs to build once
COPY package.json package-lock.json /enigma-bbs/

# Install APT and NPM packages
RUN apt-get update \
    && apt-get install -y \
    git \
    curl \
    build-essential \
    python3 \
    libssl-dev \
    lrzsz \
    arj \
    lhasa \
    unrar-free \
    p7zip-full \
    dos2unix \
    && npm set progress=false && npm config set depth 0 \
    && npm install -g pm2 \
    && cd /enigma-bbs && npm ci


# Do this after npm ci to avoid cache-miss on every code change
COPY . /enigma-bbs

#  Supplied by BuildKit for each target of the arch matrix. One sexyz is built
#  per published platform -- see docker/sexyz/build.sh -- so the right one has
#  to be selected here. A single binary copied onto every target is what #797
#  was: an x86-64 ELF giving every default X/Y/ZModem handler an "exec format
#  error" on arm. TARGETARCH names amd64/arm64/arm; arm/v7 is the only 32-bit
#  arm we publish, so it maps to the armv7 build.
ARG TARGETARCH

# Then run post source copy steps that have to happen every time
RUN dos2unix /enigma-bbs/docker/bin/docker-entrypoint.sh \
    && apt-get remove dos2unix -y \
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
    && pm2 start main.js \
    && mkdir -p /enigma-bbs-pre/art \
    && mkdir /enigma-bbs-pre/mods \
    && mkdir /enigma-bbs-pre/config \
    && cp -rp art/* ../enigma-bbs-pre/art/ \
    && cp -rp mods/* ../enigma-bbs-pre/mods/ \
    && cp -rp config/* ../enigma-bbs-pre/config/ \
    && apt-get remove build-essential python3 libssl-dev git curl -y \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
    && apt-get clean

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
