# DEV/CI ONLY: the AWS mock (Secrets Manager and STS) for SECRETS_PROVIDER=aws,
# and the agent stand-in for SECRETS_MODE=agent, in one image.
# Build from the repository root:  docker build -f dev/aws-mock/Dockerfile .
FROM docker.io/library/node:22-alpine
WORKDIR /mock
COPY dev/aws-mock/server.js ./
COPY dev/aws-mock/lib ./lib
# A data directory the unprivileged user owns (a named volume inherits it).
RUN mkdir -p /data && chown 1000:1000 /data
ENV PORT=4566 HOST=0.0.0.0
USER 1000
EXPOSE 4566
CMD ["node", "server.js"]
