FROM node:24.20.0-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    clang build-essential binutils python3 ca-certificates curl pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup
ENV PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --profile minimal --default-toolchain nightly-2026-04-16 \
    && rm /tmp/rustup.sh
WORKDIR /case
