FROM ubuntu:xenial

RUN \
  apt-get update && apt-get upgrade -q -y && \
  apt-get install -y git curl python  && \
  curl -sL https://deb.nodesource.com/setup_6.x | bash - && \
  apt-get install -y nodejs node-gyp && \
  cd /opt && \
  git clone https://github.com/NuSkooler/enigma-bbs.git && \
  cd enigma-bbs && npm install && \
  apt autoremove -y && apt-get clean && \
  mkdir /opt/enigma-conf

EXPOSE 8888

WORKDIR /opt/enigma-bbs
CMD ./main.js --config /opt/enigma-conf/config.hjson
