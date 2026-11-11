FROM node:24.20.0-bookworm
# The full Node image includes Python for the portable-input bootstrap.
RUN python3 --version
WORKDIR /case
