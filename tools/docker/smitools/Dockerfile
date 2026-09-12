# libsmi's smidump for machines without a native package.
# Debian ships libsmi 0.4.8 as `smitools`; Arch's AUR 0.5.0 does not build with current bison/gcc.
# Build:  docker build -t kaleidoscope-smitools tools/docker/smitools
# Use:    SMIDUMP=tools/bin/smidump-docker pnpm compile   (or let the compiler pick it up automatically)
FROM debian:bookworm-slim
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends smitools libsmi2-common \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /work
ENTRYPOINT ["smidump"]
